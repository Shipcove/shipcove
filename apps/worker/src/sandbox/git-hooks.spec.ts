import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELAYED_HOOKS, coAuthorPrompt, coAuthorTrailer, gitHookFiles, hookScript } from './git-hooks.js';

const TRAILER = 'Co-Authored-By: Shipcove <noreply@shipcove.dev>';

/** Dépôt temporaire dont les hooks globaux sont ceux de la plateforme. */
function repo(trailer: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'cap-hooks-'));
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  for (const h of RELAYED_HOOKS) {
    writeFileSync(join(hooks, h), hookScript(trailer));
    chmodSync(join(hooks, h), 0o755);
  }
  const dir = join(root, 'repo');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  const git = (...args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env });
  return { dir, git };
}

describe('hooks Git de la sandbox', () => {
  it('mention de co-auteur : adresse réglable, vide = aucune', () => {
    expect(coAuthorTrailer(' noreply@shipcove.dev ')).toBe(TRAILER);
    expect(coAuthorTrailer('')).toBeNull();
    expect(coAuthorPrompt(null)).toBeNull();
    expect(coAuthorPrompt(TRAILER)).toContain(TRAILER);
    expect(gitHookFiles(TRAILER).every((f) => f.mode === 0o755 && f.path.startsWith('home/agent/.cap/git-hooks/'))).toBe(true);
  });

  it('ajoute la mention à chaque commit, sans doublon', () => {
    const { dir, git } = repo(TRAILER);
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: a');
    expect(git('log', '-1', '--format=%B').trim()).toBe(`feat: a\n\n${TRAILER}`);
    git('commit', '-q', '--amend', '-m', `feat: a\n\n${TRAILER}`);
    expect(git('log', '-1', '--format=%B').match(/Co-Authored-By/g)).toHaveLength(1);
  });

  it('relaie vers les hooks du dépôt (un refus du dépôt bloque le commit)', () => {
    const { dir, git } = repo(TRAILER);
    const own = join(dir, '.git', 'hooks', 'commit-msg');
    writeFileSync(own, '#!/bin/sh\necho "vu par le dépôt" >> "$(git rev-parse --git-dir)/seen"\ngrep -q "^feat" "$1"\n');
    chmodSync(own, 0o755);
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    expect(() => git('commit', '-q', '-m', 'mauvais message')).toThrow();
    git('commit', '-q', '-m', 'feat: ok');
    expect(readFileSync(join(dir, '.git', 'seen'), 'utf8')).toContain('vu par le dépôt');
    expect(git('log', '-1', '--format=%B')).toContain(TRAILER);
  });

  it('sans adresse : aucun ajout, relais conservé', () => {
    const { dir, git } = repo(null);
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'chore: a');
    expect(git('log', '-1', '--format=%B').trim()).toBe('chore: a');
  });
});
