import { Readable } from 'node:stream';
import { Controller, Get, Inject, Logger, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { gitConnections, projects, repositories, workspaces, type Database } from '@cap/database';
import { DB, GitProviderClient, redactString } from '@cap/server-core';
import { RunTokenService } from '../run-token.service.js';

const PUSH_DENIED =
  'Publication refusée : les pushs passent par une approbation explicite (outil platform_git_push). ' +
  'Aucun credential de publication n’est disponible dans la sandbox.';

/**
 * Proxy Git « smart HTTP » en **lecture seule** pour les sandboxes (ADR 0007).
 * Seul `git-upload-pack` (clone/fetch/pull) est relayé ; le credential du propriétaire du
 * workspace est injecté côté serveur et n'est jamais transmis à la sandbox.
 */
@Controller('git')
export class GitReadProxyController {
  private readonly logger = new Logger('GitReadProxy');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tokens: RunTokenService,
    private readonly git: GitProviderClient,
  ) {}

  @Get(':repoId/info/refs')
  async infoRefs(@Param('repoId') repoId: string, @Req() req: Request, @Res() res: Response) {
    const service = String(req.query.service ?? '');
    if (service !== 'git-upload-pack') return res.status(403).type('text/plain').send(PUSH_DENIED);
    const target = await this.resolve(repoId, req, res);
    if (!target) return;
    await this.forward(`${target.url}/info/refs?service=git-upload-pack`, 'GET', target.auth, req, res);
  }

  @Post(':repoId/git-upload-pack')
  async uploadPack(@Param('repoId') repoId: string, @Req() req: Request, @Res() res: Response) {
    const target = await this.resolve(repoId, req, res);
    if (!target) return;
    await this.forward(`${target.url}/git-upload-pack`, 'POST', target.auth, req, res);
  }

  @Post(':repoId/git-receive-pack')
  receivePack(@Res() res: Response) {
    res.status(403).type('text/plain').send(PUSH_DENIED);
  }

  private async resolve(repoIdWithSuffix: string, req: Request, res: Response): Promise<{ url: string; auth: string | null } | null> {
    const repoId = repoIdWithSuffix.replace(/\.git$/, '');
    const principal = await this.tokens.authenticate(req.headers.authorization);
    if (!principal) {
      res.status(401).setHeader('WWW-Authenticate', 'Bearer').send('Jeton de run requis');
      return null;
    }
    const [row] = await this.db
      .select({ repo: repositories })
      .from(workspaces)
      .innerJoin(projects, eq(projects.id, workspaces.projectId))
      .innerJoin(repositories, eq(repositories.id, projects.repositoryId))
      .where(and(eq(workspaces.id, principal.workspaceId), eq(repositories.id, repoId)));
    if (!row) {
      res.status(404).send('Dépôt non associé à ce workspace');
      return null;
    }
    // Credential de lecture : connexion active du propriétaire du workspace pour cet hôte.
    const [conn] = await this.db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, principal.userId), eq(gitConnections.host, row.repo.host), eq(gitConnections.status, 'active'), isNull(gitConnections.revokedAt)))
      .orderBy(desc(gitConnections.lastUsedAt))
      .limit(1);
    let auth: string | null = null;
    if (conn) {
      const token = await this.git.token(conn);
      const user = conn.provider.startsWith('github') ? 'x-access-token' : 'oauth2';
      auth = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
      await this.db.update(gitConnections).set({ lastUsedAt: new Date() }).where(eq(gitConnections.id, conn.id));
    }
    return { url: row.repo.cloneUrl.replace(/\/$/, ''), auth };
  }

  private async forward(url: string, method: 'GET' | 'POST', auth: string | null, req: Request, res: Response): Promise<void> {
    const headers: Record<string, string> = { 'User-Agent': 'git/2 (coding-agent-platform)' };
    for (const h of ['content-type', 'content-encoding', 'accept', 'git-protocol']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    if (auth) headers.Authorization = auth;
    try {
      const upstream = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? (Readable.toWeb(req) as ReadableStream) : undefined,
        duplex: method === 'POST' ? 'half' : undefined,
        redirect: 'follow',
      } as RequestInit & { duplex?: 'half' });
      res.status(upstream.status);
      for (const h of ['content-type', 'cache-control']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (upstream.status === 401 || upstream.status === 403) {
        res.type('text/plain').send('Accès au dépôt refusé : rattachez un compte Git autorisé dans vos paramètres.');
        return;
      }
      if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
      else res.end();
    } catch (err) {
      this.logger.warn(`Proxy Git : ${redactString((err as Error).message)}`);
      if (!res.headersSent) res.status(502).send('Forge injoignable');
      else res.end();
    }
  }
}
