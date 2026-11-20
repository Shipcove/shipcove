import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

/**
 * Lecteur JSONL strict (docs Pi : délimiteur LF uniquement ; `readline` n'est pas conforme car
 * il coupe aussi sur U+2028/U+2029, valides dans des chaînes JSON).
 */
export function attachJsonlReader(stream: Readable, onLine: (line: string) => void, maxLineBytes = 64 * 1024 * 1024): void {
  const decoder = new StringDecoder('utf8');
  // Ligne en cours, en morceaux : chaque octet n'est parcouru qu'une fois (pas de recopie ni de
  // nouvelle recherche depuis le début du tampon à chaque bloc reçu).
  let parts: string[] = [];
  let pending = 0;
  let skipping = false;
  const emit = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > 0) onLine(line);
  };
  stream.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    for (;;) {
      const idx = text.indexOf('\n', start);
      if (idx === -1) break;
      const tail = text.slice(start, idx);
      if (!skipping) emit(parts.length ? parts.join('') + tail : tail);
      parts = [];
      pending = 0;
      skipping = false;
      start = idx + 1;
    }
    if (start < text.length && !skipping) {
      parts.push(text.slice(start));
      pending += text.length - start;
      // Ligne démesurée : abandonnée jusqu'au prochain saut de ligne (protection mémoire).
      if (pending > maxLineBytes) {
        parts = [];
        pending = 0;
        skipping = true;
      }
    }
  });
  stream.on('end', () => {
    const rest = decoder.end();
    if (!skipping && (parts.length || rest)) emit(parts.join('') + rest);
    parts = [];
    pending = 0;
  });
}
