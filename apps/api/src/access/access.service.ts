import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  conversationShares,
  conversations,
  projectMembers,
  projects,
  teamMembers,
  teams,
  workspaces,
  type Database,
} from '@cap/database';
import { AppError, DB } from '@cap/server-core';
import type { AuthUser } from '../common/request.js';

export type ProjectLevel = 'read' | 'write' | 'admin';

/**
 * Point unique de contrôle d'accès (SPEC §5, §23). Chaque contrôleur l'appelle pour chaque
 * ressource ; l'interface Angular n'est jamais considérée comme une barrière.
 *
 * Règles clés :
 * - Les projets sont partagés au sein de l'équipe ; les workspaces sont individuels.
 * - Les conversations sont privées, y compris vis-à-vis des administrateurs (équipe ou plateforme).
 * - Un partage nominatif READ n'est effectif que si le destinataire est **actuellement** membre
 *   de l'équipe du projet.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async teamRole(userId: string, teamId: string): Promise<'team_admin' | 'member' | null> {
    const [m] = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), isNull(teams.deletedAt)));
    return m?.role ?? null;
  }

  async requireTeamMember(user: AuthUser, teamId: string): Promise<'team_admin' | 'member'> {
    const role = await this.teamRole(user.id, teamId);
    if (!role) throw new AppError('not_found', 'Équipe introuvable');
    return role;
  }

  /** Administration de la structure d'une équipe : admin d'équipe ou admin plateforme. */
  async requireTeamAdmin(user: AuthUser, teamId: string): Promise<void> {
    if (user.platformRole === 'platform_admin') {
      const [t] = await this.db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), isNull(teams.deletedAt)));
      if (!t) throw new AppError('not_found', 'Équipe introuvable');
      return;
    }
    const role = await this.teamRole(user.id, teamId);
    if (!role) throw new AppError('not_found', 'Équipe introuvable');
    if (role !== 'team_admin') throw new AppError('forbidden', 'Réservé aux administrateurs de l’équipe');
  }

  async requireProject(user: AuthUser, projectId: string, level: ProjectLevel) {
    const [p] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
    if (!p) throw new AppError('not_found', 'Projet introuvable');
    const teamRole = await this.teamRole(user.id, p.teamId);
    if (!teamRole) throw new AppError('not_found', 'Projet introuvable');
    const [pm] = await this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)));
    const effective = teamRole === 'team_admin' ? 'admin' : pm?.role === 'viewer' ? 'read' : pm?.role === 'maintainer' ? 'admin' : 'write';
    const rank = { read: 0, write: 1, admin: 2 } as const;
    if (rank[effective] < rank[level]) throw new AppError('forbidden', 'Droits insuffisants sur ce projet');
    if (level !== 'read' && p.archivedAt) throw new AppError('conflict', 'Projet archivé');
    return p;
  }

  /** Accès propriétaire au workspace (seul autorisé à lancer Pi, modifier, approuver). */
  async requireWorkspaceOwner(user: AuthUser, workspaceId: string) {
    const [w] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
    if (!w || w.ownerId !== user.id) throw new AppError('not_found', 'Workspace introuvable');
    // L'appartenance à l'équipe reste requise (retrait de l'équipe = perte d'accès).
    if (!(await this.teamRole(user.id, w.teamId))) throw new AppError('not_found', 'Workspace introuvable');
    return w;
  }

  /** Lecture : propriétaire, ou destinataire d'un partage actif ET membre actuel de l'équipe. */
  async requireWorkspaceRead(user: AuthUser, workspaceId: string) {
    const [w] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
    if (!w) throw new AppError('not_found', 'Workspace introuvable');
    if (!(await this.teamRole(user.id, w.teamId))) throw new AppError('not_found', 'Workspace introuvable');
    if (w.ownerId === user.id) return { workspace: w, access: 'owner' as const };
    const [share] = await this.db
      .select({ id: conversationShares.id })
      .from(conversationShares)
      .innerJoin(conversations, eq(conversations.id, conversationShares.conversationId))
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversationShares.userId, user.id),
          isNull(conversationShares.revokedAt),
          isNull(conversations.deletedAt),
        ),
      );
    if (!share) throw new AppError('not_found', 'Workspace introuvable');
    return { workspace: w, access: 'shared_read' as const };
  }
}
