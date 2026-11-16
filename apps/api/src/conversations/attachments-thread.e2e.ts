import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentEvents, agentRuns, conversations } from '@cap/database';
import { RunQueueService } from '@cap/server-core';
import { createUser, startApp, type Client, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
let owner: { id: string; client: Client };
let workspaceId: string;

async function upload(name: string, body: Buffer): Promise<string> {
  const r = await owner.client.agent
    .post(`/api/v1/workspaces/${workspaceId}/attachments`)
    .set('X-CSRF-Token', owner.client.csrfToken)
    .attach('files', body, name);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body[0].status).toBe('ready');
  return r.body[0].id;
}

beforeAll(async () => {
  ctx = await startApp();
  owner = await createUser(ctx, 'att-owner');
  workspaceId = (await owner.client.post('/workspaces', {})).body.id;
});
afterAll(async () => ctx?.close());

describe('Pièces jointes dans le fil (e2e)', () => {
  it('l’événement message.created et la conversation portent les fichiers joints, dans l’ordre', async () => {
    const a = await upload('notes.txt', Buffer.from('bonjour\n'));
    const b = await upload('data.csv', Buffer.from('a,b\n1,2\n'));
    const r = await owner.client.post(`/workspaces/${workspaceId}/messages`, { text: 'voici deux fichiers', attachmentIds: [b, a] }, { 'Idempotency-Key': crypto.randomUUID() });
    expect(r.status).toBe(201);

    const [ev] = await ctx.db.select().from(agentEvents).where(and(eq(agentEvents.workspaceId, workspaceId), eq(agentEvents.type, 'message.created')));
    const data = ev.data as { attachments: Array<{ id: string; fileName: string; size: number; kind: string }> };
    expect(data.attachments.map((x) => x.id)).toEqual([b, a]);
    expect(data.attachments[1]).toMatchObject({ fileName: 'notes.txt', size: 8, kind: 'text' });

    const conv = await owner.client.get(`/workspaces/${workspaceId}/conversation`);
    const msg = (conv.body.messages as Array<{ id: string; attachments: Array<{ id: string }> }>).find((m) => m.id === r.body.messageId)!;
    expect(msg.attachments.map((x) => x.id).sort()).toEqual([a, b].sort());

    const dl = await owner.client.get(`/workspaces/${workspaceId}/attachments/${a}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
  });

  it('un message mis en file d’attente garde ses fichiers à sa promotion', async () => {
    const c = await upload('image-like.txt', Buffer.from('contenu\n'));
    // Un run est actif (créé par le test précédent) : le message part en file d'attente.
    const r = await owner.client.post(`/workspaces/${workspaceId}/messages`, { text: 'en attente', attachmentIds: [c], delivery: 'follow_up' }, { 'Idempotency-Key': crypto.randomUUID() });
    expect(r.status).toBe(201);
    expect(r.body.queued).toBe(true);
    // Fin du run courant puis promotion.
    await ctx.db.update(agentRuns).set({ status: 'completed', endedAt: new Date() }).where(eq(agentRuns.workspaceId, workspaceId));
    const [conv] = await ctx.db.select().from(conversations).where(eq(conversations.workspaceId, workspaceId));
    expect(await ctx.app.get(RunQueueService).startNext(conv.id)).not.toBeNull();
    const evs = await ctx.db.select().from(agentEvents).where(and(eq(agentEvents.workspaceId, workspaceId), eq(agentEvents.type, 'message.created')));
    const last = evs.at(-1)!.data as { messageId: string; attachmentIds: string[]; attachments: Array<{ id: string }> };
    expect(last.messageId).toBe(r.body.messageId);
    expect(last.attachmentIds).toEqual([c]);
    expect(last.attachments.map((x) => x.id)).toEqual([c]);
  });
});
