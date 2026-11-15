import { Directive, HostListener, Pipe, inject, type PipeTransform } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Noms affichés pour les alias courants. */
const LANG_LABEL: Record<string, string> = { ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', rb: 'ruby', rs: 'rust', kt: 'kotlin', 'c++': 'cpp', cs: 'csharp', html: 'html', xml: 'xml' };

marked.setOptions({ gfm: true, breaks: false });
marked.use({
  renderer: {
    /**
     * Bloc de code : en-tête (langage, actions au survol) et coloration syntaxique. Les actions
     * (retour à la ligne, copie) sont gérées par la directive `capCodeBlocks`.
     */
    code({ text, lang }) {
      const requested = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      let html: string;
      let language = requested;
      if (requested && hljs.getLanguage(requested)) {
        html = hljs.highlight(text, { language: requested, ignoreIllegals: true }).value;
      } else if (!requested && text.length < 20_000) {
        const auto = hljs.highlightAuto(text);
        html = auto.relevance >= 5 ? auto.value : escapeHtml(text);
        language = auto.relevance >= 5 ? (auto.language ?? '') : '';
      } else {
        html = escapeHtml(text);
      }
      const label = escapeHtml(LANG_LABEL[language] ?? (language || 'texte'));
      return (
        `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span>` +
        `<span class="code-actions"><button type="button" class="code-action" data-code-action="wrap" title="Retour à la ligne" aria-label="Retour à la ligne"></button>` +
        `<button type="button" class="code-action" data-code-action="copy" title="Copier" aria-label="Copier le code"></button></span></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>\n`
      );
    },
  },
});

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

/** Actions des blocs de code rendus par `markdown` : copie et retour à la ligne. */
@Directive({ selector: '[capCodeBlocks]' })
export class CodeBlocksDirective {
  @HostListener('click', ['$event'])
  async onClick(ev: MouseEvent) {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-code-action]');
    const block = btn?.closest<HTMLElement>('.code-block');
    if (!btn || !block) return;
    ev.preventDefault();
    if (btn.dataset['codeAction'] === 'wrap') {
      block.classList.toggle('wrap');
      btn.setAttribute('aria-pressed', String(block.classList.contains('wrap')));
      return;
    }
    await navigator.clipboard.writeText(block.querySelector('code')?.textContent ?? '');
    btn.classList.add('done');
    btn.title = 'Copié';
    setTimeout(() => {
      btn.classList.remove('done');
      btn.title = 'Copier';
    }, 1500);
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
