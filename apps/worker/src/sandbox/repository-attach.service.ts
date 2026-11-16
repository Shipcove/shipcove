import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { toRepositoryDto } from '@cap/contracts';
import { conversations, gitConnections, messages, workspaces, type Database } from '@cap/database';
import { execCollect } from '@cap/sandbox';
import { DB, EventsService, GitProviderClient, GitProviderError, parseRemoteUrl } from '@cap/server-core';
import { CheckpointService } from './checkpoint.service.js';
import { SandboxManager, type ActiveSandbox } from './sandbox-manager.service.js';

/** Dépôt Git trouvé dans `/workspace` : à la racine (`dir = '.'`) ou dans un dossier de premier niveau. */
interface FoundRepo {
  dir: string;
  origin: string;
  branch: string;
  /** Le dossier contient lui-même un `.cap` (collision avec celui de la plateforme si on le remonte). */
  hasCap: boolean;
}

/** Inventaire lu dans la sandbox (Node, sans shell ni interpolation). */
const DETECT_SCRIPT = `
const fs = require('fs'), path = require('path'), cp = require('child_process');
const W = '/workspace';
const git = (dir, args) => { try { return cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); } catch { return ''; } };
const info = (dir) => ({ dir: path.relative(W, dir) || '.', origin: git(dir, ['remote', 'get-url', 'origin']), branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), hasCap: fs.existsSync(path.join(dir, '.cap')) });
const entries = fs.existsSync(W) ? fs.readdirSync(W).filter((n) => n !== '.cap') : [];
const repos = [];
if (fs.existsSync(path.join(W, '.git'))) repos.push(info(W));
else for (const n of entries) { const d = path.join(W, n); try { if (fs.lstatSync(d).isDirectory() && fs.existsSync(path.join(d, '.git'))) repos.push(info(d)); } catch {} }
process.stdout.write(JSON.stringify({ entries, repos }));
`;

/** Remonte le contenu d'un dossier de premier niveau à la racine de `/workspace` (nom passé en argument). */
const MOVE_SCRIPT = `set -euo pipefail
tmp="/workspace/.cap-attach-$$"
mv -- "/workspace/$1" "$tmp"
shopt -s dotglob nullglob
for f in "$tmp"/*; do mv -- "$f" /workspace/; done
rmdir -- "$tmp"`;

/** Consigne à Pi dans une conversation sans dépôt. */
export const NO_REPOSITORY_PROMPT =
  'Cette conversation n’est rattachée à aucun dépôt Git. Si tu dois travailler sur un dépôt, clone-le à la racine de l’espace de travail ' +
  '(`git clone <url> .` dans /workspace, vide) : la plateforme le rattachera automatiquement à la conversation (branche, modifications, publication).';

/**
 * Rattachement d'un dépôt cloné par Pi dans une conversation démarrée sans dépôt (issue #1) :
 * même état qu'une conversation créée avec ce dépôt (`repositoryId`, branche, remote `origin`,
 * base des modifications), persisté en base et annoncé en temps réel.
 *
 * Règles :
 *  - seul le premier dépôt est rattaché ; ensuite, d'autres clones ne changent rien ;
 *  - plusieurs dépôts trouvés en même temps : aucun rattachement automatique (ambigu), note dans le fil ;
 *  - le dépôt doit être sur un hôte pour lequel l'utilisateur a une connexion Git active ;
 *  - cloné dans un sous-dossier : son contenu est remonté à la racine, en fin de run seulement
 *    (jamais pendant que Pi travaille) et seulement si `/workspace` ne contient rien d'autre.
 */
