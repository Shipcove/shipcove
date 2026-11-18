import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChangeScope, ChangesResponse, FileChangeDto, FileDiffDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { DiffEditor } from '../../shared/monaco';
import { WorkspaceStore } from './workspace.store';

/**
 * Liste des modifications et diff (onglet Git : portée `git_head`, git diff par rapport à HEAD).
 * Panneau « Modifications » (exigence PO-1) : fichiers modifiés par l'IA, recherche,
 * diff de type git (unifié ou côte à côte) et bascule vers le fichier complet.
 */
@Component({
  selector: 'cap-changes-panel',
  imports: [FormsModule, Icon, DiffEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
        @if (!fixedScope()) {
          <select class="input !w-auto !py-1 text-xs" [ngModel]="scope()" (ngModelChange)="scope.set($event)" name="scope" aria-label="Portée des modifications">
            <option value="conversation">Toute la conversation</option>
            <option value="last_run">Dernier run</option>
            <option value="git_head">Git (vs HEAD)</option>
          </select>
        }
        <div class="relative flex-1">
          <cap-icon name="search" [size]="13" class="absolute top-1/2 left-2 -translate-y-1/2 text-stone-400" />
          <input class="input !py-1 !pl-7 text-xs" placeholder="Rechercher des fichiers…" [ngModel]="query()" (ngModelChange)="query.set($event)" name="q" aria-label="Rechercher" />
        </div>
        <button class="btn-ghost !p-1" (click)="reload()" aria-label="Actualiser"><cap-icon name="refresh" [size]="14" /></button>
      </div>
      @if (selected(); as file) {
        <div class="flex items-center gap-2 border-b border-stone-200 px-3 py-1.5 text-xs dark:border-stone-800">
          <button class="btn-ghost !p-1" (click)="selected.set(null)" aria-label="Retour à la liste"><cap-icon name="chevronRight" [size]="14" class="rotate-180" /></button>
          <span class="truncate font-mono">{{ file.path }}</span>
          @if (!file.statsSkipped) { <span class="text-emerald-600">+{{ file.additions }}</span><span class="text-red-600">−{{ file.deletions }}</span> }
          <span class="ml-auto flex gap-1">
            <button class="btn-ghost hidden !px-2 !py-0.5 text-xs whitespace-nowrap sm:inline-flex" [class.bg-stone-200]="!sideBySide()" (click)="sideBySide.set(false)">Unifié</button>
            <button class="btn-ghost hidden !px-2 !py-0.5 text-xs whitespace-nowrap sm:inline-flex" [class.bg-stone-200]="sideBySide()" (click)="sideBySide.set(true)">Côte à côte</button>
            @if (file.status !== 'deleted') { <button class="btn-ghost !px-2 !py-0.5 text-xs whitespace-nowrap" (click)="openFile.emit(file.path)">Voir le fichier</button> }
          </span>
        </div>
        <div class="min-h-0 flex-1">
          @if (diff(); as d) {
            @if (d.binary) {
              <p class="p-4 text-sm text-stone-500">Fichier binaire ou trop volumineux : diff non affiché.</p>
            } @else {
              <cap-diff-editor [original]="d.original" [modified]="d.modified" [path]="d.path" [sideBySide]="sideBySide()" />
            }
          } @else {
            <p class="p-4 text-sm text-stone-500">Chargement du diff…</p>
          }
        </div>
      } @else {
        <div class="flex items-center justify-between px-3 py-1.5 text-xs text-stone-500">
          <span>{{ data()?.baseLabel }}</span>
          <span>{{ filtered().length }} fichier(s) · <span class="text-emerald-600">+{{ totals().add }}</span> <span class="text-red-600">−{{ totals().del }}</span></span>
        </div>
        <ul class="min-h-0 flex-1 overflow-y-auto pb-2" role="list">
          @for (f of filtered(); track f.path) {
            <li>
              <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" (click)="select(f)">
                <span class="w-4 shrink-0 text-center font-mono text-xs font-bold" [class]="statusClass(f.status)">{{ statusLetter(f.status) }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs" [title]="f.path">
                  <span class="text-stone-800 dark:text-stone-200">{{ base(f.path) }}</span>
                  <span class="ml-1 text-stone-400">{{ dir(f.path) }}</span>
                </span>
                @if (f.binary) { <span class="text-xs text-stone-400">bin</span> }
                @else if (f.statsSkipped) { <span class="text-xs text-stone-400" title="Lignes non comptées (trop de fichiers modifiés)">—</span> }
                @else { <span class="shrink-0 text-xs"><span class="text-emerald-600">+{{ f.additions }}</span> <span class="text-red-600">−{{ f.deletions }}</span></span> }
              </button>
            </li>
          } @empty {
            <li class="px-3 py-6 text-center text-sm text-stone-500">{{ loading() ? 'Chargement…' : 'Aucune modification' }}</li>
          }
        </ul>
      }
    </div>
  `,
  host: { class: 'block h-full' },
})
export class ChangesPanel {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly store = inject(WorkspaceStore);
  readonly openFile = output<string>();
  /** Portée imposée (onglet Git : `git_head`), sans sélecteur. */
  readonly fixedScope = input<ChangeScope | null>(null);
  /** Rechargement demandé par le parent (changement de branche…). */
  readonly refresh = input(0);
  protected readonly scope = signal<ChangeScope>('conversation');
  protected readonly query = signal('');
  protected readonly data = signal<ChangesResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly selected = signal<FileChangeDto | null>(null);
  protected readonly diff = signal<FileDiffDto | null>(null);
  protected readonly sideBySide = signal(false);

  protected readonly filtered = computed(() => {
    const q = this.query().toLowerCase();
    return (this.data()?.files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
  });
  protected readonly totals = computed(() => this.filtered().reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }));

  /** Identifiant seul : l'objet workspace change à chaque sauvegarde. */
  private readonly workspaceId = computed(() => this.store.workspace()?.id ?? null);

  constructor() {
    effect(() => {
      const fixed = this.fixedScope();
      if (fixed) untracked(() => this.scope.set(fixed));
    });
    effect(() => {
      this.scope();
      this.refresh();
      this.store.filesVersion();
      if (this.workspaceId()) untracked(() => void this.reload());
    });
  }

  /** Un seul chargement à la fois ; les demandes reçues pendant ce temps en déclenchent un seul de plus. */
  private inflight: Promise<void> | null = null;
  private rerun = false;

  async reload(): Promise<void> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.rerun = false;
          await this.load();
        } while (this.rerun);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async load(): Promise<void> {
    const ws = this.store.workspace();
    if (!ws) return;
    this.loading.set(true);
    try {
      this.data.set(await this.api.get<ChangesResponse>(`/workspaces/${ws.id}/changes`, { scope: this.scope() }));
      const sel = this.selected();
      if (sel) {
        const still = this.data()!.files.find((f) => f.path === sel.path);
        if (still) await this.select(still, true);
        else this.selected.set(null);
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Ouvre le diff d'un fichier. Rafraîchissement du fichier déjà ouvert (Pi l'écrit) : le diff
   * affiché reste en place jusqu'à l'arrivée du nouveau, et n'est remplacé que s'il a changé.
   */
  protected async select(f: FileChangeDto, refresh = false): Promise<void> {
    this.selected.set(f);
    if (!refresh) this.diff.set(null);
    try {
      const next = await this.api.get<FileDiffDto>(`/workspaces/${this.store.workspace()!.id}/changes/diff`, { path: f.path, scope: this.scope() });
      // Autre fichier ouvert entre-temps : réponse ignorée.
      if (this.selected()?.path !== f.path) return;
      const cur = this.diff();
      if (cur && cur.path === next.path && cur.binary === next.binary && cur.original === next.original && cur.modified === next.modified) return;
      this.diff.set(next);
    } catch (err) {
      if (!refresh) this.toast.error(err);
    }
  }

  protected statusLetter(s: FileChangeDto['status']) {
    return { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[s];
  }
  protected statusClass(s: FileChangeDto['status']) {
    return { added: 'text-emerald-600', modified: 'text-amber-600', deleted: 'text-red-600', renamed: 'text-sky-600' }[s];
  }
  protected base(p: string) {
    return p.split('/').pop();
  }
  protected dir(p: string) {
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  }
}
