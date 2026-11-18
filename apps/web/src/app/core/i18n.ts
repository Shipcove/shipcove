import { en } from '../i18n/en';
import { enPatterns, enServer } from '../i18n/en-server';

/**
 * Langue de l'interface (français ou anglais), fixée au démarrage :
 * choix enregistré (sélecteur), sinon langues préférées du navigateur, sinon anglais.
 * Changer de langue recharge la page : tous les textes, formats et libellés basculent ensemble.
 *
 * Les textes sont écrits en français dans le code, qui sert de clé (`t('Partager')`) ; la
 * traduction anglaise est dans `i18n/en.ts`. `pnpm lint` vérifie qu'aucune n'y manque.
 */
export type Lang = 'fr' | 'en';
export const LANGS: readonly Lang[] = ['fr', 'en'];
export const LANG_NAMES: Record<Lang, string> = { fr: 'Français', en: 'English' };
const STORAGE_KEY = 'shipcove-lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'fr' || saved === 'en') return saved;
  } catch {
    /* stockage indisponible */
  }
  const prefs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const p of prefs) {
    const l = String(p ?? '').toLowerCase().split('-')[0];
    if (l === 'fr' || l === 'en') return l;
  }
  return 'en';
}

export const lang: Lang = detect();
/** Locale des formats (dates, nombres, temps relatifs). */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-US';
if (typeof document !== 'undefined') document.documentElement.lang = lang;

const dictionary: Record<string, string> | null = lang === 'en' ? en : null;
const server: Record<string, string> | null = lang === 'en' ? { ...enServer, ...en } : null;

/**
 * Texte de l'interface dans la langue courante. `params` remplace les `{nom}` du texte.
 * Sans traduction (ex. message dynamique du serveur), le texte d'origine est rendu.
 */
export function t(fr: string, params?: Record<string, string | number | null | undefined>): string {
  const text = dictionary?.[fr] ?? fr;
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k] ?? '') : m)) : text;
}

/**
 * Traduction d'un texte venu du serveur (message d'erreur, message système du fil) s'il est
 * connu (`i18n/en-server.ts`, textes fixes puis motifs à valeurs variables), sinon tel quel.
 */
export function tr(text: string | null | undefined): string {
  if (!text) return '';
  if (!server) return text;
  const exact = server[text];
  if (exact) return exact;
  for (const [re, en] of enPatterns) {
    const m = re.exec(text);
    if (m) return en.replace(/\$(\d)/g, (_, i: string) => { const v = m[Number(i)] ?? ''; return server[v] ?? v; });
  }
  return text;
}

/** Change la langue de l'interface (enregistrée) et recharge la page. */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* stockage indisponible : le changement vaut pour cette page */
  }
  if (next !== lang) location.reload();
}

/**
 * Marque un texte à traduire sans le traduire tout de suite (tables de libellés, constantes) :
 * il est traduit au moment de l'affichage avec `t(valeur)`. Le contrôle des traductions le voit.
 */
export function tk(fr: string): string {
  return fr;
}
