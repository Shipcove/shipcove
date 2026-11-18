import { describe, expect, it } from 'vitest';
import { buildSettingsJson, PI_KEEP_RECENT_TOKENS } from '@cap/agent-runtime';
import { nothingToCompact } from './run-orchestrator.service.js';

describe('compaction', () => {
  it('traduit les refus de Pi qui ne sont pas des échecs', () => {
    expect(nothingToCompact('Compaction failed: Nothing to compact (session too small)')).toMatch(/^Rien à compacter : la conversation est encore courte/);
    expect(nothingToCompact('Already compacted')).toMatch(/déjà/);
    expect(nothingToCompact('Compaction failed: 429 rate limited')).toBeNull();
  });

  it('fixe explicitement le contexte récent conservé par Pi', () => {
    expect(JSON.parse(buildSettingsJson('m')).compaction).toEqual({ keepRecentTokens: PI_KEEP_RECENT_TOKENS });
  });
});
