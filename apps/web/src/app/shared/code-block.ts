import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import hljs from 'highlight.js/lib/common';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Bloc de code au style des réponses (`.code-block`, styles.css) : libellé en haut à gauche,
 * copie au survol, coloration syntaxique optionnelle.
 */
@Component({
  selector: 'cap-code-block',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="code-block" [class.code-error]="tone() === 'error'" [class.wrap]="wrap()">
      <div class="code-head">
        <span class="code-lang">{{ label() }}</span>
        <span class="code-actions">
          <button type="button" class="code-action" data-code-action="copy" [class.done]="copied()" [title]="copied() ? 'Copié' : 'Copier'" aria-label="Copier" (click)="copy()"></button>
        </span>
      </div>
      <pre [style.max-height]="maxHeight()"><code class="hljs">@if (prompt()) {<span class="code-prompt">{{ prompt() }} </span>}<span [innerHTML]="html()"></span></code></pre>
    </div>
  `,
})
export class CodeBlock {
  readonly code = input.required<string>();
  /** Langage pour la coloration (vide : texte brut). */
  readonly language = input('');
  readonly label = input('');
  /** Invite affichée avant le code (ex. `$`), non copiée. */
  readonly prompt = input('');
  readonly tone = input<'default' | 'error'>('default');
  readonly maxHeight = input<string | null>(null);
  /** Retour à la ligne des lignes longues (commandes). */
  readonly wrap = input(false);
  protected readonly copied = signal(false);

  protected readonly html = computed(() => {
    const lang = this.language();
    const code = this.code();
    if (lang && hljs.getLanguage(lang) && code.length < 200_000) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return escapeHtml(code);
  });

  protected async copy() {
    await navigator.clipboard.writeText(this.code());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
