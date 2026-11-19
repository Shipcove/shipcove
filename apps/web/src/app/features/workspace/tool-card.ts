import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { ToolCallDto } from '@cap/contracts';
import { Icon } from '../../shared/icon';
import { WorkspaceStore, parsePlan } from './workspace.store';
import { CodeBlock } from '../../shared/code-block';
import { AskForm } from './ask-form';
import { SharedFiles } from './shared-files';
import { ApprovalCard } from './approval-card';
import { ScreenshotStrip } from './screenshot-strip';
import { SubagentsView, subagentsOf } from './subagents-view';
import { t } from '../../core/i18n';

/** Outils de Pi qui créent une demande d'approbation Git (affichée sous l'appel). */
export const APPROVAL_TOOLS = new Set(['platform_git_push', 'platform_create_pull_request', 'platform_merge_pull_request', 'platform_delete_remote_branch']);

export function toolIcon(name: string): string {
  return ({ bash: 'terminal', read: 'eye', write: 'file', edit: 'edit', browser_screenshot: 'image', share_files: 'download', update_plan: 'checklist', subagent: 'agents' } as Record<string, string>)[name] ?? (name.startsWith('platform_') ? 'git' : name.startsWith('mcp__') ? 'puzzle' : 'cpu');
}

export function toolLabel(name: string): string {
  return ({ bash: t('Commande'), read: t('Lecture'), write: t('Écriture'), edit: t('Modification'), browser_screenshot: t('Capture d’écran'), share_files: t('Fichiers à télécharger'), update_plan: t('Plan'), subagent: t('Sous-agents'), platform_git_push: t('Push (approbation)'), platform_create_pull_request: t('Pull request (approbation)'), platform_merge_pull_request: t('Fusion (approbation)'), platform_delete_remote_branch: t('Suppression de branche (approbation)') } as Record<string, string>)[name] ?? name;
}

/** Argument principal d'un appel (commande, chemin, URL…), sur une ligne. */
export function toolSummary(call: ToolCallDto): string {
  if (call.toolName === 'update_plan') {
    const items = parsePlan(call.args) ?? [];
    return t('{done}/{total} tâches terminées', { done: items.filter((i) => i.status === 'completed').length, total: items.length });
  }
  if (call.toolName === 'subagent') return subagentsOf(call).map((a) => a.title).join(' · ').slice(0, 120);
  const a = (call.args ?? {}) as Record<string, unknown>;
  return String(a['command'] ?? a['path'] ?? a['file_path'] ?? a['url'] ?? a['local_branch'] ?? a['title'] ?? '').split('\n')[0].slice(0, 120);
}

/**
 * Appel d'outil repliable : statut, commande, sortie, durée et fichiers touchés. Les captures d'écran
 * de Pi s'affichent en miniatures (toujours visibles) et s'agrandissent au clic ; dans un groupe
 * d'étapes, elles sont affichées sous le groupe (voir la ligne `images` du fil).
 */