@Injectable()
export class RepositoryAttachService {
  private readonly logger = new Logger('RepositoryAttach');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sandboxes: SandboxManager,
    private readonly checkpoints: CheckpointService,
    private readonly git: GitProviderClient,
    private readonly events: EventsService,
  ) {}

  /** Renvoie le nom complet du dépôt rattaché, ou `null`. Ne lève jamais : un échec laisse la conversation inchangée. */
  async tryAttach(sb: ActiveSandbox, opts: { runId: string | null; allowMove: boolean }): Promise<string | null> {
    try {
      return await this.attach(sb, opts);
    } catch (err) {
      this.logger.warn(`Rattachement du dépôt (${sb.workspaceId}) : ${(err as Error).message}`);
      return null;
    }
  }

  private async attach(sb: ActiveSandbox, opts: { runId: string | null; allowMove: boolean }): Promise<string | null> {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, sb.workspaceId));
    if (!ws || ws.repositoryId || ws.deletedAt) return null;

    const r = await execCollect(this.sandboxes.provider, sb.handle, ['node', '-e', DETECT_SCRIPT], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`inventaire impossible (code ${r.exitCode})`);
    const { entries, repos } = JSON.parse(r.stdout.toString('utf8')) as { entries: string[]; repos: FoundRepo[] };

    // Dépôts hébergés sur une forge connectée par l'utilisateur.
    const conns = await this.db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, ws.ownerId), eq(gitConnections.status, 'active'), isNull(gitConnections.revokedAt)))
      .orderBy(desc(gitConnections.lastUsedAt));
    const candidates = repos.flatMap((repo) => {
      const parsed = parseRemoteUrl(repo.origin);
      const conn = parsed && conns.find((c) => c.host.toLowerCase() === parsed.host);
      return parsed && conn ? [{ repo, fullName: parsed.fullName, conn }] : [];
    });
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      await this.note(ws.id, opts.runId, 'repository_ambiguous', `Plusieurs dépôts ont été clonés (${candidates.map((c) => c.fullName).join(', ')}) : aucun n’a été rattaché automatiquement à la conversation.`);
      return null;
    }
    const [c] = candidates;

    let movedFrom: string | null = null;
    if (c.repo.dir !== '.') {
      if (!opts.allowMove) return null; // en fin de run
      const others = entries.filter((n) => n !== c.repo.dir);
      if (others.length || c.repo.hasCap) {
        await this.note(ws.id, opts.runId, 'repository_not_attached', `Le dépôt ${c.fullName} a été cloné dans le dossier « ${c.repo.dir} », à côté d’autres fichiers : il n’a pas été rattaché à la conversation. Clonez-le à la racine de l’espace de travail pour qu’il le soit.`);
        return null;
      }
    }

    let row;
    try {
      row = await this.git.upsertRepository(this.db, c.conn, c.fullName);
    } catch (err) {
      if (err instanceof GitProviderError) {
        this.logger.warn(`Dépôt ${c.fullName} inaccessible avec la connexion ${c.conn.host} : ${err.message}`);
        return null;
      }
      throw err;
    }

    if (c.repo.dir !== '.') {
      const mv = await execCollect(this.sandboxes.provider, sb.handle, ['bash', '-c', MOVE_SCRIPT, 'cap-attach', c.repo.dir], { timeoutMs: 300_000 });
      if (mv.exitCode !== 0) throw new Error(`déplacement du dépôt impossible : ${mv.stderr.toString('utf8').slice(0, 300)}`);
      movedFrom = c.repo.dir;
    }
    // Remote comme pour une conversation créée avec le dépôt (identifiants injectés par la gateway).
    await execCollect(this.sandboxes.provider, sb.handle, ['git', '-C', '/workspace', 'remote', 'set-url', 'origin', row.cloneUrl], { timeoutMs: 15_000 });
    const branch = c.repo.branch && c.repo.branch !== 'HEAD' ? c.repo.branch : row.defaultBranch;

    // Base du panneau « Modifications » : l'état au moment du rattachement, comme après un clonage initial.
    const ck = await this.checkpoints.run({
      workspaceId: ws.id,
      fencingToken: sb.fencingToken,
      provider: this.sandboxes.provider,
      handle: sb.handle,
      reason: 'repository_attached',
      triggerKey: `repository_attached:${row.id}:${opts.runId ?? 'none'}`,
      runId: opts.runId,
    });
    const updated = await this.db
      .update(workspaces)
      .set({ repositoryId: row.id, branch, baselineGeneration: ck.generation, initialized: true, updatedAt: new Date() })
      .where(and(eq(workspaces.id, ws.id), isNull(workspaces.repositoryId)))
      .returning({ id: workspaces.id });
    if (updated.length === 0) return null; // rattaché entre-temps

    await this.events.emit(ws.id, 'workspace.repository', { repository: toRepositoryDto(row), branch }, opts.runId);
    await this.note(
      ws.id,
      opts.runId,
      'repository_attached',
      `Dépôt ${row.fullName} rattaché à la conversation (branche ${branch})${movedFrom ? ` ; son contenu a été déplacé de « ${movedFrom} » vers la racine de l’espace de travail` : ''}.`,
      { repositoryId: row.id, fullName: row.fullName, branch, movedFrom, agentNotified: !movedFrom },
    );
    return row.fullName;
  }

  /**
   * Note de la plateforme pour Pi au début du run suivant : un dépôt remonté à la racine change
   * les chemins qu'il connaît. Marquée comme transmise une fois lue.
   */
  async pendingAgentNote(workspaceId: string): Promise<string | null> {
    const [conv] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, workspaceId));
    if (!conv) return null;
    const rows = await this.db
      .select({ id: messages.id, meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.role, 'system'), sql`${messages.meta}->>'kind' = 'repository_attached'`, sql`(${messages.meta}->>'agentNotified')::boolean is false`));
    if (!rows.length) return null;
    const notes = rows.map((r) => {
      const m = r.meta as { fullName: string; movedFrom: string };
      return `[Note de la plateforme : le dépôt ${m.fullName} est désormais rattaché à cette conversation. Son contenu a été déplacé de /workspace/${m.movedFrom} vers /workspace : utilise désormais les chemins à partir de /workspace.]`;
    });
    for (const r of rows) await this.db.update(messages).set({ meta: { ...(r.meta as object), agentNotified: true } }).where(eq(messages.id, r.id));
    return notes.join('\n');
  }

  /** Message système du fil ; une note identique déjà présente n'est pas répétée. */
  private async note(workspaceId: string, runId: string | null, kind: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const [conv] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, workspaceId));
    if (!conv) return;
    const [dup] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.role, 'system'), eq(messages.text, text)))
      .limit(1);
    if (dup) return;
    const meta = { kind, ...extra };
    const [m] = await this.db.insert(messages).values({ conversationId: conv.id, runId, role: 'system', text, meta }).returning({ id: messages.id });
    await this.events.emit(workspaceId, 'message.created', { messageId: m.id, role: 'system', text, attachmentIds: [], meta }, runId);
  }
}
