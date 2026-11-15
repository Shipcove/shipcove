import { SKILL_LIMITS, isMarkdownPath, type SkillFileInput, type StoredSkillFile } from '@cap/contracts';
import { AppError } from '@cap/server-core';

/** Taille (octets) d'un fichier markdown. */
export function fileSize(f: Pick<StoredSkillFile, 'content'>): number {
  return Buffer.byteLength(f.content, 'utf8');
}

/** Fichier markdown texte (les anciennes versions ont pu contenir des scripts ou des binaires). */
export function isMarkdownFile(f: { path: string; encoding?: string }): boolean {
  return isMarkdownPath(f.path) && f.encoding !== 'base64';
}

/**
 * Fichiers d'une version : markdown uniquement, contenus fournis ou repris de la version
 * précédente (`sourcePath`), chemins uniques, SKILL.md à la racine, limites de nombre et de taille.
 */
export function resolveSkillFiles(input: SkillFileInput[], previous: Array<{ path: string; content: string; encoding?: string }> = []): StoredSkillFile[] {
  const byPath = new Map(previous.filter(isMarkdownFile).map((f) => [f.path, f]));
  const out: StoredSkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of input) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new AppError('validation_failed', `Chemin en double : ${f.path}`);
    seen.add(key);
    let content: string;
    if ('sourcePath' in f) {
      const src = byPath.get(f.sourcePath);
      if (!src) throw new AppError('validation_failed', `Fichier introuvable dans la version actuelle : ${f.sourcePath}`);
      content = src.content;
    } else content = f.content;
    if (content.includes('\u0000')) throw new AppError('validation_failed', `${f.path} n’est pas un fichier texte`);
    const size = Buffer.byteLength(content, 'utf8');
    if (size > SKILL_LIMITS.maxFileBytes) throw new AppError('validation_failed', `${f.path} dépasse ${SKILL_LIMITS.maxFileBytes / 1024 / 1024} Mo`);
    total += size;
    if (total > SKILL_LIMITS.maxTotalBytes) throw new AppError('validation_failed', `Le skill dépasse ${SKILL_LIMITS.maxTotalBytes / 1024 / 1024} Mo`);
    out.push({ path: f.path, content });
  }
  // Un fichier et un dossier ne peuvent pas porter le même chemin (« docs.md/a.md » et « docs.md »).
  for (const p of seen) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new AppError('validation_failed', `« ${parts.slice(0, i).join('/')} » est à la fois un fichier et un dossier`);
    }
  }
  if (!out.some((f) => f.path === 'SKILL.md')) throw new AppError('validation_failed', 'SKILL.md est obligatoire, à la racine du skill');
  return out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
}

/** Champs `name` et `description` du frontmatter YAML de SKILL.md (valeurs simples ou blocs `>`/`|`). */
export function readFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim();
    }
    out[kv[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return { ...(out['name'] ? { name: out['name'] } : {}), ...(out['description'] ? { description: out['description'].slice(0, 1024) } : {}) };
}
