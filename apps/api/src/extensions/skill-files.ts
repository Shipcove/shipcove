import { SKILL_LIMITS, type SkillFileInput, type StoredSkillFile } from '@cap/contracts';
import { AppError } from '@cap/server-core';

/** Taille réelle (octets) d'un fichier stocké. */
export function fileSize(f: Pick<StoredSkillFile, 'content' | 'encoding'>): number {
  return f.encoding === 'base64' ? Buffer.from(f.content, 'base64').length : Buffer.byteLength(f.content, 'utf8');
}

export function fileData(f: Pick<StoredSkillFile, 'content' | 'encoding'>): Buffer {
  return f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
}

/**
 * Fichiers d'une version : contenus fournis ou repris de la version précédente (`sourcePath`),
 * chemins uniques, SKILL.md à la racine, limites de nombre et de taille.
 */
export function resolveSkillFiles(input: SkillFileInput[], previous: StoredSkillFile[] = []): StoredSkillFile[] {
  const byPath = new Map(previous.map((f) => [f.path, f]));
  const out: StoredSkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of input) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new AppError('validation_failed', `Chemin en double : ${f.path}`);
    seen.add(key);
    let stored: StoredSkillFile;
    if ('sourcePath' in f) {
      const src = byPath.get(f.sourcePath);
      if (!src) throw new AppError('validation_failed', `Fichier introuvable dans la version actuelle : ${f.sourcePath}`);
      stored = { ...src, path: f.path, ...(f.executable !== undefined ? { executable: f.executable || undefined } : {}) };
    } else {
      if (f.encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(f.content)) throw new AppError('validation_failed', `Contenu base64 invalide : ${f.path}`);
      stored = { path: f.path, content: f.content, ...(f.encoding === 'base64' ? { encoding: 'base64' as const } : {}), ...(f.executable ? { executable: true } : {}) };
    }
    if (!stored.executable) delete stored.executable;
    const size = fileSize(stored);
    if (size > SKILL_LIMITS.maxFileBytes) throw new AppError('validation_failed', `${f.path} dépasse ${SKILL_LIMITS.maxFileBytes / 1024 / 1024} Mo`);
    total += size;
    if (total > SKILL_LIMITS.maxTotalBytes) throw new AppError('validation_failed', `Le skill dépasse ${SKILL_LIMITS.maxTotalBytes / 1024 / 1024} Mo`);
    out.push(stored);
  }
  // Un fichier et un dossier ne peuvent pas porter le même chemin (« docs » et « docs/a.md »).
  for (const p of seen) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new AppError('validation_failed', `« ${parts.slice(0, i).join('/')} » est à la fois un fichier et un dossier`);
    }
  }
  const md = out.find((f) => f.path === 'SKILL.md');
  if (!md) throw new AppError('validation_failed', 'SKILL.md est obligatoire, à la racine du skill');
  if (md.encoding === 'base64') throw new AppError('validation_failed', 'SKILL.md doit être un fichier texte');
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
