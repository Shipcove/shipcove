import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';
import { t } from '../../core/i18n';

/**
 * Volet « Plan » : liste des tâches établie par Pi (outil `update_plan`) pour une tâche complexe,
 * tenue à jour en direct. Tâche en cours signalée, tâches terminées cochées et barrées.
 */
@Component({
  selector: 'cap-plan-pane',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-1 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
        <span class="flex-1 text-sm font-medium text-stone-700 dark:text-stone-200">{{ t('Plan') }}</span>
        @if (progress(); as p) { <span class="mr-1 text-xs text-stone-500 tabular-nums">{{ p.done }}/{{ p.total }}</span> }
        @if (expandable()) {
          <button class="btn-ghost !p-1.5" (click)="toggleExpand.emit()" [attr.aria-label]="expanded() ? t('Réduire') : t('Agrandir')" [title]="expanded() ? t('Réduire') : t('Agrandir')">
            <cap-icon [name]="expanded() ? 'minimize' : 'maximize'" [size]="14" />
          </button>
        }
        <button class="btn-ghost !p-1.5" (click)="closed.emit()" [attr.aria-label]="t('Fermer le plan')" [title]="t('Fermer')"><cap-icon name="x" [size]="15" /></button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        @if (store.plan(); as items) {
          <div class="mb-2 text-[11px] font-medium tracking-wide text-stone-500 uppercase">{{ t('Tâches') }}</div>
          <ul class="space-y-1.5" role="list" [attr.aria-label]="t('Tâches du plan')">
            @for (it of items; track $index) {
              <li class="flex items-start gap-2 text-sm" [attr.aria-current]="it.status === 'in_progress' ? 'step' : null">
                @switch (it.status) {
                  @case ('completed') {
                    <cap-icon name="check" [size]="15" class="mt-0.5 shrink-0 text-emerald-600" [attr.aria-label]="t('Terminée')" />
                    <span class="text-stone-400 line-through dark:text-stone-500">{{ it.content }}</span>
                  }
                  @case ('in_progress') {
                    <span class="mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center" [attr.aria-label]="t('En cours')">
                      <span class="h-3 w-3 rounded-full border-2 border-accent-500 border-t-transparent" [class.animate-spin]="running()"></span>
                    </span>
                    <span class="font-medium text-stone-900 dark:text-stone-100">{{ it.content }}</span>
                  }
                  @default {
                    <span class="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border border-stone-300 dark:border-stone-600" [attr.aria-label]="t('À faire')"></span>
                    <span class="text-stone-700 dark:text-stone-300">{{ it.content }}</span>
                  }
                }
              </li>
            }
          </ul>
        } @else {
          <p class="mt-8 text-center text-sm text-stone-500">
            {{ t('Pas encore de plan.') }}<br />{{ t('Pour une tâche complexe, Pi établit ici la liste de ses étapes et la tient à jour pendant qu’il travaille.') }}
          </p>
        }
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class PlanPane {
  protected readonly t = t;
  protected readonly store = inject(WorkspaceStore);
  readonly expanded = input(false);
  readonly expandable = input(false);
  readonly closed = output<void>();
  readonly toggleExpand = output<void>();
  /** La tâche en cours n'est animée que pendant que Pi travaille. */
  protected readonly running = computed(() => this.store.activeRun()?.status === 'running');
  protected readonly progress = computed(() => {
    const items = this.store.plan();
    return items ? { done: items.filter((i) => i.status === 'completed').length, total: items.length } : null;
  });
}
