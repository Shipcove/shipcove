import { describe, expect, it } from 'vitest';
import { computeCredits, normalizeOpenAiUsage } from './credits.js';

const coeffs = { input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' };

describe('crédits pondérés', () => {
  it('ne double-compte pas les tokens cache (prompt_tokens inclut le cache)', () => {
    const u = normalizeOpenAiUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 600 },
      cache_creation_input_tokens: 100,
    })!;
    expect(u).toEqual({ inputTokens: 300, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100 });
    // (300*3 + 200*15 + 600*0.3 + 100*3.75)/1000 = (900+3000+180+375)/1000 = 4.455
    expect(computeCredits(u, coeffs).toFixed(8)).toBe('4.45500000');
  });

  it('calcule en décimal exact', () => {
    const c = computeCredits({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { ...coeffs, input: '0.1' });
    expect(c.toFixed(8)).toBe('0.00010000');
    const sum = [1, 2].reduce((acc) => acc.add(computeCredits({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { ...coeffs, input: '0.1' })), c.mul(0));
    expect(sum.toFixed(8)).toBe('0.00020000');
  });

  it('renvoie null si usage absent (pas de consommation inventée)', () => {
    expect(normalizeOpenAiUsage(undefined)).toBeNull();
    expect(normalizeOpenAiUsage({})).toBeNull();
  });
});
