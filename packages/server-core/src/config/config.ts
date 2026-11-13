import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/**
 * Configuration d'environnement commune. Aucun secret ici : les secrets sont lus dans Vault
 * (sauf l'identité machine Vault elle-même, fournie par fichiers montés).
 */
export const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  INSTANCE_ID: z.string().default(`${hostname()}-${randomBytes(3).toString('hex')}`),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Appliquer les migrations au démarrage (désactiver en Kubernetes : Job dédié). */
  DATABASE_MIGRATE_ON_START: bool.default(false),

  VAULT_ADDR: z.url(),
  VAULT_AUTH_METHOD: z.enum(['approle', 'kubernetes', 'token']).default('approle'),
  VAULT_ROLE_ID_FILE: z.string().optional(),
  VAULT_SECRET_ID_FILE: z.string().optional(),
  VAULT_K8S_ROLE: z.string().optional(),
  /** Uniquement NODE_ENV=test/development. */
  VAULT_TOKEN: z.string().optional(),
  VAULT_KV_MOUNT: z.string().default('cap'),
  VAULT_NAMESPACE: z.string().optional(),

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().default('cap-workspaces'),
  S3_ATTACHMENTS_BUCKET: z.string().default('cap-attachments'),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** Référence Vault des identifiants S3 (clés `accessKeyId`, `secretAccessKey`). */
  S3_CREDENTIALS_REF: z.string().default('vault:infra/s3'),

  LITELLM_URL: z.url().default('http://litellm:4000'),
  LITELLM_MASTER_KEY_REF: z.string().default('vault:infra/litellm'),

  /** Origine publique de l'application (Angular + API). */
  PUBLIC_URL: z.url().default('http://localhost:4200'),
  /** Domaine des previews (origine distincte), ex. `preview.example.com`. */
  PREVIEW_DOMAIN: z.string().default('preview.localhost'),
  PREVIEW_PUBLIC_SCHEME: z.enum(['http', 'https']).default('http'),
  PREVIEW_PUBLIC_PORT: z.coerce.number().int().optional(),
  /** Clé HMAC des jetons de preview (référence Vault, clé `key`). */
  PREVIEW_SIGNING_KEY_REF: z.string().default('vault:infra/preview'),
});
export type BaseEnv = z.infer<typeof BaseEnvSchema>;

export function loadEnv<S extends z.ZodType>(schema: S, source: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${issues}`);
  }
  const env = parsed.data as BaseEnv;
  if (env.NODE_ENV === 'production' && env.VAULT_AUTH_METHOD === 'token') {
    throw new Error('VAULT_AUTH_METHOD=token interdit en production (utiliser approle ou kubernetes)');
  }
  return parsed.data;
}

export const ENV = Symbol('CAP_ENV');
