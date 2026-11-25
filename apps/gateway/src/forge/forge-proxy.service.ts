import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { lookup } from 'node:dns/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { gitConnections, repositories, workspaces, type Database } from '@cap/database';
import { AuditService, DB, ENV, GitProviderClient, SettingsService, redactString } from '@cap/server-core';
import type { GatewayEnv } from '../env.js';
import { RunTokenService, type RunPrincipal } from '../run-token.service.js';
import { isPrivateAddress } from '../egress/egress-policy.js';
import { ForgeCaService } from './forge-ca.service.js';
import {
  apiTarget,
  decideApi,
  decideRefUpdate,
  decideWeb,
  extractRunToken,
  gitRequest,
  isWorkspaceRepo,
  writeTargetRepo,
  graphqlText,
  methodOverride,
  normalizeApiPath,
  parseReceivePack,
  receivePackRejection,
  reviewEventAllowed,
  type Decision,
  type ForgeFamily,
} from './forge-policy.js';

type Conn = typeof gitConnections.$inferSelect;

export interface ForgeTarget {
  /** Hôte demandé par la sandbox (ex. `api.github.com`). */
  host: string;
  port: number;
  secure: boolean;
  family: ForgeFamily;
  /** Hôte des connexions Git correspondantes (ex. `github.com`, `gitlab.exemple.com:8443`). */
  connHost: string;
  /** Forge déclarée par l'administrateur (adresse interne admise) ou SaaS public. */
  selfHosted: boolean;
}

const SAAS: Record<string, { family: ForgeFamily; connHost: string }> = {
  'github.com': { family: 'github', connHost: 'github.com' },
  'api.github.com': { family: 'github', connHost: 'github.com' },
  'uploads.github.com': { family: 'github', connHost: 'github.com' },
  'codeload.github.com': { family: 'github', connHost: 'github.com' },
  'gitlab.com': { family: 'gitlab', connHost: 'gitlab.com' },
};

const HOP = ['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'];
const MAX_INSPECT = 64 * 1024 * 1024;
/** Taille maximale de la section de commandes d'un push (compressée et décompressée). */
const RECEIVE_PACK_COMMANDS_MAX = 1024 * 1024;

