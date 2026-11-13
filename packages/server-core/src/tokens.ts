/** Jetons d'injection (fichier séparé pour éviter les imports circulaires). */
export const DB = Symbol.for('CAP_DB');
export const SECRETS = Symbol.for('CAP_SECRETS');
export const SERVICE_NAME = 'CAP_SERVICE_NAME';
