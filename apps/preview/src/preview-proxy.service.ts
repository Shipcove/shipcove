import http from 'node:http';
import net from 'node:net';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { previewPorts, sandboxInstances, teamMembers, users, workspaces, type Database } from '@cap/database';
import { DB, ENV, SECRETS, parsePreviewHost, signPreviewToken, verifyPreviewToken, type BaseEnv } from '@cap/server-core';

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
    this.server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket as net.Socket, head));
    this.server.listen(this.env.PORT, '0.0.0.0', () => this.logger.log(`Preview gateway à l'écoute sur :${this.env.PORT}`));
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
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
      .select({ ownerId: workspaces.ownerId, teamId: workspaces.teamId, host: sandboxInstances.internalHost, status: users.status })
      .from(previewPorts)
      .innerJoin(workspaces, eq(workspaces.id, previewPorts.workspaceId))
      .innerJoin(users, eq(users.id, workspaces.ownerId))
      .leftJoin(sandboxInstances, and(eq(sandboxInstances.workspaceId, workspaces.id), eq(sandboxInstances.status, 'running')))
      .where(and(eq(previewPorts.workspaceId, parsed.workspaceId), eq(previewPorts.port, parsed.port), isNull(previewPorts.closedAt), isNull(workspaces.deletedAt)));
    if (!row || row.ownerId !== claims.uid || row.status !== 'active') return { status: 403, message: 'Preview fermée ou accès révoqué' };
    const [member] = await this.db.select().from(teamMembers).where(and(eq(teamMembers.teamId, row.teamId), eq(teamMembers.userId, claims.uid)));
    if (!member) return { status: 403, message: 'Accès révoqué' };
    if (!row.host) return { status: 503, message: 'Sandbox arrêtée : démarrez le workspace' };
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
      const auth = await this.authorize(req);
      if ('status' in auth) {
        res.writeHead(auth.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(auth.message);
        return;
      }
      const headers = { ...req.headers };
      headers.cookie = stripCookie(req.headers.cookie);
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

  private async upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const auth = await this.authorize(req).catch(() => ({ status: 500, message: 'erreur' }));
    if ('status' in auth) {
      socket.end(`HTTP/1.1 ${auth.status} Forbidden\r\n\r\n`);
      return;
    }
    const up = net.connect(auth.target.port, auth.target.host, () => {
      const headers = { ...req.headers, cookie: stripCookie(req.headers.cookie) };
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`), '', ''];
      up.write(lines.join('\r\n'));
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
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
