import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ToolCallDto, ToolFileDto } from '@cap/contracts';
import { Icon } from '../../shared/icon';
import { BytesPipe } from '../../shared/pipes';
import { WorkspaceStore } from './workspace.store';
import { t } from '../../core/i18n';

/**
 * Fichiers proposés au téléchargement par Pi (outil `share_files`) : une carte par fichier, toujours
 * visible dans le fil, téléchargeable par quiconque lit la conversation.
 */
@Component({
  selector: 'cap-shared-files',
  imports: [Icon, BytesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (call().status === 'running') {
      <div class="flex items-center gap-2 text-sm text-stone-500">
        <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500" aria-hidden="true"></span> {{ t('Préparation des fichiers à télécharger…') }}
      </div>
    } @else {
      @if (files().length) {
        <div class="flex flex-wrap gap-2" role="list" [attr.aria-label]="t('Fichiers à télécharger')">
          @for (f of files(); track f.attachmentId) {
            <a
              role="listitem"
              class="flex max-w-72 min-w-0 items-center gap-2.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm shadow-sm transition hover:border-accent-400 hover:shadow focus-visible:outline-2 focus-visible:outline-accent-500 dark:border-stone-700 dark:bg-stone-900"
              [href]="url(f)"
              [download]="f.fileName"
              [title]="t('Télécharger {name}', { name: f.path })"
            >
              <cap-icon [name]="icon(f)" [size]="18" class="shrink-0 text-stone-500" />
              <span class="min-w-0">
                <span class="block truncate font-medium">{{ f.fileName }}</span>
                <span class="block text-xs text-stone-500">{{ type(f) }} · {{ f.size | bytes }}</span>
              </span>
              <cap-icon name="download" [size]="15" class="ml-1 shrink-0 text-stone-400" />
            </a>
          }
        </div>
      }
      @if (call().isError && call().output) {
        <p class="mt-1 text-xs whitespace-pre-line text-red-600">{{ call().output }}</p>
      }
    }
  `,
})
export class SharedFiles {
  protected readonly t = t;
  readonly call = input.required<ToolCallDto>();
  private readonly store = inject(WorkspaceStore);
  protected readonly files = computed(() => this.call().files ?? []);

  protected url(f: ToolFileDto): string {
    return `/api/v1/workspaces/${this.store.workspace()?.id}/agent-files/${f.attachmentId}`;
  }

  protected icon(f: ToolFileDto): string {
    return f.kind === 'image' ? 'image' : f.kind === 'archive' ? 'archive' : 'file';
  }

  /** Type lisible : extension du nom, sinon nature détectée. */
  protected type(f: ToolFileDto): string {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(f.fileName)?.[1];
    if (ext) return ext.toUpperCase();
    return { image: 'Image', text: 'Texte', archive: 'Archive', binary: 'Fichier' }[f.kind];
  }
}
