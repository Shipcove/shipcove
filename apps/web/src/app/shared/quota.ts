import type { QuotaWindowDto } from '@cap/contracts';

/**
 * Présentation des quotas côté utilisateur : uniquement des pourcentages (jamais de crédits),
 * colorés à l'approche de la limite. Les crédits restent visibles dans l'administration.
 */
export const QUOTA_WARN = 70;
export const QUOTA_DANGER = 90;

export type QuotaLevel = 'ok' | 'warn' | 'danger';

/** Pourcentage consommé (fourni par l'API), ou `null` si la fenêtre est sans limite / exemptée. */
export function quotaPct(w: QuotaWindowDto): number | null {
  return w.percent;
}

export function quotaLevel(pct: number | null): QuotaLevel {
  if (pct === null) return 'ok';
  return pct >= QUOTA_DANGER ? 'danger' : pct >= QUOTA_WARN ? 'warn' : 'ok';
}

/** Classes de la jauge (barre). */
export function quotaBarClass(pct: number | null): string {
  return { ok: 'bg-blue-600', warn: 'bg-orange-500', danger: 'bg-red-600' }[quotaLevel(pct)];
}

/** Classes du texte du pourcentage. */
export function quotaTextClass(pct: number | null): string {
  return { ok: 'text-stone-500', warn: 'text-orange-600 font-medium', danger: 'text-red-600 font-medium' }[quotaLevel(pct)];
}

/** Couleur SVG (anneau). */
export function quotaStroke(pct: number | null): string {
  return { ok: '#2563eb', warn: '#f97316', danger: '#dc2626' }[quotaLevel(pct)];
}

export function windowLabel(w: QuotaWindowDto['window']): string {
  return w === '5h' ? 'Limite de 5 heures' : '7 jours glissants';
}

export function formatReset(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `à ${time}` : `le ${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${time}`;
}
