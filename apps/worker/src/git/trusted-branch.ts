import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';
import type { SandboxHandle, SandboxProvider } from '@cap/sandbox';

const run = promisify(execFile);

/** Taille maximale du bundle d'une branche (écrit sur disque, jamais gardé en mémoire). */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;

export class BundleTooLargeError extends Error {}

/**
 * Copie de confiance d'une branche de la sandbox : le bundle Git exporté par la sandbox est écrit
 * sur le disque du worker puis importé dans un dépôt nu local. Tout ce qui est affiché à l'humain
 * (commits, diff) et tout ce qui est poussé vient de cette copie, lue par le `git` du worker :
 * la sandbox, contrôlée par l'agent, ne peut ni fausser l'affichage ni changer le contenu publié.
 */
export class TrustedBranch {
  private constructor(
    readonly dir: string,
    readonly repo: string,
    /** Commit de tête importé (`refs/heads/cap-push`). */
    readonly sha: string,
  ) {}

  /** Environnement Git du worker : aucune configuration système ni utilisateur, aucune invite. */
  static env(dir: string): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: dir };
  }

  static async export(provider: SandboxProvider, handle: SandboxHandle, localBranch: string, tmpRoot: string, maxBytes = MAX_BUNDLE_BYTES): Promise<TrustedBranch> {
    await mkdir(tmpRoot, { recursive: true });
    const dir = await mkdtemp(join(tmpRoot, 'branch-'));
    try {
      const bundle = join(dir, 'x.bundle');
      const proc = await provider.exec(handle, ['git', '-C', '/workspace', 'bundle', 'create', '-', `refs/heads/${localBranch}`], { timeoutMs: 600_000 });
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) cb(new BundleTooLargeError(`Branche trop volumineuse pour être publiée (> ${Math.round(maxBytes / 1024 / 1024)} Mo)`));
          else cb(null, chunk);
        },
      });
      const stderr: Buffer[] = [];
      proc.stderr.on('data', (c: Buffer) => {
        if (stderr.length < 64) stderr.push(c);
      });
      try {
        await pipeline(proc.stdout, limit, createWriteStream(bundle));
      } catch (err) {
        await proc.kill().catch(() => undefined);
        throw err;
      }
      const code = await proc.wait();
      if (code !== 0) throw new Error(`git bundle : ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`);
      const env = TrustedBranch.env(dir);
      const repo = join(dir, 'repo.git');
      await run('git', ['init', '--bare', '-q', repo], { env });
      await run('git', ['-C', repo, 'bundle', 'verify', '-q', bundle], { env });
      await run('git', ['-C', repo, 'fetch', '-q', '--no-tags', bundle, `refs/heads/${localBranch}:refs/heads/cap-push`], { env });
      await rm(bundle, { force: true });
      const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'refs/heads/cap-push'], { env });
      return new TrustedBranch(dir, repo, stdout.trim());
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async git(args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
    const { stdout } = await run('git', ['-C', this.repo, ...args], { env: TrustedBranch.env(this.dir), maxBuffer });
    return stdout;
  }

  async hasCommit(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return false;
    return this.git(['cat-file', '-e', `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
  }

  /**
   * Commits et diff entre `base` (état distant, lu sur la forge) et la tête importée. `base` absent
   * de la copie (branche distante divergente) : commits listés depuis la tête, diff indisponible.
   */
  async describe(base: string | null): Promise<{ commits: Array<{ sha: string; subject: string; author: string }>; diffStat: string | null; patch: string | null; baseKnown: boolean }> {
    const baseKnown = base !== null && (await this.hasCommit(base));
    const range = baseKnown ? `${base}..${this.sha}` : this.sha;
    const log = await this.git(['log', '--no-color', '--format=%H%x1f%s%x1f%an', '-n', '200', range]);
    const commits = log
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, author] = l.split('\x1f');
        return { sha, subject, author };
      });
    if (!baseKnown) return { commits, diffStat: null, patch: null, baseKnown };
    // Aucun pilote externe ni conversion de texte (`.gitattributes` du dépôt ignorés pour l'affichage).
    const opts = ['--no-color', '--no-ext-diff', '--no-textconv'];
    const diffStat = (await this.git(['diff', ...opts, '--stat', base!, this.sha])).slice(0, 20_000);
    // Diff très volumineux : aperçu indisponible plutôt qu'une sortie illimitée en mémoire.
    const patch = await this.git(['diff', ...opts, base!, this.sha], 32 * 1024 * 1024).then(
      (p) => p.slice(0, 200_000),
      () => '(diff trop volumineux pour être affiché : voir le résumé des fichiers)',
    );
    return { commits, diffStat, patch, baseKnown };
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
