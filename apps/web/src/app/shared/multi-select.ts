import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, input, model, signal, viewChild } from '@angular/core';
import { Icon } from './icon';
import { t } from '../core/i18n';

export interface MultiSelectOption {
  value: string;
  label: string;
  description?: string;
  /** Option non modifiable (cadenas), avec la raison affichée à côté. */
  locked?: boolean;
  lockedReason?: string;
}

/**
 * Sélection multiple : puces des valeurs choisies (× pour en retirer une, ⊗ pour tout vider), liste
 * déroulante à cases à cocher avec recherche, « Tout sélectionner » / « Aucun ». Les options
 * verrouillées restent visibles, grisées, et ne changent jamais d'état. Clavier : ↑ ↓ pour se
 * déplacer, Entrée ou Espace pour cocher, Échap pour fermer, Retour arrière pour retirer la dernière puce.
 */
@Component({
  selector: 'cap-multi-select',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block' },
  template: `
    <div
      class="input flex min-h-9 cursor-text flex-wrap items-center gap-1 !py-1 pr-16"
      [class.ring-2]="open()"
      [class.ring-accent-500]="open()"
      (click)="openList()"
    >
      @for (o of chips(); track o.value) {
        <span class="inline-flex max-w-full items-center gap-1 rounded border border-stone-300 bg-white px-1.5 py-0.5 font-mono text-xs dark:border-stone-700 dark:bg-stone-800">
          <span class="truncate">{{ o.label }}</span>
          @if (!o.locked) {
            <button type="button" class="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" (click)="remove(o.value, $event)" [attr.aria-label]="t('Retirer {name}', { name: o.label })">
              <cap-icon name="x" [size]="11" />
            </button>
          }
        </span>
      }
      <input
        #search
        class="min-w-24 flex-1 border-0 bg-transparent p-0.5 text-sm outline-none focus:ring-0"
        [placeholder]="chips().length ? '' : placeholder()"
        [value]="query()"
        (input)="query.set($any($event.target).value); active.set(0); open.set(true)"
        (focus)="open.set(true)"
        (keydown)="onKey($event)"
        role="combobox"
        [attr.aria-expanded]="open()"
        [attr.aria-label]="ariaLabel()"
        aria-autocomplete="list"
      />
      <span class="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 text-stone-500">
        @if (clearable()) {
          <button type="button" class="rounded-full hover:text-stone-900 dark:hover:text-stone-100" (click)="clear($event)" [attr.aria-label]="t('Tout désélectionner')" [title]="t('Tout désélectionner')">
            <cap-icon name="x" [size]="13" />
          </button>
        }
        <button type="button" (click)="toggle($event)" [attr.aria-label]="open() ? t('Fermer la liste') : t('Ouvrir la liste')"><cap-icon [name]="open() ? 'chevronDown' : 'chevronRight'" [size]="14" /></button>
      </span>
    </div>
    @if (open()) {
      <div class="absolute right-0 left-0 z-30 mt-1 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900">
        <div class="flex items-center gap-3 border-b border-stone-200 px-3 py-1.5 text-xs dark:border-stone-800">
          <span class="text-stone-500">{{ t('{n}/{total} sélectionné(s)', { n: value().length, total: options().length }) }}</span>
          <button type="button" class="ml-auto text-accent-700 hover:underline dark:text-accent-400" (click)="selectAll()">{{ t('Tout sélectionner') }}</button>
          <button type="button" class="text-accent-700 hover:underline dark:text-accent-400" (click)="selectNone()">{{ t('Aucun') }}</button>
        </div>
        <ul class="max-h-72 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
          @for (o of filtered(); track o.value; let i = $index) {
            <li
              role="option"
              [attr.aria-selected]="isOn(o.value)"
              [attr.aria-disabled]="o.locked || null"
              class="flex cursor-pointer items-start gap-2.5 border-l-2 px-3 py-1.5 text-sm"
              [class]="i === active() ? 'border-accent-500 bg-stone-100 dark:bg-stone-800' : 'border-transparent'"
              [class.cursor-not-allowed]="o.locked"
              [class.opacity-60]="o.locked"
              (mousemove)="active.set(i)"
              (mousedown)="$event.preventDefault()"
              (click)="flip(o)"
            >
              @if (o.locked) {
                <cap-icon name="lock" [size]="14" class="mt-0.5 shrink-0 text-stone-400" />
              } @else {
                <input type="checkbox" class="pointer-events-none mt-0.5 h-4 w-4 shrink-0" [checked]="isOn(o.value)" tabindex="-1" aria-hidden="true" />
              }
              <span class="min-w-0">
                <span class="block truncate font-mono text-[13px]">{{ o.label }}</span>
                @if (o.locked && o.lockedReason) { <span class="block truncate text-xs text-stone-500">{{ o.lockedReason }}</span> }
                @else if (o.description) { <span class="block truncate text-xs text-stone-500" [title]="o.description">{{ o.description }}</span> }
              </span>
            </li>
          } @empty {
            <li class="px-3 py-2 text-sm text-stone-500">{{ t('Aucun résultat.') }}</li>
          }
        </ul>
      </div>
    }
  `,
})
export class MultiSelect {
  protected readonly t = t;
  readonly options = input.required<MultiSelectOption[]>();
  /** Valeurs sélectionnées (liaison bidirectionnelle). */
  readonly value = model<string[]>([]);
  readonly placeholder = input(t('Choisir…'));
  readonly ariaLabel = input(t('Sélection'));
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly chips = computed(() => {
    const on = new Set(this.value());
    return this.options().filter((o) => on.has(o.value));
  });
  protected readonly clearable = computed(() => this.chips().some((o) => !o.locked));
  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return q ? this.options().filter((o) => o.label.toLowerCase().includes(q) || (o.description ?? '').toLowerCase().includes(q)) : this.options();
  });

  constructor(private readonly el: ElementRef<HTMLElement>) {}

  /** Clic en dehors : la liste se ferme. */
  @HostListener('document:mousedown', ['$event'])
  protected onDocument(ev: MouseEvent) {
    if (this.open() && !this.el.nativeElement.contains(ev.target as Node)) this.close();
  }

  protected isOn(v: string): boolean {
    return this.value().includes(v);
  }

  protected openList() {
    this.open.set(true);
    this.searchInput()?.nativeElement.focus();
  }

  protected toggle(ev: Event) {
    ev.stopPropagation();
    if (this.open()) this.close();
    else this.openList();
  }

  private close() {
    this.open.set(false);
    this.query.set('');
  }

  protected flip(o: MultiSelectOption) {
    if (o.locked) return;
    this.value.set(this.isOn(o.value) ? this.value().filter((v) => v !== o.value) : [...this.value(), o.value]);
  }

  protected remove(v: string, ev: Event) {
    ev.stopPropagation();
    this.value.set(this.value().filter((x) => x !== v));
  }

  /** Tout vider, sauf les options verrouillées (dont l'état ne change jamais). */
  protected clear(ev: Event) {
    ev.stopPropagation();
    this.selectNone();
  }

  /** Options modifiables de la liste affichée (filtre de recherche compris). */
  private editable(): string[] {
    return this.filtered().filter((o) => !o.locked).map((o) => o.value);
  }

  protected selectAll() {
    this.value.set([...new Set([...this.value(), ...this.editable()])]);
  }

  protected selectNone() {
    const off = new Set(this.editable());
    this.value.set(this.value().filter((v) => !off.has(v)));
  }

  protected onKey(ev: KeyboardEvent) {
    const list = this.filtered();
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        this.open.set(true);
        this.active.set(Math.min(list.length - 1, this.active() + 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        this.active.set(Math.max(0, this.active() - 1));
        break;
      case 'Enter':
      case ' ':
        if (ev.key === ' ' && this.query()) return;
        ev.preventDefault();
        if (this.open() && list[this.active()]) this.flip(list[this.active()]);
        else this.open.set(true);
        break;
      case 'Escape':
        if (this.open()) {
          ev.stopPropagation();
          this.close();
        }
        break;
      case 'Backspace': {
        if (this.query()) return;
        const last = this.chips().filter((o) => !o.locked).at(-1);
        if (last) this.value.set(this.value().filter((v) => v !== last.value));
        break;
      }
    }
  }
}
