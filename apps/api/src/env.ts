import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BaseEnvSchema, loadEnv } from '@cap/server-core';

/** Résout les variables `X_FILE` (secrets Docker/Kubernetes montés en fichiers). */
export function resolveFileVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (k.endsWith('_FILE') && v && !out[k.slice(0, -5)]) {
      try {
        out[k.slice(0, -5)] = readFileSync(v, 'utf8').trim();
      } catch {
        /* laissé à la validation */
      }
    }
  }
  return out;
}

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
