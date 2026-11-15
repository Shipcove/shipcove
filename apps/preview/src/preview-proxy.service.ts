import http from 'node:http';
import net from 'node:net';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { previewPorts, sandboxInstances, users, workspaces, type Database } from '@cap/database';
import { previewPortAllowed } from '@cap/contracts';
import { DB, ENV, SECRETS, SettingsService, parsePreviewHost, signPreviewToken, verifyPreviewToken, type BaseEnv } from '@cap/server-core';

const COOKIE = 'cap_preview';

interface Target {
  host: string;
  port: number;
  at: number;
}

/**
 * Preview Gateway (ADR 0011) : origine distincte de l'application, aucun cookie de l'application
 * principale, accès réservé au propriétaire du workspace, destination limitée à la sandbox du
 * workspace et au port explicitement ouvert (pas de SSRF).
 */
@Injectable()
export class PreviewProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Preview');
  private server: http.Server | null = null;
  private key: string | null = null;
  private readonly cache = new Map<string, Target>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: BaseEnv & { PORT: number },
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly settings: SettingsService,
  ) {}

  private async signingKey(): Promise<string> {
    if (!this.key) {
      const k = await this.secrets.readKey(this.env.PREVIEW_SIGNING_KEY_REF, 'key');
      if (!k) throw new Error('Clé de signature des previews absente');
      this.key = k;
    }
    return this.key;
  }

  onModuleInit(): void {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      // Gestionnaire posé avant l'autorisation (asynchrone) : un client qui coupe ne fait pas tomber le service.
      socket.on('error', () => socket.destroy());
      void this.upgrade(req, socket as net.Socket, head).catch(() => socket.destroy());
    });
    this.server.listen(this.env.PORT, '0.0.0.0', () => this.logger.log(`Preview gateway à l'écoute sur :${this.env.PORT}`));
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Un certificat n'est émis que pour le nom d'une preview ouverte d'un workspace existant. */
  private async tlsAllowed(domain: string): Promise<boolean> {
    const parsed = parsePreviewHost(domain, this.env.PREVIEW_DOMAIN);
    if (!parsed) return false;
    const [row] = await this.db
      .select({ id: previewPorts.id })
      .from(previewPorts)
      .innerJoin(workspaces, eq(workspaces.id, previewPorts.workspaceId))
      .where(and(eq(previewPorts.workspaceId, parsed.workspaceId), eq(previewPorts.port, parsed.port), isNull(previewPorts.closedAt), isNull(workspaces.deletedAt)));
    return Boolean(row);
  }

  /** Vérifie l'accès et renvoie la cible (IP sandbox + port ouvert). */
  private async authorize(req: http.IncomingMessage): Promise<{ target: Target; ws: string; port: number } | { status: number; message: string }> {
    const parsed = parsePreviewHost(req.headers.host ?? '', this.env.PREVIEW_DOMAIN);
    if (!parsed) return { status: 404, message: 'Preview inconnue' };
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
    const claims = verifyPreviewToken(await this.signingKey(), cookies[COOKIE], 'session');
    if (!claims || claims.ws !== parsed.workspaceId || claims.port !== parsed.port) return { status: 401, message: 'Accès à la preview non autorisé : ouvrez-la depuis le workspace' };
    const cacheKey = `${parsed.workspaceId}:${parsed.port}:${claims.uid}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10_000) return { target: hit, ws: parsed.workspaceId, port: parsed.port };
    const [row] = await this.db
      .select({ ownerId: workspaces.ownerId, host: sandboxInstances.internalHost, status: users.status })
      .from(previewPorts)
      .innerJoin(workspaces, eq(workspaces.id, previewPorts.workspaceId))
      .innerJoin(users, eq(users.id, workspaces.ownerId))
      .leftJoin(sandboxInstances, and(eq(sandboxInstances.workspaceId, workspaces.id), eq(sandboxInstances.status, 'running')))
      .where(and(eq(previewPorts.workspaceId, parsed.workspaceId), eq(previewPorts.port, parsed.port), isNull(previewPorts.closedAt), isNull(workspaces.deletedAt)));
    if (!row || row.ownerId !== claims.uid || row.status !== 'active') return { status: 403, message: 'Preview fermée ou accès révoqué' };
    if (!row.host) return { status: 503, message: 'Sandbox arrêtée : démarrez le workspace' };
    // Liste blanche relue à chaque vérification : un port retiré par l'administrateur est coupé aussitôt.
    const { enabled, allowedPorts } = await this.settings.section('previews');
    if (!enabled || !previewPortAllowed(parsed.port, allowedPorts)) return { status: 403, message: 'Port non autorisé pour les previews' };
    const target = { host: row.host, port: parsed.port, at: Date.now() };
    this.cache.set(cacheKey, target);
    return { target, ws: parsed.workspaceId, port: parsed.port };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/__cap_health') {
        res.writeHead(200).end('ok');
        return;
      }
      if (url.pathname === '/__cap_auth') return await this.exchange(req, res, url);
      if (url.pathname === '/__cap_tls_ask' && !parsePreviewHost(req.headers.host ?? '', this.env.PREVIEW_DOMAIN)) {
        // Reverse proxy TLS (certificats à la demande) : seulement pour une preview ouverte.
        res.writeHead((await this.tlsAllowed(url.searchParams.get('domain') ?? '')) ? 200 : 404).end();
        return;
      }
      const auth = await this.authorize(req);
      if ('status' in auth) {
        res.writeHead(auth.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(auth.message);
        return;
      }
      const headers = { ...req.headers };
      // Cookie de la passerelle retiré ; s'il était seul, plus d'en-tête du tout (Node refuse `undefined`).
      const cookie = stripCookie(req.headers.cookie);
      if (cookie) headers.cookie = cookie;
      else delete headers.cookie;
      delete headers['x-forwarded-for'];
      const up = http.request({ host: auth.target.host, port: auth.target.port, method: req.method, path: req.url, headers, timeout: 300_000 }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Le serveur de l’application ne répond pas sur ce port');
        else res.end();
      });
      req.pipe(up);
    } catch (err) {
      this.logger.error((err as Error).message);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  /** Échange du jeton court (émis par l'API) contre un cookie propre au sous-domaine. */
  private async exchange(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parsed = parsePreviewHost(req.headers.host ?? '', this.env.PREVIEW_DOMAIN);
    const key = await this.signingKey();
    const c = verifyPreviewToken(key, url.searchParams.get('token') ?? undefined, 'exchange');
    if (!parsed || !c || c.ws !== parsed.workspaceId || c.port !== parsed.port) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Lien de preview invalide ou expiré');
      return;
    }
    const session = signPreviewToken(key, { ...c, kind: 'session', exp: Math.floor(Date.now() / 1000) + 12 * 3600 });
    const secure = this.env.PREVIEW_PUBLIC_SCHEME === 'https' ? '; Secure' : '';
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`,
      Location: '/',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  /**
   * WebSocket : la requête d'upgrade est rejouée en HTTP et le tunnel n'est ouvert que si
   * l'application répond « 101 Switching Protocols ». Un service qui ne parle pas HTTP
   * (PostgreSQL, Redis…) ne répond jamais 101 : impossible d'en faire un tunnel TCP brut.
   */
  private async upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const auth = await this.authorize(req).catch(() => ({ status: 500, message: 'erreur' }));
    if ('status' in auth) {
      socket.end(`HTTP/1.1 ${auth.status} Forbidden\r\n\r\n`);
      return;
    }
    proxyUpgrade(req, socket, head, auth.target);
  }
}

function stripCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const rest = cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => !c.startsWith(`${COOKIE}=`));
  return rest.length ? rest.join('; ') : undefined;
}

/**
 * Relais d'une requête d'upgrade (WebSocket) vers `target`. Le tunnel n'est ouvert qu'après une
 * réponse « 101 » de l'application ; sinon la connexion est refusée sans rien relayer.
 */
export function proxyUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, target: { host: string; port: number }): void {
  const headers = { ...req.headers };
  const cookie = stripCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  delete headers['x-forwarded-for'];
  const up = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers, timeout: 30_000 });
  up.on('upgrade', (r, upSocket, upHead) => {
    if (r.statusCode !== 101) {
      upSocket.destroy();
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const lines = [`HTTP/1.1 101 ${r.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.setTimeout(0);
    upSocket.on('error', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  // Réponse HTTP ordinaire (pas d'upgrade) : refus, sans relayer le contenu.
  up.on('response', (r) => {
    r.resume();
    socket.end(`HTTP/1.1 ${r.statusCode ?? 502} Upgrade Refused\r\n\r\n`);
  });
  up.on('timeout', () => up.destroy());
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.end();
}
