import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  CreateSkillSchema,
  SaveSkillFilesSchema,
  UpdateSkillSchema,
  SkillNameSchema,
  SkillScopeSchema,
  type CreateSkill,
  type SaveSkillFiles,
  type SkillDetailDto,
  type SkillDto,
  type StoredSkillFile,
} from '@cap/contracts';
import { skillCategories, skillInstallations, skillVersions, skills, type Database } from '@cap/database';
import { AppError, AuditService, DB, SettingsService, canonicalJson, sha256Hex, skillEnabledByDefault, skillEnabledFor } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { ARCHIVE_LIMITS, readZip, toSkillFiles, writeZip } from './skill-archive.js';
import { fileSize, isMarkdownFile, readFrontmatter, resolveSkillFiles } from './skill-files.js';

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
    const v = await this.content(s);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      scope: s.scope,
      ownerId: s.ownerId,
      status: s.status,
      digest: v?.digest ?? '',
      source: s.source,
      findings: v?.analysis.findings ?? [],
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      enabledForMe: s.status === 'published' && skillEnabledFor(installs, s.id, user.id),
      enabledByDefault: skillEnabledByDefault(installs, s.id),
      fileCount: v?.files.filter(isMarkdownFile).length ?? 0,
      categoryId: s.categoryId,
      canManage: await this.canManage(user, s),
    };
  }

  /** Contenu actuel du skill (une seule version conservée). */
  private async content(s: typeof skills.$inferSelect) {
    const [v] = await this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, s.id), eq(skillVersions.version, s.latestVersion)));
    return v;
  }

  /** Skill visible par l'utilisateur : global, ou personnel à lui (un skill d'autrui reste introuvable). */
  private async visible(user: AuthUser, id: string) {
    const [s] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!s || (s.scope === 'personal' && s.ownerId !== user.id && user.platformRole !== 'platform_admin')) throw new AppError('not_found', 'Skill introuvable');
    if (s.scope === 'personal' && s.ownerId !== user.id && s.status !== 'pending_review') throw new AppError('not_found', 'Skill introuvable');
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
    for (const s of visible) out.push(await this.dto(user, s, installs));
    return out;
  }

  /** Skills personnels en attente de revue (administrateur, si la revue est imposée). */
  @Get('review/pending')
  async pending(@CurrentUser() user: AuthUser): Promise<SkillDto[]> {
    if (user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    const rows = await this.db.select().from(skills).where(eq(skills.status, 'pending_review')).orderBy(skills.name);
    return Promise.all(rows.map((s) => this.dto(user, s, [])));
  }

  private async canManage(user: AuthUser, s: { scope: string; ownerId: string | null }) {
    try {
      await this.assertManage(user, s);
      return true;
    } catch {
      return false;
    }
  }

  /** Détail : fichiers markdown (arborescence). */
  @Get(':skillId')
  async get(@Param('skillId', uuid) id: string, @CurrentUser() user: AuthUser): Promise<SkillDetailDto> {
    const s = await this.visible(user, id);
    const v = await this.content(s);
    const installs = await this.db.select().from(skillInstallations).where(eq(skillInstallations.skillId, id));
    return {
      skill: await this.dto(user, s, installs),
      files: (v?.files ?? []).filter(isMarkdownFile).map((f) => ({ path: f.path, size: fileSize(f), content: f.content })),
    };
  }

  @Post()
  async create(@Body({ schema: CreateSkillSchema }) body: CreateSkill, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.createFrom(user, ctx, { name: body.name, scope: body.scope, description: body.description, source: body.source, categoryId: body.categoryId ?? null, files: resolveSkillFiles(body.files) });
  }

  private async assertCategory(categoryId: string | null | undefined) {
    if (!categoryId) return;
    const [c] = await this.db.select({ id: skillCategories.id }).from(skillCategories).where(eq(skillCategories.id, categoryId));
    if (!c) throw new AppError('validation_failed', 'Catégorie inconnue');
  }

  private async createFrom(user: AuthUser, ctx: RequestContext, input: { name: string; scope: 'global' | 'personal'; description?: string; source?: string; categoryId?: string | null; files: StoredSkillFile[] }) {
    await this.assertCategory(input.categoryId);
    const cfg = await this.settings.section('skills');
    if (input.scope === 'personal' && !cfg.personalSkillsAllowed) throw new AppError('forbidden', 'Les skills personnels sont désactivés');
    const meta = { scope: input.scope, ownerId: input.scope === 'personal' ? user.id : null };
    await this.assertManage(user, meta);
    const description = readFrontmatter(input.files[0].content).description ?? input.description;
    if (!description) throw new AppError('validation_failed', 'Description requise : champ « description » du frontmatter de SKILL.md');
    const findings = analyzeSkill(input.files, input.name);
    // Disponible tout de suite ; revue seulement si l'administrateur l'impose pour les skills personnels.
    const status = input.scope === 'personal' && cfg.personalSkillsRequireReview ? 'pending_review' : 'published';
    const [s] = await this.db
      .insert(skills)
      .values({ name: input.name, description, ...meta, status, source: input.source ?? null, categoryId: input.categoryId ?? null, latestVersion: 1 })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Un skill porte déjà ce nom');
        throw err;
      });
    await this.db.insert(skillVersions).values({ skillId: s.id, version: 1, files: input.files, digest: sha256Hex(canonicalJson(input.files)), analysis: { findings, scannedAt: new Date().toISOString() }, createdBy: user.id });
    await this.audit.record({ actorId: user.id, action: 'skill.create', targetType: 'skill', targetId: s.id, ip: ctx.ip, metadata: { scope: input.scope, files: input.files.length, findings } });
    return { id: s.id, status, findings };
  }

  /** Enregistrement : remplace le contenu (fichiers inchangés repris par leur chemin, `sourcePath`). */
  @Put(':skillId/files')
  async save(@Param('skillId', uuid) id: string, @Body({ schema: SaveSkillFilesSchema }) body: SaveSkillFiles, @CurrentUser() user: AuthUser) {
    const s = await this.visible(user, id);
    await this.assertManage(user, s);
    const current = await this.content(s);
    return this.replaceContent(user, s, resolveSkillFiles(body.files, current?.files ?? []));
  }

  private async replaceContent(user: AuthUser, s: typeof skills.$inferSelect, files: StoredSkillFile[]) {
    const findings = analyzeSkill(files, s.name);
    const description = readFrontmatter(files[0].content).description ?? s.description;
    const values = { files, digest: sha256Hex(canonicalJson(files)), analysis: { findings, scannedAt: new Date().toISOString() }, createdBy: user.id };
    const [updated] = await this.db.update(skillVersions).set(values).where(and(eq(skillVersions.skillId, s.id), eq(skillVersions.version, s.latestVersion))).returning({ id: skillVersions.id });
    if (!updated) await this.db.insert(skillVersions).values({ skillId: s.id, version: s.latestVersion || 1, ...values });
    await this.db.update(skills).set({ description, latestVersion: s.latestVersion || 1, updatedAt: new Date() }).where(eq(skills.id, s.id));
    await this.audit.record({ actorId: user.id, action: 'skill.update', targetType: 'skill', targetId: s.id, metadata: { files: files.length, findings } });
    return { id: s.id, findings };
  }

  /** Catégorie d'un skill (parmi celles définies par les administrateurs ; `null` : sans catégorie). */
  @Patch(':skillId')
  async update(@Param('skillId', uuid) id: string, @Body({ schema: UpdateSkillSchema }) body: { categoryId: string | null }, @CurrentUser() user: AuthUser) {
    const s = await this.visible(user, id);
    await this.assertManage(user, s);
    await this.assertCategory(body.categoryId);
    await this.db.update(skills).set({ categoryId: body.categoryId, updatedAt: new Date() }).where(eq(skills.id, id));
    await this.audit.record({ actorId: user.id, action: 'skill.category', targetType: 'skill', targetId: id, metadata: { categoryId: body.categoryId } });
    return { ok: true };
  }

  /** Suppression définitive (auteur d'un skill personnel, administrateur pour un skill global). */
  @Delete(':skillId')
  @HttpCode(204)
  async remove(@Param('skillId', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const s = await this.visible(user, id);
    await this.assertManage(user, s);
    await this.db.delete(skills).where(eq(skills.id, id)); // versions et activations en cascade
    await this.audit.record({ actorId: user.id, action: 'skill.delete', targetType: 'skill', targetId: id, ip: ctx.ip, metadata: { name: s.name, scope: s.scope } });
  }

  /** Validation d'un skill personnel en attente de revue (administrateur). */
  @Post(':skillId/approve')
  @HttpCode(200)
  async approve(@Param('skillId', uuid) id: string, @CurrentUser() user: AuthUser) {
    if (user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    const [s] = await this.db.update(skills).set({ status: 'published', updatedAt: new Date() }).where(and(eq(skills.id, id), eq(skills.status, 'pending_review'))).returning({ id: skills.id });
    if (!s) throw new AppError('not_found', 'Aucun skill en attente avec cet identifiant');
    await this.audit.record({ actorId: user.id, action: 'skill.approve', targetType: 'skill', targetId: id });
    return { status: 'published' };
  }

  /**
   * Import d'une archive .zip (SKILL.md à la racine, ou dans un unique dossier racine) : nouveau
   * skill, ou remplacement du contenu d'un skill existant (`skillId`). Nom et description lus dans le frontmatter.
   */
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ARCHIVE_LIMITS.maxTotalBytes, files: 1, fields: 6 } }))
  async importZip(@UploadedFile() file: UploadedZip | undefined, @Body() raw: Record<string, string>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    if (!file) throw new AppError('validation_failed', 'Fichier .zip manquant');
    const fields = z
      .object({ scope: SkillScopeSchema.default('personal'), skillId: z.uuid().optional(), name: SkillNameSchema.optional(), categoryId: z.uuid().optional() })
      .safeParse(raw);
    if (!fields.success) throw new AppError('validation_failed', 'Paramètres d’import invalides');
    // Markdown uniquement : scripts, binaires et images de l'archive sont ignorés (et signalés).
    const { files: md, ignored } = toSkillFiles(readZip(file.buffer));
    if (!md.some((f) => f.path === 'SKILL.md')) throw new AppError('validation_failed', 'Archive refusée : SKILL.md absent (à la racine ou dans un unique dossier racine)');
    const files = resolveSkillFiles(md);
    if (fields.data.skillId) {
      const s = await this.visible(user, fields.data.skillId);
      await this.assertManage(user, s);
      return { ...(await this.replaceContent(user, s, files)), ignored };
    }
    const fmName = readFrontmatter(files[0].content).name;
    const fallback = file.originalname.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const name = fields.data.name ?? (fmName && SkillNameSchema.safeParse(fmName).success ? fmName : fallback);
    if (!SkillNameSchema.safeParse(name).success) throw new AppError('validation_failed', `Nom de skill invalide : « ${name} » (minuscules, chiffres, tirets)`);
    return { ...(await this.createFrom(user, ctx, { name, scope: fields.data.scope, categoryId: fields.data.categoryId ?? null, files, source: `zip:${file.originalname.slice(0, 200)}` })), ignored };
  }

  /** Export .zip (arborescence markdown). */
  @Get(':skillId/export')
  async exportZip(@Param('skillId', uuid) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const s = await this.visible(user, id);
    const v = await this.content(s);
    const zip = writeZip((v?.files ?? []).filter(isMarkdownFile).map((f) => ({ path: f.path, data: Buffer.from(f.content, 'utf8') })), s.name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${s.name}.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(zip);
  }

  /**
   * Activation : `personal` = choix de l'utilisateur (prioritaire), `global` = activé par défaut
   * pour tous (administrateur).
   */
  @Put(':skillId/installation')
  async install(
    @Param('skillId', uuid) id: string,
    @Body({ schema: z.object({ scope: SkillScopeSchema, enabled: z.boolean() }) }) body: { scope: 'global' | 'personal'; enabled: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    const s = await this.visible(user, id);
    if (body.scope === 'global' && (user.platformRole !== 'platform_admin' || s.scope !== 'global')) throw new AppError('forbidden', 'Réservé aux administrateurs, pour un skill global');
    const subjectId = body.scope === 'global' ? null : user.id;
    const [existing] = await this.db
      .select({ id: skillInstallations.id })
      .from(skillInstallations)
      .where(and(eq(skillInstallations.skillId, id), eq(skillInstallations.scope, body.scope), subjectId ? eq(skillInstallations.subjectId, subjectId) : isNull(skillInstallations.subjectId)));
    if (existing) await this.db.update(skillInstallations).set({ enabled: body.enabled }).where(eq(skillInstallations.id, existing.id));
    else await this.db.insert(skillInstallations).values({ skillId: id, scope: body.scope, subjectId, enabled: body.enabled, createdBy: user.id });
    await this.audit.record({ actorId: user.id, action: 'skill.installation', targetType: 'skill', targetId: id, metadata: body });
    return { ok: true };
  }
}
