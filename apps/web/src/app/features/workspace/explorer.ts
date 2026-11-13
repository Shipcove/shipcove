import { ChangeDetectionStrategy, Component, effect, inject, output, signal } from '@angular/core';
import type { FileEntryDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';

interface Node extends FileEntryDto {
  children?: Node[];
  open?: boolean;
  depth: number;
}

/** Explorateur arborescent (chargement paresseux) basé sur le dernier checkpoint. */
@Component({
  selector: 'cap-explorer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto py-1 text-sm" role="tree" aria-label="Fichiers du workspace">
      @for (n of flat(); track n.path) {
        <button class="flex w-full items-center gap-1 truncate py-0.5 pr-2 text-left hover:bg-stone-200/70 dark:hover:bg-stone-800" [style.padding-left.px]="8 + n.depth * 12"
          (click)="click(n)" role="treeitem" [attr.aria-expanded]="n.type === 'dir' ? !!n.open : null">
          @if (n.type === 'dir') { <cap-icon [name]="n.open ? 'chevronDown' : 'chevronRight'" [size]="12" class="text-stone-400" /><cap-icon name="folder" [size]="13" class="text-stone-500" /> }
          @else { <span class="w-3"></span><cap-icon name="file" [size]="13" class="text-stone-400" /> }
          <span class="truncate">{{ n.path.split('/').pop() }}</span>
        </button>
      } @empty {
        <p class="px-3 py-4 text-xs text-stone-500">Aucun fichier (workspace vierge ou pas encore initialisé).</p>
      }
    </div>
  `,
  host: { class: 'block h-full' },
})
export class Explorer {
  private readonly api = inject(Api);
  private readonly store = inject(WorkspaceStore);
  readonly openFile = output<string>();
  private readonly roots = signal<Node[]>([]);
  protected readonly flat = signal<Node[]>([]);

  constructor() {
    effect(() => {
      this.store.filesVersion();
      if (this.store.workspace()) void this.refresh();
    });
  }

  private async list(path: string, depth: number): Promise<Node[]> {
    const items = await this.api.get<FileEntryDto[]>(`/workspaces/${this.store.workspace()!.id}/files`, { path });
    return items.map((i) => ({ ...i, depth }));
  }

  private async refresh(): Promise<void> {
    // Conserve les dossiers ouverts lors d'un rafraîchissement.
    const openPaths = new Set<string>();
    const walk = (ns: Node[]) => ns.forEach((n) => (n.open && openPaths.add(n.path), n.children && walk(n.children)));
    walk(this.roots());
    const load = async (path: string, depth: number): Promise<Node[]> => {
      const nodes = await this.list(path, depth);
      for (const n of nodes) if (n.type === 'dir' && openPaths.has(n.path)) {
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
