import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
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
  const r = await admin.agent.post('/api/v1/skills/import').set('X-CSRF-Token', admin.csrfToken).attach('file', zip, 'revue-code.zip');
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  skillId = r.body.id;
});
afterAll(async () => ctx?.close());

describe('Portée d’un skill importé en .zip (e2e)', () => {
  it('un skill personnel importé n’est pas visible des autres', async () => {
    expect((await listOf(user.client)).some((s) => s.id === skillId)).toBe(false);
  });

  it('un non-administrateur ne peut pas changer la portée', async () => {
    const own = await user.client.agent.post('/api/v1/skills/import').set('X-CSRF-Token', user.client.csrfToken).attach('file', zip, 'revue-code.zip');
    expect(own.status).toBe(201);
    expect((await user.client.put(`/skills/${own.body.id}/scope`, { scope: 'global' })).status).toBe(403);
    expect((await user.client.put(`/skills/${skillId}/scope`, { scope: 'global' })).status).toBe(403);
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

  it('création et import sont toujours personnels : une portée demandée est ignorée', async () => {
    const z2 = writeZip([{ path: 'SKILL.md', data: Buffer.from('---\nname: autre-skill\ndescription: Autre\n---\n') }], 'autre-skill');
    const imp = await admin.agent.post('/api/v1/skills/import').set('X-CSRF-Token', admin.csrfToken).field('scope', 'global').attach('file', z2, 'autre-skill.zip');
    expect(imp.status).toBe(201);
    const created = await admin.post('/skills', { name: 'cree-en-global', scope: 'global', files: [{ path: 'SKILL.md', content: '---\nname: cree-en-global\ndescription: X\n---\n' }] });
    expect(created.status).toBe(201);
    for (const id of [imp.body.id, created.body.id]) {
      expect((await listOf(admin)).find((s) => s.id === id)?.scope).toBe('personal');
      expect((await listOf(user.client)).some((s) => s.id === id)).toBe(false);
    }
  });

  it('conflit de nom en rendant global un skill homonyme d’un skill global', async () => {
    expect((await admin.put(`/skills/${skillId}/scope`, { scope: 'global' })).status).toBe(200);
    const mine = await admin.agent.post('/api/v1/skills/import').set('X-CSRF-Token', admin.csrfToken).field('name', 'revue-code-2').attach('file', zip, 'x.zip');
    expect(mine.status).toBe(201);
    // Homonyme (renommé en base : deux skills personnels d'un même auteur ne peuvent pas l'être).
    await ctx.db.execute(sql`update skills set name = 'revue-code' where id = ${mine.body.id}`);
    expect((await admin.put(`/skills/${mine.body.id}/scope`, { scope: 'global' })).status).toBe(409);
  });
});
