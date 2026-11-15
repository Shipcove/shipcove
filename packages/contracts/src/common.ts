import { z } from 'zod';

/** Identifiant UUID (v7 côté serveur, ordonnable dans le temps). */
export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

/** Horodatage ISO-8601 UTC. */
export const TimestampSchema = z.iso.datetime({ offset: true });

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Montant décimal exact sérialisé en chaîne (jamais en number flottant). */
export const DecimalStringSchema = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,8})?$/, 'Décimal invalide (max 12 chiffres entiers, 8 décimales)');

/**
 * Codes d'erreur métier stables, renvoyés dans `error.code`.
 * Ne jamais renommer un code existant (compatibilité clients).
 */
export const ErrorCodes = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'csrf_invalid',
  'rate_limited',
  'mfa_required',
  'mfa_invalid',
  'invalid_credentials',
  'account_locked',
  'account_suspended',
  'email_not_verified',
  'registration_disabled',
  'provider_disabled',
  'run_already_active',
  'workspace_not_running',
  'workspace_busy',
  'quota_exceeded',
  'model_not_allowed',
  'editing_disabled',
  'edit_conflict',
  'precondition_required',
  'approval_expired',
  'approval_already_decided',
  'preview_limit_reached',
  'idempotency_conflict',
  'attachment_rejected',
  'secret_backend_unavailable',
  'storage_unavailable',
  'internal_error',
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    correlationId?: string;
    details?: unknown;
  };
}

export const PlatformRoleSchema = z.enum(['platform_admin', 'user']);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

