import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { Refused, SANDBOX_NET_RE, isManaged, route, validateCreate, validateExec, validateNetworkCreate, validatePull, type GuardConfig } from './policy.js';

export interface GuardOptions extends GuardConfig {
  /** Socket du moteur Docker. */
  socketPath: string;
  /** Secret partagé avec le worker (en-tête `X-Cap-Guard-Token`). */
  token: string;
  log?: (event: Record<string, unknown>) => void;
}

const TOKEN_HEADER = 'x-cap-guard-token';
const MAX_BODY = 1024 * 1024;

/**
 * Garde du moteur Docker (ADR 0014) : seul détenteur du socket. Le worker l'appelle comme un
 * démon Docker ; chaque appel est authentifié, reconnu dans une liste blanche et, pour les
 * créations, validé contre le modèle des sandboxes et des services.
 */
/** Étiquette des conteneurs d'infrastructure joints à chaque réseau de sandbox (valeur : alias DNS). */
export const PEER_LABEL = 'cap.sandbox-peer';

export interface Guard {
  server: http.Server;
  /** Rebranche la gateway et la preview sur chaque réseau de sandbox (après un redémarrage). */
  reconcile(): Promise<void>;
}

export function createGuard(opts: GuardOptions): http.Server {
  return createGuardWithPeers(opts).server;
}

