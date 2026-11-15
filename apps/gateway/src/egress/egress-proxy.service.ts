import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@cap/database';
import { DB, ENV, SettingsService } from '@cap/server-core';
import type { GatewayEnv } from '../env.js';
import { decideHost, isPrivateAddress } from './egress-policy.js';
import { ForgeProxyService } from '../forge/forge-proxy.service.js';

/**
 * Proxy d'egress HTTP(S) des sandboxes (seule route sortante du réseau `cap-sandbox`).
 * - Liste blanche de domaines administrable.
 * - Forges Git : interceptées par `ForgeProxyService` (jeton de run → jeton OAuth, garde-fous).
 * - Résolution DNS puis connexion à l'adresse vérifiée (pas de DNS rebinding).
 * - Adresses privées / métadonnées refusées (anti-SSRF vers les services internes).
 */
@Injectable()
export class EgressProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Egress');
  private server: http.Server | null = null;
  private forgeHosts: { at: number; hosts: string[] } | null = null;

  constructor(
    @Inject(ENV) private readonly env: GatewayEnv,
    @Inject(DB) private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly forge: ForgeProxyService,
  ) {}

  /** Hôtes de forges connus (GitHub Enterprise, GitLab self-managed) : également refusés. */
  private async deniedHosts(): Promise<string[]> {
    if (this.forgeHosts && Date.now() - this.forgeHosts.at < 60_000) return this.forgeHosts.hosts;
    const res = await this.db.execute<{ host: string }>(
      sql`select distinct host from repositories union select distinct host from git_connections`,
    );
    const hosts = res.rows.map((r) => r.host.split(':')[0]);
    this.forgeHosts = { at: Date.now(), hosts };
    return hosts;
  }

  async check(host: string, port: number): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    const { egressAllowlist } = await this.settings.section('sandbox');
    const decision = decideHost(host, port, egressAllowlist, await this.deniedHosts());
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return { ok: false, reason: 'résolution DNS impossible' };
    }
    const safe = addresses.find((a) => !this.env.EGRESS_BLOCK_PRIVATE || !isPrivateAddress(a.address));
    if (!safe) return { ok: false, reason: 'adresse interne refusée' };
    return { ok: true, address: safe.address };
  }

  onModuleInit(): void {
    const server = http.createServer((req, res) => void this.handleHttp(req, res));
    server.on('connect', (req, socket, head) => {
      const client = socket as net.Socket;
      // Gestionnaire posé avant toute étape asynchrone (DNS, forges) : un client qui coupe
      // brutalement (délai dépassé, RST) ne doit jamais faire tomber la passerelle.
      client.on('error', () => client.destroy());
      void this.handleConnect(req, client, head).catch(() => client.destroy());
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    server.listen(this.env.EGRESS_PORT, '0.0.0.0', () => this.logger.log(`Proxy d'egress à l'écoute sur :${this.env.EGRESS_PORT}`));
    this.server = server;
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private deny(target: string, reason: string) {
    this.logger.warn(JSON.stringify({ event: 'egress_denied', target, reason }));
  }

  private async handleConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    const [host, portStr] = (req.url ?? '').split(':');
    const port = Number(portStr || 443);
    const forge = await this.forge.match(host, port, true).catch(() => null);
    if (forge) {
      await this.forge.intercept(client, head, forge).catch(() => client.destroy());
      return;
    }
    const verdict = await this.check(host, port).catch(() => ({ ok: false as const, reason: 'erreur interne' }));
    if (!verdict.ok) {
      this.deny(`${host}:${port}`, verdict.reason);
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nX-Cap-Egress-Denied: 1\r\n\r\nAccès refusé par la plateforme : ${verdict.reason}\r\n`);
      return;
    }
    const upstream = net.connect(port, verdict.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.setTimeout(600_000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Requête proxy invalide');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('Seul HTTP est relayé ici (HTTPS via CONNECT)');
      return;
    }
    const port = Number(url.port || 80);
    const forge = await this.forge.match(url.hostname, port, false).catch(() => null);
    if (forge) {
      await this.forge.handlePlain(req, res, forge, `${url.pathname}${url.search}`);
      return;
    }
    const verdict = await this.check(url.hostname, port).catch(() => ({ ok: false as const, reason: 'erreur interne' }));
    if (!verdict.ok) {
      this.deny(`${url.hostname}:${port}`, verdict.reason);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Cap-Egress-Denied': '1' }).end(`Accès refusé par la plateforme : ${verdict.reason}`);
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(
      { host: verdict.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: 600_000 },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}
