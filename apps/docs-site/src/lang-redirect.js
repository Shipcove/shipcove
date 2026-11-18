// Page racine : redirige vers la documentation dans la langue du visiteur.
// Ordre : choix enregistré (sélecteur de langue), langues préférées du navigateur, anglais.
(() => {
  const supported = ['fr', 'en'];
  let lang = null;
  try {
    lang = localStorage.getItem('shipcove-docs-lang');
  } catch {
    /* stockage indisponible (navigation privée stricte) */
  }
  if (!supported.includes(lang)) {
    const prefs = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
    lang = prefs.map((l) => String(l).toLowerCase().split('-')[0]).find((l) => supported.includes(l)) ?? 'en';
  }
  location.replace(new URL(`${lang}/${location.hash}`, location.href.replace(/[^/]*$/, '')));
})();
