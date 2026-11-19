import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { ToolCallDto } from '@cap/contracts';
import { Icon } from '../../shared/icon';
import { CodeBlocksDirective, MarkdownPipe } from '../../shared/pipes';
import { t } from '../../core/i18n';

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface SubagentView {
  title: string;
  mode: 'explore' | 'work';
  status: SubagentStatus;
  steps: Array<{ tool: string; summary: string; status: 'running' | 'completed' | 'failed' }>;
  toolCount: number;
  output: string;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  tokens: number;
}

/** Tâches demandées (arguments de l'appel), en attendant la première mise à jour du plugin. */
function fromArgs(args: unknown): SubagentView[] {
  const tasks = ((args ?? {}) as { tasks?: Array<{ title?: string; mode?: string }> }).tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map((x) => ({
    title: String(x?.title ?? ''),
    mode: x?.mode === 'work' ? 'work' : 'explore',
    status: 'queued',
    steps: [],
    toolCount: 0,
    output: '',
    error: null,
    startedAt: null,
    endedAt: null,
    tokens: 0,
  }));
}

/** Sous-agents d'un appel `subagent` : détails structurés du plugin, sinon les tâches demandées. */
export function subagentsOf(call: ToolCallDto): SubagentView[] {
  const d = call.details as { kind?: string; agents?: SubagentView[] } | null;
  const agents = d?.kind === 'subagents' && Array.isArray(d.agents) ? d.agents : fromArgs(call.args);
  // Appel terminé sans état final (ancienne image, interruption) : plus rien n'est « en cours ».
  if (call.status === 'running') return agents;
  return agents.map((a) => (a.status === 'running' || a.status === 'queued' ? { ...a, status: call.status === 'completed' ? 'completed' : 'aborted' } : a));
}

/**
 * Carte des sous-agents : une ligne par sous-agent (statut, mode, nombre d'actions, durée), ses
 * dernières étapes pendant qu'il travaille et, une fois terminé, son compte rendu en dépliant la ligne.
 */
