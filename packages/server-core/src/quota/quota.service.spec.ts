import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { creditLedger, llmModels, llmRequests, modelCoefficients, quotaPolicies, users, type Database } from '@cap/database';
import { createTestDatabase, truncateAll } from '../testing.js';
import { SettingsService } from '../settings/settings.service.js';
import { QuotaExceededError, QuotaService } from './quota.service.js';

let db: Database;
let svc: QuotaService;
let userId: string;
let modelId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  svc = new QuotaService(db, new SettingsService(db, { on: async () => () => undefined } as never));
});
afterAll(async () => db.$client.end());

beforeEach(async () => {
  await truncateAll(db);
  [{ id: userId }] = await db.insert(users).values({ email: 'u@x.io', username: 'u', displayName: 'U' }).returning();
  [{ id: modelId }] = await db
    .insert(llmModels)
    .values({ litellmModel: 'test-model', displayName: 'Test', provider: 'mock', contextWindow: 100000, maxOutputTokens: 1000 })
    .returning();
  // 1 crédit / 1000 tokens d'entrée et de sortie.
  await db.insert(modelCoefficients).values({ modelId, version: 1, input: '1', output: '1', cacheRead: '0.1', cacheWrite: '1.25' });
});

const reserveInput = () => ({
  userId,
  workspaceId: null,
  runId: null,
  modelId,
  estimatedInputTokens: 1000,
  estimatedOutputTokens: 1000,
}); // = 2 crédits

describe('QuotaService (intégration PostgreSQL)', () => {
  it('réserve atomiquement sous concurrence : jamais au-delà de la limite', async () => {
    await db.insert(quotaPolicies).values({ scope: 'user', subjectId: userId, limit5h: '10', limit7d: '100' });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => svc.reserve(reserveInput())));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(5);
    expect(ko).toHaveLength(15);
    expect((ko[0] as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceededError);
    const rejected = await db.select().from(llmRequests).where(eq(llmRequests.status, 'rejected'));
    expect(rejected).toHaveLength(15);
  });

  it('régularise de façon idempotente et libère l’excédent', async () => {
    await db.insert(quotaPolicies).values({ scope: 'user', subjectId: userId, limit5h: '10', limit7d: '100' });
    const r = await svc.reserve(reserveInput());
    const usage = { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const [a, b] = await Promise.all([svc.settle(r.requestId, usage), svc.settle(r.requestId, usage)]);
    expect([a.alreadySettled, b.alreadySettled].sort()).toEqual([false, true]);
    const ledger = await db.select().from(creditLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe('0.60000000');
    const [w5] = await svc.userWindows(userId);
    expect(w5.used).toBe('0.60000000');
    expect(w5.reserved).toBe('0.00000000');
    expect(w5.remaining).toBe('9.40000000');
  });

  it('quota personnel : un compteur par personne, sans plafond d’équipe', async () => {
    await db.insert(quotaPolicies).values({ scope: 'user', subjectId: userId, limit5h: '3', limit7d: null });
    await svc.reserve(reserveInput());
    await expect(svc.reserve(reserveInput())).rejects.toMatchObject({ window: '5h' });
    // Une politique d'équipe active est refusée par la base.
    await expect(db.insert(quotaPolicies).values({ scope: 'team' as never, subjectId: userId, limit5h: '1', limit7d: null })).rejects.toThrow();
  });

  it('respecte exemptions et désactivation', async () => {
    await db.insert(quotaPolicies).values({ scope: 'user', subjectId: userId, limit5h: '1', limit7d: '1', exempt: true });
    await expect(svc.reserve(reserveInput())).resolves.toBeDefined();
  });

  it('le ledger est immuable', async () => {
    const r = await svc.reserve(reserveInput());
    await svc.settle(r.requestId, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await expect(db.update(creditLedger).set({ amount: '0' })).rejects.toThrow();
    await expect(db.delete(creditLedger)).rejects.toThrow();
  });

  it('les coefficients versionnés ne modifient pas les consommations passées', async () => {
    const r = await svc.reserve(reserveInput());
    await db.insert(modelCoefficients).values({ modelId, version: 2, input: '100', output: '100', cacheRead: '1', cacheWrite: '1' });
    const { credits } = await svc.settle(r.requestId, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(credits).toBe('1.00000000');
    await expect(db.update(modelCoefficients).set({ input: '0' })).rejects.toThrow();
  });
});
