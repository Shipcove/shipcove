import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { FileContentDto } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { BytesPipe } from '../../shared/pipes';
import { CodeEditor } from '../../shared/monaco';
import { WorkspaceStore } from './workspace.store';

/** Visualisation (lecture seule par défaut) et édition contrôlée d'un fichier. */
@Component({
  selector: 'cap-file-panel',
  imports: [Icon, BytesPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col">
      @if (path()) {
        <div class="flex items-center gap-2 border-b border-stone-200 px-3 py-1.5 text-xs dark:border-stone-800">
          <cap-icon name="file" [size]="13" />
          <span class="truncate font-mono">{{ path() }}</span>
          @if (file(); as f) { <span class="text-stone-400">{{ f.size | bytes }}</span> }
          <span class="ml-auto flex items-center gap-1">
            @if (canEdit()) {
              @if (!editing()) {
                <button class="btn-ghost !px-2 !py-0.5 text-xs" (click)="editing.set(true)"><cap-icon name="edit" [size]="12" /> Modifier</button>
              } @else {
                <button class="btn-ghost !px-2 !py-0.5 text-xs" (click)="cancel()">Annuler</button>
                <button class="btn-accent !px-2 !py-0.5 text-xs" (click)="save()" [disabled]="saving() || draft() === file()?.content">Enregistrer</button>
              }
            } @else {
              <span class="badge bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400"><cap-icon name="lock" [size]="11" /> Lecture seule</span>
            }
          </span>
        </div>
        <div class="min-h-0 flex-1">
          @if (file(); as f) {
            @if (f.content === null) {
              <p class="p-4 text-sm text-stone-500">{{ f.binary ? 'Fichier binaire : aperçu indisponible.' : 'Fichier trop volumineux pour l’affichage.' }}</p>
            } @else {
              <cap-code-editor [value]="f.content" [path]="f.path" [readOnly]="!editing()" (changed)="draft.set($event)" />
            }
          } @else if (error()) {
            <p class="p-4 text-sm text-red-600">{{ error() }}</p>
          } @else {
            <p class="p-4 text-sm text-stone-500">Chargement…</p>
          }
        </div>
      } @else {
        <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <cap-icon name="folder" [size]="22" class="text-stone-400" />
          <p class="text-sm font-medium text-stone-700 dark:text-stone-300">Les fichiers ouverts apparaissent ici</p>
          <p class="max-w-64 text-xs text-stone-500">Sélectionnez un fichier dans l’arborescence, ou cliquez sur un chemin de fichier dans la conversation.</p>
        </div>
      }
    </div>
  `,
  host: { class: 'block h-full' },
})
export class FilePanel {
  readonly path = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly store = inject(WorkspaceStore);
  protected readonly file = signal<FileContentDto | null>(null);
  protected readonly error = signal('');
  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  protected readonly draft = signal<string | null>(null);
  protected readonly canEdit = computed(() => this.store.isOwner() && !!this.store.config()?.editor.manualEditingEnabled && this.file()?.content !== null && !this.file()?.binary);

  /** Identifiant seul : l'objet workspace change à chaque sauvegarde. */
  private readonly workspaceId = computed(() => this.store.workspace()?.id ?? null);

  constructor() {
    effect(() => {
      const p = this.path();
      this.store.filesVersion();
      const id = this.workspaceId();
      if (p && id && !this.editing()) untracked(() => void this.load(p));
    });
  }

  private async load(path: string): Promise<void> {
    this.error.set('');
    try {
      const f = await this.api.get<FileContentDto>(`/workspaces/${this.store.workspace()!.id}/files/content`, { path });
      this.file.set(f);
      this.draft.set(f.content);
    } catch (err) {
      this.file.set(null);
      this.error.set(err instanceof ApiError ? err.message : 'Lecture impossible');
    }
  }

  protected cancel(): void {
    this.editing.set(false);
    this.draft.set(this.file()?.content ?? null);
    void this.load(this.path()!);
  }

  /** Enregistrement avec If-Match : un conflit avec Pi est détecté, jamais écrasé silencieusement. */
  protected async save(): Promise<void> {
    const f = this.file();
    if (!f || this.draft() === null) return;
    this.saving.set(true);
    try {
      await this.api.put(`/workspaces/${this.store.workspace()!.id}/files`, { path: f.path, content: this.draft() }, { 'If-Match': `"${f.etag}"` });
      this.toast.show('Fichier enregistré et sauvegardé (checkpoint)', 'success');
      this.editing.set(false);
      await this.load(f.path);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_conflict') this.toast.show('Conflit : le fichier a été modifié entre-temps. Rechargez pour voir la nouvelle version.', 'error', 10_000);
      else this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}
