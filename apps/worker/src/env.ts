import { z } from 'zod';
import { BaseEnvSchema, loadEnv, resolveFileVars } from '@cap/server-core';

export const WorkerEnvSchema = BaseEnvSchema.extend({
  /** Port HTTP de santé / métriques (interne). */
  PORT: z.coerce.number().int().default(3001),
  SANDBOX_PROVIDER: z.enum(['docker', 'kubernetes']).default('docker'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /** Garde Docker (ADR 0014) : si défini, le worker n'utilise jamais le socket directement. */
  DOCKER_GUARD_URL: z.string().optional(),
  DOCKER_GUARD_TOKEN: z.string().min(32).optional(),
  SANDBOX_NETWORK: z.string().default('cap-sandbox'),
  /** Image officielle par défaut (si aucune image active en base). */
  SANDBOX_IMAGE: z.string().default('shipcove-sandbox:0.1.0'),
  SANDBOX_RUNTIME: z.string().optional(),
  K8S_NAMESPACE: z.string().default('cap-sandboxes'),
  K8S_RUNTIME_CLASS: z.string().optional(),
  /** Secrets de registre des Pods de sandbox (noms séparés par des virgules). */
  K8S_IMAGE_PULL_SECRETS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined)),
  /** Sélecteur de nœuds des sandboxes, en JSON (ex. {"shipcove.io/sandbox":"true"}). */
  K8S_NODE_SELECTOR: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      try {
        return z.record(z.string(), z.string()).parse(JSON.parse(v));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'K8S_NODE_SELECTOR : objet JSON de chaînes attendu' });
        return z.NEVER;
      }
    }),
  /** URL de la gateway vue depuis les sandboxes. */
  GATEWAY_INTERNAL_URL: z.string().default('http://gateway:8081'),
  EGRESS_PROXY_URL: z.string().default('http://gateway:3128'),
  /** Concurrence par file. */
  RUN_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(8),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(8),
  /** Répertoire temporaire du Git Broker (dépôts nus éphémères). */
  GIT_BROKER_TMP: z.string().default('/tmp/cap-git-broker'),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;
export const loadWorkerEnv = () => loadEnv(WorkerEnvSchema, resolveFileVars(process.env));
