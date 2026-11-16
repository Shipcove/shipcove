import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversationShares, conversations } from '@cap/database';
import { createUser, startApp, type Client, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
let owner: { id: string; client: Client };
let alice: { id: string; client: Client };
let bob: { id: string; client: Client };
let workspaceId: string;
let conversationId: string;

const visibleTo = async (c: Client) => ((await c.get('/workspaces')).body as Array<{ id: string }>).some((w) => w.id === workspaceId);

beforeAll(async () => {
  ctx = await startApp();
  owner = await createUser(ctx, 'share-owner');
  alice = await createUser(ctx, 'share-alice');
  bob = await createUser(ctx, 'share-bob');
  workspaceId = (await owner.client.post('/workspaces', {})).body.id;
  [{ id: conversationId }] = await ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, workspaceId));
  for (const u of [alice, bob]) expect((await owner.client.post(`/conversations/${conversationId}/shares`, { userId: u.id })).status).toBe(201);
});
afterAll(async () => ctx?.close());

describe('Retrait d’un partage par son destinataire (e2e)', () => {
  it('retire la conversation pour ce destinataire seulement', async () => {
    expect(await visibleTo(alice.client)).toBe(true);
    expect((await alice.client.delete(`/workspaces/${workspaceId}/share`)).status).toBe(204);
    expect(await visibleTo(alice.client)).toBe(false);
    expect((await alice.client.get(`/workspaces/${workspaceId}/conversation`)).status).toBe(404);
    // Propriétaire et autre destinataire inchangés.
    expect(await visibleTo(owner.client)).toBe(true);
    expect(await visibleTo(bob.client)).toBe(true);
    const shares = await ctx.db.select().from(conversationShares).where(eq(conversationShares.conversationId, conversationId));
    expect(shares.filter((s) => s.revokedAt === null).map((s) => s.userId)).toEqual([bob.id]);
  });

  it('n’agit que sur le partage de l’utilisateur courant', async () => {
    expect((await alice.client.delete(`/workspaces/${workspaceId}/share`)).status).toBe(404);
    expect((await owner.client.delete(`/workspaces/${workspaceId}/share`)).status).toBe(404);
    expect(await visibleTo(bob.client)).toBe(true);
  });

  it('le propriétaire peut partager de nouveau', async () => {
    expect((await owner.client.post(`/conversations/${conversationId}/shares`, { userId: alice.id })).status).toBe(201);
    expect(await visibleTo(alice.client)).toBe(true);
  });
});
