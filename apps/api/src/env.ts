import { z } from 'zod';
import { BaseEnvSchema, loadEnv, resolveFileVars } from '@cap/server-core';

export const ApiEnvSchema = BaseEnvSchema.extend({
  PORT: z.coerce.number().int().default(3000),
  /** Proxies de confiance (pour l'IP client derrière le load balancer). */
  TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Délai max d'une opération synchrone déléguée au worker (ms). */
  SANDBOX_RPC_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  /** Compte administrateur initial (créé si aucun admin n'existe). */
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
});
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export function loadApiEnv(): ApiEnv {
  return loadEnv(ApiEnvSchema, resolveFileVars(process.env));
}
