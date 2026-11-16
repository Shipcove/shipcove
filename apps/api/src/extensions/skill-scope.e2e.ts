import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginAdmin, startApp, type Client, type TestContext } from '../test/helpers.js';
import { writeZip } from './skill-archive.js';

let ctx: TestContext;
let admin: Client;
let user: { id: string; client: Client };
let skillId: string;

const zip = writeZip([{ path: 'SKILL.md', data: Buffer.from('---\nname: revue-code\ndescription: Revue de code maison\n---\n\n# Revue\n') }], 'revue-code');
const listOf = async (c: Client) => (await c.get('/skills')).body as Array<{ id: string; scope: string; canManage: boolean }>;

beforeAll(async () => {
  ctx = await startApp();
  admin = (await loginAdmin(ctx.app)).client;
  user = await createUser(ctx, 'skill-user');
  const r = await admin.agent.post('/api/v1/skills/import').set('X-CSRF-Token', admin.csrfToken).field('scope', 'personal').attach('file', zip, 'revue-code.zip');
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  skillId = r.body.id;
});
afterAll(async () => ctx?.close());

describe('Portée d’un skill importé en .zip (e2e)', () => {
  it('un skill personnel importé n’est pas visible des autres', async () => {
    expect((await listOf(user.client)).some((s) => s.id === skillId)).toBe(false);
  });

  it('un non-administrateur ne peut pas changer la portée', async () => {
    const own = await user.client.agent.post('/api/v1/skills/import').set('X-CSRF-Token', user.client.csrfToken).field('scope', 'personal').attach('file', zip, 'revue-code.zip');
    expect(own.status).toBe(201);
    expect((await user.client.put(`/skills/${own.body.id}/scope`, { scope: 'global' })).status).toBe(403);
    expect((await user.client.put(`/skills/${skillId}/scope`, { scope: 'global' })).status).toBe(403);
    // Import direct en global refusé aussi.
    const g = await user.client.agent.post('/api/v1/skills/import').set('X-CSRF-Token', user.client.csrfToken).field('scope', 'global').attach('file', zip, 'autre.zip');
    expect(g.status).toBe(403);
  });

  it('l’administrateur le rend global : disponible pour tous, non modifiable par eux', async () => {
    const r = await admin.put(`/skills/${skillId}/scope`, { scope: 'global' });
    expect(r.status).toBe(200);
    const seen = (await listOf(user.client)).find((s) => s.id === skillId);
    expect(seen).toMatchObject({ scope: 'global', canManage: false });
  });

  it('puis lui retire le caractère global', async () => {
    expect((await admin.put(`/skills/${skillId}/scope`, { scope: 'personal' })).status).toBe(200);
    expect((await listOf(user.client)).some((s) => s.id === skillId)).toBe(false);
    expect((await listOf(admin)).find((s) => s.id === skillId)).toMatchObject({ scope: 'personal', canManage: true });
  });

  it('import .zip directement en global par l’administrateur', async () => {
    const r = await admin.agent.post('/api/v1/skills/import').set('X-CSRF-Token', admin.csrfToken).field('scope', 'global').attach('file', zip, 'revue-code.zip');
    expect(r.status).toBe(201);
    expect((await listOf(user.client)).find((s) => s.id === r.body.id)?.scope).toBe('global');
    // Conflit de nom en promouvant le skill personnel homonyme.
    expect((await admin.put(`/skills/${skillId}/scope`, { scope: 'global' })).status).toBe(409);
  });
});
