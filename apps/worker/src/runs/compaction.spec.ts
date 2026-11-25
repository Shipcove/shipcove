import { describe, expect, it } from 'vitest';
import { buildSettingsJson, PI_KEEP_RECENT_TOKENS, PI_RESERVE_TOKENS } from '@cap/agent-runtime';
import { contextPercent } from '@cap/contracts';
import { nothingToCompact, sandboxLossReason } from './run-orchestrator.service.js';

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

describe('surveillance de la sandbox pendant un run', () => {
  const t0 = '2026-11-25T10:00:00Z';
  it('sandbox en marche, même démarrage : rien à signaler', () => {
    expect(sandboxLossReason({ state: 'running', exitCode: null, startedAt: t0 }, t0)).toBeNull();
    expect(sandboxLossReason({ state: 'creating', exitCode: null, startedAt: null }, t0)).toBeNull();
  });
  it('arrêt, disparition ou redémarrage : run à clore, avec la cause', () => {
    expect(sandboxLossReason({ state: 'stopped', exitCode: 137, startedAt: t0 }, t0)).toMatch(/arrêtée.*code 137.*mémoire/);
    expect(sandboxLossReason({ state: 'stopped', exitCode: 0, startedAt: t0 }, t0)).toMatch(/arrêtée.*code 0\)/);
    expect(sandboxLossReason({ state: 'missing', exitCode: null, startedAt: null }, t0)).toMatch(/disparu/);
    expect(sandboxLossReason({ state: 'running', exitCode: null, startedAt: '2026-11-25T10:05:00Z' }, t0)).toMatch(/redémarré/);
  });
});
