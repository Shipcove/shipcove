import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

/**
 * Lecteur JSONL strict (docs Pi : délimiteur LF uniquement ; `readline` n'est pas conforme car
 * il coupe aussi sur U+2028/U+2029, valides dans des chaînes JSON).
 */
export function attachJsonlReader(stream: Readable, onLine: (line: string) => void, maxLineBytes = 64 * 1024 * 1024): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
    if (buffer.length > maxLineBytes) buffer = ''; // protection mémoire
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    buffer = '';
  });
}
