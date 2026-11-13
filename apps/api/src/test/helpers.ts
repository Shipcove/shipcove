import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { generate } from 'otplib';
import { truncateAll, createTestDatabase } from '@cap/server-core';
import type { Database } from '@cap/database';
import { ApiEnvSchema, type ApiEnv } from '../env.js';
import { createApp } from '../setup-app.js';

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return ApiEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://cap:cap@127.0.0.1:5433/cap_test',
    DATABASE_MIGRATE_ON_START: 'true',
    VAULT_ADDR: process.env.TEST_VAULT_ADDR ?? 'http://127.0.0.1:8299',
    VAULT_AUTH_METHOD: 'token',
    VAULT_TOKEN: 'root',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:3910',
    S3_BUCKET: 'cap-test',
    S3_ATTACHMENTS_BUCKET: 'cap-test',
    COOKIE_SECURE: 'false',
    PUBLIC_URL: 'http://localhost:4200',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'Admin-Password-123!',
    ...overrides,
  });
}

export interface TestContext {
  app: NestExpressApplication;
  db: Database;
  close(): Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const db = await createTestDatabase();
  await truncateAll(db);
  const app = await createApp(testEnv(overrides), { logger: false });
  await app.init();
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.$client.end();
    },
  };
}

/** Client HTTP avec cookies et en-tête CSRF automatique (comme le front Angular). */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  private csrf = '';
  constructor(app: NestExpressApplication) {
    this.agent = request.agent(app.getHttpServer());
  }
  private capture(res: request.Response) {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    for (const c of cookies) {
      const m = /^cap_csrf=([^;]*)/.exec(c);
      if (m) this.csrf = decodeURIComponent(m[1]);
    }
    return res;
  }
  async get(url: string) {
    return this.capture(await this.agent.get(`/api/v1${url}`));
  }
  async post(url: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.capture(await this.agent.post(`/api/v1${url}`).set({ 'X-CSRF-Token': this.csrf, ...headers }).send(body as object));
  }
  async put(url: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.capture(await this.agent.put(`/api/v1${url}`).set({ 'X-CSRF-Token': this.csrf, ...headers }).send(body as object));
  }
  async patch(url: string, body?: unknown) {
    return this.capture(await this.agent.patch(`/api/v1${url}`).set('X-CSRF-Token', this.csrf).send(body as object));
  }
  async delete(url: string) {
    return this.capture(await this.agent.delete(`/api/v1${url}`).set('X-CSRF-Token', this.csrf));
  }
  get csrfToken() {
    return this.csrf;
  }
}

/** Connexion de l'administrateur initial, avec enrôlement TOTP imposé par la politique. */
export async function loginAdmin(app: NestExpressApplication): Promise<{ client: Client; totpSecret: string }> {
  const client = new Client(app);
  const r = await client.post('/auth/login', { login: 'admin@example.test', password: 'Admin-Password-123!' });
  if (r.body.status !== 'mfa_enrollment_required') throw new Error(`login admin: ${JSON.stringify(r.body)}`);
  const e = await client.post('/auth/mfa/totp/enroll');
  const code = await generate({ secret: e.body.secret });
  const c = await client.post('/auth/mfa/totp/confirm', { code });
  if (c.status !== 200) throw new Error(`confirm: ${JSON.stringify(c.body)}`);
  return { client, totpSecret: e.body.secret };
}

/** Crée un utilisateur local actif directement en base (tests). */
export async function createUser(ctx: TestContext, username: string, password = 'User-Password-123!'): Promise<{ id: string; client: Client }> {
  const { users, localCredentials } = await import('@cap/database');
  const { hash } = await import('@node-rs/argon2');
  const [u] = await ctx.db
    .insert(users)
    .values({ email: `${username}@example.test`, username, displayName: username.toUpperCase(), status: 'active', emailVerifiedAt: new Date() })
    .returning();
  await ctx.db.insert(localCredentials).values({ userId: u.id, passwordHash: await hash(password, { algorithm: 2 }) });
  const client = new Client(ctx.app);
  const r = await client.post('/auth/login', { login: username, password });
  if (r.body.status !== 'authenticated') throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return { id: u.id, client };
}
