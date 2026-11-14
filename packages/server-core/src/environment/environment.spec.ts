import { describe, expect, it } from 'vitest';
import { StreamScrubber, scrubDeep, scrubSecrets } from './environment.service.js';

const SECRETS = ['s3cr3t-value-123', 'tok"en\\x9'];

describe('masquage des secrets', () => {
  it('masque les occurrences brutes et échappées JSON', () => {
    expect(scrubSecrets('a s3cr3t-value-123 b', SECRETS)).toBe('a *** b');
    expect(scrubSecrets(JSON.stringify({ v: 'tok"en\\x9' }), SECRETS)).toBe('{"v":"***"}');
    expect(scrubDeep({ cmd: 'echo s3cr3t-value-123' }, SECRETS)).toEqual({ cmd: 'echo ***' });
  });

  it('ne laisse jamais fuiter un secret coupé entre deux fragments de flux', () => {
    const text = 'Le jeton est s3cr3t-value-123, fin.';
    for (let cut = 1; cut < text.length; cut++) {
      for (let cut2 = cut + 1; cut2 <= text.length; cut2 += 3) {
        const sc = new StreamScrubber(SECRETS);
        const parts = [sc.push(text.slice(0, cut)), sc.push(text.slice(cut, cut2)), sc.push(text.slice(cut2))];
        const { rest, text: final } = sc.end();
        const streamed = parts.join('') + rest;
        expect(streamed).toBe(final);
        expect(streamed).toBe('Le jeton est ***, fin.');
        for (const p of parts) expect(p).not.toMatch(/s3cr3t-v/);
      }
    }
  });

  it('sans secret, le flux est transmis tel quel', () => {
    const sc = new StreamScrubber([]);
    expect(sc.push('abc')).toBe('abc');
    expect(sc.end().rest).toBe('');
  });
});
