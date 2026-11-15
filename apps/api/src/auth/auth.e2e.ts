import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generate } from 'otplib';
import { auditEvents, jobs, localCredentials } from '@cap/database';
import { Client, createUser, loginAdmin, startApp, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startApp();
});
afterAll(async () => ctx.close());

describe('Authentification locale (e2e)', () => {
  it('stocke les mots de passe en Argon2id', async () => {
    const [c] = await ctx.db.select().from(localCredentials).limit(1);
    expect(c.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('impose l’enrôlement MFA à l’administrateur puis exige le TOTP aux connexions suivantes', async () => {
    const { totpSecret } = await loginAdmin(ctx.app);
    const c = new Client(ctx.app);
    const r = await c.post('/auth/login', { login: 'admin', password: 'Admin-Password-123!' });
    expect(r.body).toEqual({ status: 'mfa_required', methods: ['totp', 'recovery_code'] });
    // La session en attente ne donne accès à rien.
    expect((await c.get('/me')).status).toBe(401);
    const bad = await c.post('/auth/mfa/verify', { code: '000000' });
    expect(bad.body.error.code).toBe('mfa_invalid');
    const ok = await c.post('/auth/mfa/verify', { code: await generate({ secret: totpSecret, epoch: Math.floor(Date.now() / 1000) + 30 }) });
    expect(ok.body.status).toBe('authenticated');
    const me = await c.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.platformRole).toBe('platform_admin');
    expect(me.body.mfaEnabled).toBe(true);
  });

  it('refuse les mutations sans jeton CSRF', async () => {
    const { client } = await createUser(ctx, 'csrfuser');
    const r = await client.agent.post('/api/v1/auth/sessions/revoke-others').send();
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_invalid');
    const ok = await client.post('/auth/sessions/revoke-others');
    expect(ok.status).toBe(204);
  });

  it('ne révèle pas l’existence d’un compte et verrouille après échecs répétés', async () => {
    await createUser(ctx, 'locked');
    const c = new Client(ctx.app);
    const unknown = await c.post('/auth/login', { login: 'nobody', password: 'whatever-password' });
    expect(unknown.body.error.code).toBe('invalid_credentials');
    for (let i = 0; i < 8; i++) await c.post('/auth/login', { login: 'locked', password: 'wrong-password-xx' });
    const r = await c.post('/auth/login', { login: 'locked', password: 'User-Password-123!' });
    expect(r.body.error.code).toBe('account_locked');
    const audits = await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.account_locked'));
    expect(audits.length).toBe(1);
  });

  it('réinitialise le mot de passe par lien à usage unique et révoque les sessions', async () => {
    const { client } = await createUser(ctx, 'resetme');
    await new Client(ctx.app).post('/auth/password/forgot', { email: 'resetme@example.test' });
    const all = await ctx.db.select().from(jobs).where(eq(jobs.queue, 'email.send'));
    const job = all.find((j) => (j.payload as { template: string }).template === 'auth.password_reset')!;
    const link = (job.payload as { vars: { link: string } }).vars.link;
    const token = new URL(link).searchParams.get('token')!;
    const anon = new Client(ctx.app);
    expect((await anon.post('/auth/password/reset', { token, password: 'Brand-New-Password-42' })).status).toBe(204);
    expect((await anon.post('/auth/password/reset', { token, password: 'Brand-New-Password-43' })).status).toBe(404);
    expect((await client.get('/me')).status).toBe(401);
    const relog = await new Client(ctx.app).post('/auth/login', { login: 'resetme', password: 'Brand-New-Password-42' });
    expect(relog.body.status).toBe('authenticated');
  });

  it('les inscriptions sont fermées par défaut', async () => {
    const r = await new Client(ctx.app).post('/auth/register', {
      email: 'new@example.test',
      username: 'newbie',
      displayName: 'New',
      password: 'Long-Enough-Password-1',
    });
    expect(r.body.error.code).toBe('registration_disabled');
  });

  it('liste et révoque les sessions', async () => {
    const { client } = await createUser(ctx, 'sessions');
    const second = new Client(ctx.app);
    await second.post('/auth/login', { login: 'sessions', password: 'User-Password-123!' });
    const list = await client.get('/auth/sessions');
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    expect((await client.delete(`/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await second.get('/me')).status).toBe(401);
  });
});
