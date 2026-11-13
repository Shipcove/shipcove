import type { Readable, Writable } from 'node:stream';

/**
 * Abstraction interchangeable des environnements d'exécution isolés (SPEC §10, §22).
 * Implémentations v1 : conteneurs Docker et Pods Kubernetes. Une implémentation microVM
 * pourra être ajoutée sans changer les appelants.
 *
 * IMPORTANT : `exec` est une API **interne d'orchestration** (worker uniquement). Aucun
 * endpoint utilisateur ne l'expose (SPEC §7 : pas de terminal interactif).
 */
export interface SandboxResources {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  pidsLimit: number;
}

export interface SandboxSpec {
  /** Identifiant de l'instance (`sandbox_instances.id`). */
  instanceId: string;
  workspaceId: string;
  ownerId: string;
  image: string;
  resources: SandboxResources;
  /** Variables d'environnement non sensibles du conteneur. */
  env: Record<string, string>;
  labels?: Record<string, string>;
}

export interface SandboxHandle {
  provider: 'docker' | 'kubernetes';
  /** Identifiant externe (id de conteneur, nom de Pod). */
  externalId: string;
  /** Adresse interne joignable par la preview gateway (IP ou DNS). */
  internalHost: string | null;
}

export interface SandboxInfo extends SandboxHandle {
  state: 'creating' | 'running' | 'stopped' | 'missing' | 'failed';
  startedAt: string | null;
  exitCode: number | null;
}

export interface ExecOptions {
  /** Flux écrit sur stdin du processus (fermé à la fin). */
  stdin?: Readable | Buffer | string;
  /** Garder stdin ouvert pour un dialogue (ex. Pi RPC). */
  interactive?: boolean;
  env?: Record<string, string>;
  workdir?: string;
  user?: string;
  /** Délai max (ms) ; le processus est tué au-delà. */
  timeoutMs?: number;
}

export interface ExecProcess {
  stdout: Readable;
  stderr: Readable;
  /** Présent si `interactive` : écriture sur stdin. */
  stdin: Writable | null;
  /** Résout le code de sortie. */
  wait(): Promise<number>;
  /** Termine le processus (best effort). */
  kill(): Promise<void>;
}

export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface SandboxProvider {
  readonly kind: 'docker' | 'kubernetes';
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<SandboxHandle>;
  inspect(handle: SandboxHandle): Promise<SandboxInfo>;
  /** Exécution interne en flux. */
  exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): Promise<ExecProcess>;
  /** Port interne joignable (preview) : renvoie l'URL cible côté réseau sandbox. */
  portTarget(handle: SandboxHandle, port: number): Promise<{ host: string; port: number }>;
  stop(handle: SandboxHandle, graceMs?: number): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  /** Sandboxes existantes connues du moteur (réconciliation après panne). */
  list(): Promise<Array<{ externalId: string; instanceId: string | null; workspaceId: string | null }>>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/** Exécute une commande et collecte stdout/stderr (bornés). */
export async function execCollect(
  provider: SandboxProvider,
  handle: SandboxHandle,
  argv: string[],
  opts: ExecOptions & { maxBytes?: number } = {},
): Promise<ExecResult> {
  const proc = await provider.exec(handle, argv, opts);
  const max = opts.maxBytes ?? 64 * 1024 * 1024;
  const collect = (s: Readable) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      s.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= max) chunks.push(c);
      });
      s.on('end', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    });
  const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()]);
  return { exitCode, stdout, stderr };
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export const SANDBOX_LABEL = 'cap.sandbox';
export const SANDBOX_USER = '10001:10001';
