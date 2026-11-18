import type {
  AgentEventDataMap,
  AgentEventType,
  AttachmentDto,
  ChangesResponse,
  ConversationDto,
  EventEnvelope,
  FileChangeDto,
  FileEntryDto,
  MessageDto,
  SessionInfo,
  SkillDto,
  WorkspaceDto,
} from '@cap/contracts';
import { lang } from '../core/i18n';
import * as D from './data';
import { SETTINGS } from './settings';
import { PiSimulator, registerText } from './pi';

/** Erreur renvoyée par l'API simulée (même forme que l'API réelle). */
export class DemoError {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
  ) {}
}

export interface DemoRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Listener = (e: EventEnvelope) => void;

/** Fichiers joints envoyés pendant la démo : servis depuis la mémoire du navigateur. */
export const blobUrls = new Map<string, string>();

const READ_ONLY = D.L('Démonstration : l’administration est en lecture seule.', 'Demo: administration is read-only.');
const UNAVAILABLE = D.L('Démonstration : cette action n’est pas disponible.', 'Demo: this action is not available.');

/**
 * Backend de la démonstration : l'état vit en mémoire (rechargé à chaque visite), les routes
 * reprennent celles de l'API réelle et les événements de conversation imitent le flux SSE.
 */
export class DemoServer {
  readonly workspaces = new Map<string, D.DemoWorkspace>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly eventIds = new Map<string, number>();
  private loggedIn = true;
  private skills: SkillDto[] = D.SKILLS.map((s) => ({ ...s }));
  private notifications = D.NOTIFICATIONS.map((n) => ({ ...n }));
  private counter = 0;
  readonly pi = new PiSimulator(this);

  constructor() {
    for (const w of D.seedWorkspaces()) this.workspaces.set(w.ws.id, w);
    registerText('backup.sh', D.BACKUP_SH);
  }

  newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.counter}`;
  }

  /* ------------------------------ Événements ------------------------------ */

  subscribe(workspaceId: string, fn: Listener): () => void {
    let set = this.listeners.get(workspaceId);
    if (!set) this.listeners.set(workspaceId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit<T extends AgentEventType>(workspaceId: string, type: T, data: AgentEventDataMap[T], runId: string | null = null): void {
    const id = (this.eventIds.get(workspaceId) ?? 0) + 1;
    this.eventIds.set(workspaceId, id);
    const e: EventEnvelope = { v: 1, id, workspaceId, runId, type, ts: new Date().toISOString(), data } as EventEnvelope;
    this.applyLocally(e);
    for (const fn of this.listeners.get(workspaceId) ?? []) fn(e);
  }

  /** L'état du serveur suit les événements : un rechargement de la conversation les retrouve. */
  private applyLocally(e: EventEnvelope): void {
    const w = this.workspaces.get(e.workspaceId);
    if (!w) return;
    const d = e.data as unknown as Record<string, unknown>;
    const msg = (id: unknown) => w.messages.find((m) => m.id === id);
    const toolCall = (id: unknown) => w.messages.flatMap((m) => m.toolCalls).find((t) => t.id === id);
    switch (e.type) {
      case 'message.created':
        w.messages.push(D.message(w.ws.conversationId, d['role'] as MessageDto['role'], d['text'] as string, e.ts, { id: d['messageId'] as string, runId: e.runId, meta: (d['meta'] as MessageDto['meta']) ?? null, attachments: (d['attachments'] as AttachmentDto[]) ?? [], completedAt: null, stopReason: null }));
        break;
      case 'message.delta': {
        const m = msg(d['messageId']);
        if (m) m.text += d['delta'] as string;
        break;
      }
      case 'thinking.delta': {
        const m = msg(d['messageId']);
        if (m) m.thinking = (m.thinking ?? '') + (d['delta'] as string);
        break;
      }
      case 'message.completed': {
        const m = msg(d['messageId']);
        if (m) Object.assign(m, { text: d['text'], stopReason: d['stopReason'], completedAt: e.ts });
        break;
      }
      case 'tool.started': {
        const m = msg(d['messageId']);
        m?.toolCalls.push(D.tool(e.runId ?? '', d['toolName'] as string, d['args'], '', e.ts, { id: d['toolCallId'] as string, messageId: m.id, status: 'running', completedAt: null, durationMs: null }));
        break;
      }
      case 'tool.completed': {
        const t = toolCall(d['toolCallId']);
        if (t) Object.assign(t, { status: d['isError'] ? 'failed' : 'completed', isError: d['isError'], output: d['output'], durationMs: d['durationMs'], filesTouched: d['filesTouched'], images: d['images'] ?? [], files: d['files'] ?? [], completedAt: e.ts });
        break;
      }
      case 'run.queued':
      case 'run.started': {
        const r = w.runs.find((x) => x.id === d['runId']);
        if (r) r.status = e.type === 'run.started' ? 'running' : 'queued';
        else w.runs.push({ ...D.run(w.ws.id, d['runId'] as string, e.ts, e.ts), status: 'queued', endedAt: null, modelId: w.ws.modelId, agentMode: w.ws.agentMode });
        w.ws.activeRunId = d['runId'] as string;
        break;
      }
      case 'run.completed':
      case 'run.interrupted':
      case 'run.failed': {
        const r = w.runs.find((x) => x.id === d['runId']);
        if (r) Object.assign(r, { status: e.type === 'run.completed' ? 'completed' : e.type === 'run.failed' ? 'failed' : 'interrupted', endedAt: e.ts });
        w.ws.activeRunId = null;
        w.ws.lastActivityAt = e.ts;
        break;
      }
      case 'workspace.status':
        w.ws.status = d['status'] as WorkspaceDto['status'];
        break;
      case 'workspace.renamed':
        Object.assign(w.ws, { name: d['name'], titleSource: d['titleSource'] });
        break;
      case 'workspace.branch':
        w.ws.branch = d['branch'] as string;
        break;
      case 'checkpoint.completed':
        w.ws.lastCheckpointAt = e.ts;
        break;
      default:
        break;
    }
  }

  /* -------------------------------- Routes -------------------------------- */

  handle(req: DemoRequest): unknown {
    const { method, path } = req;
    if (method === 'GET') return this.get(req);
    if (path.startsWith('/admin/')) throw new DemoError(403, 'forbidden', READ_ONLY);
    return this.mutate(req);
  }

  private ws(id: string): D.DemoWorkspace {
    const w = this.workspaces.get(id);
    if (!w) throw new DemoError(404, 'not_found', D.L('Workspace introuvable', 'Workspace not found'));
    return w;
  }

  private get({ path, query }: DemoRequest): unknown {
    let m: RegExpMatchArray | null;
    if (path === '/auth/session') return this.loggedIn ? { authenticated: true, user: D.ME } : { authenticated: false, user: null };
    if (path === '/auth/providers') return { localEnabled: true, registrationEnabled: false, providers: [{ id: 'p-kc', type: 'oidc', name: 'Keycloak', startUrl: '#' }] };
    if (path === '/auth/sessions') return this.sessions();
    if (path === '/auth/identities') return [{ id: 'li-1', providerId: 'p-kc', provider: 'Keycloak', type: 'oidc', email: D.ME.email, lastLoginAt: D.ago(5), createdAt: D.ago(60 * 24 * 60) }];
    if (path === '/me/git-connections') return D.GIT_CONNECTIONS;
    if (path === '/me/git-connections/oauth/providers') return { forges: D.FORGES.map((f) => ({ id: f.id, provider: f.provider, name: f.name, host: f.host })) };
    if (/^\/me\/git-connections\/[^/]+\/repositories$/.test(path)) return D.REMOTE_REPOS;
    if (path === '/models') return D.MODELS;
    if (path === '/platform/config') return { editor: { manualEditingEnabled: true }, previews: { enabled: true, maxPortsPerWorkspace: 3 }, attachments: { maxFileMb: 20, maxFilesPerMessage: 10, allowArchives: true }, sandbox: { idleTimeoutMinutes: 15 }, quotas: { enabled: true }, skills: { personalSkillsAllowed: true }, mcp: { personalServersAllowed: true } };
    if (path === '/usage') return { quotasEnabled: true, user: { windows: [{ window: '5h', percent: 23, resetsAt: new Date(Date.now() + 2.5 * 3600_000).toISOString() }, { window: '7d', percent: 41, resetsAt: new Date(Date.now() + 3.2 * 86400_000).toISOString() }] } };
    if (path === '/usage/breakdown') return D.USAGE_BREAKDOWN;
    if (path === '/usage/requests') return D.USAGE_REQUESTS;
    if (path === '/workspaces') return [...this.workspaces.values()].map((w) => w.ws).filter((w) => !w.archivedAt);
    if ((m = path.match(/^\/workspaces\/([^/]+)$/))) return this.ws(m[1]).ws;
    if ((m = path.match(/^\/workspaces\/([^/]+)\/conversation$/))) return this.conversation(this.ws(m[1]));
    if ((m = path.match(/^\/workspaces\/([^/]+)\/git\/approvals$/))) return this.ws(m[1]).approvals;
    if ((m = path.match(/^\/workspaces\/([^/]+)\/git\/branches$/))) {
      const w = this.ws(m[1]);
      return { available: !!w.ws.repository, current: w.ws.branch, local: w.branches.map((name) => ({ name, date: D.ago(60) })), remote: [] };
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/files$/))) return this.listDir(this.ws(m[1]), query.get('path') ?? '');
    if ((m = path.match(/^\/workspaces\/([^/]+)\/files\/content$/))) {
      const w = this.ws(m[1]);
      const p = query.get('path') ?? '';
      const content = w.files[p];
      if (content === undefined) throw new DemoError(404, 'not_found', D.L('Fichier introuvable', 'File not found'));
      return { path: p, content, binary: false, size: content.length, etag: String(content.length), source: 'sandbox' };
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/changes$/))) return this.changes(this.ws(m[1]), (query.get('scope') as ChangesResponse['scope']) ?? 'git_head');
    if ((m = path.match(/^\/workspaces\/([^/]+)\/changes\/diff$/))) {
      const w = this.ws(m[1]);
      const p = query.get('path') ?? '';
      return { path: p, scope: query.get('scope') ?? 'git_head', original: w.base[p] ?? null, modified: w.files[p] ?? null, binary: false, patch: '' };
    }
    if (/^\/conversations\/[^/]+\/shares$/.test(path)) return [];
    if (path === '/users/search') return D.ADMIN_USERS.filter((u) => u.id !== D.ME.id).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }));
    if (path === '/notifications') return query.get('unread') ? { unreadCount: this.notifications.filter((n) => !n.readAt).length } : { items: this.notifications };
    if (path === '/notifications/preferences') return D.NOTIF_PREFS;
    if (path === '/skills') return this.skills;
    if (path === '/skills/review/pending') return [];
    if ((m = path.match(/^\/skills\/([^/]+)$/))) {
      const s = this.skills.find((x) => x.id === m![1]);
      if (!s) throw new DemoError(404, 'not_found', D.L('Skill introuvable', 'Skill not found'));
      return { skill: s, files: D.skillFiles(s) };
    }
    if (path === '/skill-categories' || path === '/admin/skill-categories') return D.CATEGORIES;
    if (path === '/mcp-servers') return D.MCP;
    if (path.startsWith('/admin/')) return this.admin(path);
    return [];
  }

  private admin(path: string): unknown {
    switch (path) {
      case '/admin/overview':
        return D.OVERVIEW;
      case '/admin/users':
        return D.ADMIN_USERS;
      case '/admin/invitations':
        return [{ id: 'inv-1', email: 'nina.roy@example.com', expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(), acceptedAt: null, createdAt: D.ago(60 * 48) }];
      case '/admin/git-forges':
        return D.FORGES;
      case '/admin/models':
        return D.ADMIN_MODELS;
      case '/admin/litellm/connection':
        return { url: 'http://litellm:4000', source: 'env', keyConfigured: true };
      case '/admin/settings':
        return SETTINGS;
      case '/admin/service-catalog':
        return D.SERVICES;
      case '/admin/registry-mirrors':
        return { mirrors: [{ registry: 'docker.io', prefix: 'harbor.example.com/dockerhub', username: 'robot$shipcove', passwordSet: true }], fallbackToUpstream: true };
      case '/admin/auth-providers':
        return [{ id: 'p-kc', type: 'oidc', name: 'Keycloak', enabled: true, autoProvision: true, config: { issuer: 'https://sso.example.com/realms/acme', clientId: 'shipcove', mfa: 'auto' }, secretConfigured: true, lastTestAt: D.ago(60 * 24), lastTestResult: D.L('OK : configuration OIDC découverte', 'OK: OIDC configuration discovered'), callbackUrl: 'https://shipcove.example.com/api/v1/auth/sso/p-kc/callback' }];
      case '/admin/quotas/policies':
        return [{ id: 'qp-1', scope: 'global_user_default', subjectId: null, limit5h: '20000', limit7d: '120000', exempt: false, version: 3, createdAt: D.ago(60 * 24 * 10) }];
      case '/admin/quotas/ledger':
        return D.USAGE_REQUESTS.slice(0, 8).map((r, i) => ({ id: `l-${i}`, occurredAt: r.createdAt, userId: D.ME.id, kind: 'usage', estimated: false, amount: String(-(12 + i * 3.5)), inputTokens: 1800 + i * 420, outputTokens: 320 + i * 40, cacheReadTokens: 12000, cacheWriteTokens: 0, reason: null }));
      case '/admin/sandboxes':
        return [...this.workspaces.values()].filter((w) => w.ws.status === 'running').map((w) => ({ workspace: w.ws.name, owner: D.ME.displayName, s: { id: `sb-${w.ws.id}`, workspaceId: w.ws.id, status: 'running', provider: 'docker', destroyReason: null, lastActivityAt: w.ws.lastActivityAt } }));
      case '/admin/sandbox-images':
        return [{ id: 'img-1', name: 'shipcove-sandbox', version: '0.9.0', reference: 'ghcr.io/shipcove/shipcove-sandbox:0.9.0', digest: 'sha256:4b1d…e07a', piVersion: '0.58.1', status: 'active', isDefault: true }];
      case '/admin/secrets':
        return { health: { ok: true, version: 'v1.20.0', detail: '' }, infrastructure: [{ ref: 'litellm/master-key', configured: true, version: 2, updatedAt: D.ago(60 * 24 * 12) }, { ref: 'smtp/password', configured: true, version: 1, updatedAt: D.ago(60 * 24 * 40) }] };
      case '/admin/storage':
        return { health: { ok: true }, stats: { workspaces: 23, snapshots: 418, current_bytes: 2.4e9, bytes_uploaded: 9.8e9 }, unsynced: [] };
      case '/admin/smtp':
        return { configured: true, host: 'smtp.example.com', port: 587, secure: false, username: 'shipcove', fromAddress: 'shipcove@example.com' };
      case '/admin/email-templates':
        return [{ key: 'auth.verify_email', subject: D.L('Vérifiez votre adresse', 'Verify your address'), bodyText: D.L('Bonjour {{name}},\n\nConfirmez votre adresse : {{link}}', 'Hello {{name}},\n\nConfirm your address: {{link}}') }];
      case '/admin/retention':
        return [{ dataType: 'audit_events', retentionDays: 365, legalHold: false }, { dataType: 'llm_requests', retentionDays: 90, legalHold: false }, { dataType: 'workspace_snapshots', retentionDays: 30, legalHold: false }];
      case '/admin/deletion-jobs':
        return [{ id: 'dj-1', createdAt: D.ago(60 * 3), dataType: 'llm_requests', status: 'completed', stats: { deleted: 1840 } }];
      case '/admin/audit':
        return D.AUDIT;
      default:
        return [];
    }
  }

  private mutate({ method, path, body }: DemoRequest): unknown {
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;
    if (path === '/auth/logout') {
      this.loggedIn = false;
      return {};
    }
    if (path === '/auth/login' || path === '/auth/ldap/login') {
      this.loggedIn = true;
      return { status: 'authenticated', user: D.ME };
    }
    if (path === '/workspaces' && method === 'POST') return this.createWorkspace(b);
    if ((m = path.match(/^\/workspaces\/([^/]+)$/))) {
      const w = this.ws(m[1]);
      if (method === 'DELETE') {
        this.pi.interrupt(w.ws.id);
        this.workspaces.delete(w.ws.id);
        return {};
      }
      if (typeof b['name'] === 'string') b['titleSource'] = 'user';
      Object.assign(w.ws, b);
      return w.ws;
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/(start|stop)$/))) {
      const w = this.ws(m[1]);
      const starting = m[2] === 'start';
      this.emit(w.ws.id, 'workspace.status', { status: starting ? 'starting' : 'stopping', syncState: 'synced', detail: null });
      setTimeout(() => this.emit(w.ws.id, 'workspace.status', { status: starting ? 'running' : 'ready', syncState: 'synced', detail: null }), 900);
      return {};
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/messages$/))) return this.pi.message(this.ws(m[1]), b);
    if ((m = path.match(/^\/workspaces\/([^/]+)\/runs\/[^/]+\/interrupt$/))) {
      this.pi.interrupt(m[1]);
      return {};
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/git\/checkout$/))) {
      const w = this.ws(m[1]);
      const to = String(b['branch']);
      const from = w.ws.branch;
      if (!w.branches.includes(to)) w.branches.push(to);
      this.emit(w.ws.id, 'workspace.branch', { branch: to });
      this.emit(w.ws.id, 'message.created', { messageId: this.newId('msg'), role: 'system', text: from ? `Branche de travail : ${from} → ${to}` : `Branche de travail : ${to}`, attachmentIds: [], meta: { kind: 'branch_switched', from, to } });
      return {};
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/files$/)) && method === 'PUT') {
      const w = this.ws(m[1]);
      w.files[String(b['path'])] = String(b['content']);
      this.emit(w.ws.id, 'file.changed', { paths: [String(b['path'])], generation: 0 });
      return {};
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/attachments$/))) return this.attachments(body);
    if (/^\/workspaces\/[^/]+\/messages\/[^/]+$/.test(path)) return {};
    if (path === '/notifications/read') {
      const ids = (b['ids'] as string[] | undefined) ?? null;
      for (const n of this.notifications) if (!ids || ids.includes(n.id)) n.readAt ??= new Date().toISOString();
      return {};
    }
    if (path === '/notifications/preferences') return {};
    if ((m = path.match(/^\/skills\/([^/]+)\/installation$/))) {
      const s = this.skills.find((x) => x.id === m![1]);
      if (s) s.enabledForMe = !!b['enabled'];
      return {};
    }
    if ((m = path.match(/^\/skills\/([^/]+)$/)) && method === 'PATCH') {
      const s = this.skills.find((x) => x.id === m![1]);
      if (s && 'categoryId' in b) s.categoryId = (b['categoryId'] as string | null) ?? null;
      return s ?? {};
    }
    throw new DemoError(403, 'forbidden', UNAVAILABLE);
  }

  /* ------------------------------- Outils ------------------------------- */

  private createWorkspace(b: Record<string, unknown>): WorkspaceDto {
    const repo = b['repository'] as { fullName: string } | undefined;
    const r = repo ? D.repository(repo.fullName) : null;
    const id = this.newId('w');
    const ws: WorkspaceDto = {
      id, ownerId: D.ME.id, name: D.L('Nouvelle conversation', 'New conversation'), titleSource: 'auto', repository: r, status: 'starting', syncState: 'synced', branch: r ? 'main' : null,
      modelId: (b['modelId'] as string) ?? 'm-sonnet', thinkingLevel: (b['thinkingLevel'] as WorkspaceDto['thinkingLevel']) ?? 'medium', agentMode: (b['agentMode'] as WorkspaceDto['agentMode']) ?? 'autonomous',
      conversationId: `c-${id}`, activeRunId: null, activeRunStatus: null, lastActivityAt: new Date().toISOString(), lastCheckpointAt: null, createdAt: new Date().toISOString(), archivedAt: null, access: 'owner',
    };
    const files: Record<string, string> = r ? { 'README.md': `# ${r.fullName}\n`, 'src/index.ts': "export const hello = () => 'hello';\n" } : {};
    this.workspaces.set(id, { ws, messages: [], runs: [], approvals: [], base: { ...files }, files, branches: r ? ['main'] : [] });
    return ws;
  }

  private conversation(w: D.DemoWorkspace): ConversationDto {
    return {
      id: w.ws.conversationId,
      workspaceId: w.ws.id,
      ownerId: w.ws.ownerId,
      messages: structuredClone(w.messages),
      runs: structuredClone(w.runs),
      queued: [],
      lastEventId: this.eventIds.get(w.ws.id) ?? 0,
      context: { percent: w.messages.length ? Math.min(90, 8 + w.messages.length * 4) : 0 },
    };
  }

  private listDir(w: D.DemoWorkspace, dir: string): FileEntryDto[] {
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    const seen = new Map<string, FileEntryDto>();
    for (const [p, content] of Object.entries(w.files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      const full = prefix + head;
      if (tail.length) seen.set(full, { path: full, type: 'dir', size: 0 });
      else seen.set(full, { path: full, type: 'file', size: content.length });
    }
    return [...seen.values()].sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  }

  private changes(w: D.DemoWorkspace, scope: ChangesResponse['scope']): ChangesResponse {
    const files: FileChangeDto[] = [];
    const paths = new Set([...Object.keys(w.base), ...Object.keys(w.files)]);
    for (const p of [...paths].sort()) {
      const a = w.base[p];
      const b = w.files[p];
      if (a === b) continue;
      const { additions, deletions } = lineStats(a ?? '', b ?? '');
      files.push({ path: p, status: a === undefined ? 'added' : b === undefined ? 'deleted' : 'modified', additions, deletions, binary: false });
    }
    return { scope, baseLabel: 'HEAD', files };
  }

  private attachments(body: unknown): AttachmentDto[] {
    const out: AttachmentDto[] = [];
    if (!(body instanceof FormData)) return out;
    for (const f of body.getAll('files')) {
      if (!(f instanceof File)) continue;
      const id = this.newId('att');
      blobUrls.set(id, URL.createObjectURL(f));
      const dto: AttachmentDto = { id, fileName: f.name, mimeType: f.type || 'application/octet-stream', size: f.size, kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('text/') ? 'text' : 'binary', status: 'ready', rejectionReason: null, createdAt: new Date().toISOString() };
      this.pi.uploads.set(id, dto);
      out.push(dto);
    }
    return out;
  }

  private sessions(): SessionInfo[] {
    const ua = typeof navigator === 'undefined' ? null : navigator.userAgent;
    return [
      { id: 's-1', current: true, createdAt: D.ago(60), lastSeenAt: D.ago(0), expiresAt: D.ago(-60 * 24), ip: '10.0.4.21', userAgent: ua, authMethod: 'oidc' },
      { id: 's-2', current: false, createdAt: D.ago(60 * 30), lastSeenAt: D.ago(60 * 5), expiresAt: D.ago(-60 * 24 * 5), ip: '10.0.7.3', userAgent: lang === 'fr' ? 'Safari sur iPhone' : 'Safari on iPhone', authMethod: 'oidc' },
    ];
  }
}

/** Lignes ajoutées et retirées entre deux versions (comparaison simple, ligne à ligne). */
export function lineStats(a: string, b: string): { additions: number; deletions: number } {
  const al = a ? a.split('\n') : [];
  const bl = b ? b.split('\n') : [];
  const count = (l: string[]) => l.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(al);
  let common = 0;
  for (const x of bl) {
    const n = ca.get(x) ?? 0;
    if (n > 0) {
      common++;
      ca.set(x, n - 1);
    }
  }
  return { additions: bl.length - common, deletions: al.length - common };
}

export const server = new DemoServer();
