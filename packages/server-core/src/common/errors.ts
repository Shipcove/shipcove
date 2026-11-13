import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@cap/contracts';

const STATUS: Partial<Record<ErrorCode, number>> = {
  validation_failed: HttpStatus.BAD_REQUEST,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  invalid_credentials: HttpStatus.UNAUTHORIZED,
  mfa_required: HttpStatus.UNAUTHORIZED,
  mfa_invalid: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  csrf_invalid: HttpStatus.FORBIDDEN,
  account_suspended: HttpStatus.FORBIDDEN,
  email_not_verified: HttpStatus.FORBIDDEN,
  registration_disabled: HttpStatus.FORBIDDEN,
  provider_disabled: HttpStatus.FORBIDDEN,
  editing_disabled: HttpStatus.FORBIDDEN,
  model_not_allowed: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  run_already_active: HttpStatus.CONFLICT,
  workspace_busy: HttpStatus.CONFLICT,
  workspace_not_running: HttpStatus.CONFLICT,
  approval_already_decided: HttpStatus.CONFLICT,
  idempotency_conflict: HttpStatus.CONFLICT,
  approval_expired: HttpStatus.GONE,
  edit_conflict: HttpStatus.PRECONDITION_FAILED,
  precondition_required: HttpStatus.PRECONDITION_REQUIRED,
  account_locked: HttpStatus.TOO_MANY_REQUESTS,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  quota_exceeded: HttpStatus.PAYMENT_REQUIRED,
  preview_limit_reached: HttpStatus.CONFLICT,
  attachment_rejected: HttpStatus.UNPROCESSABLE_ENTITY,
  secret_backend_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  storage_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  internal_error: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Erreur métier à code stable (sérialisée par le filtre global). */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super({ error: { code, message, details } }, status ?? STATUS[code] ?? HttpStatus.BAD_REQUEST);
  }
}

export const notFound = (what = 'Ressource') => new AppError('not_found', `${what} introuvable`);
export const forbidden = (msg = 'Accès refusé') => new AppError('forbidden', msg);
