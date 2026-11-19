import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, safeEqual } from '@cap/server-core';
import { ALLOW_PENDING_MFA, IS_PUBLIC, PLATFORM_ADMIN, SKIP_CSRF } from '../common/decorators.js';
import type { AppRequest } from '../common/request.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Garde globale : session, état MFA, CSRF (en-tête lié à la session) et rôle administrateur.
 * Toute route est protégée par défaut ; `@Public()` doit être explicite.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const handlers = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers);
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = await this.sessions.load(token);

    if (session) {
      req.session = { id: session.id, state: session.state, csrfToken: session.csrfToken, userId: session.user.id };
      if (session.state === 'active') {
        req.user = {
          id: session.user.id,
          email: session.user.email,
          username: session.user.username,
          displayName: session.user.displayName,
          platformRole: session.user.platformRole,
          sessionId: session.id,
          mfaVerified: !!session.mfaVerifiedAt,
        };
      }
    }

    // CSRF : toute méthode non sûre portée par un cookie de session exige l'en-tête.
    if (!SAFE_METHODS.has(req.method) && session && !this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, handlers)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, session.csrfToken)) {
        throw new AppError('csrf_invalid', 'Jeton CSRF absent ou invalide');
      }
    }

    // Requêtes publiques sans session (connexion, inscription…) : le jeton CSRF n'existe pas
    // encore. On exige qu'elles viennent de l'application elle-même, sinon un formulaire caché
    // sur un autre site (ou une preview) connecterait la victime au compte de l'attaquant.
    if (!SAFE_METHODS.has(req.method) && !session && !this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, handlers) && !isSameOrigin(req)) {
      throw new AppError('csrf_invalid', 'Requête refusée : elle ne vient pas de l’application');
    }

    if (isPublic) return true;
    if (!session) throw new AppError('unauthenticated', 'Authentification requise');
    if (session.state !== 'active') {
      if (this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, handlers)) return true;
      throw new AppError('mfa_required', 'Second facteur requis', { state: session.state });
    }
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, handlers) && req.user!.platformRole !== 'platform_admin') {
      throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    }
    return true;
  }
}

/**
 * Requête émise par l'application : `Sec-Fetch-Site` (navigateurs récents) vaut `same-origin` ou
 * `none` ; à défaut, l'en-tête `Origin` désigne le même hôte. Sans aucun des deux (client non
 * navigateur), la requête est acceptée : un navigateur envoie toujours `Origin` en cross-site.
 */
export function isSameOrigin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';
  const origin = req.headers['origin'];
  if (typeof origin !== 'string') return true;
  if (origin === 'null') return false;
  const fwd = req.headers['x-forwarded-host'];
  const host = (typeof fwd === 'string' ? fwd.split(',')[0].trim() : undefined) ?? req.headers['host'];
  try {
    // Noms d'hôte comparés sans le port : nginx transmet `Host` sans lui (`$host`).
    return typeof host === 'string' && new URL(origin).hostname.toLowerCase() === host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
}
