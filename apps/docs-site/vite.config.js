import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

/** Navigation du site (ordre d'affichage). */
export const NAV = [
  { section: 'Prise en main', pages: [
    { file: 'index.html', title: 'Présentation' },
    { file: 'quickstart.html', title: 'Démarrage rapide' },
    { file: 'guide.html', title: 'Guide utilisateur' },
  ] },
  { section: 'Administration', pages: [
    { file: 'administration.html', title: 'Console d’administration' },
    { file: 'identite.html', title: 'Identité et SSO' },
    { file: 'git.html', title: 'Forges Git' },
    { file: 'environnement.html', title: 'Environnement et services' },
  ] },
  { section: 'Exploitation', pages: [
    { file: 'installation.html', title: 'Installation et configuration' },
    { file: 'architecture.html', title: 'Architecture' },
    { file: 'securite.html', title: 'Sécurité' },
    { file: 'exploitation.html', title: 'Exploitation et limites' },
  ] },
  { section: 'Contribuer', pages: [{ file: 'developpement.html', title: 'Développement et tests' }] },
];

const layout = readFileSync(resolve(root, 'src/layout.html'), 'utf8');

/**
 * Gabarit commun appliqué à la construction : chaque page ne contient que son titre et son
 * contenu (`<main>`), le reste (en-tête, navigation, sommaire) vient de `src/layout.html`.
 */
function docsLayout() {
  return {
    name: 'docs-layout',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx.filename.split('/').pop();
        const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Documentation';
        const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
        const main = /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
        const nav = NAV.map(
          (s) =>
            `<div class="nav-section"><p class="nav-title">${s.section}</p><ul>${s.pages
              .map((p) => `<li><a href="/${p.file === 'index.html' ? '' : p.file}" class="nav-link${p.file === file ? ' is-active' : ''}"${p.file === file ? ' aria-current="page"' : ''}>${p.title}</a></li>`)
              .join('')}</ul></div>`,
        ).join('');
        const flat = NAV.flatMap((s) => s.pages);
        const i = flat.findIndex((p) => p.file === file);
        const link = (p, label, cls) => (p ? `<a class="pager-link ${cls}" href="/${p.file === 'index.html' ? '' : p.file}"><span>${label}</span><strong>${p.title}</strong></a>` : '<span></span>');
        const pager = `<nav class="pager" aria-label="Pages voisines">${link(flat[i - 1], 'Précédent', '')}${link(flat[i + 1], 'Suivant', 'text-right')}</nav>`;
        return layout
          .replaceAll('{{title}}', title)
          .replaceAll('{{description}}', description)
          .replace('{{nav}}', nav)
          .replace('{{content}}', main)
          .replace('{{pager}}', i >= 0 ? pager : '');
      },
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), docsLayout()],
  build: {
    rollupOptions: {
      input: Object.fromEntries(readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => [f.replace('.html', ''), resolve(root, f)])),
    },
  },
});
