import { describe, expect, it } from 'vitest';
import { classify, normalizeSharedPath } from './agent-files.service.js';

describe('fichiers partagés par Pi', () => {
  it('confine les chemins à /workspace et /tmp', () => {
    expect(normalizeSharedPath('README.md')).toBe('/workspace/README.md');
    expect(normalizeSharedPath('./docs/../out/rapport.pdf')).toBe('/workspace/out/rapport.pdf');
    expect(normalizeSharedPath('/tmp/export.csv')).toBe('/tmp/export.csv');
    expect(normalizeSharedPath('/workspace/../etc/passwd')).toBeNull();
    expect(normalizeSharedPath('../../etc/shadow')).toBeNull();
    expect(normalizeSharedPath('/etc/passwd')).toBeNull();
    expect(normalizeSharedPath('/workspacex/a')).toBeNull();
    expect(normalizeSharedPath('/tmpfoo')).toBeNull();
    expect(normalizeSharedPath('/workspace-state/pi-sessions/s.jsonl')).toBeNull();
    expect(normalizeSharedPath('/workspace/.cap/screenshots/a.png')).toBeNull();
    expect(normalizeSharedPath('a\0b')).toBeNull();
    expect(normalizeSharedPath('  ')).toBeNull();
  });

  it('classe le contenu', () => {
    expect(classify(Buffer.from('# Titre\n'), 'README.md')).toEqual({ kind: 'text', mime: 'text/plain' });
    expect(classify(Buffer.from('%PDF-1.7\n\0\0'), 'r.pdf').kind).toBe('binary');
    expect(classify(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'site.zip').kind).toBe('archive');
    expect(classify(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(0)]), 'a.png').kind).toBe('image');
    expect(classify(Buffer.from([0, 1, 2, 3]), 'data.bin').kind).toBe('binary');
  });
});
