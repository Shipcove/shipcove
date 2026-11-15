import { describe, expect, it } from 'vitest';
import { expandSkillCommands, splitSkillCommands } from './skill-expansion.js';

describe('splitSkillCommands', () => {
  it('extrait une ou plusieurs commandes en tête de message', () => {
    expect(splitSkillCommands('/skill:pdf Résume ce fichier')).toEqual({ names: ['pdf'], rest: 'Résume ce fichier' });
    expect(splitSkillCommands('/skill:a /skill:b-c  texte /skill:d')).toEqual({ names: ['a', 'b-c'], rest: 'texte /skill:d' });
    expect(splitSkillCommands('/skill:seul')).toEqual({ names: ['seul'], rest: '' });
  });

  it('ignore le texte sans commande ou une commande au milieu', () => {
    expect(splitSkillCommands('Bonjour /skill:x')).toEqual({ names: [], rest: 'Bonjour /skill:x' });
    expect(splitSkillCommands('/skillx')).toEqual({ names: [], rest: '/skillx' });
    expect(splitSkillCommands('/skill:../etc texte').names).toEqual([]);
  });
});

describe('expandSkillCommands', () => {
  const files: Record<string, string> = { a: '---\nname: a\n---\nContenu A', b: 'Contenu B' };
  const read = async (n: string) => files[n] ?? null;

  it('développe chaque skill en bloc, puis le texte', async () => {
    const out = await expandSkillCommands('/skill:a /skill:b Fais-le', read);
    expect(out).toContain('<skill name="a" location="/home/agent/.pi/agent/skills/a/SKILL.md">');
    expect(out).toContain('Contenu A\n</skill>');
    expect(out).not.toContain('name: a');
    expect(out.indexOf('Contenu A')).toBeLessThan(out.indexOf('Contenu B'));
    expect(out.endsWith('\n\nFais-le')).toBe(true);
  });

  it('laisse un skill inconnu tel quel et ne touche pas un message ordinaire', async () => {
    expect(await expandSkillCommands('/skill:zzz texte', read)).toBe('/skill:zzz texte');
    expect(await expandSkillCommands('texte', read)).toBe('texte');
  });
});
