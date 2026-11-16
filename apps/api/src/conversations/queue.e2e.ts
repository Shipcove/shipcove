import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { conversations, messages } from '@cap/database';
import { createUser, startApp, type Client, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
let owner: { id: string; client: Client };
let other: { id: string; client: Client };
let workspaceId: string;
let conversationId: string;

async function queue(text: string): Promise<string> {
  const [m] = await ctx.db.insert(messages).values({ conversationId, role: 'user', authorId: owner.id, text, pendingDelivery: true }).returning();
  return m.id;
}
const queued = async () => (await owner.client.get(`/workspaces/${workspaceId}/conversation`)).body.queued as Array<{ messageId: string; text: string }>;

beforeAll(async () => {
  ctx = await startApp();
  owner = await createUser(ctx, 'queue-owner');
  other = await createUser(ctx, 'queue-other');
  const r = await owner.client.post('/workspaces', {});
  expect(r.status).toBe(201);
  workspaceId = r.body.id;
  const [conv] = await ctx.db.select().from(conversations).where(eq(conversations.workspaceId, workspaceId));
  conversationId = conv.id;
});
afterAll(async () => ctx?.close());

describe('File d’attente des messages (e2e)', () => {
  it('supprime uniquement le message choisi, en conservant l’ordre des autres', async () => {
    const a = await queue('premier');
    const b = await queue('deuxième');
    const c = await queue('troisième');
    const r = await owner.client.delete(`/workspaces/${workspaceId}/messages/${b}`);
    expect(r.status).toBe(204);
    expect((await queued()).map((q) => q.messageId)).toEqual([a, c]);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, b));
    expect(row.pendingDelivery).toBe(false);
    expect(row.deletedAt).not.toBeNull();
  });

  it('modifie le texte d’un message en attente', async () => {
    const id = await queue('à corriger');
    const r = await owner.client.patch(`/workspaces/${workspaceId}/messages/${id}`, { text: 'corrigé' });
    expect(r.status).toBe(200);
    expect((await queued()).find((q) => q.messageId === id)?.text).toBe('corrigé');
  });

  it('refuse un message déjà transmis', async () => {
    const id = await queue('transmis');
    await ctx.db.update(messages).set({ pendingDelivery: false }).where(and(eq(messages.id, id)));
    expect((await owner.client.delete(`/workspaces/${workspaceId}/messages/${id}`)).status).toBe(409);
    expect((await owner.client.patch(`/workspaces/${workspaceId}/messages/${id}`, { text: 'x' })).status).toBe(409);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
    expect(row.deletedAt).toBeNull();
    expect(row.text).toBe('transmis');
  });

  it('refuse un autre utilisateur', async () => {
    const id = await queue('privé');
    const r = await other.client.delete(`/workspaces/${workspaceId}/messages/${id}`);
    expect([403, 404]).toContain(r.status);
    expect((await queued()).some((q) => q.messageId === id)).toBe(true);
  });
});
