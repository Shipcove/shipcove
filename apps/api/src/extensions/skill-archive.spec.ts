import { describe, expect, it } from 'vitest';
import { readZip, toStoredFiles, writeZip } from './skill-archive.js';
import { readFrontmatter, resolveSkillFiles } from './skill-files.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('archives de skills', () => {
  it('aller-retour : dossiers, binaire, droit d’exécution, dossier racine retiré', () => {
    const zip = writeZip(
      [
        { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: Démo\n---\nCorps') },
        { path: 'scripts/build.sh', data: Buffer.from('#!/bin/sh\necho ok\n'), executable: true },
        { path: 'references/api/guide.md', data: Buffer.from('# Guide '.repeat(200)) },
        { path: 'assets/logo.png', data: png },
      ],
      'demo',
    );
    const entries = readZip(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(['SKILL.md', 'assets/logo.png', 'references/api/guide.md', 'scripts/build.sh']);
    expect(entries.find((e) => e.path === 'scripts/build.sh')!.executable).toBe(true);
    expect(entries.find((e) => e.path === 'assets/logo.png')!.data.equals(png)).toBe(true);
    const stored = toStoredFiles(entries);
    expect(stored.find((f) => f.path === 'assets/logo.png')!.encoding).toBe('base64');
    expect(stored.find((f) => f.path === 'SKILL.md')!.encoding).toBeUndefined();
  });

  it('ignore les métadonnées de systèmes de fichiers', () => {
    const zip = writeZip([
      { path: 'SKILL.md', data: Buffer.from('x') },
      { path: '__MACOSX/._SKILL.md', data: Buffer.from('x') },
      { path: 'docs/.DS_Store', data: Buffer.from('x') },
    ]);
    expect(readZip(zip).map((e) => e.path)).toEqual(['SKILL.md']);
  });

  it('refuse les chemins dangereux et les archives corrompues ou trop grosses', () => {
    expect(() => readZip(writeZip([{ path: '../evil.sh', data: Buffer.from('x') }]))).toThrow(/chemin dangereux/);
    expect(() => readZip(writeZip([{ path: 'a/.git/config', data: Buffer.from('x') }]))).toThrow(/chemin/);
    expect(() => readZip(Buffer.from('pas un zip'))).toThrow(/illisible/);
    const big = writeZip([{ path: 'big.txt', data: Buffer.alloc(6 * 1024 * 1024, 97) }]);
    expect(() => readZip(big)).toThrow(/dépasse/);
    const corrupt = writeZip([{ path: 'SKILL.md', data: Buffer.from('contenu original') }]);
    corrupt[30 + 'SKILL.md'.length + 2] ^= 0xff; // octet de données altéré (stocké sans compression)
    expect(() => readZip(corrupt)).toThrow(/intégrité|décompression/);
  });
});

describe('fichiers d’une version', () => {
  const previous = [
    { path: 'SKILL.md', content: 'v1' },
    { path: 'assets/logo.png', content: png.toString('base64'), encoding: 'base64' as const },
  ];

  it('reprend un fichier inchangé (y compris renommé) sans le renvoyer', () => {
    const out = resolveSkillFiles([{ path: 'SKILL.md', content: 'v2', encoding: 'utf8' }, { path: 'images/logo.png', sourcePath: 'assets/logo.png' }], previous);
    expect(out).toEqual([{ path: 'SKILL.md', content: 'v2' }, { path: 'images/logo.png', content: previous[1].content, encoding: 'base64' }]);
  });

  it('refuse doublons, conflit fichier/dossier, SKILL.md absent', () => {
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a', encoding: 'utf8' }, { path: 'skill.md', content: 'b', encoding: 'utf8' }])).toThrow(/double/);
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a', encoding: 'utf8' }, { path: 'docs', content: 'b', encoding: 'utf8' }, { path: 'docs/a.md', content: 'c', encoding: 'utf8' }])).toThrow(/fichier et un dossier/);
    expect(() => resolveSkillFiles([{ path: 'docs/SKILL.md', content: 'a', encoding: 'utf8' }])).toThrow(/SKILL.md est obligatoire/);
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a', encoding: 'utf8' }, { path: 'x.png', sourcePath: 'absent.png' }], previous)).toThrow(/introuvable/);
  });

  it('lit le frontmatter (valeur simple, guillemets, bloc replié)', () => {
    expect(readFrontmatter('---\nname: pdf\ndescription: "Lit des PDF"\n---\n')).toEqual({ name: 'pdf', description: 'Lit des PDF' });
    expect(readFrontmatter('---\nname: x\ndescription: >\n  Première ligne\n  seconde ligne\nlicense: MIT\n---')).toEqual({ name: 'x', description: 'Première ligne seconde ligne' });
    expect(readFrontmatter('pas de frontmatter')).toEqual({});
  });
});