export function createGuardWithPeers(opts: GuardOptions): Guard {
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const expected = Buffer.from(opts.token);

  const authorized = (req: http.IncomingMessage) => {
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  /** Appel direct au moteur (inspection pour les contrôles, branchement des réseaux). */
  const docker = (method: string, path: string, json?: unknown): Promise<{ status: number; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const payload = json === undefined ? null : Buffer.from(JSON.stringify(json));
      const headers: Record<string, string> = { Host: 'docker', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) };
      const r = http.request({ socketPath: opts.socketPath, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      r.on('error', reject);
      r.end(payload ?? undefined);
    });

  const containerKind = async (id: string) => {
    const r = await docker('GET', `/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return { kind: null, exists: false };
    if (r.status !== 200) throw new Error(`inspection impossible (${r.status})`);
    const info = JSON.parse(r.body.toString('utf8')) as { Config?: { Labels?: Record<string, string> } };
    return { kind: isManaged(info.Config?.Labels), exists: true };
  };

  const requireManaged = async (id: string, want?: 'sandbox') => {
    const c = await containerKind(id);
    if (!c.exists) return; // Docker répondra 404
    if (!c.kind || (want && c.kind !== want)) throw new Refused(`conteneur ${id.slice(0, 12)} non géré par la plateforme`);
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Refused('corps trop volumineux'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  /** Contrôle commun à HTTP et aux connexions détournées (exec). Renvoie le corps déjà lu, le cas échéant. */
  const check = async (req: http.IncomingMessage): Promise<Buffer | null> => {
    if (!authorized(req)) throw Object.assign(new Refused('authentification du worker requise'), { status: 401 });
    const r = route(req.method ?? 'GET', req.url ?? '/');
    switch (r.kind) {
      case 'create': {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new Refused('corps JSON invalide');
        }
        const v = validateCreate(parsed, opts);
        if (v.type === 'service') await requireManaged(v.sandbox, 'sandbox');
        return body;
      }
      case 'exec-create': {
        await requireManaged(r.id);
        const c = await containerKind(r.id);
        const body = await readBody(req);
        try {
          validateExec(JSON.parse(body.toString('utf8')), c.kind === 'service' ? 'service' : 'sandbox', opts);
        } catch (err) {
          if (err instanceof Refused) throw err;
          throw new Refused('corps JSON invalide');
        }
        return body;
      }
      case 'container':
        await requireManaged(r.id);
        return null;
      case 'image-pull': {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        validatePull(q.get('fromImage') ?? '', q.get('tag'), opts);
        return null;
      }
      case 'network-create': {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new Refused('corps JSON invalide');
        }
        validateNetworkCreate(parsed, opts);
        return body;
      }
      case 'network-remove': {
        const n = await docker('GET', `/networks/${encodeURIComponent(r.id)}`);
        if (n.status === 404) return null;
        const info = JSON.parse(n.body.toString('utf8')) as { Name?: string; Labels?: Record<string, string> };
        if (info.Labels?.['cap.sandbox-net'] !== 'true' || !SANDBOX_NET_RE.test(info.Name ?? '')) throw new Refused('réseau non géré par la plateforme');
        await disconnectPeers(r.id);
        return null;
      }
      case 'exec': {
        const e = await docker('GET', `/exec/${r.id}/json`);
        if (e.status === 200) {
          const { ContainerID } = JSON.parse(e.body.toString('utf8')) as { ContainerID: string };
          await requireManaged(ContainerID);
        }
        return null;
      }
      default:
        return null;
    }
  };

  const forwardHeaders = (req: http.IncomingMessage, body: Buffer | null) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== TOKEN_HEADER) headers[k] = v;
    if (body) {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }
    return headers;
  };

  const refuse = (err: unknown, req: http.IncomingMessage) => {
    const status = (err as { status?: number }).status ?? (err instanceof Refused ? 403 : 502);
    const message = err instanceof Refused ? err.message : `moteur Docker indisponible : ${(err as Error).message}`;
    if (status !== 502) log({ event: 'docker_denied', method: req.method, path: (req.url ?? '').split('?')[0], reason: message });
    return { status, message };
  };

  /** Conteneurs d'infrastructure (gateway, preview) et leur alias sur les réseaux de sandbox. */
  const peers = async (): Promise<Array<{ id: string; alias: string }>> => {
    const filters = encodeURIComponent(JSON.stringify({ label: [PEER_LABEL] }));
    const r = await docker('GET', `/containers/json?filters=${filters}`);
    if (r.status !== 200) return [];
    const list = JSON.parse(r.body.toString('utf8')) as Array<{ Id: string; Labels?: Record<string, string> }>;
    return list.filter((c) => /^[a-z][a-z0-9-]{0,62}$/.test(c.Labels?.[PEER_LABEL] ?? '')).map((c) => ({ id: c.Id, alias: c.Labels![PEER_LABEL] }));
  };

  const connectPeers = async (network: string, present: Set<string> = new Set()) => {
    for (const p of await peers()) {
      if (present.has(p.id)) continue;
      const r = await docker('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: p.id, EndpointConfig: { Aliases: [p.alias] } });
      if (r.status >= 300 && !/already exists/i.test(r.body.toString('utf8'))) log({ event: 'peer_connect_failed', network, peer: p.alias, status: r.status });
    }
  };

  const disconnectPeers = async (network: string) => {
    for (const p of await peers()) await docker('POST', `/networks/${encodeURIComponent(network)}/disconnect`, { Container: p.id, Force: true }).catch(() => undefined);
  };

  const reconcile = async () => {
    const filters = encodeURIComponent(JSON.stringify({ label: ['cap.sandbox-net=true'] }));
    const r = await docker('GET', `/networks?filters=${filters}`);
    if (r.status !== 200) return;
    for (const n of JSON.parse(r.body.toString('utf8')) as Array<{ Id: string; Name: string }>) {
      if (!SANDBOX_NET_RE.test(n.Name)) continue;
      const d = await docker('GET', `/networks/${n.Id}`);
      if (d.status !== 200) continue;
      const containers = (JSON.parse(d.body.toString('utf8')) as { Containers?: Record<string, unknown> }).Containers ?? {};
      await connectPeers(n.Id, new Set(Object.keys(containers)));
    }
  };

  const server = http.createServer(async (req, res) => {
    let body: Buffer | null;
    try {
      body = await check(req);
    } catch (err) {
      const { status, message } = refuse(err, req);
      req.resume();
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: `Garde Docker : ${message}` }));
      return;
    }
    const isNetworkCreate = (() => {
      try {
        return route(req.method ?? 'GET', req.url ?? '/').kind === 'network-create';
      } catch {
        return false;
      }
    })();
    const up = http.request({ socketPath: opts.socketPath, method: req.method, path: req.url, headers: forwardHeaders(req, body) }, (ur) => {
      if (isNetworkCreate && ur.statusCode === 201) {
        // Réseau privé créé : la gateway et la preview y sont branchées avant de répondre, pour
        // que la sandbox les joigne dès son démarrage.
        const chunks: Buffer[] = [];
        ur.on('data', (c: Buffer) => chunks.push(c));
        ur.on('end', () => {
          const out = Buffer.concat(chunks);
          const id = (JSON.parse(out.toString('utf8') || '{}') as { Id?: string }).Id;
          void (id ? connectPeers(id) : Promise.resolve())
            .catch((e: Error) => log({ event: 'peer_connect_failed', error: e.message }))
            .finally(() => {
              res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': String(out.length) });
              res.end(out);
            });
        });
        return;
      }
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    if (body) up.end(body);
    else req.pipe(up);
  });

  // Connexions détournées (exec avec flux stdin/stdout) : relais brut après contrôle.
  server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    // Le corps (ex. {"Detach":false}) peut arriver pendant les contrôles : ne rien perdre.
    socket.pause();
    socket.on('error', () => undefined);
    try {
      const r = route(req.method ?? 'GET', req.url ?? '/');
      if (r.kind !== 'exec' || r.action !== 'start') throw new Refused('seul exec/start peut être détourné');
      await check(req);
    } catch (err) {
      const { status, message } = refuse(err, req);
      socket.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ message: `Garde Docker : ${message}` })}`);
      return;
    }
    // Node remet le corps de la requête (ex. {"Detach":false}) sur `req`, pas sur la connexion brute.
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      socket.destroy();
      return;
    }
    const upstream = net.connect(opts.socketPath, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (name === TOKEN_HEADER || name === 'content-length' || name === 'transfer-encoding') continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Content-Length: ${body.length}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (body.length) upstream.write(body);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  return { server, reconcile };
}
