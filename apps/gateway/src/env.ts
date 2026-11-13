import { z } from 'zod';
import { BaseEnvSchema, loadEnv, resolveFileVars } from '@cap/server-core';

export const GatewayEnvSchema = BaseEnvSchema.extend({
  PORT: z.coerce.number().int().default(8081),
  /** Proxy d'egress HTTP(S) des sandboxes. */
  EGRESS_PORT: z.coerce.number().int().default(3128),
  /** Résoudre et refuser les adresses privées / internes (anti-SSRF). Désactivable uniquement en test. */
  EGRESS_BLOCK_PRIVATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** URL publique de la gateway vue depuis les sandboxes (proxy Git en lecture). */
  GATEWAY_INTERNAL_URL: z.string().default('http://gateway:8081'),
});
export type GatewayEnv = z.infer<typeof GatewayEnvSchema>;
export const loadGatewayEnv = () => loadEnv(GatewayEnvSchema, resolveFileVars(process.env));
