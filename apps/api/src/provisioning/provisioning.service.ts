import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AUTH_PROVIDER_CONFIG_SCHEMAS, AUTH_PROVIDER_SECRET_FIELDS, type PlatformSettings } from '@cap/contracts';
import { authProviders, gitForges, llmModels, type Database } from '@cap/database';
import type { SecretProvider } from '@cap/secrets';
import { AuditService, DB, ENV, LiteLlmClient, SECRETS, SettingsService, resolveFileVars } from '@cap/server-core';
import type { RequestContext } from '../common/decorators.js';
import type { ApiEnv } from '../env.js';
import { FederationService } from '../auth/providers/federation.service.js';
import { GitForgesService } from '../git/git-forges.controller.js';
import { isEmpty, parseProvisioning, ProvisioningError, type ProvisionedAuthProvider, type Provisioning } from './provisioning-env.js';

const CONFIG_LOCK = 7212024010;
const MODELS_LOCK = 7212024011;
const SMTP_REF = 'vault:infra/smtp';
/** LiteLLM peut démarrer après l'API : nouvelles tentatives pendant ~15 min. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, ...Array.from({ length: 28 }, () => 30_000)];

const CTX: RequestContext = { ip: null, userAgent: null, correlationId: 'provisioning' };

/**
 * Applique au démarrage la configuration déclarée par variables d'environnement
 * (voir `provisioning-env.ts` et docs/operations/environment.md). Idempotent et sûr avec
 * plusieurs instances (verrou consultatif) ; rien n'est réécrit si la valeur est déjà en place.
 * Une configuration invalide empêche l'API de démarrer ; un LiteLLM injoignable non.
 */