@Component({
  selector: 'cap-tool-card',
  imports: [Icon, CodeBlock, AskForm, SharedFiles, ApprovalCard, ScreenshotStrip, SubagentsView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (call().toolName === 'ask_user') {
      <cap-ask-form [call]="call()" />
    } @else if (call().toolName === 'share_files') {
      <cap-shared-files [call]="call()" />
    } @else if (call().toolName === 'subagent') {
      <cap-subagents-view [call]="call()" />
    } @else {
    <div class="my-1.5 min-w-0 overflow-hidden rounded-lg border border-stone-200 bg-stone-50 text-sm dark:border-stone-800 dark:bg-stone-900/70">
      <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800/70" (click)="open.set(!open())" [attr.aria-expanded]="open()">
        <cap-icon [name]="open() ? 'chevronDown' : 'chevronRight'" [size]="14" class="text-stone-400" />
        <cap-icon [name]="icon()" [size]="14" class="text-stone-500" />
        <span class="font-medium">{{ label() }}</span>
        <span class="truncate font-mono text-xs text-stone-500">{{ summary() }}</span>
        <span class="ml-auto flex shrink-0 items-center gap-2 text-xs text-stone-500">
          @if (call().filesTouched.length) { <span [title]="t('Fichiers modifiés')">{{ t('{n} fichier(s)', { n: call().filesTouched.length }) }}</span> }
          @if (call().durationMs !== null) { <span>{{ duration() }}</span> }
          @switch (call().status) {
            @case ('running') { <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500" [attr.aria-label]="t('En cours')"></span> }
            @case ('failed') { <cap-icon name="x" [size]="14" class="text-red-600" /> }
            @case ('blocked') { <cap-icon name="lock" [size]="14" class="text-amber-600" /> }
            @default { <cap-icon name="check" [size]="14" class="text-emerald-600" /> }
          }
        </span>
      </button>
      @if (showImages() && images().length) {
        <div class="border-t border-stone-200 px-3 py-1 dark:border-stone-800"><cap-screenshot-strip [images]="images()" /></div>
      }
      @if (open()) {
        <div class="space-y-2 border-t border-stone-200 p-3 dark:border-stone-800 [&_.code-block]:my-0">
          @if (command()) {
            <cap-code-block [code]="command()" language="bash" label="bash" prompt="$" [wrap]="true" />
          } @else if (argsText()) {
            <cap-code-block [code]="argsText()" language="json" [label]="t('paramètres')" />
          }
          @if (call().output) {
            <cap-code-block [code]="call().output" label="sortie" maxHeight="24rem" />
          }
          @if (call().filesTouched.length) {
            <div class="flex flex-wrap gap-1">
              @for (f of shownFiles(); track f) {
                <button class="badge bg-stone-200 font-mono text-stone-700 hover:bg-stone-300 dark:bg-stone-800 dark:text-stone-300" (click)="openFile.emit(f)">{{ f }}</button>
              }
              @if (call().filesTouched.length > shownFiles().length) {
                <button class="badge bg-transparent text-stone-500 hover:text-stone-800 dark:hover:text-stone-200" (click)="allFiles.set(true)">+ {{ call().filesTouched.length - shownFiles().length }} autres</button>
              }
            </div>
          }
        </div>
      }
    </div>
    @if (approval(); as a) { <div class="mb-2"><cap-approval-card [approval]="a" /></div> }
    }
  `,
})
export class ToolCard {
  protected readonly t = t;
  readonly call = input.required<ToolCallDto>();
  readonly openFile = output<string>();
  /** Captures sous l'appel ; masquées dans un groupe d'étapes, qui les affiche en dessous de lui. */
  readonly showImages = input(true);
  protected readonly open = signal(false);
  protected readonly allFiles = signal(false);
  /** Fichiers touchés : les premiers seulement (un `git init` en touche des dizaines). */
  protected readonly shownFiles = computed(() => {
    const files = this.call().filesTouched;
    if (this.allFiles() || files.length <= 12) return files;
    // Les fichiers du projet d'abord, l'intérieur de .git ensuite.
    return [...files].sort((a, b) => Number(a.includes('/.git/') || a.startsWith('.git/')) - Number(b.includes('/.git/') || b.startsWith('.git/'))).slice(0, 12);
  });
  private readonly store = inject(WorkspaceStore);
  protected readonly images = computed(() => this.call().images ?? []);
  /** Demande d'approbation créée par cet appel (outils `platform_*` Git). */
  protected readonly approval = computed(() => (APPROVAL_TOOLS.has(this.call().toolName) ? (this.store.approvals().find((a) => a.toolCallId === this.call().id) ?? null) : null));


  protected readonly icon = computed(() => toolIcon(this.call().toolName));
  protected readonly label = computed(() => toolLabel(this.call().toolName));
  protected readonly summary = computed(() => toolSummary(this.call()));
  /** Commande shell (outil bash), affichée avec coloration et invite `$`. */
  protected readonly command = computed(() => {
    if (this.call().toolName !== 'bash') return '';
    return String(((this.call().args ?? {}) as Record<string, unknown>)['command'] ?? '');
  });
  protected readonly argsText = computed(() => {
    const a = (this.call().args ?? {}) as Record<string, unknown>;
    const { content: _c, ...rest } = a;
    const s = JSON.stringify(rest, null, 2);
    return s === '{}' ? '' : s;
  });
  protected readonly duration = computed(() => {
    const ms = this.call().durationMs ?? 0;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  });

}
