import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxProvider } from '@cap/sandbox';
import { BundleTooLargeError, TrustedBranch } from './trusted-branch.js';

/** « Sandbox » factice : les commandes visent un dépôt local à la place de /workspace. */
function fakeProvider(workspace: string): SandboxProvider {
  return {
    exec: async (_h: unknown, argv: string[]) => {
      const args = argv.slice(1).map((a) => (a === '/workspace' ? workspace : a));
      const p = spawn(argv[0], args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: workspace } });
      const code = new Promise<number>((r) => p.on('close', (c) => r(c ?? 1)));
      return { stdout: p.stdout, stderr: p.stderr, stdin: null, wait: () => code, kill: async () => void p.kill() };
    },
  } as unknown as SandboxProvider;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } })
    .toString()
    .trim();

describe('copie de confiance d’une branche (approbation et push)', () => {
  let ws: string;
  let tmp: string;
  let base: string;
  let head: string;

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'cap-ws-'));
    tmp = mkdtempSync(join(tmpdir(), 'cap-broker-'));
    git(ws, 'init', '-q', '-b', 'main');
    writeFileSync(join(ws, 'a.txt'), 'un\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-qm', 'base');
    base = git(ws, 'rev-parse', 'HEAD');
    git(ws, 'checkout', '-qb', 'feature');
    writeFileSync(join(ws, 'a.txt'), 'un\ndeux\n');
    writeFileSync(join(ws, '.gitattributes'), '* diff=menteur\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-qm', 'ajout de deux');
    head = git(ws, 'rev-parse', 'HEAD');
    // La sandbox tente de fausser l'affichage : pilote de diff externe dans SA configuration.
    git(ws, 'config', 'diff.menteur.command', 'echo rien a voir');
    git(ws, 'config', 'diff.external', 'echo rien a voir');
  });
  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('importe la branche et décrit le vrai diff, sans la configuration de la sandbox', async () => {
    const copy = await TrustedBranch.export(fakeProvider(ws), {} as never, 'feature', tmp);
    try {
      expect(copy.sha).toBe(head);
      const d = await copy.describe(base);
      expect(d.baseKnown).toBe(true);
      expect(d.commits.map((c) => c.subject)).toEqual(['ajout de deux']);
      expect(d.patch).toContain('+deux');
      expect(d.patch).not.toContain('rien a voir');
      expect(d.diffStat).toContain('a.txt');
    } finally {
      await copy.cleanup();
    }
  });

  it('base absente (branche distante divergente) : commits listés, diff indisponible', async () => {
    const copy = await TrustedBranch.export(fakeProvider(ws), {} as never, 'feature', tmp);
    try {
      const d = await copy.describe('f'.repeat(40));
      expect(d.baseKnown).toBe(false);
      expect(d.patch).toBeNull();
      expect(d.commits.length).toBe(2);
    } finally {
      await copy.cleanup();
    }
  });

  it('bundle plafonné : écrit sur disque et refusé au-delà de la limite', async () => {
    await expect(TrustedBranch.export(fakeProvider(ws), {} as never, 'feature', tmp, 100)).rejects.toBeInstanceOf(BundleTooLargeError);
  });
});
