import { describe, expect, it } from 'vitest';
import { readZip, toSkillFiles, writeZip } from './skill-archive.js';
import { readFrontmatter, resolveSkillFiles } from './skill-files.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('archives de skills', () => {
  it('aller-retour : dossiers et sous-dossiers, dossier racine retiré ; seul le markdown est retenu', () => {
    const zip = writeZip(
      [
        { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: Démo\n---\nCorps') },
        { path: 'references/api/guide.md', data: Buffer.from('# Guide '.repeat(200)) },
        { path: 'scripts/build.sh', data: Buffer.from('#!/bin/sh\necho ok\n'), executable: true },
        { path: 'assets/logo.png', data: png },
        { path: 'docs/notes.markdown', data: Buffer.from('notes') },
      ],
      'demo',
    );
    const { files, ignored } = toSkillFiles(readZip(zip));
    expect(files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'docs/notes.markdown', 'references/api/guide.md']);
    expect(ignored.sort()).toEqual(['assets/logo.png', 'scripts/build.sh']);
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
    expect(() => readZip(writeZip([{ path: '../evil.md', data: Buffer.from('x') }]))).toThrow(/chemin dangereux/);
    expect(() => readZip(writeZip([{ path: 'a/.git/config', data: Buffer.from('x') }]))).toThrow(/chemin/);
    expect(() => readZip(Buffer.from('pas un zip'))).toThrow(/illisible/);
    const big = writeZip([{ path: 'big.md', data: Buffer.alloc(11 * 1024 * 1024, 97) }]);
    expect(() => readZip(big)).toThrow(/dépasse/);
    const corrupt = writeZip([{ path: 'SKILL.md', data: Buffer.from('contenu original') }]);
    corrupt[30 + 'SKILL.md'.length + 2] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow(/intégrité|décompression/);
  });
});

describe('fichiers d’une version', () => {
  const previous = [
    { path: 'SKILL.md', content: 'v1' },
    { path: 'references/a.md', content: 'A' },
    { path: 'old.png', content: 'xx', encoding: 'base64' },
  ];

  it('reprend un fichier inchangé (y compris renommé) sans le renvoyer', () => {
    const out = resolveSkillFiles([{ path: 'SKILL.md', content: 'v2' }, { path: 'docs/a.md', sourcePath: 'references/a.md' }], previous);
    expect(out).toEqual([{ path: 'SKILL.md', content: 'v2' }, { path: 'docs/a.md', content: 'A' }]);
  });

  it('refuse doublons, conflit fichier/dossier, SKILL.md absent, ancien fichier non markdown, contenu binaire', () => {
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a' }, { path: 'skill.md', content: 'b' }])).toThrow(/double/);
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a' }, { path: 'docs.md', content: 'b' }, { path: 'docs.md/a.md', content: 'c' }])).toThrow(/fichier et un dossier/);
    expect(() => resolveSkillFiles([{ path: 'docs/SKILL.md', content: 'a' }])).toThrow(/SKILL.md est obligatoire/);
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a' }, { path: 'x.md', sourcePath: 'old.png' }], previous)).toThrow(/introuvable/);
    expect(() => resolveSkillFiles([{ path: 'SKILL.md', content: 'a\u0000b' }])).toThrow(/texte/);
  });

  it('lit le frontmatter (valeur simple, guillemets, bloc replié)', () => {
    expect(readFrontmatter('---\nname: pdf\ndescription: "Lit des PDF"\n---\n')).toEqual({ name: 'pdf', description: 'Lit des PDF' });
    expect(readFrontmatter('---\nname: x\ndescription: >\n  Première ligne\n  seconde ligne\nlicense: MIT\n---')).toEqual({ name: 'x', description: 'Première ligne seconde ligne' });
    expect(readFrontmatter('pas de frontmatter')).toEqual({});
  });
});
