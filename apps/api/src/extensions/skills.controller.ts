import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { CreateSkillSchema, SkillScopeSchema, type CreateSkill, type SkillDto } from '@cap/contracts';
import { skillInstallations, skillVersions, skills, teamMembers, type Database } from '@cap/database';
import { AppError, AuditService, DB, SettingsService, canonicalJson, sha256Hex } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';

const uuid = { schema: z.uuid() };

/**
 * Analyse statique des sources d'un skill. Un skill est un ensemble d'instructions : il ne confère
 * aucun privilège, mais l'analyse signale les contenus à risque pour la revue humaine.
 */
export function analyzeSkill(files: Array<{ path: string; content: string }>): string[] {
  const findings: string[] = [];
  const md = files.find((f) => f.path === 'SKILL.md');
  if (!md) findings.push('SKILL.md manquant');
  else if (!/^---\n[\s\S]*?name:\s*\S+[\s\S]*?description:\s*\S+[\s\S]*?\n---/.test(md.content)) findings.push('Frontmatter SKILL.md incomplet (name, description)');
  for (const f of files) {
    if (f.path.includes('..') || f.path.startsWith('/')) findings.push(`Chemin invalide : ${f.path}`);
    if (/\.(sh|py|js|ts|mjs|rb|pl)$/.test(f.path)) findings.push(`Script exécutable inclus : ${f.path}`);
    if (/curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh/.test(f.content)) findings.push(`Téléchargement exécuté (curl|sh) : ${f.path}`);
    if (/\brm\s+-rf\s+[/~]/.test(f.content)) findings.push(`Suppression récursive dangereuse : ${f.path}`);
    if (/(gh[pousr]_[A-Za-z0-9]{20,}|glpat-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(f.content)) findings.push(`Secret probable : ${f.path}`);
    if (/[A-Za-z0-9+/]{400,}={0,2}/.test(f.content)) findings.push(`Bloc encodé volumineux : ${f.path}`);
    if (/(ignore (all )?previous instructions|disregard .*instructions)/i.test(f.content)) findings.push(`Formulation d’injection de prompt : ${f.path}`);
    if (/git\s+push|platform_git_push/.test(f.content)) findings.push(`Mentionne une publication Git : ${f.path} (soumise à approbation)`);
  }
  return [...new Set(findings)];
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

  private async myTeams(userId: string): Promise<string[]> {
    return (await this.db.select({ t: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId))).map((r) => r.t);
  }

  /** Autorité sur un skill selon sa portée (global : admin plateforme ; équipe : admin d'équipe ; personnel : propriétaire). */
  private async assertManage(user: AuthUser, s: { scope: string; teamId: string | null; ownerId: string | null }) {
    if (s.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    if (s.scope === 'team') await this.access.requireTeamAdmin(user, s.teamId!);
    if (s.scope === 'personal' && s.ownerId !== user.id) throw new AppError('forbidden', 'Skill personnel d’un autre utilisateur');
  }

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<SkillDto[]> {
    const teams = await this.myTeams(user.id);
    const rows = await this.db
      .select()
      .from(skills)
      .where(or(eq(skills.scope, 'global'), and(eq(skills.scope, 'team'), teams.length ? inArray(skills.teamId, teams) : eq(skills.id, skills.id)), and(eq(skills.scope, 'personal'), eq(skills.ownerId, user.id))))
      .orderBy(skills.name);
    const visible = rows.filter((s) => s.scope !== 'team' || (s.teamId && teams.includes(s.teamId)));
    const installs = visible.length ? await this.db.select().from(skillInstallations).where(inArray(skillInstallations.skillId, visible.map((s) => s.id))) : [];
    const out: SkillDto[] = [];
    for (const s of visible) {
      if (s.status !== 'published' && !(await this.canManage(user, s))) continue;
      const [v] = await this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, s.id), eq(skillVersions.version, s.latestVersion)));
      const mine = installs.filter((i) => i.skillId === s.id && (i.scope === 'global' || (i.scope === 'team' && teams.includes(i.subjectId ?? '')) || (i.scope === 'personal' && i.subjectId === user.id)));
      out.push({
        id: s.id,
        name: s.name,
        description: s.description,
        scope: s.scope,
        teamId: s.teamId,
        ownerId: s.ownerId,
        status: s.status,
        latestVersion: s.latestVersion,
        digest: v?.digest ?? '',
        source: s.source,
        findings: v?.analysis.findings ?? [],
        createdAt: s.createdAt.toISOString(),
        enabledForMe: s.status === 'published' && !mine.some((i) => !i.enabled),
      });
    }
    return out;
  }

  private async canManage(user: AuthUser, s: { scope: string; teamId: string | null; ownerId: string | null }) {
    try {
      await this.assertManage(user, s);
      return true;
    } catch {
      return false;
    }
  }

  @Get(':skillId')
  async get(@Param('skillId', uuid) id: string, @CurrentUser() user: AuthUser) {
    const [s] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!s) throw new AppError('not_found', 'Skill introuvable');
    const teams = await this.myTeams(user.id);
    if ((s.scope === 'team' && !teams.includes(s.teamId!)) || (s.scope === 'personal' && s.ownerId !== user.id)) throw new AppError('not_found', 'Skill introuvable');
    const versions = await this.db.select().from(skillVersions).where(eq(skillVersions.skillId, id)).orderBy(desc(skillVersions.version));
    return { skill: s, versions: versions.map((v) => ({ version: v.version, digest: v.digest, findings: v.analysis.findings, createdAt: v.createdAt, files: v.files })) };
  }

  @Post()
  async create(@Body({ schema: CreateSkillSchema }) body: CreateSkill, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const cfg = await this.settings.section('skills');
    if (body.scope === 'personal' && !cfg.personalSkillsAllowed) throw new AppError('forbidden', 'Les skills personnels sont désactivés');
    if (body.scope === 'team' && !body.teamId) throw new AppError('validation_failed', 'teamId requis');
    const meta = { scope: body.scope, teamId: body.scope === 'team' ? body.teamId : null, ownerId: body.scope === 'personal' ? user.id : null };
    await this.assertManage(user, meta);
    const findings = analyzeSkill(body.files);
    // Skill personnel : publié directement sauf revue imposée ; autres portées : brouillon puis publication explicite.
    const status = body.scope === 'personal' ? (cfg.personalSkillsRequireReview ? 'pending_review' : 'published') : 'draft';
    const [s] = await this.db
      .insert(skills)
      .values({ name: body.name, description: body.description, ...meta, status, source: body.source ?? null, latestVersion: 1 })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') throw new AppError('conflict', 'Un skill porte déjà ce nom dans cette portée');
        throw err;
      });
    await this.db.insert(skillVersions).values({ skillId: s.id, version: 1, files: body.files, digest: sha256Hex(canonicalJson(body.files)), analysis: { findings, scannedAt: new Date().toISOString() }, createdBy: user.id });
    await this.audit.record({ actorId: user.id, action: 'skill.create', targetType: 'skill', targetId: s.id, ip: ctx.ip, metadata: { scope: body.scope, findings } });
    return { id: s.id, status, findings };
  }

  @Post(':skillId/versions')
  async newVersion(
    @Param('skillId', uuid) id: string,
    @Body({ schema: CreateSkillSchema.pick({ files: true, description: true }) }) body: Pick<CreateSkill, 'files' | 'description'>,
    @CurrentUser() user: AuthUser,
  ) {
    const [s] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!s) throw new AppError('not_found', 'Skill introuvable');
    await this.assertManage(user, s);
    if (s.status === 'revoked') throw new AppError('conflict', 'Skill révoqué');
    const version = s.latestVersion + 1;
    const findings = analyzeSkill(body.files);
    await this.db.insert(skillVersions).values({ skillId: id, version, files: body.files, digest: sha256Hex(canonicalJson(body.files)), analysis: { findings, scannedAt: new Date().toISOString() }, createdBy: user.id });
    await this.db.update(skills).set({ latestVersion: version, description: body.description, updatedAt: new Date() }).where(eq(skills.id, id));
    await this.audit.record({ actorId: user.id, action: 'skill.version', targetType: 'skill', targetId: id, metadata: { version, findings } });
    return { version, findings };
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

  /** Activation / désactivation pour soi, pour son équipe (admin d'équipe) ou globalement (admin). */
  @Put(':skillId/installation')
  async install(
    @Param('skillId', uuid) id: string,
    @Body({ schema: z.object({ scope: SkillScopeSchema, teamId: z.uuid().optional(), enabled: z.boolean(), pinnedVersion: z.number().int().positive().nullable().optional() }) })
    body: { scope: 'global' | 'team' | 'personal'; teamId?: string; enabled: boolean; pinnedVersion?: number | null },
    @CurrentUser() user: AuthUser,
  ) {
    if (body.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs');
    if (body.scope === 'team') await this.access.requireTeamAdmin(user, body.teamId!);
    const subjectId = body.scope === 'global' ? null : body.scope === 'team' ? body.teamId! : user.id;
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
