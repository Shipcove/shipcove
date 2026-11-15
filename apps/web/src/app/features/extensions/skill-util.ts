/** UTF-8 valide sans octet nul : fichier texte, éditable. */
export function isTextFile(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * En-tête YAML (`---`) d'un fichier markdown séparé du corps, pour l'aperçu : paires clé/valeur
 * simples (les blocs repliés « > » / « | » sont joints), corps rendu en markdown.
 */
export function splitFrontmatter(md: string): { meta: Array<{ key: string; value: string }>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: [], body: md };
  const meta: Array<{ key: string; value: string }> = [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim();
    }
    meta.push({ key: kv[1], value: value.replace(/^(['"])([\s\S]*)\1$/, '$2') });
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Téléchargement de l'archive .zip d'un skill (cookies de session). */
export async function downloadSkillZip(base: string, id: string, name: string): Promise<void> {
  const res = await fetch(`${base}/skills/${id}/export`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
