/**
 * Expurgation des secrets dans les logs, traces, sorties d'outils et événements SSE.
 * Approche défensive : motifs de jetons connus + clés sensibles dans les objets.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(gh[pousr]_[A-Za-z0-9]{20,255})\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, '[REDACTED:github-token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:gitlab-token]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:api-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bhvs\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:vault-token]'],
  [/\bcap_rt_[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:run-token]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/(https?:\/\/)[^\s:@/]+:[^\s@/]+@/g, '$1[REDACTED]@'],
  [/\b(authorization|x-vault-token|cookie|set-cookie)\s*[:=]\s*("[^"]*"|[^\s,;]+(?:\s+[^\s,;]+)?)/gi, '$1: [REDACTED]'],
];

const SENSITIVE_KEYS = /^(password|passwd|secret|token|apiKey|api_key|accessToken|refreshToken|clientSecret|client_secret|authorization|cookie|privateKey|secretAccessKey|bindPassword|code)$/i;

export function redactString(input: string): string {
  let out = input;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) && typeof v === 'string' ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
