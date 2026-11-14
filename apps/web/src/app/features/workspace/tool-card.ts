import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ToolCallDto } from '@cap/contracts';
import { Icon } from '../../shared/icon';

/** Appel d'outil repliable : statut, commande, sortie, durée et fichiers touchés. */
@Component({
  selector: 'cap-tool-card',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="my-1.5 min-w-0 overflow-hidden rounded-lg border border-stone-200 bg-stone-50 text-sm dark:border-stone-800 dark:bg-stone-900/70">
      <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800/70" (click)="open.set(!open())" [attr.aria-expanded]="open()">
        <cap-icon [name]="open() ? 'chevronDown' : 'chevronRight'" [size]="14" class="text-stone-400" />
        <cap-icon [name]="icon()" [size]="14" class="text-stone-500" />
        <span class="font-medium">{{ label() }}</span>
        <span class="truncate font-mono text-xs text-stone-500">{{ summary() }}</span>
        <span class="ml-auto flex shrink-0 items-center gap-2 text-xs text-stone-500">
          @if (call().filesTouched.length) { <span title="Fichiers modifiés">{{ call().filesTouched.length }} fichier(s)</span> }
          @if (call().durationMs !== null) { <span>{{ duration() }}</span> }
          @switch (call().status) {
            @case ('running') { <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500" aria-label="En cours"></span> }
            @case ('failed') { <cap-icon name="x" [size]="14" class="text-red-600" /> }
            @case ('blocked') { <cap-icon name="lock" [size]="14" class="text-amber-600" /> }
            @default { <cap-icon name="check" [size]="14" class="text-emerald-600" /> }
          }
        </span>
      </button>
      @if (open()) {
        <div class="border-t border-stone-200 dark:border-stone-800">
          @if (argsText()) {
            <pre class="max-h-48 overflow-auto bg-white px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-stone-700 dark:bg-stone-950 dark:text-stone-300">{{ argsText() }}</pre>
          }
          @if (call().output) {
            <div class="relative">
              <pre class="max-h-96 overflow-auto bg-stone-900 px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-stone-100" [class.text-red-300]="call().isError">{{ call().output }}</pre>
              <button class="btn-ghost absolute top-1 right-1 !p-1 !text-stone-300" (click)="copy()" aria-label="Copier la sortie"><cap-icon [name]="copied() ? 'check' : 'copy'" [size]="13" /></button>
            </div>
          }
          @if (call().filesTouched.length) {
            <div class="flex flex-wrap gap-1 px-3 py-2">
              @for (f of call().filesTouched; track f) {
                <button class="badge bg-stone-200 font-mono text-stone-700 hover:bg-stone-300 dark:bg-stone-800 dark:text-stone-300" (click)="openFile.emit(f)">{{ f }}</button>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class ToolCard {
  readonly call = input.required<ToolCallDto>();
  readonly openFile = output<string>();
  protected readonly open = signal(false);
  protected readonly copied = signal(false);

  protected readonly icon = computed(() => ({ bash: 'terminal', read: 'eye', write: 'file', edit: 'edit' })[this.call().toolName] ?? (this.call().toolName.startsWith('platform_') ? 'git' : this.call().toolName.startsWith('mcp__') ? 'puzzle' : 'cpu'));
  protected readonly label = computed(() => ({ bash: 'Commande', read: 'Lecture', write: 'Écriture', edit: 'Modification' })[this.call().toolName] ?? this.call().toolName);
  protected readonly summary = computed(() => {
    const a = (this.call().args ?? {}) as Record<string, unknown>;
    return String(a['command'] ?? a['path'] ?? a['file_path'] ?? a['local_branch'] ?? a['title'] ?? '').split('\n')[0].slice(0, 120);
  });
  protected readonly argsText = computed(() => {
    const a = (this.call().args ?? {}) as Record<string, unknown>;
    if (this.call().toolName === 'bash') return `$ ${a['command'] ?? ''}`;
    const { content: _c, ...rest } = a;
    const s = JSON.stringify(rest, null, 2);
    return s === '{}' ? '' : s;
  });
  protected readonly duration = computed(() => {
    const ms = this.call().durationMs ?? 0;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  });

  protected async copy() {
    await navigator.clipboard.writeText(this.call().output);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
