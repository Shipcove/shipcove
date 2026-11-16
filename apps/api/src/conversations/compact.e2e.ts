import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRuns, messages } from '@cap/database';
import { createUser, startApp, type Client, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
let owner: { id: string; client: Client };
let workspaceId: string;
const send = (body: Record<string, unknown>) => owner.client.post(`/workspaces/${workspaceId}/messages`, body, { 'Idempotency-Key': crypto.randomUUID() });

beforeAll(async () => {
  ctx = await startApp();
  owner = await createUser(ctx, 'compact-owner');
  workspaceId = (await owner.client.post('/workspaces', {})).body.id;
});
afterAll(async () => ctx?.close());

describe('/compact (e2e)', () => {
  it('crée un run dont le message déclencheur porte la commande', async () => {
    const r = await send({ text: '/compact garde les décisions', command: 'compact' });
    expect(r.status).toBe(201);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.id, r.body.messageId));
    expect(m.meta).toEqual({ kind: 'compact' });
    const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, r.body.runId));
    expect(run.triggerMessageId).toBe(m.id);
  });

  it('pendant un run : mise en file d’attente possible, guidage refusé', async () => {
    expect((await send({ text: '/compact', command: 'compact', delivery: 'steer' })).status).toBe(400);
    const q = await send({ text: '/compact', command: 'compact', delivery: 'follow_up' });
    expect(q.status).toBe(201);
    expect(q.body.queued).toBe(true);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.id, q.body.messageId));
    expect(m).toMatchObject({ pendingDelivery: true, meta: { kind: 'compact' } });
  });

  it('refuse une commande inconnue', async () => {
    expect((await send({ text: '/x', command: 'reset' })).status).toBe(400);
  });
});
