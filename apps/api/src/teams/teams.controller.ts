import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AddTeamMemberSchema,
  CreateInvitationSchema,
  CreateTeamSchema,
  UpdateTeamMemberSchema,
  UpdateTeamSchema,
  type CreateInvitation,
  type CreateTeam,
  type InvitationDto,
  type TeamDto,
  type TeamMemberDto,
  type UserSummaryDto,
} from '@cap/contracts';
import { invitations, projects, teamMembers, teams, users, type Database } from '@cap/database';
import { AppError, AuditService, DB, ENV, NotificationService, randomToken, sha256Hex } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import type { ApiEnv } from '../env.js';

const uuid = { schema: z.uuid() };

@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<TeamDto[]> {
    const rows = await this.db
      .select({
        team: teams,
        myRole: teamMembers.role,
        memberCount: sql<number>`(select count(*)::int from team_members m where m.team_id = ${teams.id})`,
        projectCount: sql<number>`(select count(*)::int from projects p where p.team_id = ${teams.id} and p.deleted_at is null)`,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, user.id), isNull(teams.deletedAt)))
      .orderBy(teams.name);
    return rows.map((r) => this.toDto(r.team, r.myRole, r.memberCount, r.projectCount));
  }

  /** Création d'équipe : réservée aux administrateurs plateforme (gouvernance entreprise). */
  @PlatformAdmin()
  @Post()
  async create(@Body({ schema: CreateTeamSchema }) body: CreateTeam, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<TeamDto> {
    const team = await this.db.transaction(async (tx) => {
      const [exists] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.slug, body.slug));
      if (exists) throw new AppError('conflict', 'Identifiant d’équipe déjà utilisé');
      const [t] = await tx.insert(teams).values({ ...body, createdBy: user.id }).returning();
      await tx.insert(teamMembers).values({ teamId: t.id, userId: user.id, role: 'team_admin' });
      await this.audit.record({ actorId: user.id, action: 'team.create', targetType: 'team', targetId: t.id, ip: ctx.ip }, tx);
      return t;
    });
    return this.toDto(team, 'team_admin', 1, 0);
  }

  @Get(':teamId')
  async get(@Param('teamId', uuid) teamId: string, @CurrentUser() user: AuthUser): Promise<TeamDto> {
    const role = await this.access.requireTeamMember(user, teamId);
    const [t] = await this.db.select().from(teams).where(eq(teams.id, teamId));
    const [{ m }] = await this.db.select({ m: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
    const [{ p }] = await this.db.select({ p: count() }).from(projects).where(and(eq(projects.teamId, teamId), isNull(projects.deletedAt)));
    return this.toDto(t, role, m, p);
  }

  @Patch(':teamId')
  async update(
    @Param('teamId', uuid) teamId: string,
    @Body({ schema: UpdateTeamSchema }) body: Partial<CreateTeam>,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    await this.access.requireTeamAdmin(user, teamId);
    const [t] = await this.db.update(teams).set({ ...body, updatedAt: new Date() }).where(eq(teams.id, teamId)).returning();
    await this.audit.record({ actorId: user.id, action: 'team.update', targetType: 'team', targetId: teamId, ip: ctx.ip, metadata: body });
    return this.get(t.id, user).catch(() => this.toDto(t, null, 0, 0));
  }

  @Get(':teamId/members')
  async members(@Param('teamId', uuid) teamId: string, @CurrentUser() user: AuthUser): Promise<TeamMemberDto[]> {
    await this.access.requireTeamMember(user, teamId);
    const rows = await this.db
      .select({ m: teamMembers, u: users })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(users.displayName);
    return rows.map(({ m, u }) => ({
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  @Post(':teamId/members')
  @HttpCode(204)
  async addMember(
    @Param('teamId', uuid) teamId: string,
    @Body({ schema: AddTeamMemberSchema }) body: z.infer<typeof AddTeamMemberSchema>,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.access.requireTeamAdmin(user, teamId);
    const [u] = await this.db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, body.userId));
    if (!u || u.status === 'deleted') throw new AppError('not_found', 'Utilisateur introuvable');
    await this.db
      .insert(teamMembers)
      .values({ teamId, userId: body.userId, role: body.role })
      .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role: body.role } });
    await this.audit.record({ actorId: user.id, action: 'team.member_add', targetType: 'team', targetId: teamId, ip: ctx.ip, metadata: body });
  }

  @Patch(':teamId/members/:userId')
  @HttpCode(204)
  async updateMember(
    @Param('teamId', uuid) teamId: string,
    @Param('userId', uuid) userId: string,
    @Body({ schema: UpdateTeamMemberSchema }) body: { role: 'team_admin' | 'member' },
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.access.requireTeamAdmin(user, teamId);
    if (body.role === 'member') await this.ensureAnotherAdmin(teamId, userId);
    const res = await this.db
      .update(teamMembers)
      .set({ role: body.role })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .returning();
    if (res.length === 0) throw new AppError('not_found', 'Membre introuvable');
    await this.audit.record({ actorId: user.id, action: 'team.member_role', targetType: 'team', targetId: teamId, ip: ctx.ip, metadata: { userId, ...body } });
  }

  /**
   * Retrait d'un membre : ses partages reçus deviennent inopérants immédiatement
   * (l'appartenance est vérifiée à chaque accès).
   */
  @Delete(':teamId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Param('teamId', uuid) teamId: string,
    @Param('userId', uuid) userId: string,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ) {
    if (userId !== user.id) await this.access.requireTeamAdmin(user, teamId);
    await this.ensureAnotherAdmin(teamId, userId);
    await this.db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    await this.audit.record({ actorId: user.id, action: 'team.member_remove', targetType: 'team', targetId: teamId, ip: ctx.ip, metadata: { userId } });
  }

  @Post(':teamId/invitations')
  async invite(
    @Param('teamId', uuid) teamId: string,
    @Body({ schema: CreateInvitationSchema }) body: CreateInvitation,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<InvitationDto> {
    await this.access.requireTeamAdmin(user, teamId);
    const [existing] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.email}`);
    if (existing) {
      // Utilisateur existant : ajout direct + notification (pas de fusion automatique d'identité).
      await this.db.insert(teamMembers).values({ teamId, userId: existing.id, role: body.role }).onConflictDoNothing();
      const [t] = await this.db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
      await this.notifications.notify({
        userId: existing.id,
        type: 'invitation',
        title: `Vous avez été ajouté à l’équipe ${t.name}`,
        body: `${user.displayName} vous a ajouté à l’équipe ${t.name}.`,
        link: `/teams/${teamId}`,
      });
      await this.audit.record({ actorId: user.id, action: 'team.member_add', targetType: 'team', targetId: teamId, ip: ctx.ip, metadata: { userId: existing.id } });
    }
    const token = randomToken(32);
    const [inv] = await this.db
      .insert(invitations)
      .values({
        email: body.email,
        tokenHash: sha256Hex(token),
        teamId,
        role: body.role,
        invitedBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        acceptedAt: existing ? new Date() : null,
        acceptedBy: existing?.id ?? null,
      })
      .returning();
    if (!existing) {
      const [t] = await this.db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
      await this.notifications.sendEmail({
        to: body.email,
        template: 'auth.invitation',
        vars: { inviter: user.displayName, team: t.name, link: `${this.env.PUBLIC_URL}/auth/register?invitation=${token}` },
        idempotencyKey: `invite:${inv.id}`,
      });
    }
    await this.audit.record({ actorId: user.id, action: 'team.invite', targetType: 'team', targetId: teamId, ip: ctx.ip, metadata: { email: body.email } });
    return this.invitationDto(inv);
  }

  @Get(':teamId/invitations')
  async invitations(@Param('teamId', uuid) teamId: string, @CurrentUser() user: AuthUser): Promise<InvitationDto[]> {
    await this.access.requireTeamAdmin(user, teamId);
    const rows = await this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.teamId, teamId), isNull(invitations.revokedAt)))
      .orderBy(sql`${invitations.createdAt} desc`);
    return rows.map((r) => this.invitationDto(r));
  }

  @Delete(':teamId/invitations/:id')
  @HttpCode(204)
  async revokeInvitation(@Param('teamId', uuid) teamId: string, @Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.access.requireTeamAdmin(user, teamId);
    await this.db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, id), eq(invitations.teamId, teamId)));
    await this.audit.record({ actorId: user.id, action: 'team.invitation_revoke', targetType: 'invitation', targetId: id });
  }

  private async ensureAnotherAdmin(teamId: string, userId: string) {
    const admins = await this.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'team_admin')));
    if (admins.length === 1 && admins[0].userId === userId) {
      throw new AppError('conflict', 'L’équipe doit conserver au moins un administrateur');
    }
  }

  private toDto(t: typeof teams.$inferSelect, role: 'team_admin' | 'member' | null, memberCount: number, projectCount: number): TeamDto {
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      myRole: role,
      memberCount: Number(memberCount),
      projectCount: Number(projectCount),
      createdAt: t.createdAt.toISOString(),
    };
  }

  private invitationDto(r: typeof invitations.$inferSelect): InvitationDto {
    return {
      id: r.id,
      email: r.email,
      teamId: r.teamId,
      role: r.role,
      expiresAt: r.expiresAt.toISOString(),
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

/** Annuaire minimal pour le partage nominatif et l'ajout de membres. */
@ApiTags('users')
@Controller('users')
export class UsersDirectoryController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  /** Recherche limitée aux membres d'une équipe dont le demandeur fait partie. */
  @Get('search/:teamId/:q')
  async search(@Param('teamId', uuid) teamId: string, @Param('q', { schema: z.string().min(2).max(100) }) q: string, @CurrentUser() user: AuthUser): Promise<UserSummaryDto[]> {
    const role = await this.access.teamRole(user.id, teamId);
    const isAdmin = user.platformRole === 'platform_admin' || role === 'team_admin';
    if (!role && !isAdmin) throw new AppError('not_found', 'Équipe introuvable');
    const pattern = `%${q.replace(/[%_]/g, '')}%`;
    const base = this.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users);
    const rows = isAdmin
      ? await base.where(and(eq(users.status, 'active'), or(ilike(users.username, pattern), ilike(users.displayName, pattern), ilike(users.email, pattern)))).limit(20)
      : await base
          .innerJoin(teamMembers, and(eq(teamMembers.userId, users.id), eq(teamMembers.teamId, teamId)))
          .where(and(eq(users.status, 'active'), or(ilike(users.username, pattern), ilike(users.displayName, pattern))))
          .limit(20);
    return rows;
  }
}
