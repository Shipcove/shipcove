import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { conversationShares, conversations, workspaces, type Database } from '@cap/database';
import { AppError, DB } from '@cap/server-core';
import type { AuthUser } from '../common/request.js';

/**
 * Point unique de contrôle d'accès (SPEC §5, §23). Chaque contrôleur l'appelle pour chaque
 * ressource ; l'interface Angular n'est jamais considérée comme une barrière.
 *
 * Règles clés :
 * - Chaque conversation (workspace) appartient à un utilisateur ; elle est privée, y compris vis-à-vis
 *   des administrateurs de la plateforme.
 * - Un partage nominatif READ donne la lecture à un autre utilisateur, révocable à tout moment.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Accès propriétaire (seul autorisé à lancer Pi, modifier, approuver). */
  async requireWorkspaceOwner(user: AuthUser, workspaceId: string) {
    const [w] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
    if (!w || w.ownerId !== user.id) throw new AppError('not_found', 'Conversation introuvable');
    return w;
  }

  /** Lecture : propriétaire, ou destinataire d'un partage actif. */
  async requireWorkspaceRead(user: AuthUser, workspaceId: string) {
    const [w] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
    if (!w) throw new AppError('not_found', 'Conversation introuvable');
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
    if (!share) throw new AppError('not_found', 'Conversation introuvable');
    return { workspace: w, access: 'shared_read' as const };
  }
}
