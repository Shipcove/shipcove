import { describe, expect, it } from 'vitest';
import { csvSafe } from './admin.controller.js';

describe('export CSV de l’audit', () => {
  it('neutralise les formules de tableur', () => {
    expect(csvSafe('=HYPERLINK("http://x","clic")')).toBe(`'=HYPERLINK("http://x","clic")`);
    for (const v of ['+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(csvSafe(v).startsWith("'")).toBe(true);
    expect(csvSafe('alice@example.com')).toBe('alice@example.com');
    expect(csvSafe('2026-11-25T10:00:00.000Z')).toBe('2026-11-25T10:00:00.000Z');
  });
});
