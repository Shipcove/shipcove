import {
  SecretNotFoundError,
  assertSecretPath,
  parseRef,
  type SecretData,
  type SecretHealth,
  type SecretMetadata,
  type SecretProvider,
  type SecretRef,
} from './secret-provider.js';

/**
 * Implémentation en mémoire **réservée aux tests unitaires**.
 * Refuse de s'instancier si NODE_ENV=production.
 */
export class InMemorySecretProvider implements SecretProvider {
  readonly backend = 'memory';
  private readonly store = new Map<string, { versions: SecretData[]; createdAt: string; updatedAt: string }>();
  public available = true;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('InMemorySecretProvider interdit en production');
    }
  }

  reference(path: string): SecretRef {
    assertSecretPath(path);
    return `memory:${path}`;
  }

  private check(): void {
    if (!this.available) throw new Error('backend de secrets indisponible (simulation)');
  }

  async write(path: string, data: SecretData): Promise<SecretRef> {
    this.check();
    assertSecretPath(path);
    const now = new Date().toISOString();
    const entry = this.store.get(path);
    if (entry) {
      entry.versions.push({ ...data });
      entry.updatedAt = now;
    } else {
      this.store.set(path, { versions: [{ ...data }], createdAt: now, updatedAt: now });
    }
    return this.reference(path);
  }

  async read(ref: SecretRef): Promise<SecretData> {
    this.check();
    const entry = this.store.get(parseRef(ref, this.backend));
    if (!entry) throw new SecretNotFoundError(ref);
    return { ...entry.versions.at(-1)! };
  }

  async readKey(ref: SecretRef, key: string): Promise<string | undefined> {
    return (await this.read(ref))[key];
  }

  async metadata(ref: SecretRef): Promise<SecretMetadata | null> {
    const entry = this.store.get(parseRef(ref, this.backend));
    if (!entry) return null;
    return { ref, version: entry.versions.length, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }

  async rotate(ref: SecretRef, data: SecretData): Promise<SecretMetadata> {
    await this.write(parseRef(ref, this.backend), data);
    return (await this.metadata(ref))!;
  }

  async revoke(ref: SecretRef): Promise<void> {
    this.store.delete(parseRef(ref, this.backend));
  }

  async health(): Promise<SecretHealth> {
    return { ok: this.available, backend: this.backend };
  }
}
