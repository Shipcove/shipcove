/** Répertoire des skills de Pi dans la sandbox (matérialisés avant chaque run). */
export const SKILLS_DIR = '/home/agent/.pi/agent/skills';

const SKILL_TOKEN = /^\/skill:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?=\s|$)/;

/**
 * Commandes `/skill:nom` en tête de message (une ou plusieurs, séparées par des espaces) et
 * texte restant. Pi n'en développe qu'une, et seulement en tout début de message : la plateforme
 * les développe toutes elle-même, avant d'éventuelles notes ajoutées en tête.
 */
export function splitSkillCommands(text: string): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const m = SKILL_TOKEN.exec(rest);
    if (!m) break;
    if (!names.includes(m[1])) names.push(m[1]);
    rest = rest.slice(m[0].length).trimStart();
  }
  return { names, rest: names.length ? rest : text };
}

export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** Bloc identique à celui que produit Pi pour `/skill:nom`. */
export function skillBlock(name: string, content: string): string {
  const dir = `${SKILLS_DIR}/${name}`;
  return `<skill name="${name}" location="${dir}/SKILL.md">\nReferences are relative to ${dir}.\n\n${stripFrontmatter(content).trim()}\n</skill>`;
}

/**
 * Développe les skills en tête de message ; `read` renvoie le contenu de SKILL.md ou `null`
 * (skill inconnu ou désactivé : la commande est laissée telle quelle, comme le fait Pi).
 */
export async function expandSkillCommands(text: string, read: (name: string) => Promise<string | null>): Promise<string> {
  const { names, rest } = splitSkillCommands(text);
  if (!names.length) return text;
  const blocks: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const content = await read(name);
    if (content === null) unknown.push(`/skill:${name}`);
    else blocks.push(skillBlock(name, content));
  }
  const tail = [unknown.join(' '), rest].filter(Boolean).join(' ');
  return [...blocks, tail].filter(Boolean).join('\n\n');
}
