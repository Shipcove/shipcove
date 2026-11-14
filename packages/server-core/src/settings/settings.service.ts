import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { PlatformSettingsSchema, type PlatformSettings } from '@cap/contracts';
import { platformSettings, type Database } from '@cap/database';
import { DB } from '../tokens.js';
import { AppError } from '../common/errors.js';
import { PgNotifier } from '../events/pg-notifier.js';

type Section = keyof PlatformSettings;

/**
 * Paramètres plateforme versionnés, en cache par instance.
 * Une modification est notifiée (NOTIFY `cap_settings`, dans la transaction) à toutes les
 * instances (API, worker, gateway), qui invalident immédiatement leur cache : un réglage de
 * sécurité (connexion locale, édition manuelle…) ne reste pas actif ailleurs après sa désactivation.
 * Le TTL ne sert que de filet de sécurité (perte de connexion LISTEN : invalidation à la reconnexion).
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private cache: { at: number; value: PlatformSettings } | null = null;
  private static readonly TTL_MS = 30_000;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifier: PgNotifier,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.notifier.on('cap_settings', () => this.invalidate());
  }

  async get(): Promise<PlatformSettings> {
    if (this.cache && Date.now() - this.cache.at < SettingsService.TTL_MS) return this.cache.value;
    const rows = await this.db.select().from(platformSettings).where(eq(platformSettings.active, true));
    const raw: Record<string, unknown> = {};
    for (const r of rows) raw[r.section] = r.values;
    const value = PlatformSettingsSchema.parse(raw);
    this.cache = { at: Date.now(), value };
    return value;
  }

  async section<S extends Section>(s: S): Promise<PlatformSettings[S]> {
    return (await this.get())[s];
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Met à jour une section (nouvelle version) ; validation complète contre le schéma. */
  async update<S extends Section>(section: S, patch: Record<string, unknown>, actorId: string): Promise<PlatformSettings[S]> {
    const current = await this.get();
    const merged = { ...current, [section]: { ...(current[section] as object), ...patch } };
    const parsed = PlatformSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Paramètres invalides', parsed.error.issues);
    }
    const values = parsed.data[section] as Record<string, unknown>;
    await this.db.transaction(async (tx) => {
      const [{ v }] = await tx
        .select({ v: sql<number>`coalesce(max(${platformSettings.version}), 0)` })
        .from(platformSettings)
        .where(eq(platformSettings.section, section));
      await tx
        .update(platformSettings)
        .set({ active: false })
        .where(and(eq(platformSettings.section, section), eq(platformSettings.active, true)));
      await tx.insert(platformSettings).values({ section, values, version: Number(v) + 1, updatedBy: actorId });
      // Délivré aux autres instances à la validation de la transaction.
      await tx.execute(sql`select pg_notify('cap_settings', ${section})`);
    });
    this.invalidate();
    return parsed.data[section];
  }
}
