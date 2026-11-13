/**
 * Abstraction de gestion des secrets (SPEC §12, §22).
 *
 * PostgreSQL ne conserve que des **références** (`SecretRef`), jamais les valeurs.
 * Format d'une référence : `<backend>:<chemin logique>` — ex. `vault:git-connections/<id>`.
 */
export type SecretRef = string;

export type SecretData = Record<string, string>;

export interface SecretHealth {
  ok: boolean;
  backend: string;
  sealed?: boolean;
  version?: string;
  detail?: string;
}

export interface SecretMetadata {
  ref: SecretRef;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  keys?: string[];
}

export interface SecretProvider {
  readonly backend: string;
  /** Construit une référence pour un chemin logique (sans écrire). */
  reference(path: string): SecretRef;
  /** Écrit (ou crée une nouvelle version) et renvoie la référence. */
  write(path: string, data: SecretData): Promise<SecretRef>;
  /** Lit la dernière version, pour une identité de service autorisée. */
  read(ref: SecretRef): Promise<SecretData>;
  /** Lit une seule clé. */
  readKey(ref: SecretRef, key: string): Promise<string | undefined>;
  /** Métadonnées sans divulgation des valeurs (console d'administration). */
  metadata(ref: SecretRef): Promise<SecretMetadata | null>;
  /** Rotation : nouvelle version ; les anciennes restent consultables jusqu'à la purge. */
  rotate(ref: SecretRef, data: SecretData): Promise<SecretMetadata>;
  /** Révocation définitive (suppression de toutes les versions). */
  revoke(ref: SecretRef): Promise<void>;
  health(): Promise<SecretHealth>;
}

export class SecretBackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SecretBackendError';
  }
}

export class SecretNotFoundError extends Error {
  constructor(ref: string) {
    super(`Secret introuvable : ${ref}`);
    this.name = 'SecretNotFoundError';
  }
}

const PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,400}$/;

export function assertSecretPath(path: string): void {
  if (!PATH_RE.test(path) || path.includes('..') || path.includes('//')) {
    throw new Error(`Chemin de secret invalide : ${path}`);
  }
}

export function parseRef(ref: SecretRef, expectedBackend: string): string {
  const idx = ref.indexOf(':');
  if (idx <= 0) throw new Error(`Référence de secret invalide`);
  const backend = ref.slice(0, idx);
  const path = ref.slice(idx + 1);
  if (backend !== expectedBackend) {
    throw new Error(`Référence de secret pour un autre backend (${backend})`);
  }
  assertSecretPath(path);
  return path;
}
