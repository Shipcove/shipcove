import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ToolCallDto } from '@cap/contracts';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';
import { t } from '../../core/i18n';

interface AskOption {
  label: string;
  description?: string;
}
interface AskQuestion {
  question: string;
  options: AskOption[];
  multi_select?: boolean;
  recommended?: number;
}
interface Answer {
  picked: Set<number>;
  other: boolean;
  otherText: string;
}

/**
 * Formulaire des questions de Pi (plugin `ask_user`) : choix unique ou multiple, réponse libre
 * « Autre ». La validation envoie un message de réponse (rattaché à l'appel d'outil) et Pi reprend.
 */
@Component({
  selector: 'cap-ask-form',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="my-2 overflow-hidden rounded-xl border border-stone-200 bg-white text-[0.95rem] dark:border-stone-800 dark:bg-stone-900">
      @if (answered()) {
        <div class="flex items-center gap-2 px-4 py-3 text-sm text-stone-600 dark:text-stone-300">
          <cap-icon name="check" [size]="15" class="text-emerald-600" />
          <span class="font-medium">{{ title() }}</span>
          <span class="text-stone-500">— {{ questions().length > 1 ? t('répondu ({n} questions)', { n: questions().length }) : t('répondu ({n} question)', { n: questions().length }) }}</span>
        </div>
      } @else {
        <div class="px-5 pt-4 pb-1">
          <p class="flex items-center gap-2 text-xs font-medium tracking-wide text-stone-500 uppercase"><cap-icon name="help" [size]="13" /> {{ title() }}</p>
        </div>
        @for (q of questions(); track $index; let qi = $index; let last = $last) {
          <fieldset class="px-5 py-4" [class.border-b]="!last" [class.border-stone-100]="!last" [class.dark:border-stone-800]="!last" [disabled]="!canAnswer()">
            <legend class="float-left mb-3 w-full font-medium text-stone-900 dark:text-stone-100">{{ qi + 1 }}. {{ q.question }}
              @if (q.multi_select) { <span class="ml-1 text-xs font-normal text-stone-500">(plusieurs choix possibles)</span> }
            </legend>
            <div class="clear-both space-y-1">
              @for (o of q.options; track $index; let oi = $index) {
                <label class="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-800/60">
                  <input [type]="q.multi_select ? 'checkbox' : 'radio'" class="mt-1 h-4 w-4 shrink-0 accent-stone-900 dark:accent-stone-100" [name]="radioName(qi)" [checked]="isPicked(qi, oi)" (change)="pick(qi, oi, q)" />
                  <span>
                    <span class="text-stone-800 dark:text-stone-200">{{ o.label }}</span>
                    @if (q.recommended === oi) { <span class="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{{ t('Recommandé') }}</span> }
                    @if (o.description) { <span class="block text-sm text-stone-500 dark:text-stone-400">{{ o.description }}</span> }
                  </span>
                </label>
              }
              <label class="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-800/60">
                <input [type]="q.multi_select ? 'checkbox' : 'radio'" class="mt-1 h-4 w-4 shrink-0 accent-stone-900 dark:accent-stone-100" [name]="radioName(qi)" [checked]="answers()[qi]?.other" (change)="pickOther(qi, q)" />
                <span class="flex-1">
                  <span class="text-stone-800 dark:text-stone-200">{{ t('Autre') }}</span>
                  @if (answers()[qi]?.other) {
                    <input class="input mt-1.5 !py-1.5" [name]="'other-' + qi" [placeholder]="t('Votre réponse')" [ngModel]="answers()[qi]?.otherText" (ngModelChange)="setOther(qi, $event)" />
                  }
                </span>
              </label>
            </div>
          </fieldset>
        }
        @if (canAnswer()) {
          <div class="px-5 pt-1 pb-5">
            <button class="flex w-full items-center justify-center gap-2 rounded-full bg-stone-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300" [disabled]="!complete() || sending()" (click)="submit()">
              {{ sending() ? t('Envoi…') : t('Valider ces choix') }} <cap-icon name="arrowRight" [size]="15" />
            </button>
            @if (!complete()) { <p class="mt-2 text-center text-xs text-stone-500">{{ t('Répondez à chaque question pour continuer.') }}</p> }
          </div>
        } @else if (!store.isOwner()) {
          <p class="px-5 pb-4 text-xs text-stone-500">{{ t('Seul le propriétaire du workspace peut répondre.') }}</p>
        }
      }
    </div>
  `,
})
export class AskForm {
  protected readonly t = t;
  readonly call = input.required<ToolCallDto>();
  protected readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);
  protected readonly sending = signal(false);
  private readonly submitted = signal(false);

  private readonly args = computed(() => (this.call().args ?? {}) as { title?: string; questions?: AskQuestion[] });
  protected readonly title = computed(() => this.args().title || t('Questions de Pi'));
  protected readonly questions = computed(() => (this.args().questions ?? []).filter((q) => q && q.question && Array.isArray(q.options)));
  protected readonly answers = signal<Answer[]>([]);

  /** Répondu : une réponse rattachée à cet appel existe déjà dans la conversation. */
  protected readonly answered = computed(
    () => this.submitted() || this.store.messages().some((m) => m.role === 'user' && m.meta?.['kind'] === 'answers' && m.meta?.['toolCallId'] === this.call().id),
  );
  protected readonly canAnswer = computed(() => this.store.isOwner() && !this.answered());
  protected readonly complete = computed(() => {
    const a = this.state();
    return a.length > 0 && a.every((x) => x.picked.size > 0 || (x.other && x.otherText.trim().length > 0));
  });

  constructor() {
    // Une entrée de réponse par question.
    effect(() => {
      const n = this.questions().length;
      untracked(() => {
        if (this.answers().length !== n) this.answers.set(Array.from({ length: n }, () => ({ picked: new Set<number>(), other: false, otherText: '' })));
      });
    });
  }

  private state(): Answer[] {
    return this.answers();
  }

  protected radioName(qi: number): string {
    return `ask-${this.call().id}-${qi}`;
  }

  protected isPicked(qi: number, oi: number): boolean {
    return this.state()[qi]?.picked.has(oi) ?? false;
  }

  private update(qi: number, fn: (a: Answer) => Answer) {
    this.answers.set(this.state().map((a, i) => (i === qi ? fn(a) : a)));
  }

  protected pick(qi: number, oi: number, q: AskQuestion) {
    this.update(qi, (a) => {
      if (!q.multi_select) return { picked: new Set([oi]), other: false, otherText: a.otherText };
      const picked = new Set(a.picked);
      if (picked.has(oi)) picked.delete(oi);
      else picked.add(oi);
      return { ...a, picked };
    });
  }

  protected pickOther(qi: number, q: AskQuestion) {
    this.update(qi, (a) => (q.multi_select ? { ...a, other: !a.other } : { picked: new Set(), other: true, otherText: a.otherText }));
  }

  protected setOther(qi: number, text: string) {
    this.update(qi, (a) => ({ ...a, otherText: text }));
  }

  protected async submit() {
    if (!this.complete() || this.sending()) return;
    const title = this.args().title;
    const lines = [title ? t('Réponses à tes questions (« {title} ») :', { title }) : t('Réponses à tes questions :'), ''];
    this.questions().forEach((q, i) => {
      const a = this.state()[i];
      const chosen = [...a.picked].sort((x, y) => x - y).map((oi) => q.options[oi].label);
      if (a.other && a.otherText.trim()) chosen.push(t('Autre : {text}', { text: a.otherText.trim() }));
      lines.push(`${i + 1}. ${q.question}`, `→ ${chosen.join(' ; ')}`, '');
    });
    this.sending.set(true);
    try {
      await this.store.send(lines.join('\n').trim(), [], this.store.activeRun() ? 'follow_up' : 'new_run', this.call().id);
      this.submitted.set(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.sending.set(false);
    }
  }
}
