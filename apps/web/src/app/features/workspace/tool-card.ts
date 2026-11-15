import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import type { ToolCallDto } from '@cap/contracts';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';
import { CodeBlock } from '../../shared/code-block';
import { AskForm } from './ask-form';

/**
 * Appel d'outil repliable : statut, commande, sortie, durée et fichiers touchés. Les captures d'écran
 * de Pi s'affichent en miniatures (toujours visibles) et s'agrandissent au clic.
 */
@Component({
  selector: 'cap-tool-card',
  imports: [Icon, CodeBlock, AskForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (call().toolName === 'ask_user') {
      <cap-ask-form [call]="call()" />
    } @else {
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
      @if (images().length) {
        <div class="flex gap-2 overflow-x-auto border-t border-stone-200 px-3 py-2 dark:border-stone-800" role="list" aria-label="Captures d’écran">
          @for (img of images(); track img.attachmentId; let i = $index) {
            <button
              role="listitem"
              class="group relative shrink-0 overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm transition hover:border-accent-400 hover:shadow focus-visible:outline-2 focus-visible:outline-accent-500 dark:border-stone-700 dark:bg-stone-950"
              (click)="viewer.set(i)"
              [attr.aria-label]="'Agrandir la capture ' + img.fileName"
            >
              <img [src]="src(img.attachmentId)" [alt]="img.fileName" loading="lazy" class="h-28 w-auto max-w-56 object-cover object-top" [attr.width]="thumbWidth(img)" height="112" />
              <span class="absolute right-1 bottom-1 rounded bg-black/55 p-0.5 text-white opacity-0 transition group-hover:opacity-100 touch:opacity-100"><cap-icon name="maximize" [size]="12" /></span>
            </button>
          }
        </div>
      }
      @if (viewer() !== null && images()[viewer()!]; as img) {
        <div
          #overlay
          class="fixed inset-0 z-50 flex flex-col bg-black/85 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="'Capture ' + img.fileName"
          tabindex="-1"
          (click)="viewer.set(null)"
          (keydown)="onKey($event)"
        >
          <div class="mb-3 flex items-center gap-3 text-sm text-stone-200" (click)="$event.stopPropagation()">
            <span class="truncate font-mono">{{ img.fileName }}</span>
            @if (img.width && img.height) { <span class="text-stone-400">{{ img.width }} × {{ img.height }}</span> }
            @if (images().length > 1) { <span class="text-stone-400">{{ viewer()! + 1 }} / {{ images().length }}</span> }
            <a class="ml-auto rounded px-2 py-1 hover:bg-white/10" [href]="src(img.attachmentId)" target="_blank" rel="noopener">Taille réelle</a>
            <button class="rounded p-1 hover:bg-white/10" (click)="viewer.set(null)" aria-label="Fermer"><cap-icon name="x" [size]="18" /></button>
          </div>
          <div class="relative flex min-h-0 flex-1 items-center justify-center">
            @if (images().length > 1) {
              <button class="absolute left-0 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" (click)="step(-1, $event)" aria-label="Capture précédente"><cap-icon name="chevronLeft" [size]="20" /></button>
            }
            <img [src]="src(img.attachmentId)" [alt]="img.fileName" class="max-h-full max-w-full rounded object-contain shadow-2xl" (click)="$event.stopPropagation()" />
            @if (images().length > 1) {
              <button class="absolute right-0 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" (click)="step(1, $event)" aria-label="Capture suivante"><cap-icon name="chevronRight" [size]="20" /></button>
            }
          </div>
        </div>
      }
      @if (open()) {
        <div class="space-y-2 border-t border-stone-200 p-3 dark:border-stone-800 [&_.code-block]:my-0">
          @if (command()) {
            <cap-code-block [code]="command()" language="bash" label="bash" prompt="$" [wrap]="true" />
          } @else if (argsText()) {
            <cap-code-block [code]="argsText()" language="json" label="paramètres" />
          }
          @if (call().output) {
            <cap-code-block [code]="call().output" [label]="call().isError ? 'erreur' : 'sortie'" [tone]="call().isError ? 'error' : 'default'" maxHeight="24rem" />
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
    }
  `,
})
export class ToolCard {
  readonly call = input.required<ToolCallDto>();
  readonly openFile = output<string>();
  protected readonly open = signal(false);
  protected readonly viewer = signal<number | null>(null);
  protected readonly allFiles = signal(false);
  /** Fichiers touchés : les premiers seulement (un `git init` en touche des dizaines). */
  protected readonly shownFiles = computed(() => {
    const files = this.call().filesTouched;
    if (this.allFiles() || files.length <= 12) return files;
    // Les fichiers du projet d'abord, l'intérieur de .git ensuite.
    return [...files].sort((a, b) => Number(a.includes('/.git/') || a.startsWith('.git/')) - Number(b.includes('/.git/') || b.startsWith('.git/'))).slice(0, 12);
  });
  private readonly store = inject(WorkspaceStore);
  private readonly overlay = viewChild<ElementRef<HTMLElement>>('overlay');
  protected readonly images = computed(() => this.call().images ?? []);

  constructor() {
    // Focus sur la visionneuse à l'ouverture (clavier : Échap, flèches).
    effect(() => this.overlay()?.nativeElement.focus());
  }

  protected src(attachmentId: string): string {
    return `/api/v1/workspaces/${this.store.workspace()?.id}/screenshots/${attachmentId}`;
  }

  protected thumbWidth(img: { width: number | null; height: number | null }): number | null {
    return img.width && img.height ? Math.min(224, Math.round((112 * img.width) / img.height)) : null;
  }

  protected step(delta: number, ev?: Event) {
    ev?.stopPropagation();
    const n = this.images().length;
    this.viewer.update((i) => (i === null ? null : (i + delta + n) % n));
  }

  protected onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') this.viewer.set(null);
    else if (ev.key === 'ArrowRight') this.step(1);
    else if (ev.key === 'ArrowLeft') this.step(-1);
  }

  protected readonly icon = computed(() => ({ bash: 'terminal', read: 'eye', write: 'file', edit: 'edit', browser_screenshot: 'image' })[this.call().toolName] ?? (this.call().toolName.startsWith('platform_') ? 'git' : this.call().toolName.startsWith('mcp__') ? 'puzzle' : 'cpu'));
  protected readonly label = computed(() => ({ bash: 'Commande', read: 'Lecture', write: 'Écriture', edit: 'Modification', browser_screenshot: 'Capture d’écran' })[this.call().toolName] ?? this.call().toolName);
  protected readonly summary = computed(() => {
    const a = (this.call().args ?? {}) as Record<string, unknown>;
    return String(a['command'] ?? a['path'] ?? a['file_path'] ?? a['url'] ?? a['local_branch'] ?? a['title'] ?? '').split('\n')[0].slice(0, 120);
  });
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
