import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

/**
 * Chemin de publication du site (racine d'un domaine par défaut). Pour un sous-dossier :
 * DOCS_BASE=/docs/ pnpm docs:build. Tous les liens du site sont dérivés de cette valeur.
 */
const base = (process.env.DOCS_BASE ?? '/').replace(/\/?$/, '/');

/** Langues du site : chaque page existe dans chacune, sous le même nom de fichier. */
export const LANGS = ['fr', 'en'];

/** Textes de l'habillage (en-tête, navigation, pied de page), par langue. */
const UI = {
  fr: {
    docs: 'Documentation',
    skip: 'Aller au contenu',
    menu: 'Menu',
    nav: 'Documentation',
    toc: 'Sur cette page',
    prev: 'Précédent',
    next: 'Suivant',
    pager: 'Pages voisines',
    language: 'Langue',
    footer: 'Shipcove — logiciel libre sous licence AGPL v3.',
    source: 'Code source',
  },
  en: {
    docs: 'Documentation',
    skip: 'Skip to content',
    menu: 'Menu',
    nav: 'Documentation',
    toc: 'On this page',
    prev: 'Previous',
    next: 'Next',
    pager: 'Adjacent pages',
    language: 'Language',
    footer: 'Shipcove — free software under the AGPL v3 license.',
    source: 'Source code',
  },
};

/** Navigation du site (ordre d'affichage), titres par langue. */
export const NAV = [
  { section: { fr: 'Prise en main', en: 'Getting started' }, pages: [
    { file: 'index.html', title: { fr: 'Présentation', en: 'Overview' } },
    { file: 'quickstart.html', title: { fr: 'Démarrage rapide', en: 'Quick start' } },
    { file: 'guide.html', title: { fr: 'Guide utilisateur', en: 'User guide' } },
  ] },
  { section: { fr: 'Administration', en: 'Administration' }, pages: [
    { file: 'administration.html', title: { fr: 'Console d’administration', en: 'Admin console' } },
    { file: 'identite.html', title: { fr: 'Identité et SSO', en: 'Identity and SSO' } },
    { file: 'git.html', title: { fr: 'Forges Git', en: 'Git forges' } },
    { file: 'environnement.html', title: { fr: 'Environnement et services', en: 'Environment and services' } },
  ] },
  { section: { fr: 'Exploitation', en: 'Operations' }, pages: [
    { file: 'installation.html', title: { fr: 'Installation et configuration', en: 'Installation and configuration' } },
    { file: 'architecture.html', title: { fr: 'Architecture', en: 'Architecture' } },
    { file: 'securite.html', title: { fr: 'Sécurité', en: 'Security' } },
    { file: 'exploitation.html', title: { fr: 'Exploitation et limites', en: 'Operations and limits' } },
  ] },
  { section: { fr: 'Contribuer', en: 'Contributing' }, pages: [
    { file: 'developpement.html', title: { fr: 'Développement et tests', en: 'Development and tests' } },
  ] },
];

const layout = readFileSync(resolve(root, 'src/layout.html'), 'utf8');
const href = (lang, file) => `${base}${lang}/${file === 'index.html' ? '' : file}`;

/**
 * Gabarit commun appliqué à la construction : chaque page ne contient que son titre et son contenu
 * (`<main>`), le reste (en-tête, navigation, sélecteur de langue, sommaire) vient de `src/layout.html`.
 * Les pages de `fr/` et `en/` reçoivent l'habillage de leur langue ; la page racine (choix de la
 * langue) est laissée telle quelle.
 */
function docsLayout() {
  return {
    name: 'docs-layout',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const parts = ctx.filename.split('/');
        const file = parts.pop();
        const lang = parts.pop();
        if (!LANGS.includes(lang)) return html.replaceAll('%BASE%', base);
        const ui = UI[lang];
        const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Documentation';
        const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
        const main = /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
        const nav = NAV.map(
          (s) =>
            `<div class="nav-section"><p class="nav-title">${s.section[lang]}</p><ul>${s.pages
              .map((p) => `<li><a href="${href(lang, p.file)}" class="nav-link${p.file === file ? ' is-active' : ''}"${p.file === file ? ' aria-current="page"' : ''}>${p.title[lang]}</a></li>`)
              .join('')}</ul></div>`,
        ).join('');
        const flat = NAV.flatMap((s) => s.pages);
        const i = flat.findIndex((p) => p.file === file);
        const link = (p, label, cls) => (p ? `<a class="pager-link ${cls}" href="${href(lang, p.file)}"><span>${label}</span><strong>${p.title[lang]}</strong></a>` : '<span></span>');
        const pager = `<nav class="pager" aria-label="${ui.pager}">${link(flat[i - 1], ui.prev, '')}${link(flat[i + 1], ui.next, 'text-right')}</nav>`;
        // Même page dans les autres langues : sélecteur et balises hreflang.
        const switcher = LANGS.map((l) =>
          l === lang
            ? `<span class="lang-link is-active" aria-current="true">${l.toUpperCase()}</span>`
            : `<a class="lang-link" href="${href(l, file)}" hreflang="${l}" lang="${l}" data-lang="${l}">${l.toUpperCase()}</a>`,
        ).join('');
        const alternates = LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${href(l, file)}" vite-ignore />`).join('\n    ');
        // Liens internes du contenu : écrits relatifs à la langue (« guide.html »), complétés ici.
        const content = main.replace(/href="([a-z-]+\.html)(#[^"]*)?"/g, (_m, f, hash) => `href="${href(lang, f)}${hash ?? ''}"`).replace(/href="\.\/"/g, `href="${href(lang, 'index.html')}"`);
        return layout
          .replaceAll('{{lang}}', lang)
          .replaceAll('{{title}}', title)
          .replaceAll('{{description}}', description)
          .replaceAll('{{base}}', base)
          .replaceAll('{{home}}', href(lang, 'index.html'))
          .replace('{{alternates}}', alternates)
          .replace('{{switcher}}', switcher)
          .replace('{{nav}}', nav)
          .replace('{{content}}', content)
          .replace('{{pager}}', i >= 0 ? pager : '')
          .replace(/\{\{ui\.(\w+)\}\}/g, (_m, k) => ui[k] ?? k);
      },
    },
  };
}

const pages = (dir) =>
  readdirSync(resolve(root, dir))
    .filter((f) => f.endsWith('.html'))
    .map((f) => [`${dir === '.' ? '' : `${dir}/`}${f.replace('.html', '')}`, resolve(root, dir, f)]);

export default defineConfig({
  base,
  plugins: [tailwindcss(), docsLayout()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([...pages('.'), ...LANGS.flatMap((l) => pages(l))]),
    },
  },
});
