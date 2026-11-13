import { Pipe, inject, type PipeTransform } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/** Markdown → HTML assaini (DOMPurify) ; aucun HTML brut du modèle n'est exécuté. */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);
  transform(value: string | null | undefined): SafeHtml {
    const html = DOMPurify.sanitize(marked.parse(value ?? '', { async: false }) as string, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
      FORBID_ATTR: ['style', 'onerror', 'onclick'],
    });
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}

@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  private readonly fmt = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  transform(value: string | Date | null | undefined): string {
    if (!value) return '—';
    const d = typeof value === 'string' ? new Date(value) : value;
    const s = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (abs < 60) return this.fmt.format(s, 'second');
    if (abs < 3600) return this.fmt.format(Math.round(s / 60), 'minute');
    if (abs < 86400) return this.fmt.format(Math.round(s / 3600), 'hour');
    return this.fmt.format(Math.round(s / 86400), 'day');
  }
}

@Pipe({ name: 'bytes' })
export class BytesPipe implements PipeTransform {
  transform(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let i = 0;
    let n = v;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
}

@Pipe({ name: 'credits' })
export class CreditsPipe implements PipeTransform {
  transform(v: string | null | undefined, digits = 2): string {
    if (v === null || v === undefined) return '∞';
    const n = Number(v);
    return n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: digits });
  }
}

@Pipe({ name: 'tokens' })
export class TokensPipe implements PipeTransform {
  transform(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }
}