@Component({
  selector: 'cap-subagents-view',
  imports: [Icon, MarkdownPipe, CodeBlocksDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="my-1.5 min-w-0 overflow-hidden rounded-lg border border-stone-200 bg-stone-50 text-sm dark:border-stone-800 dark:bg-stone-900/70">
      <div class="flex items-center gap-2 px-3 py-1.5">
        <cap-icon name="agents" [size]="14" class="text-stone-500" />
        <span class="font-medium">{{ t('Sous-agents') }}</span>
        <span class="truncate text-xs text-stone-500">{{ headline() }}</span>
        @if (call().status === 'running') {
          <span class="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-500" [attr.aria-label]="t('En cours')"></span>
        }
      </div>
      <ul class="divide-y divide-stone-200 border-t border-stone-200 dark:divide-stone-800 dark:border-stone-800">
        @for (a of agents(); track $index; let i = $index) {
          <li>
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-stone-100 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-stone-800/70 dark:disabled:hover:bg-transparent"
              (click)="toggle(i)"
              [disabled]="!expandable(a)"
              [attr.aria-expanded]="expandable(a) ? isOpen(i, a) : null"
            >
              @switch (a.status) {
                @case ('running') { <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-500" [attr.aria-label]="t('En cours')"></span> }
                @case ('queued') { <span class="h-2 w-2 shrink-0 rounded-full border border-stone-400" [attr.aria-label]="t('En attente')"></span> }
                @case ('completed') { <cap-icon name="check" [size]="14" class="shrink-0 text-emerald-600" [attr.aria-label]="t('Terminé')" /> }
                @case ('aborted') { <cap-icon name="stop" [size]="12" class="shrink-0 text-stone-400" [attr.aria-label]="t('Interrompu')" /> }
                @default { <cap-icon name="x" [size]="14" class="shrink-0 text-red-600" [attr.aria-label]="t('Échec')" /> }
              }
              <span class="truncate font-medium">{{ a.title }}</span>
              <span
                class="badge shrink-0"
                [class]="a.mode === 'work' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300'"
                [title]="a.mode === 'work' ? t('Peut modifier des fichiers et lancer des commandes') : t('Lecture seule')"
              >{{ a.mode === 'work' ? t('travail') : t('exploration') }}</span>
              <span class="ml-auto flex shrink-0 items-center gap-2 text-xs text-stone-500">
                @if (a.toolCount) { <span>{{ t('{n} action(s)', { n: a.toolCount }) }}</span> }
                @if (elapsed(a); as d) { <span>{{ d }}</span> }
                @if (expandable(a)) { <cap-icon [name]="isOpen(i, a) ? 'chevronDown' : 'chevronRight'" [size]="14" class="text-stone-400" /> }
              </span>
            </button>
            @if (a.status === 'running' && a.steps.length && !isOpen(i, a)) {
              <ol class="space-y-0.5 px-3 pb-2 pl-8">
                @for (s of a.steps.slice(-3); track $index) {
                  <li class="flex min-w-0 items-center gap-1.5 text-xs text-stone-500">
                    <span class="shrink-0 font-medium text-stone-600 dark:text-stone-400">{{ s.tool }}</span>
                    <span class="truncate font-mono">{{ s.summary }}</span>
                    @if (s.status === 'running') { <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-500"></span> }
                  </li>
                }
              </ol>
            }
            @if (isOpen(i, a)) {
              <div class="space-y-2 border-t border-stone-200 px-3 py-2 dark:border-stone-800">
                @if (a.error) { <p class="text-xs text-red-600">{{ a.error }}</p> }
                @if (a.steps.length) {
                  <details class="text-xs text-stone-500">
                    <summary class="cursor-pointer select-none">{{ t('Étapes ({n})', { n: a.toolCount }) }}</summary>
                    <ol class="mt-1 space-y-0.5">
                      @for (s of a.steps; track $index) {
                        <li class="flex min-w-0 items-center gap-1.5">
                          <span class="shrink-0 font-medium text-stone-600 dark:text-stone-400">{{ s.tool }}</span>
                          <span class="truncate font-mono">{{ s.summary }}</span>
                          @if (s.status === 'failed') { <cap-icon name="x" [size]="12" class="shrink-0 text-red-600" /> }
                        </li>
                      }
                    </ol>
                  </details>
                }
                @if (a.output) {
                  <div class="prose-chat min-w-0 text-sm" capCodeBlocks [innerHTML]="a.output | markdown"></div>
                } @else if (a.status !== 'running') {
                  <p class="text-xs text-stone-500">{{ t('Aucun compte rendu.') }}</p>
                }
              </div>
            }
          </li>
        }
      </ul>
    </div>
  `,
})
export class SubagentsView {
  protected readonly t = t;
  readonly call = input.required<ToolCallDto>();
  /** Lignes ouvertes ou fermées par l'utilisateur (sinon : ouverte s'il n'y a qu'un sous-agent terminé). */
  private readonly toggled = signal<Record<number, boolean>>({});
  protected readonly agents = computed(() => subagentsOf(this.call()));
  protected readonly headline = computed(() => {
    const all = this.agents();
    const running = all.filter((a) => a.status === 'running').length;
    const done = all.filter((a) => a.status !== 'running' && a.status !== 'queued').length;
    if (this.call().status === 'running') return t('{done}/{total} terminé(s), {running} en cours', { done, total: all.length, running });
    return t('{n} sous-agent(s)', { n: all.length });
  });

  protected expandable(a: SubagentView): boolean {
    return !!(a.output || a.error || a.steps.length);
  }

  protected isOpen(i: number, a: SubagentView): boolean {
    const v = this.toggled()[i];
    if (v !== undefined) return v && this.expandable(a);
    return this.agents().length === 1 && a.status !== 'running' && !!a.output;
  }

  protected toggle(i: number) {
    const a = this.agents()[i];
    this.toggled.update((s) => ({ ...s, [i]: !this.isOpen(i, a) }));
  }

  protected elapsed(a: SubagentView): string {
    if (!a.startedAt || !a.endedAt) return '';
    const ms = a.endedAt - a.startedAt;
    return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  }
}
