import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { AppRequest, AuthUser } from './request.js';

export const IS_PUBLIC = 'cap:public';
/** Route accessible sans session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING_MFA = 'cap:allow-pending-mfa';
/** Route accessible pendant l'étape MFA (session `pending_mfa`). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);

export const SKIP_CSRF = 'cap:skip-csrf';
/** Exemption CSRF (callbacks SSO en POST provenant de l'IdP, ex. SAML). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export const PLATFORM_ADMIN = 'cap:platform-admin';
/** Réservé aux administrateurs plateforme (vérifié côté API). */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return req.user!;
});

export const ReqCtx = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.correlationId,
  };
});
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
}
