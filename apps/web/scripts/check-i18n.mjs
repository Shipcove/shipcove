#!/usr/bin/env node
// Vérifie les traductions de l'interface : chaque texte passé à t('…') a sa traduction anglaise,
// avec les mêmes paramètres {nom} ; signale aussi les traductions qui ne servent plus.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src/app/', import.meta.url).pathname;
const { en } = await import(new URL('../src/app/i18n/en.ts', import.meta.url).href);

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.includes('/i18n/') && !p.endsWith('core/i18n.ts')) files.push(p);
  }
};
walk(root);

/** Littéraux de chaîne passés en premier argument à t( ou en argument à tk( (clé seule). */
const CALL = /\bt[k]?\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
const unescape = (lit) => Function(`"use strict"; return (${lit});`)();
const used = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const key = unescape(m[1]);
    if (!used.has(key)) used.set(key, relative(root, f));
  }
}

const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const missing = [...used].filter(([k]) => !(k in en));
const mismatched = [...used].filter(([k]) => k in en && params(k) !== params(en[k]));
const unused = Object.keys(en).filter((k) => !used.has(k) && !k.startsWith('server:'));
for (const [k, f] of missing) console.error(`traduction manquante (${f}) : ${JSON.stringify(k)}`);
for (const [k, f] of mismatched) console.error(`paramètres différents (${f}) : ${JSON.stringify(k)} → ${JSON.stringify(en[k])}`);
for (const k of unused) console.warn(`traduction inutilisée : ${JSON.stringify(k)}`);
console.log(`i18n : ${used.size} textes, ${missing.length} manquant(s), ${mismatched.length} paramètre(s) différent(s), ${unused.length} inutilisé(s)`);
if (missing.length || mismatched.length) process.exit(1);
