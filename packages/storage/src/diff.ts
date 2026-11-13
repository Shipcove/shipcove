import { createTwoFilesPatch, diffLines } from 'diff';

/** Détection binaire simple : octet NUL dans les 8 premiers Ko. */
export function isBinary(buf: Buffer | null): boolean {
  if (!buf) return false;
  return buf.subarray(0, 8192).includes(0);
}

/** Patch unifié au format git + compteurs d'ajouts/suppressions. */
export function unifiedDiff(path: string, before: string | null, after: string | null): { patch: string; additions: number; deletions: number } {
  const a = before ?? '';
  const b = after ?? '';
  const patch = createTwoFilesPatch(before === null ? '/dev/null' : `a/${path}`, after === null ? '/dev/null' : `b/${path}`, a, b, '', '', { context: 3 });
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(a, b)) {
    const lines = part.count ?? 0;
    if (part.added) additions += lines;
    else if (part.removed) deletions += lines;
  }
  return { patch: `diff --git a/${path} b/${path}\n${patch.split('\n').slice(1).join('\n')}`, additions, deletions };
}