class Denied extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Accès des sandboxes aux forges Git (ADR 0013) : `git`, `gh` et `glab` fonctionnent normalement,
 * mais présentent le **jeton de run** ; la gateway intercepte le TLS (autorité propre à
 * l'installation), remplace ce jeton par le jeton OAuth de l'utilisateur (Vault) et applique les
 * garde-fous. Le jeton de la forge n'entre jamais dans la sandbox.
 */
@Injectable()
export class ForgeProxyService {
  private readonly logger = new Logger('ForgeProxy');
  private readonly server = http.createServer((req, res) => void this.dispatch(req, res));
  private readonly targets = new WeakMap<net.Socket, ForgeTarget>();
  private hosts: { at: number; map: Map<string, { family: ForgeFamily; connHost: string }> } | null = null;
  private readonly facts = new Map<string, { at: number; value: { defaultBranch: string; protectedBranches: Set<string> } }>();
  /** Tests : forcer l'adresse et la confiance TLS de l'amont. */
  upstreamOverride: { address: string; port?: number; ca?: string } | null = null;

  constructor(
    @Inject(ENV) private readonly env: GatewayEnv,
    @Inject(DB) private readonly db: Database,
    private readonly tokens: RunTokenService,
    private readonly git: GitProviderClient,
    private readonly ca: ForgeCaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {
    this.server.on('clientError', (_e, s) => s.destroy());
  }

  /**
   * Portée des écritures (`git.agentWriteScope`) : par défaut, l'agent n'écrit que dans le dépôt
   * de la conversation. Une écriture sans dépôt identifiable par son chemin (GraphQL, Markdown)
   * reste soumise aux seules règles d'opérations.
   */
  private async assertWriteScope(principal: RunPrincipal, target: ForgeTarget, path: string): Promise<void> {
    const { agentWriteScope } = await this.settings.section('git');
    if (agentWriteScope === 'any') return;
    const candidate = writeTargetRepo(target.family, target.host, path);
    if (candidate === null) return;
    const row = await this.workspaceRepo(principal.workspaceId);
    if (!row || row.host.toLowerCase() !== target.connHost.toLowerCase() || !isWorkspaceRepo(candidate, row)) {
      throw new Denied(403, `Refusé par la plateforme : l’agent n’écrit que dans le dépôt de la conversation${row ? ` (${row.fullName})` : ' (aucun dépôt rattaché)'} ; réglage git.agentWriteScope.`);
    }
  }

  /* ------------------------------ forges ------------------------------ */

  private async selfHosted(): Promise<Map<string, { family: ForgeFamily; connHost: string }>> {
    if (this.hosts && Date.now() - this.hosts.at < 30_000) return this.hosts.map;
    const res = await this.db.execute<{ host: string; provider: string }>(
      // Forges déclarées par l'administrateur uniquement : un hôte ajouté par un utilisateur (jeton
      // personnel) ne doit pas être intercepté, et donc ouvert, pour toutes les sandboxes.
      sql`select host, provider from git_forges where enabled`,
    );
    const map = new Map<string, { family: ForgeFamily; connHost: string }>();
    for (const r of res.rows) {
      const h = r.host.toLowerCase();
      if (SAAS[h.split(':')[0]]) continue;
      map.set(h, { family: r.provider.startsWith('github') ? 'github' : 'gitlab', connHost: h });
    }
    this.hosts = { at: Date.now(), map };
    return map;
  }

  /** Forge reconnue pour `host:port`, ou `null` (trafic ordinaire, soumis à la liste blanche). */
  async match(host: string, port: number, secure: boolean): Promise<ForgeTarget | null> {
    const h = host.toLowerCase().replace(/\.$/, '');
    const defaultPort = secure ? 443 : 80;
    const saas = SAAS[h];
    if (saas) return port === 443 && secure ? { host: h, port, secure, ...saas, selfHosted: false } : null;
    const map = await this.selfHosted();
    const key = port === defaultPort ? h : `${h}:${port}`;
    const hit = map.get(key) ?? (port === defaultPort ? undefined : map.get(h));
    if (!hit) return null;
    if (!secure) {
      // HTTP seulement pour un hôte explicitement autorisé par l'administrateur.
      try {
        await this.git.assertTransport(`http://${hit.connHost}/`);
      } catch {
        return null;
      }
    }
    return { host: h, port, secure, ...hit, selfHosted: true };
  }

  /** CONNECT vers une forge : terminaison TLS avec un certificat de l'autorité des forges. */
  async intercept(client: net.Socket, head: Buffer, target: ForgeTarget): Promise<void> {
    const secureContext = await this.ca.contextFor(target.host);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.unshift(head);
    const socket = new tls.TLSSocket(client, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
    socket.on('error', () => client.destroy());
    this.targets.set(socket, target);
    this.server.emit('connection', socket);
  }

  /** Requête HTTP en clair (forge interne autorisée en HTTP) reçue par le proxy d'egress. */
  async handlePlain(req: http.IncomingMessage, res: http.ServerResponse, target: ForgeTarget, path: string): Promise<void> {
    await this.handle(req, res, target, path);
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = this.targets.get(req.socket as net.Socket);
    if (!target) return void res.writeHead(400).end();
    await this.handle(req, res, target, req.url ?? '/');
  }

  /* ----------------------------- requêtes ----------------------------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, target: ForgeTarget, path: string): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    let principal: RunPrincipal | null = null;
    let conn: Conn | null = null;
    try {
      const runToken = extractRunToken(req.headers);
      principal = runToken ? await this.tokens.authenticate(`Bearer ${runToken}`) : null;
      const git = gitRequest(path);
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !(git && git.kind === 'upload-pack') && !path.split('?')[0].endsWith('/info/lfs/objects/batch');
      if (!principal) {
        // Git demande alors ses identifiants (assistant de la sandbox → jeton de run).
        if (git || write) throw new Denied(401, 'Authentification requise : utilisez le jeton de run de la sandbox (configuré pour git, gh et glab).');
      } else {
        // Écriture seulement pendant un run en cours : un processus laissé en arrière-plan par
        // l'agent (ou une dépendance piégée) ne publie plus rien une fois le run terminé.
        if ((write || git?.kind === 'receive-pack' || git?.service === 'git-receive-pack') && principal.runStatus !== 'running') {
          throw new Denied(403, 'Refusé par la plateforme : écriture vers la forge possible seulement pendant un run de l’agent.');
        }
        if (write || git?.kind === 'receive-pack' || git?.service === 'git-receive-pack') await this.assertWriteScope(principal, target, path);
        conn = await this.connection(principal.userId, target.connHost);
        if (!conn && (write || git?.kind === 'receive-pack' || git?.service === 'git-receive-pack')) {
          throw new Denied(403, `Aucun compte ${target.connHost} rattaché : Paramètres → Connexions Git.`);
        }
      }

      let body: Buffer | null = null;
      let decision: Decision = { allowed: true, reason: '' };
      const search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
      if (methodOverride(req.headers, search)) throw new Denied(403, 'Refusé par la plateforme : surcharge de méthode HTTP non acceptée.');
      // Corps inspectés par les garde-fous (API) : jamais compressés, sinon le contrôle serait aveugle.
      if (!git && write && req.headers['content-encoding'] && !/^identity$/i.test(String(req.headers['content-encoding']))) {
        throw new Denied(415, 'Refusé par la plateforme : corps de requête compressé non contrôlable (Content-Encoding).');
      }
      if (git?.kind === 'receive-pack') {
        const r = await this.inspectReceivePack(req, res, target, conn!, git.repo);
        if (!r) return; // refus déjà envoyé au format git
        body = r;
      } else if (!git) {
        const api = apiTarget(target.family, target.host, path);
        if (api?.kind === 'graphql') {
          if (method === 'POST') body = await readBody(req, 2 * 1024 * 1024);
          const query = graphqlText(body, search);
          if (query === null) {
            if (method === 'POST') throw new Denied(403, 'Refusé par la plateforme : requête GraphQL sans texte (requête persistée) non contrôlable.');
          } else decision = decideApi(target.family, method, '/graphql', query);
        } else if (api?.kind === 'rest') {
          decision = decideApi(target.family, method, api.path);
          if (decision.allowed && decision.branchWrite) {
            body = await readBody(req, MAX_INSPECT);
            await this.checkApiBranch(conn!, decision.branchWrite.repo, parseJson<{ branch?: string }>(body)?.branch);
          }
          if (decision.allowed && decision.reviewEvent) {
            body = await readBody(req, 2 * 1024 * 1024);
            if (!reviewEventAllowed(parseJson<unknown>(body))) {
              decision = { allowed: false, reason: 'approbation d’une PR réservée à un humain (revue « COMMENT » ou « REQUEST_CHANGES » seulement)' };
            }
          }
        } else {
          // Interface web : lecture seule ; Git LFS (batch, verrous) sur le chemin seul, jamais la requête.
          const pathname = normalizeApiPath(path);
          decision = /\.git\/info\/lfs\/|\/info\/lfs\/(objects|locks)(\/|$)/.test(pathname) ? { allowed: true, reason: '' } : decideWeb(method);
        }
      }
      if (!decision.allowed) throw new Denied(403, `Refusé par la plateforme : ${decision.reason}.`);

      await this.forward(req, res, target, path, conn, git !== null, body);
      if (principal && write) {
        this.logger.log(JSON.stringify({ event: 'forge_write', host: target.host, method, path: path.split('?')[0], userId: principal.userId, workspaceId: principal.workspaceId }));
        await this.audit
          .record({ actorId: principal.userId, actorLabel: 'pi', action: 'git.agent_write', targetType: 'workspace', targetId: principal.workspaceId, outcome: 'success', metadata: { host: target.host, method, path: path.split('?')[0].slice(0, 300) } })
          .catch(() => undefined);
      }
    } catch (err) {
      const status = err instanceof Denied ? err.status : 502;
      const message = err instanceof Denied ? err.message : `Forge injoignable : ${redactString((err as Error).message)}`;
      if (err instanceof Denied && status === 403 && principal) {
        this.logger.warn(JSON.stringify({ event: 'forge_denied', host: target.host, method, path: path.split('?')[0], userId: principal.userId, reason: message }));
        await this.audit
          .record({ actorId: principal.userId, actorLabel: 'pi', action: 'git.agent_write', targetType: 'workspace', targetId: principal.workspaceId, outcome: 'failure', metadata: { host: target.host, method, path: path.split('?')[0].slice(0, 300), reason: message } })
          .catch(() => undefined);
      }
      req.resume();
      if (res.headersSent) return void res.end();
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Cap-Forge-Denied': '1' };
      if (status === 401) headers['WWW-Authenticate'] = 'Basic realm="Shipcove"';
      res.writeHead(status, headers).end(JSON.stringify({ message, documentation_url: 'https://github.com/Shipcove/shipcove' }));
    }
  }

  private async workspaceRepo(workspaceId: string): Promise<{ host: string; fullName: string; externalId: string | null } | null> {
    const [row] = await this.db
      .select({ host: repositories.host, fullName: repositories.fullName, externalId: repositories.externalId })
      .from(workspaces)
      .innerJoin(repositories, eq(repositories.id, workspaces.repositoryId))
      .where(eq(workspaces.id, workspaceId));
    return row ?? null;
  }

  private async connection(userId: string, host: string): Promise<Conn | null> {
    const [c] = await this.db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, userId), sql`lower(${gitConnections.host}) = ${host.toLowerCase()}`, eq(gitConnections.status, 'active'), isNull(gitConnections.revokedAt)))
      .orderBy(desc(gitConnections.lastUsedAt))
      .limit(1);
    return c ?? null;
  }

  private async branchFacts(conn: Conn, repo: string, branches: string[]) {
    const key = `${conn.id}|${repo}|${branches.join(',')}`;
    const hit = this.facts.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = await this.git.branchFacts(conn, repo, branches);
    this.facts.set(key, { at: Date.now(), value });
    if (this.facts.size > 500) this.facts.clear();
    return value;
  }

  private async checkApiBranch(conn: Conn, repo: string, branch: string | undefined): Promise<void> {
    const facts = await this.branchFacts(conn, repo, branch ? [branch] : []);
    const d = decideRefUpdate({ oldSha: '1'.repeat(40), newSha: '1'.repeat(40), ref: `refs/heads/${branch ?? facts.defaultBranch}` }, facts);
    if (!d.allowed) throw new Denied(403, `Refusé par la plateforme : ${d.reason}.`);
  }

  /**
   * Lit la section de commandes d'un push, applique les garde-fous et renvoie les octets déjà lus
   * (à retransmettre). En cas de refus, répond au format `report-status` et renvoie `null`.
   */
  private async inspectReceivePack(req: http.IncomingMessage, res: http.ServerResponse, target: ForgeTarget, conn: Conn, repo: string): Promise<Buffer | null> {
    const gzip = /gzip/i.test(String(req.headers['content-encoding'] ?? ''));
    const raw: Buffer[] = [];
    let rawLength = 0;
    let parsed: ReturnType<typeof parseReceivePack> = null;
    await new Promise<void>((resolve, reject) => {
      // Décompression incrémentale (hors de la boucle d'événements) et bornée : chaque octet reçu
      // n'est décompressé qu'une fois, et ni l'entrée ni la sortie ne dépassent la limite.
      const gunzip = gzip ? zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : null;
      const decoded: Buffer[] = [];
      let decodedLength = 0;
      let finished = false;
      const done = (err?: Error) => {
        if (finished) return;
        finished = true;
        req.off('data', onData).off('end', onEnd).off('error', onError);
        gunzip?.removeAllListeners('data');
        gunzip?.destroy();
        if (err) reject(err);
        else resolve();
      };
      const feed = (buf: Buffer) => {
        decoded.push(buf);
        decodedLength += buf.length;
        if (decodedLength > RECEIVE_PACK_COMMANDS_MAX) throw new Denied(400, 'Section de commandes du push trop longue');
        parsed = parseReceivePack(Buffer.concat(decoded, decodedLength));
        if (parsed) {
          req.pause();
          done();
        }
      };
      const fail = (err: unknown) => done(err instanceof Denied ? err : new Denied(400, `Push illisible : ${(err as Error).message}`));
      gunzip?.on('data', (d: Buffer) => {
        try {
          if (!finished) feed(d);
        } catch (err) {
          fail(err);
        }
      });
      gunzip?.on('error', fail);
      const onData = (chunk: Buffer) => {
        raw.push(chunk);
        rawLength += chunk.length;
        try {
          if (!parsed && rawLength > RECEIVE_PACK_COMMANDS_MAX) throw new Denied(400, 'Section de commandes du push trop longue');
          if (gunzip) gunzip.write(chunk);
          else feed(chunk);
        } catch (err) {
          fail(err);
        }
      };
      const onEnd = () => {
        if (!gunzip) return done();
        // Fin du corps : laisser la décompression rendre ses derniers octets.
        gunzip.once('end', () => done());
        gunzip.end();
      };
      const onError = (err: Error) => done(err);
      req.on('data', onData).on('end', onEnd).on('error', onError);
    });
    if (!parsed) parsed = { updates: [], capabilities: [] };
    if (parsed.updates.length === 0) return Buffer.concat(raw); // sonde d'authentification
    const branches = parsed.updates.filter((u) => u.ref.startsWith('refs/heads/')).map((u) => u.ref.slice(11));
    const facts = await this.branchFacts(conn, repo, branches);
    const reasons = new Map<string, string>();
    for (const u of parsed.updates) {
      const d = decideRefUpdate(u, facts);
      if (!d.allowed) reasons.set(u.ref, d.reason);
    }
    if (reasons.size === 0) return Buffer.concat(raw);
    this.logger.warn(JSON.stringify({ event: 'forge_push_denied', host: target.host, repo, refs: [...reasons.keys()] }));
    await drain(req);
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' });
    res.end(receivePackRejection(parsed.updates, reasons, parsed.capabilities));
    return null;
  }

  /* ------------------------------ amont ------------------------------ */

  private async resolve(target: ForgeTarget): Promise<string> {
    if (this.upstreamOverride) return this.upstreamOverride.address;
    const addresses = await lookup(target.host, { all: true });
    // Une forge auto-hébergée déclarée par l'administrateur peut être sur le réseau interne.
    const ok = addresses.find((a) => target.selfHosted || !this.env.EGRESS_BLOCK_PRIVATE || !isPrivateAddress(a.address));
    if (!ok) throw new Denied(403, 'Adresse interne refusée');
    return ok.address;
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse, target: ForgeTarget, path: string, conn: Conn | null, isGit: boolean, prefix: Buffer | null): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.includes(k)) headers[k] = v;
    // L'hôte contrôlé est celui de la connexion (SNI / CONNECT), jamais un en-tête Host choisi par la sandbox.
    headers['host'] = target.port === (target.secure ? 443 : 80) ? target.host : `${target.host}:${target.port}`;
    const basic = /^Basic\s/i.test(String(req.headers.authorization ?? ''));
    delete headers['authorization'];
    delete headers['private-token'];
    delete headers['job-token'];
    if (conn) {
      const token = await this.git.token(conn);
      if (isGit || basic) {
        const user = target.family === 'github' ? 'x-access-token' : 'oauth2';
        headers['authorization'] = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
      } else {
        headers['authorization'] = `Bearer ${token}`;
      }
      void Promise.resolve()
        .then(() => this.db.update(gitConnections).set({ lastUsedAt: new Date() }).where(eq(gitConnections.id, conn.id)))
        .catch(() => undefined);
    }
    if (prefix && !req.readableEnded) {
      // Corps partiellement lu : longueur inconnue → transfert par blocs.
      delete headers['content-length'];
    } else if (prefix) {
      headers['content-length'] = String(prefix.length);
    }
    const address = await this.resolve(target);
    const port = this.upstreamOverride?.port ?? target.port;
    await new Promise<void>((resolve, reject) => {
      const opts: https.RequestOptions = { host: address, port, method: req.method, path, headers, timeout: 600_000 };
      const upstream = target.secure
        ? https.request({ ...opts, servername: target.host, ca: this.upstreamOverride?.ca })
        : http.request(opts);
      upstream.on('response', (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP.includes(k)) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
        up.on('end', () => resolve());
        up.on('error', reject);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('délai dépassé')));
      upstream.on('error', reject);
      if (prefix) upstream.write(prefix);
      if (req.readableEnded) upstream.end();
      else req.pipe(upstream);
    });
  }
}

/** Consomme le reste d'une requête (sans attendre un « end » déjà émis). */
async function drain(req: http.IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return;
  await new Promise<void>((resolve) => {
    req.once('end', () => resolve()).once('error', () => resolve()).once('close', () => resolve());
    req.resume();
  });
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) throw new Denied(413, 'Corps de requête trop volumineux pour être contrôlé');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseJson<T>(b: Buffer): T | null {
  try {
    return JSON.parse(b.toString('utf8')) as T;
  } catch {
    return null;
  }
}
