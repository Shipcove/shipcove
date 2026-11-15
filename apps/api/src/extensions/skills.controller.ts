import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  CreateSkillSchema,
  NewSkillVersionSchema,
  SKILL_LIMITS,
  SkillNameSchema,
  SkillScopeSchema,
  type CreateSkill,
  type NewSkillVersion,
  type SkillDetailDto,
  type SkillDto,
  type StoredSkillFile,
} from '@cap/contracts';
import { skillInstallations, skillVersions, skills, type Database } from '@cap/database';
import { AppError, AuditService, DB, SettingsService, canonicalJson, sha256Hex } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { readZip, toStoredFiles, writeZip } from './skill-archive.js';
import { fileData, fileSize, readFrontmatter, resolveSkillFiles } from './skill-files.js';

const uuid = { schema: z.uuid() };

/**
 * Analyse statique des sources d'un skill. Un skill est un ensemble d'instructions : il ne confère
 * aucun privilège, mais l'analyse signale les contenus à risque pour la revue humaine.
 */
export function analyzeSkill(files: StoredSkillFile[], name?: string): string[] {
  const findings: string[] = [];
  const md = files.find((f) => f.path === 'SKILL.md');
  if (!md) findings.push('SKILL.md manquant');
  else {
    const fm = readFrontmatter(md.content);
    if (!fm.name || !fm.description) findings.push('Frontmatter SKILL.md incomplet (name, description)');
    else if (name && fm.name !== name) findings.push(`Le nom du frontmatter (« ${fm.name} ») devrait être « ${name} » : Pi s’appuie sur le nom du dossier`);
  }
  for (const f of files) {
    if (/\.(sh|bash|py|js|ts|mjs|cjs|rb|pl|ps1|bat|cmd|exe|bin)$/i.test(f.path) || f.executable) findings.push(`Script exécutable inclus : ${f.path}`);
    if (f.encoding === 'base64') continue; // binaire : seules les règles de nom s'appliquent
    if (/curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh/.test(f.content)) findings.push(`Téléchargement exécuté (curl|sh) : ${f.path}`);
    if (/\brm\s+-rf\s+[/~]/.test(f.content)) findings.push(`Suppression récursive dangereuse : ${f.path}`);
    if (/(gh[pousr]_[A-Za-z0-9]{20,}|glpat-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(f.content)) findings.push(`Secret probable : ${f.path}`);
    if (/[A-Za-z0-9+/]{400,}={0,2}/.test(f.content)) findings.push(`Bloc encodé volumineux : ${f.path}`);
    if (/(ignore (all )?previous instructions|disregard .*instructions)/i.test(f.content)) findings.push(`Formulation d’injection de prompt : ${f.path}`);
    if (/git\s+push|platform_git_push|\bgh\s+(pr|api|repo)|\bglab\s+(mr|api|repo)/.test(f.content)) findings.push(`Mentionne une publication Git : ${f.path} (pushs et PR/MR faits au nom de l’utilisateur)`);
  }
  return [...new Set(findings)];
}

interface UploadedZip {
  originalname: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('skills')
@Controller('skills')
export class SkillsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Autorité sur un skill selon sa portée (global : admin plateforme ; personnel : propriétaire). */
  private async assertManage(user: AuthUser, s: { scope: string; ownerId: string | null }) {
    if (s.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    if (s.scope === 'personal' && s.ownerId !== user.id) throw new AppError('forbidden', 'Skill personnel d’un autre utilisateur');
  }

  private async dto(user: AuthUser, s: typeof skills.$inferSelect, installs: Array<typeof skillInstallations.$inferSelect>): Promise<SkillDto> {
    const [v] = await this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, s.id), eq(skillVersions.version, s.latestVersion)));
    const mine = installs.filter((i) => i.skillId === s.id && (i.scope === 'global' || (i.scope === 'personal' && i.subjectId === user.id)));
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      scope: s.scope,
      ownerId: s.ownerId,
      status: s.status,
      latestVersion: s.latestVersion,
      digest: v?.digest ?? '',
      source: s.source,
      findings: v?.analysis.findings ?? [],
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      enabledForMe: s.status === 'published' && !mine.some((i) => !i.enabled),
      fileCount: v?.files.length ?? 0,
      canManage: await this.canManage(user, s),
    };
  }

  /** Skill visible par l'utilisateur (global, ou personnel à lui ; brouillons pour ceux qui le gèrent). */
  private async visible(user: AuthUser, id: string) {
    const [s] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!s || (s.scope === 'personal' && s.ownerId !== user.id) || (s.status !== 'published' && !(await this.canManage(user, s)))) {
      throw new AppError('not_found', 'Skill introuvable');
    }
    return s;
  }

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<SkillDto[]> {
    const visible = await this.db
      .select()
      .from(skills)
      .where(or(eq(skills.scope, 'global'), and(eq(skills.scope, 'personal'), eq(skills.ownerId, user.id))))
      .orderBy(skills.name);
    const installs = visible.length ? await this.db.select().from(skillInstallations).where(inArray(skillInstallations.skillId, visible.map((s) => s.id))) : [];
    const out: SkillDto[] = [];
    for (const s of visible) {
      if (s.status !== 'published' && !(await this.canManage(user, s))) continue;
      out.push(await this.dto(user, s, installs));
    }
    return out;
  }

  private async canManage(user: AuthUser, s: { scope: string; ownerId: string | null }) {
    try {
      await this.assertManage(user, s);
      return true;
    } catch {
      return false;
    }
  }

  /** Détail : fichiers (arborescence) d'une version, la dernière par défaut, et historique. */
  @Get(':skillId')
  async get(@Param('skillId', uuid) id: string, @Query('version', { schema: z.coerce.number().int().positive().optional() }) version: number | undefined, @CurrentUser() user: AuthUser): Promise<SkillDetailDto> {
    const s = await this.visible(user, id);
    const versions = await this.db.select().from(skillVersions).where(eq(skillVersions.skillId, id)).orderBy(desc(skillVersions.version));
    const v = versions.find((x) => x.version === (version ?? s.latestVersion));
    if (!v) throw new AppError('not_found', 'Version introuvable');
    const installs = await this.db.select().from(skillInstallations).where(eq(skillInstallations.skillId, id));
    return {
      skill: await this.dto(user, s, installs),
      version: v.version,
      files: v.files.map((f) => ({ path: f.path, size: fileSize(f), encoding: f.encoding ?? 'utf8', executable: !!f.executable, content: f.content })),
      versions: versions.map((x) => ({ version: x.version, digest: x.digest, findings: x.analysis.findings, createdAt: x.createdAt.toISOString(), fileCount: x.files.length })),
    };
  }

  @Post()
  async create(@Body({ schema: CreateSkillSchema }) body: CreateSkill, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.createFrom(user, ctx, { name: body.name, scope: body.scope, description: body.description, source: body.source, files: resolveSkillFiles(body.files) });
  }

  private async createFrom(user: AuthUser, ctx: RequestContext, input: { name: string; scope: 'global' | 'personal'; description?: string; source?: string; files: StoredSkillFile[] }) {
    const cfg = await this.settings.section('skills');
    if (input.scope === 'personal' && !cfg.personalSkillsAllowed) throw new AppError('forbidden', 'Les skills personnels sont désactivés');
    const meta = { scope: input.scope, ownerId: input.scope === 'personal' ? user.id : null };
    await this.assertManage(user, meta);
    const description = readFrontmatter(input.files[0].content).description ?? input.description;
    if (!description) throw new AppError('validation_failed', 'Description requise : champ « description » du frontmatter de SKILL.md');
    const findings = analyzeSkill(input.files, input.name);
    // Skill personnel : publié directement sauf revue imposée ; autres portées : brouillon puis publication explicite.
    const status = input.scope === 'personal' ? (cfg.personalSkillsRequireReview ? 'pending_review' : 'published') : 'draft';
    const [s] = await this.db
      .insert(skills)
      .values({ name: input.name, description, ...meta, status, source: input.source ?? null, latestVersion: 1 })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Un skill porte déjà ce nom dans cette portée');
        throw err;
      });
    await this.db.insert(skillVersions).values({ skillId: s.id, version: 1, files: input.files, digest: sha256Hex(canonicalJson(input.files)), analysis: { findings, scannedAt: new Date().toISOString() }, createdBy: user.id });
    await this.audit.record({ actorId: user.id, action: 'skill.create', targetType: 'skill', targetId: s.id, ip: ctx.ip, metadata: { scope: input.scope, files: input.files.length, findings } });
    return { id: s.id, status, findings };
  }

  /** Nouvelle version : fichiers modifiés envoyés, fichiers inchangés repris par leur chemin (`sourcePath`). */
  @Post(':skillId/versions')
  async newVersion(@Param('skillId', uuid) id: string, @Body({ schema: NewSkillVersionSchema }) body: NewSkillVersion, @CurrentUser() user: AuthUser) {
    // Un skill personnel d'un autre utilisateur reste introuvable (son existence n'est pas révélée).
    const s = await this.visible(user, id);
    await this.assertManage(user, s);
    const [prev] = await this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, id), eq(skillVersions.version, s.latestVersion)));
    return this.addVersion(user, s, resolveSkillFiles(body.files, prev?.files ?? []), body.description);
  }

  private async addVersion(user: AuthUser, s: typeof skills.$inferSelect, files: StoredSkillFile[], description?: string) {
    if (s.status === 'revoked') throw new AppError('conflict', 'Skill révoqué');
    const version = s.latestVersion + 1;
    const findings = analyzeSkill(files, s.name);
    const desc = readFrontmatter(files[0].content).description ?? description ?? s.description;
    await this.db.insert(skillVersions).values({ skillId: s.id, version, files, digest: sha256Hex(canonicalJson(files)), analysis: { findings, scannedAt: new Date().toISOString() }, createdBy: user.id });
    await this.db.update(skills).set({ latestVersion: version, description: desc, updatedAt: new Date() }).where(eq(skills.id, s.id));
    await this.audit.record({ actorId: user.id, action: 'skill.version', targetType: 'skill', targetId: s.id, metadata: { version, files: files.length, findings } });
    return { id: s.id, version, findings };
  }

  /**
   * Import d'une archive .zip (SKILL.md à la racine, ou dans un unique dossier racine) : nouveau
   * skill, ou nouvelle version d'un skill existant (`skillId`). Nom et description lus dans le frontmatter.
   */
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SKILL_LIMITS.maxTotalBytes + 1024 * 1024, files: 1, fields: 5 } }))
  async importZip(@UploadedFile() file: UploadedZip | undefined, @Body() raw: Record<string, string>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    if (!file) throw new AppError('validation_failed', 'Fichier .zip manquant');
    const fields = z.object({ scope: SkillScopeSchema.default('personal'), skillId: z.uuid().optional(), name: SkillNameSchema.optional() }).safeParse(raw);
    if (!fields.success) throw new AppError('validation_failed', 'Paramètres d’import invalides');
    const files = resolveSkillFiles(toStoredFiles(readZip(file.buffer)).map((f) => ({ ...f, encoding: f.encoding ?? 'utf8' })));
    if (fields.data.skillId) {
      const s = await this.visible(user, fields.data.skillId);
      await this.assertManage(user, s);
      return this.addVersion(user, s, files);
    }
    const fmName = readFrontmatter(files[0].content).name;
    const fallback = file.originalname.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const name = fields.data.name ?? (fmName && SkillNameSchema.safeParse(fmName).success ? fmName : fallback);
    if (!SkillNameSchema.safeParse(name).success) throw new AppError('validation_failed', `Nom de skill invalide : « ${name} » (minuscules, chiffres, tirets)`);
    return this.createFrom(user, ctx, { name, scope: fields.data.scope, files, source: `zip:${file.originalname.slice(0, 200)}` });
  }

  /** Export .zip d'une version (dernière par défaut), arborescence et droits d'exécution conservés. */
  @Get(':skillId/export')
  async exportZip(@Param('skillId', uuid) id: string, @Query('version', { schema: z.coerce.number().int().positive().optional() }) version: number | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const s = await this.visible(user, id);
    const [v] = await this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, id), eq(skillVersions.version, version ?? s.latestVersion)));
    if (!v) throw new AppError('not_found', 'Version introuvable');
    const zip = writeZip(v.files.map((f) => ({ path: f.path, data: fileData(f), executable: !!f.executable })), s.name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${s.name}-v${v.version}.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(zip);
  }

  @Post(':skillId/status')
  @HttpCode(200)
  async setStatus(@Param('skillId', uuid) id: string, @Body({ schema: z.object({ status: z.enum(['published', 'disabled', 'revoked', 'draft']) }) }) body: { status: 'published' | 'disabled' | 'revoked' | 'draft' }, @CurrentUser() user: AuthUser) {
    const [s] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!s) throw new AppError('not_found', 'Skill introuvable');
    // La révocation et la publication d'un skill en attente de revue sont des décisions d'administration.
    if (body.status === 'revoked' || s.status === 'pending_review') {
      if (user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Décision réservée aux administrateurs plateforme');
    } else await this.assertManage(user, s);
    if (s.status === 'revoked') throw new AppError('conflict', 'Un skill révoqué ne peut pas être réactivé');
    await this.db.update(skills).set({ status: body.status, updatedAt: new Date() }).where(eq(skills.id, id));
    await this.audit.record({ actorId: user.id, action: `skill.${body.status}`, targetType: 'skill', targetId: id });
    return { status: body.status };
  }

  /** Activation / désactivation pour soi ou globalement (admin). */
  @Put(':skillId/installation')
  async install(
    @Param('skillId', uuid) id: string,
    @Body({ schema: z.object({ scope: SkillScopeSchema, enabled: z.boolean(), pinnedVersion: z.number().int().positive().nullable().optional() }) })
    body: { scope: 'global' | 'personal'; enabled: boolean; pinnedVersion?: number | null },
    @CurrentUser() user: AuthUser,
  ) {
    const [s] = await this.db.select().from(skills).where(eq(skills.id, id));
    const visible = s && (user.platformRole === 'platform_admin' || s.scope === 'global' || (s.scope === 'personal' && s.ownerId === user.id));
    if (!visible) throw new AppError('not_found', 'Skill introuvable');
    if (body.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs');
    const subjectId = body.scope === 'global' ? null : user.id;
    const [existing] = await this.db
      .select({ id: skillInstallations.id })
      .from(skillInstallations)
      .where(and(eq(skillInstallations.skillId, id), eq(skillInstallations.scope, body.scope), subjectId ? eq(skillInstallations.subjectId, subjectId) : isNull(skillInstallations.subjectId)));
    if (existing) {
      await this.db.update(skillInstallations).set({ enabled: body.enabled, pinnedVersion: body.pinnedVersion ?? null }).where(eq(skillInstallations.id, existing.id));
    } else {
      await this.db.insert(skillInstallations).values({ skillId: id, scope: body.scope, subjectId, enabled: body.enabled, pinnedVersion: body.pinnedVersion ?? null, createdBy: user.id });
    }
    await this.audit.record({ actorId: user.id, action: 'skill.installation', targetType: 'skill', targetId: id, metadata: body });
    return { ok: true };
  }
}
