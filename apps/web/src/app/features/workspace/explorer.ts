import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { FileEntryDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';

interface Node extends FileEntryDto {
  children?: Node[];
  open?: boolean;
  depth: number;
}

/**
 * Colonne de navigation des fichiers (dernier checkpoint) : recherche, arborescence à chargement
 * paresseux ou liste plate, repli global. Le fichier actif est mis en évidence.
 */
@Component({
  selector: 'cap-explorer',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-end gap-1 px-2 pt-2">
        <button class="btn-ghost !p-1" (click)="collapseAll()" [disabled]="mode() === 'list'" title="Tout replier" aria-label="Tout replier"><cap-icon name="chevronDown" [size]="14" class="rotate-180" /></button>
        <button class="btn-ghost !p-1" [class.bg-stone-200]="mode() === 'list'" [class.dark:bg-stone-700]="mode() === 'list'" (click)="toggleMode()"
          [title]="mode() === 'tree' ? 'Afficher en liste' : 'Afficher en arborescence'" [attr.aria-pressed]="mode() === 'list'" aria-label="Basculer liste / arborescence"><cap-icon name="list" [size]="14" /></button>
      </div>
      <div class="px-2 py-2">
        <div class="relative">
          <cap-icon name="search" [size]="13" class="absolute top-1/2 left-2 -translate-y-1/2 text-stone-400" />
          <input class="input !py-1.5 !pl-7 text-xs" placeholder="Rechercher des fichiers…" [ngModel]="query()" (ngModelChange)="query.set($event)" name="fq" aria-label="Rechercher des fichiers" />
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto pb-2 text-sm" role="tree" aria-label="Fichiers du workspace">
        @if (showFlat()) {
          @for (p of filtered(); track p) {
            <button class="flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left hover:bg-stone-200/70 dark:hover:bg-stone-800"
              [class.bg-stone-200]="p === selected()" [class.dark:bg-stone-800]="p === selected()" (click)="openFile.emit(p)" [title]="p" role="treeitem">
              <cap-icon name="code" [size]="13" class="shrink-0 text-stone-400" />
              <span class="truncate">{{ base(p) }}</span>
              @if (dir(p)) { <span class="truncate text-xs text-stone-400">{{ dir(p) }}</span> }
            </button>
          } @empty {
            <p class="px-3 py-4 text-xs text-stone-500">{{ query() ? 'Aucun fichier ne correspond.' : 'Aucun fichier (workspace vierge ou pas encore initialisé).' }}</p>
          }
        } @else {
          @for (n of flat(); track n.path) {
            <button class="flex w-full items-center gap-1 truncate rounded-md py-1 pr-2 text-left hover:bg-stone-200/70 dark:hover:bg-stone-800" [style.padding-left.px]="6 + n.depth * 12"
              [class.bg-stone-200]="n.path === selected()" [class.dark:bg-stone-800]="n.path === selected()"
              (click)="click(n)" role="treeitem" [attr.aria-expanded]="n.type === 'dir' ? !!n.open : null" [title]="n.path">
              @if (n.type === 'dir') { <cap-icon [name]="n.open ? 'chevronDown' : 'chevronRight'" [size]="12" class="shrink-0 text-stone-400" /><cap-icon name="folder" [size]="13" class="shrink-0 text-stone-500" /> }
              @else { <span class="w-3 shrink-0"></span><cap-icon name="code" [size]="13" class="shrink-0 text-stone-400" /> }
              <span class="truncate">{{ base(n.path) }}</span>
            </button>
          } @empty {
            <p class="px-3 py-4 text-xs text-stone-500">Aucun fichier (workspace vierge ou pas encore initialisé).</p>
          }
        }
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class Explorer {
  private readonly api = inject(Api);
  private readonly store = inject(WorkspaceStore);
  /** Fichier actif (mis en évidence). */
  readonly selected = input<string | null>(null);
  readonly openFile = output<string>();
  protected readonly query = signal('');
  protected readonly mode = signal<'tree' | 'list'>('tree');
  private readonly roots = signal<Node[]>([]);
  protected readonly flat = signal<Node[]>([]);
  private readonly allFiles = signal<string[]>([]);

  /** Recherche ou mode liste : liste plate de tous les fichiers. */
  protected readonly showFlat = computed(() => this.mode() === 'list' || this.query().trim().length > 0);
  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.allFiles().filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 2000);
  });

  constructor() {
    effect(() => {
      this.store.filesVersion();
      if (this.store.workspace()) void this.refresh();
    });
  }

  protected base(p: string): string {
    return p.split('/').pop() ?? p;
  }

  protected dir(p: string): string {
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  }

  protected toggleMode(): void {
    this.mode.set(this.mode() === 'tree' ? 'list' : 'tree');
  }

  protected collapseAll(): void {
    const walk = (ns: Node[]) => ns.forEach((n) => ((n.open = false), n.children && walk(n.children)));
    walk(this.roots());
    this.flatten();
  }

  private async list(path: string, depth: number): Promise<Node[]> {
    const items = await this.api.get<FileEntryDto[]>(`/workspaces/${this.store.workspace()!.id}/files`, { path });
    return items.map((i) => ({ ...i, depth }));
  }

  private async refresh(): Promise<void> {
    const id = this.store.workspace()!.id;
    void this.api
      .get<string[]>(`/workspaces/${id}/files/all`)
      .then((all) => this.allFiles.set(all.sort((a, b) => a.localeCompare(b))))
      .catch(() => this.allFiles.set([]));
    // Conserve les dossiers ouverts lors d'un rafraîchissement.
    const openPaths = new Set<string>();
    const walk = (ns: Node[]) =>
      ns.forEach((n) => {
        if (n.open) openPaths.add(n.path);
        if (n.children) walk(n.children);
      });
    walk(this.roots());
    const load = async (path: string, depth: number): Promise<Node[]> => {
      const nodes = await this.list(path, depth);
      for (const n of nodes)
        if (n.type === 'dir' && openPaths.has(n.path)) {
          n.open = true;
          n.children = await load(n.path, depth + 1);
        }
      return nodes;
    };
    this.roots.set(await load('', 0).catch(() => []));
    this.flatten();
  }

  protected async click(n: Node): Promise<void> {
    if (n.type !== 'dir') {
      this.openFile.emit(n.path);
      return;
    }
    n.open = !n.open;
    if (n.open && !n.children) n.children = await this.list(n.path, n.depth + 1);
    this.flatten();
  }

  private flatten(): void {
    const out: Node[] = [];
    const walk = (ns: Node[]) => {
      for (const n of ns) {
        out.push(n);
        if (n.open && n.children) walk(n.children);
      }
    };
    walk(this.roots());
    this.flat.set(out);
  }
}
