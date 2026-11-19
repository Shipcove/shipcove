import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CreateInvitationSchema, type CreateInvitation, type InvitationDto, type UserSummaryDto } from '@cap/contracts';
import { invitations, users, type Database } from '@cap/database';
import { AuditService, DB, ENV, NotificationService, randomToken, sha256Hex, type BaseEnv } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';

const uuid = { schema: z.uuid() };

/** Annuaire minimal pour le partage nominatif d'une conversation : utilisateurs actifs. */
@ApiTags('users')
@Controller('users')
export class UsersDirectoryController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('search')
  async search(@Query('q', { schema: z.string().min(2).max(100) }) q: string, @CurrentUser() user: AuthUser): Promise<UserSummaryDto[]> {
    const pattern = `%${q.replace(/[%_\\]/g, '')}%`;
    return this.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      // L'email ne se cherche qu'en entier : une recherche partielle permettrait de deviner les
      // adresses des autres utilisateurs.
      .where(and(eq(users.status, 'active'), ne(users.id, user.id), or(ilike(users.username, pattern), ilike(users.displayName, pattern), sql`lower(${users.email}) = ${q.trim().toLowerCase()}`)))
      .orderBy(users.displayName)
      .limit(20);
  }
}

/** Invitations à rejoindre la plateforme (administrateur). */
@ApiTags('admin')
@Controller('admin/invitations')
@PlatformAdmin()
export class AdminInvitationsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: BaseEnv,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private dto(r: typeof invitations.$inferSelect): InvitationDto {
    return { id: r.id, email: r.email, expiresAt: r.expiresAt.toISOString(), acceptedAt: r.acceptedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
  }

  @Get()
  async list(): Promise<InvitationDto[]> {
    const rows = await this.db.select().from(invitations).where(isNull(invitations.revokedAt)).orderBy(desc(invitations.createdAt)).limit(200);
    return rows.map((r) => this.dto(r));
  }

  @Post()
  async invite(@Body({ schema: CreateInvitationSchema }) body: CreateInvitation, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<InvitationDto> {
    const [existing] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    const token = randomToken(32);
    const [inv] = await this.db
      .insert(invitations)
      .values({
        email: body.email,
        tokenHash: sha256Hex(token),
        invitedBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        acceptedAt: existing ? new Date() : null,
        acceptedBy: existing?.id ?? null,
      })
      .returning();
    if (!existing) {
      await this.notifications.sendEmail({
        to: body.email,
        template: 'auth.invitation',
        vars: { inviter: user.displayName, link: `${this.env.PUBLIC_URL}/auth/register?invitation=${token}` },
        idempotencyKey: `invite:${inv.id}`,
      });
    }
    await this.audit.record({ actorId: user.id, action: 'admin.invite', targetType: 'invitation', targetId: inv.id, ip: ctx.ip, metadata: { email: body.email, existing: !!existing } });
    return this.dto(inv);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, id));
    await this.audit.record({ actorId: user.id, action: 'admin.invitation_revoke', targetType: 'invitation', targetId: id });
  }
}
