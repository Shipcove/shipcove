import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { ConfirmService } from '../core/confirm.service';
import { Icon } from './icon';

/**
 * Modale de confirmation de l'application : Échap ou clic hors de la fenêtre pour annuler,
 * focus sur « Annuler » pour une action destructive, focus maintenu dans la fenêtre.
 */
@Component({
  selector: 'cap-confirm-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (confirm.current(); as c) {
      <div class="cap-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-stone-950/40 p-4 backdrop-blur-[2px]" (click)="confirm.answer(false)">
        <div #dialog class="cap-pop-in w-full max-w-md rounded-2xl border border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900"
          role="alertdialog" aria-modal="true" aria-labelledby="cap-confirm-title" aria-describedby="cap-confirm-body" (click)="$event.stopPropagation()">
          <div class="flex gap-4 p-5">
            @if (c.danger) {
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950/60 dark:text-red-400">
                <cap-icon name="trash" [size]="18" />
              </div>
            }
            <div class="min-w-0 flex-1">
              <h2 id="cap-confirm-title" class="text-base font-semibold text-stone-900 dark:text-stone-100">{{ c.title }}</h2>
              <div id="cap-confirm-body" class="mt-1.5 text-sm text-stone-600 dark:text-stone-400">
                <p>
                  @for (part of parts(); track $index) {
                    @if (part.subject) { <strong class="font-medium break-words text-stone-900 dark:text-stone-100">{{ part.text }}</strong> } @else { {{ part.text }} }
                  }
                </p>
                @if (c.details?.length) {
                  <ul class="mt-3 space-y-1">
                    @for (d of c.details; track d) {
                      <li class="flex items-start gap-2"><span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-stone-400"></span><span>{{ d }}</span></li>
                    }
                  </ul>
                }
                @if (c.warning) {
                  <p class="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                    <cap-icon name="alert" [size]="15" class="mt-0.5 shrink-0" /><span>{{ c.warning }}</span>
                  </p>
                }
              </div>
            </div>
          </div>
          <div class="flex justify-end gap-2 rounded-b-2xl border-t border-stone-100 bg-stone-50 px-5 py-3 dark:border-stone-800 dark:bg-stone-900/60">
            <button #cancel type="button" class="btn-secondary" (click)="confirm.answer(false)">{{ c.cancelLabel ?? 'Annuler' }}</button>
            <button #ok type="button" (click)="confirm.answer(true)"
              [class]="c.danger ? 'btn-danger' : 'btn-primary'">
              {{ c.confirmLabel ?? 'Confirmer' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .cap-fade-in { animation: cap-fade 120ms ease-out; }
    .cap-pop-in { animation: cap-pop 140ms cubic-bezier(0.2, 0.9, 0.3, 1.2); }
    @keyframes cap-fade { from { opacity: 0; } }
    @keyframes cap-pop { from { opacity: 0; transform: translateY(6px) scale(0.97); } }
    @media (prefers-reduced-motion: reduce) { .cap-fade-in, .cap-pop-in { animation: none; } }
  `,
})
export class ConfirmDialog {
  protected readonly confirm = inject(ConfirmService);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly cancelBtn = viewChild<ElementRef<HTMLButtonElement>>('cancel');
  private readonly okBtn = viewChild<ElementRef<HTMLButtonElement>>('ok');
  private previousFocus: HTMLElement | null = null;

  /** Message découpé autour de `{subject}`. */
  protected readonly parts = computed(() => {
    const c = this.confirm.current();
    if (!c) return [];
    const [before, ...rest] = c.message.split('{subject}');
    if (!c.subject || !rest.length) return [{ text: c.message, subject: false }];
    return [
      { text: before, subject: false },
      { text: c.subject, subject: true },
      { text: rest.join('{subject}'), subject: false },
    ];
  });

  constructor() {
    effect(() => {
      const c = this.confirm.current();
      if (c) {
        this.previousFocus = document.activeElement as HTMLElement | null;
        // Action destructive : focus sur « Annuler » (Entrée ne supprime pas par mégarde).
        setTimeout(() => (c.danger ? this.cancelBtn() : this.okBtn())?.nativeElement.focus());
      } else if (this.previousFocus) {
        const el = this.previousFocus;
        this.previousFocus = null;
        setTimeout(() => el.isConnected && el.focus());
      }
    });
  }

  protected onKey(ev: KeyboardEvent): void {
    if (!this.confirm.current()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.confirm.answer(false);
    } else if (ev.key === 'Tab') {
      // Focus maintenu dans la fenêtre.
      const items = [...(this.dialog()?.nativeElement.querySelectorAll<HTMLElement>('button') ?? [])];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      ev.preventDefault();
      items[next].focus();
    }
  }
}
