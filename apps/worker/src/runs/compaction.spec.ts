import { describe, expect, it } from 'vitest';
import { buildSettingsJson, PI_KEEP_RECENT_TOKENS, PI_RESERVE_TOKENS } from '@cap/agent-runtime';
import { contextPercent } from '@cap/contracts';
import { nothingToCompact } from './run-orchestrator.service.js';

describe('compaction', () => {
  it('traduit les refus de Pi qui ne sont pas des échecs', () => {
    expect(nothingToCompact('Compaction failed: Nothing to compact (session too small)')).toMatch(/^Rien à compacter : la conversation est encore courte/);
    expect(nothingToCompact('Already compacted')).toMatch(/déjà/);
    expect(nothingToCompact('Compaction failed: 429 rate limited')).toBeNull();
  });

  it('fixe explicitement le contexte récent conservé et la marge de compaction de Pi', () => {
    expect(JSON.parse(buildSettingsJson('m')).compaction).toEqual({ keepRecentTokens: PI_KEEP_RECENT_TOKENS, reserveTokens: PI_RESERVE_TOKENS });
  });

  it('borne la jauge de contexte à 100 % (Pi peut dépasser la fenêtre pendant un long tour)', () => {
    expect(contextPercent(121_000, 100_000)).toBe(100);
    expect(contextPercent(45_400, 100_000)).toBe(45);
    expect(contextPercent(null, 100_000)).toBeNull();
    expect(contextPercent(1000, 0)).toBeNull();
    expect(contextPercent(1000, null)).toBeNull();
  });
});