@Injectable()
export class ProvisioningService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Provisioning');
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly litellm: LiteLlmClient,
    private readonly settings: SettingsService,
    private readonly federation: FederationService,
    private readonly forges: GitForgesService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Tests : chaque suite part d'une base connue (applyConfig / applyModels sont appelés directement).
    if (this.env.NODE_ENV === 'test') return;
    let p: Provisioning;
    try {
      p = parseProvisioning(resolveFileVars(process.env), this.env.LITELLM_URL);
    } catch (e) {
      if (e instanceof ProvisioningError) throw new Error(`Configuration par variables d'environnement refusée : ${e.message}`);
      throw e;
    }
    if (!isEmpty(p)) await this.applyConfig(p);
    if (p.litellm.syncOnStart || p.litellm.models.length || p.litellm.enable === '*' || p.litellm.enable.length || p.litellm.defaultModel || p.litellm.titleModel) {
      void this.withRetry('modèles LiteLLM', () => this.applyModels(p));
    }
    if (p.litellm.syncIntervalMinutes > 0) {
      const t = setInterval(() => {
        this.litellm.syncModels(null).catch((e: Error) => this.logger.warn(`Synchronisation périodique des modèles : ${e.message}`));
      }, p.litellm.syncIntervalMinutes * 60_000);
      t.unref();
      this.timers.push(t);
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /* --------------------- Configuration (base et Vault) --------------------- */

  async applyConfig(p: Provisioning): Promise<string[]> {
    const changes: string[] = [];
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CONFIG_LOCK})`);
      if (p.litellm.connection) changes.push(...(await this.litellmConnection(p.litellm.connection)));
      for (const a of p.authProviders) changes.push(...(await this.authProvider(a)));
      for (const f of p.gitForges) changes.push(...(await this.gitForge(f)));
      if (p.smtp) changes.push(...(await this.smtp(p.smtp)));
      for (const [section, patch] of Object.entries(p.settings)) changes.push(...(await this.setting(section as keyof PlatformSettings, patch)));
    });
    if (changes.length) {
      this.logger.log(`Configuration appliquée depuis l'environnement : ${changes.join(', ')}`);
      await this.audit.record({ action: 'platform.env_provisioning', actorLabel: 'environment', metadata: { changes } });
    }
    return changes;
  }

  private async litellmConnection(c: { url: string; masterKey: string }): Promise<string[]> {
    const cur = await this.secrets.read(this.env.LITELLM_MASTER_KEY_REF).catch(() => ({}) as Record<string, string>);
    if (cur['url'] === c.url && cur['masterKey'] === c.masterKey) return [];
    await this.litellm.saveConnection(c.url, c.masterKey);
    return ['litellm.connection'];
  }

  private async authProvider(a: ProvisionedAuthProvider): Promise<string[]> {
    const [prev] = await this.db.select().from(authProviders).where(eq(authProviders.name, a.name));
    if (prev && prev.type !== a.type) throw new Error(`Fournisseur d'identité « ${a.name} » : déjà déclaré avec le type ${prev.type} (changez son nom)`);
    if (prev) {
      // Même configuration et mêmes secrets : rien à réécrire (pas de nouvelle version à chaque démarrage).
      const secretFields = AUTH_PROVIDER_SECRET_FIELDS[a.type];
      const { config, secrets } = splitSecrets(a.config, secretFields);
      const parsed = AUTH_PROVIDER_CONFIG_SCHEMAS[a.type].safeParse(config);
      const stored = prev.secretRef && Object.keys(secrets).length ? await this.secrets.read(prev.secretRef).catch(() => ({}) as Record<string, string>) : {};
      const same =
        parsed.success &&
        stable(parsed.data) === stable(prev.config) &&
        prev.enabled === a.enabled &&
        prev.autoProvision === a.autoProvision &&
        Object.entries(secrets).every(([k, v]) => stored[k] === v);
      if (same) return [];
    }
    try {
      await this.federation.upsert(prev?.id ?? null, a, null, CTX);
    } catch (e) {
      throw new Error(`Fournisseur d'identité « ${a.name} » : ${describe(e)}`);
    }
    return [`sso:${a.name}`];
  }

  private async gitForge(f: Provisioning['gitForges'][number]): Promise<string[]> {
    const [prev] = await this.db.select().from(gitForges).where(sql`lower(${gitForges.host}) = ${f.host.toLowerCase()}`);
    if (prev) {
      const stored = f.clientSecret && prev.secretRef ? await this.secrets.read(prev.secretRef).catch(() => ({}) as Record<string, string>) : {};
      const same = prev.provider === f.provider && prev.name === f.name && prev.clientId === f.clientId && prev.enabled === f.enabled && (!f.clientSecret || stored['clientSecret'] === f.clientSecret);
      if (same) return [];
    }
    try {
      await this.forges.upsert(prev?.id ?? null, f, null, CTX);
    } catch (e) {
      throw new Error(`Forge Git ${f.host} : ${describe(e)}`);
    }
    return [`git:${f.host}`];
  }

  private async smtp(s: NonNullable<Provisioning['smtp']>): Promise<string[]> {
    const prev = await this.secrets.read(SMTP_REF).catch(() => ({}) as Record<string, string>);
    const data: Record<string, string> = {
      host: s.host,
      port: String(s.port),
      secure: String(s.secure),
      fromAddress: s.fromAddress,
      fromName: s.fromName,
      ...(s.username ? { username: s.username } : {}),
      ...(s.password ? { password: s.password } : prev['password'] && s.username ? { password: prev['password'] } : {}),
    };
    if (stable(data) === stable(prev)) return [];
    await this.secrets.write(SMTP_REF.replace(/^vault:/, ''), data);
    return ['smtp'];
  }

  private async setting(section: keyof PlatformSettings, patch: Record<string, unknown>): Promise<string[]> {
    const cur = (await this.settings.section(section)) as Record<string, unknown>;
    if (stable({ ...cur, ...patch }) === stable(cur)) return [];
    try {
      await this.settings.update(section, patch, null);
    } catch (e) {
      throw new Error(`Paramètres « ${section} » : ${describe(e)}`);
    }
    return [`settings.${section}`];
  }

  /* ------------------------------ Modèles LiteLLM ------------------------------ */

  async applyModels(p: Provisioning): Promise<void> {
    const l = p.litellm;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${MODELS_LOCK})`);
      const created: string[] = [];
      if (l.models.length) {
        const existing = new Set(await this.litellmModelNames());
        for (const m of l.models) {
          if (existing.has(m.model_name)) continue;
          await this.litellm.request('POST', '/model/new', m, 30_000);
          existing.add(m.model_name);
          created.push(m.model_name);
        }
        if (created.length) this.logger.log(`Modèles créés dans LiteLLM : ${created.join(', ')}`);
      }
      const sync = await this.litellm.syncModels(null);
      this.logger.log(`Modèles LiteLLM découverts : ${sync.discovered}${sync.added.length ? ` (nouveaux : ${sync.added.join(', ')})` : ''}`);

      const rows = await this.db.select({ id: llmModels.id, name: llmModels.litellmModel, enabled: llmModels.enabled, isDefault: llmModels.isDefault, available: llmModels.available }).from(llmModels).where(isNull(llmModels.deletedAt));
      const byName = new Map(rows.map((r) => [r.name, r]));
      const wanted = new Set<string>(l.enable === '*' ? rows.filter((r) => r.available).map((r) => r.name) : l.enable);
      for (const m of l.models) wanted.add(m.model_name);
      if (l.defaultModel) wanted.add(l.defaultModel);
      if (l.titleModel) wanted.add(l.titleModel);
      const unknown = [...wanted].filter((n) => !byName.has(n));
      if (unknown.length) this.logger.warn(`Modèles déclarés introuvables dans LiteLLM : ${unknown.join(', ')}`);
      const toEnable = [...wanted].map((n) => byName.get(n)).filter((r): r is NonNullable<typeof r> => !!r && !r.enabled);
      if (toEnable.length) {
        await this.db.update(llmModels).set({ enabled: true, updatedAt: new Date() }).where(inArray(llmModels.id, toEnable.map((r) => r.id)));
        this.logger.log(`Modèles activés : ${toEnable.map((r) => r.name).join(', ')}`);
      }
      const def = l.defaultModel ? byName.get(l.defaultModel) : undefined;
      if (def && !def.isDefault) {
        await this.db.transaction(async (t2) => {
          await t2.update(llmModels).set({ isDefault: false }).where(and(ne(llmModels.id, def.id), eq(llmModels.isDefault, true)));
          await t2.update(llmModels).set({ isDefault: true, enabled: true, updatedAt: new Date() }).where(eq(llmModels.id, def.id));
        });
        this.logger.log(`Modèle par défaut : ${def.name}`);
      }
      const title = l.titleModel ? byName.get(l.titleModel) : undefined;
      if (title) await this.setting('conversations', { titleModelId: title.id });
      if (created.length || toEnable.length || (def && !def.isDefault)) {
        await this.audit.record({ action: 'platform.env_provisioning', actorLabel: 'environment', metadata: { litellmCreated: created, enabled: toEnable.map((r) => r.name), defaultModel: def?.name ?? null } });
      }
    });
  }

  /** Noms de tous les modèles de LiteLLM (y compris hors conversation : embeddings…). */
  private async litellmModelNames(): Promise<string[]> {
    try {
      const r = await this.litellm.request<{ data?: Array<{ model_name?: string }> }>('GET', '/model/info');
      return (r.data ?? []).map((m) => m.model_name ?? '').filter(Boolean);
    } catch {
      const r = await this.litellm.request<{ data?: Array<{ id: string }> }>('GET', '/v1/models');
      return (r.data ?? []).map((m) => m.id);
    }
  }

  private async withRetry(label: string, fn: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) return;
      try {
        await fn();
        return;
      } catch (e) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.logger.error(`Provisioning des ${label} abandonné : ${describe(e)}`);
          return;
        }
        this.logger.warn(`Provisioning des ${label} : ${describe(e)} (nouvelle tentative dans ${delay / 1000} s)`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          t.unref();
          this.timers.push(t);
        });
      }
    }
  }
}

function splitSecrets(input: Record<string, unknown>, fields: readonly string[]): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const config = { ...input };
  const secrets: Record<string, string> = {};
  for (const f of fields) {
    if (typeof config[f] === 'string' && config[f]) secrets[f] = config[f] as string;
    delete config[f];
  }
  return { config, secrets };
}

/** Sérialisation à clés triées, pour comparer deux configurations. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function describe(e: unknown): string {
  const err = e as Error & { details?: unknown };
  const details = Array.isArray(err.details) ? ` (${err.details.map((d: { path?: unknown; message?: string }) => `${Array.isArray(d.path) ? d.path.join('.') : (d.path ?? '')} : ${d.message ?? ''}`).join(' ; ')})` : '';
  return `${err.message ?? String(e)}${details}`;
}
