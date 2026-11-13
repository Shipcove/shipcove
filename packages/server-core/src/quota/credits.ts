import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

/** Usage normalisé : chaque token apparaît dans **une seule** catégorie. */
export interface NormalizedUsage {
  /** Tokens d'entrée hors cache (ni lus ni écrits en cache). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Coefficients {
  /** Crédits pour 1 000 tokens. */
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

/**
 * Normalise l'objet `usage` au format OpenAI renvoyé par LiteLLM.
 * Hypothèse documentée (ADR 0005) : `prompt_tokens` **inclut** les tokens lus et écrits en cache
 * (convention OpenAI, appliquée par LiteLLM aux autres providers). On les retire donc de l'entrée
 * pour éviter le double comptage.
 */
export function normalizeOpenAiUsage(usage: unknown): NormalizedUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  if (typeof u.prompt_tokens !== 'number' && typeof u.completion_tokens !== 'number') return null;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const cacheRead = num(details.cached_tokens) || num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens) || num(details.cache_creation_tokens);
  return {
    inputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    outputTokens: num(u.completion_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/** crédits = Σ(tokens_catégorie × coefficient_catégorie) / 1000, en décimal exact (8 décimales). */
export function computeCredits(usage: NormalizedUsage, c: Coefficients): Decimal {
  const total = new Decimal(usage.inputTokens)
    .mul(c.input)
    .add(new Decimal(usage.outputTokens).mul(c.output))
    .add(new Decimal(usage.cacheReadTokens).mul(c.cacheRead))
    .add(new Decimal(usage.cacheWriteTokens).mul(c.cacheWrite))
    .div(1000);
  return total.toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);
}

/** Estimation conservatrice des tokens d'entrée à partir de la taille du corps (≈ 3 caractères / token). */
export function estimateInputTokens(bodyChars: number): number {
  return Math.ceil(bodyChars / 3);
}

export function toFixed8(d: Decimal | string | number): string {
  return new Decimal(d).toFixed(8);
}
