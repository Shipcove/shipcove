import { ChangeDetectionStrategy, Component, computed, input, model, output, signal } from '@angular/core';
import { Icon } from '../../shared/icon';
import { Explorer } from './explorer';
import { FilePanel } from './file-panel';
import { t } from '../../core/i18n';

/**
 * Volet « Fichiers » : onglets des fichiers ouverts, visionneuse (Monaco) et colonne de
 * navigation à droite (recherche, arborescence / liste). Exclusif avec le panneau latéral.
 */
@Component({
  selector: 'cap-files-pane',
  imports: [Icon, Explorer, FilePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-1 border-b border-stone-200 py-1.5 pr-2 pl-2 dark:border-stone-800">
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" [attr.aria-label]="t('Fichiers ouverts')">
          @for (p of openFiles(); track p) {
            <div class="flex shrink-0 items-center gap-1 rounded-md py-1 pr-1 pl-2.5 text-sm" role="tab" [attr.aria-selected]="p === active()"
              [class]="p === active() ? 'bg-stone-100 dark:bg-stone-800' : 'text-stone-500 hover:bg-stone-100/70 dark:hover:bg-stone-800/60'">
              <button class="max-w-48 truncate" [class.italic]="p === active()" (click)="active.set(p)" [title]="p">{{ base(p) }}</button>
              <button class="rounded p-0.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-700" (click)="closeFile(p)" [attr.aria-label]="t('Fermer {name}', { name: base(p) })"><cap-icon name="x" [size]="12" /></button>
            </div>
          } @empty {
            <span class="px-1 text-sm text-stone-600 dark:text-stone-300">{{ t('Fichiers') }}</span>
          }
        </div>
        @if (compact()) {
          <button class="btn-ghost !p-1.5" [class.bg-stone-200]="browsing()" [class.dark:bg-stone-700]="browsing()" (click)="browse.set(!browse())"
            [attr.aria-pressed]="browsing()" [attr.aria-label]="t('Arborescence des fichiers')" [title]="t('Arborescence')"><cap-icon name="folder" [size]="15" /></button>
        }
        @if (expandable()) {
        <button class="btn-ghost !p-1.5" (click)="toggleExpand.emit()" [attr.aria-label]="expanded() ? t('Réduire') : t('Agrandir')" [title]="expanded() ? t('Réduire') : t('Agrandir')"><cap-icon [name]="expanded() ? 'minimize' : 'maximize'" [size]="14" /></button>
        }
        <button class="btn-ghost !p-1.5" (click)="closed.emit()" [attr.aria-label]="t('Fermer l’explorateur')" [title]="t('Fermer')"><cap-icon name="x" [size]="15" /></button>
      </div>
      <!-- Écran étroit : arborescence ou fichier, l'un après l'autre. -->
      <div class="flex min-h-0 flex-1">
        <div class="min-w-0 flex-1" [class.hidden]="compact() && browsing()"><cap-file-panel [path]="active()" /></div>
        <div class="shrink-0 border-stone-200 dark:border-stone-800" [class]="compact() ? (browsing() ? 'w-full' : 'hidden') : 'w-60 border-l'">
          <cap-explorer [selected]="active()" (openFile)="open($event)" />
        </div>
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class FilesPane {
  protected readonly t = t;
  /** Fichiers ouverts (onglets) et fichier actif, partagés avec la page. */
  readonly openFiles = model<string[]>([]);
  readonly active = model<string | null>(null);
  readonly expanded = input(false);
  /** Écran étroit : arborescence et fichier affichés l'un après l'autre. */
  readonly compact = input(false);
  readonly expandable = input(true);
  protected readonly browse = signal(false);
  /** Sans fichier ouvert, l'arborescence s'affiche d'office. */
  protected readonly browsing = computed(() => this.browse() || !this.active());
  readonly toggleExpand = output<void>();
  readonly closed = output<void>();

  protected base(p: string): string {
    return p.split('/').pop() ?? p;
  }

  open(path: string): void {
    if (!this.openFiles().includes(path)) this.openFiles.set([...this.openFiles(), path]);
    this.active.set(path);
    this.browse.set(false);
  }

  protected closeFile(path: string): void {
    const list = this.openFiles();
    const idx = list.indexOf(path);
    const next = list.filter((p) => p !== path);
    this.openFiles.set(next);
    if (this.active() === path) this.active.set(next[Math.min(idx, next.length - 1)] ?? null);
  }
}
