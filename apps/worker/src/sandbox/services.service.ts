import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { serviceCatalog, type Database } from '@cap/database';
import { DB, RegistryMirrorService, SettingsService, scrubSecrets, type ResolvedEnvironment } from '@cap/server-core';
import { SandboxManager, type ActiveSandbox } from './sandbox-manager.service.js';

const HEALTH_TIMEOUT_MS = 180_000;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface StartRequest {
  /** Clé du catalogue (ex. `postgres`). */
  service: string;
  /** Nom de l'instance (défaut : la clé) — permet deux instances du même service. */
  name?: string;
  /** Variables du conteneur ; `${NOM}` reprend une variable ou un secret du dépôt. */
  env?: Record<string, string>;
  memoryMb?: number;
}

/**
 * Services d'appui lancés **à la demande de Pi** (PostgreSQL, Redis, RabbitMQ…), parmi ceux que
 * l'administrateur a approuvés dans le catalogue (images, variables par défaut, mémoire maximale).
 * Rien ne démarre tant que Pi ne le demande pas. Les services partagent le réseau de la sandbox
 * (localhost), durent autant qu'elle et disparaissent avec elle (données éphémères).
 */
@Injectable()
export class ServicesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sandboxes: SandboxManager,
    private readonly settings: SettingsService,
    private readonly mirrors: RegistryMirrorService,
  ) {}

  private async enabledCatalog() {
    return this.db.select().from(serviceCatalog).where(eq(serviceCatalog.enabled, true)).orderBy(serviceCatalog.key);
  }

  /** Catalogue lu par l'extension de Pi à son démarrage (description de l'outil). */
  async writeCatalog(sb: ActiveSandbox): Promise<void> {
    const list = (await this.enabledCatalog()).map((c) => ({ key: c.key, name: c.name, image: c.image, port: c.port, defaultEnv: c.defaultEnv, maxMemoryMb: c.maxMemoryMb }));
    await this.sandboxes.writeFiles(sb.handle, [{ path: 'run/cap/services.json', content: JSON.stringify(list) }]);
  }

  async catalogText(): Promise<string> {
    const c = await this.enabledCatalog();
    if (!c.length) return 'Aucun service n’est disponible (catalogue vide).';
    return c
      .map((x) => `- ${x.key} : ${x.name} (${x.image})${x.port ? `, port ${x.port}` : ''}${Object.keys(x.defaultEnv).length ? `, variables par défaut ${Object.entries(x.defaultEnv).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`)
      .join('\n');
  }

  async start(sb: ActiveSandbox, env: ResolvedEnvironment, req: StartRequest): Promise<string> {
    const [c] = await this.db.select().from(serviceCatalog).where(and(eq(serviceCatalog.key, String(req.service ?? '')), eq(serviceCatalog.enabled, true)));
    if (!c) throw new Error(`Service « ${req.service} » non disponible. Catalogue :\n${await this.catalogText()}`);
    const name = req.name ?? c.key;
    if (!NAME_RE.test(name)) throw new Error('Nom invalide : minuscules, chiffres et tirets (32 caractères max.)');
    const provider = this.sandboxes.provider;
    const running = await provider.listServices(sb.handle);
    const { maxServicesPerWorkspace, cpu } = await this.settings.section('sandbox');
    const existing = running.find((r) => r.name === name);
    if (!existing && running.length >= maxServicesPerWorkspace) {
      throw new Error(`Limite de ${maxServicesPerWorkspace} services atteinte : arrêtez-en un (action « stop ») avant d’en lancer un autre`);
    }
    const merged = { ...c.defaultEnv, ...(req.env ?? {}) };
    const missing: string[] = [];
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (!ENV_RE.test(k)) throw new Error(`Nom de variable invalide : ${k}`);
      resolved[k] = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n: string) => {
        if (env.vars[n] === undefined) missing.push(n);
        return env.vars[n] ?? '';
      });
    }
    if (missing.length) throw new Error(`Variables du dépôt non définies : ${missing.join(', ')}`);
    const memoryMb = Math.min(Math.max(64, Math.round(req.memoryMb ?? c.defaultMemoryMb)), c.maxMemoryMb);
    // Miroir de registre éventuel (réécriture de la référence, identifiants, repli).
    const pull = await this.mirrors.plan(c.image);
    const specHash = createHash('sha256').update(JSON.stringify([pull.image, resolved, memoryMb])).digest('hex');
    // Même configuration déjà lancée : rien à faire (idempotent).
    if (existing?.running && existing.specHash === specHash) return this.describeOne(sb, name, c);
    if (existing) await provider.removeService(sb.handle, name);
    await provider.startServices(sb.handle, [{ name, key: c.key, image: pull.image, pullAuth: pull.auth, fallbackImage: pull.fallback, env: resolved, memoryMb, cpu: Math.max(0.25, Math.min(2, cpu / 2)), pidsLimit: 512, specHash }]);
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.healthy(sb, name, c.healthCommand)) {
        const hint = await this.writeClientCredentials(sb, c, resolved);
        return `${await this.describeOne(sb, name, c)}\nDémarré et prêt.${hint ? `\n${hint}` : ''}`;
      }
      const state = (await provider.listServices(sb.handle)).find((s) => s.name === name);
      if (!state?.running) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const logs = await this.logs(sb, env, name, 40).catch(() => '');
    throw new Error(`Le service ${name} n’est pas prêt (sonde de santé en échec). Dernières lignes du journal :\n${logs}`);
  }

  /**
   * PostgreSQL : identifiants écrits dans le fichier de mots de passe de libpq (PGPASSFILE,
   * /run/cap/pgpass, lisible par l'agent seul). psql, pg_dump et les pilotes qui suivent libpq
   * s'y connectent sans que le mot de passe apparaisse dans les commandes affichées.
   */
  private async writeClientCredentials(sb: ActiveSandbox, c: typeof serviceCatalog.$inferSelect, env: Record<string, string>): Promise<string | null> {
    const password = env['POSTGRES_PASSWORD'];
    if (password === undefined) return null;
    const user = env['POSTGRES_USER'] || 'postgres';
    const db = env['POSTGRES_DB'] || user;
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    await this.sandboxes.writeFiles(sb.handle, [{ path: 'run/cap/pgpass', content: `*:*:*:${esc(user)}:${esc(password)}\n`, mode: 0o600 }]);
    return (
      `Connexion : psql -h 127.0.0.1${c.port && c.port !== 5432 ? ` -p ${c.port}` : ''} -U ${user} -d ${db} — le mot de passe est fourni ` +
      'automatiquement (PGPASSFILE) : ne l’écris jamais dans une commande (ni PGPASSWORD=…, ni dans une URL passée à psql).'
    );
  }

  async stop(sb: ActiveSandbox, name: string): Promise<string> {
    const exists = (await this.sandboxes.provider.listServices(sb.handle)).some((s) => s.name === name);
    if (!exists) return `Aucun service « ${name} » en cours.`;
    await this.sandboxes.provider.removeService(sb.handle, name);
    return `Service ${name} arrêté (ses données sont supprimées).`;
  }

  private async healthy(sb: ActiveSandbox, name: string, health: string[]): Promise<boolean> {
    const state = (await this.sandboxes.provider.listServices(sb.handle)).find((s) => s.name === name);
    if (!state?.running) return false;
    if (health.length === 0) return true;
    const res = await this.sandboxes.provider.serviceExec(sb.handle, name, health, 10_000).catch(() => null);
    return res?.exitCode === 0;
  }

  private async describeOne(sb: ActiveSandbox, name: string, c: typeof serviceCatalog.$inferSelect): Promise<string> {
    const ok = await this.healthy(sb, name, c.healthCommand);
    return `- ${name} (${c.image}) : ${ok ? 'prêt' : 'indisponible'}${c.port ? `, localhost:${c.port}` : ''}`;
  }

  /** État des services lancés dans la sandbox. */
  async status(sb: ActiveSandbox): Promise<string> {
    const running = await this.sandboxes.provider.listServices(sb.handle);
    if (!running.length) return `Aucun service lancé. Disponibles :\n${await this.catalogText()}`;
    const catalog = await this.db.select().from(serviceCatalog);
    const lines: string[] = [];
    for (const r of running) {
      const c = catalog.find((x) => x.key === r.key);
      lines.push(c ? await this.describeOne(sb, r.name, c) : `- ${r.name} : ${r.running ? 'en cours' : 'arrêté'}`);
    }
    return lines.join('\n');
  }

  /** Journaux d'un service (secrets masqués), pour diagnostiquer. */
  async logs(sb: ActiveSandbox, env: ResolvedEnvironment, name: string, lines: number): Promise<string> {
    const raw = await this.sandboxes.provider.serviceLogs(sb.handle, name, Math.max(1, Math.min(lines, 500)));
    return scrubSecrets(raw, env.secretValues).slice(-50_000) || '(journal vide)';
  }
}
