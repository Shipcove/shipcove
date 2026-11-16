/**
 * Cache LRU borné (en nombre d'entrées et, optionnellement, en poids), avec fusion des
 * chargements concurrents d'une même clé : N requêtes simultanées → un seul chargement.
 *
 * Prévu pour des valeurs immuables (objets adressés par contenu, manifestes d'une génération,
 * statistiques d'un couple de hachages) : aucune invalidation n'est nécessaire.
 */
export class ContentCache<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private readonly inflight = new Map<string, Promise<V>>();
  private weight = 0;

  constructor(
    private readonly opts: {
      maxEntries: number;
      /** Poids total maximal (ex. octets) ; illimité si absent. */
      maxWeight?: number;
      weigh?: (value: V) => number;
      /** Valeurs à ne pas conserver (ex. `null`, objets trop gros) ; elles restent fusionnées en vol. */
      shouldCache?: (value: V) => boolean;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Réinsertion : la Map garde l'ordre d'insertion, la première clé est la moins récente.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.opts.shouldCache && !this.opts.shouldCache(value)) return;
    const weight = this.opts.weigh?.(value) ?? 1;
    if (this.opts.maxWeight !== undefined && weight > this.opts.maxWeight) return;
    const prev = this.entries.get(key);
    if (prev) {
      this.weight -= prev.weight;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.entries.size > this.opts.maxEntries || (this.opts.maxWeight !== undefined && this.weight > this.opts.maxWeight)) {
      const oldest = this.entries.keys().next().value as string;
      this.weight -= this.entries.get(oldest)!.weight;
      this.entries.delete(oldest);
    }
  }

  /** Valeur en cache, chargement en cours partagé, ou nouveau chargement. */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
