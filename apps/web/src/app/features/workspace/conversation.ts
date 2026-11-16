import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, output, signal, viewChild } from '@angular/core';
import type { AttachmentDto, MessageDto } from '@cap/contracts';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { BytesPipe, CodeBlocksDirective, MarkdownPipe, linkify } from '../../shared/pipes';
import { ToolCard } from './tool-card';
import { WorkspaceStore } from './workspace.store';

@Component({
  selector: 'cap-conversation',
  imports: [ToolCard, MarkdownPipe, CodeBlocksDirective, BytesPipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #scroller class="h-full overflow-x-hidden overflow-y-auto" (scroll)="onScroll()">
      <div class="mx-auto max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
        @if (store.messages().length === 0) {
          <div class="mt-20 text-center text-stone-500">
            <div class="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent-100 font-mono text-xl font-bold text-accent-700 dark:bg-accent-700/20">π</div>
            <p class="font-medium text-stone-700 dark:text-stone-300">Que voulez-vous construire ?</p>
            <p class="mt-1 text-sm">Pi travaille dans une sandbox isolée : il lit, modifie et teste le code. Chaque modification est sauvegardée.</p>
          </div>
        }
        @for (m of store.messages(); track m.id) {
          @if (m.role === 'user') {
            <div class="group my-4 flex items-start justify-end gap-1">
              @if (canRewind(m)) {
                <button class="btn-ghost mt-1.5 !p-1 opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100 focus:opacity-100" (click)="rewind(m)" [disabled]="busy()" title="Revenir à l’état des fichiers d’avant ce message" aria-label="Revenir avant ce message"><cap-icon name="undo" [size]="14" /></button>
              }
              <div class="max-w-[85%] min-w-0 rounded-2xl bg-stone-200/80 px-4 py-2.5 text-[0.925rem] [overflow-wrap:anywhere] dark:bg-stone-800">@let parts = skillParts(m.text);
                @for (sk of parts.skills; track sk) { <span class="mr-1.5 font-medium text-sky-700 dark:text-sky-400" [title]="'/skill:' + sk"><span class="opacity-60">/</span>{{ sk }}</span> }
                <span class="whitespace-pre-wrap">@for (seg of linkify(parts.rest); track $index) {@if (seg.href) {<a class="external-link text-accent-700 underline dark:text-accent-500" [href]="seg.href" target="_blank" rel="noopener noreferrer">{{ seg.text }}</a>} @else {<span>{{ seg.text }}</span>}}</span>
                @if (m.attachments.length) {
                  <div class="mt-2 flex flex-wrap gap-1.5" role="list" aria-label="Fichiers joints">
                    @for (a of m.attachments; track a.id) {
                      @if (a.kind === 'image' && store.isOwner()) {
                        <button role="listitem" class="group relative overflow-hidden rounded-lg border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900"
                          (click)="viewing.set(a)" [attr.aria-label]="'Agrandir ' + a.fileName" [title]="a.fileName + ' · ' + (a.size | bytes)">
                          <img [src]="attachmentUrl(a)" [alt]="a.fileName" loading="lazy" class="h-24 w-auto max-w-48 object-cover" height="96" />
                          <span class="absolute right-1 bottom-1 rounded bg-black/55 p-0.5 text-white opacity-0 transition group-hover:opacity-100 touch:opacity-100"><cap-icon name="maximize" [size]="12" /></span>
                        </button>
                      } @else if (store.isOwner()) {
                        <a role="listitem" class="flex max-w-64 items-center gap-2 rounded-lg border border-stone-300 bg-white/70 px-2.5 py-1.5 text-xs hover:border-accent-400 dark:border-stone-700 dark:bg-stone-900"
                          [href]="attachmentUrl(a)" [download]="a.fileName" [title]="'Télécharger ' + a.fileName">
                          <cap-icon [name]="attachmentIcon(a)" [size]="16" class="shrink-0 text-stone-500" />
                          <span class="min-w-0"><span class="block truncate font-medium">{{ a.fileName }}</span><span class="block text-stone-500">{{ attachmentType(a) }} · {{ a.size | bytes }}</span></span>
                          <cap-icon name="download" [size]="13" class="shrink-0 text-stone-400" />
                        </a>
                      } @else {
                        <span role="listitem" class="flex max-w-64 items-center gap-2 rounded-lg border border-stone-300 bg-white/70 px-2.5 py-1.5 text-xs dark:border-stone-700 dark:bg-stone-900" title="Contenu accessible au propriétaire de la conversation uniquement">
                          <cap-icon [name]="attachmentIcon(a)" [size]="16" class="shrink-0 text-stone-500" />
                          <span class="min-w-0"><span class="block truncate font-medium">{{ a.fileName }}</span><span class="block text-stone-500">{{ attachmentType(a) }} · {{ a.size | bytes }}</span></span>
                        </span>
                      }
                    }
                  </div>
                }
              </div>
            </div>
          } @else if (m.role === 'system') {
            <div class="my-3 flex items-start gap-2 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm text-stone-600 [overflow-wrap:anywhere] dark:border-stone-700 dark:text-stone-400" [attr.aria-label]="m.meta?.['kind'] === 'rewind' ? 'Retour en arrière' : m.meta?.['kind'] === 'setup' ? 'Préparation de l’environnement' : null">
              @if (m.meta?.['kind'] === 'rewind') { <cap-icon name="undo" [size]="14" class="mt-0.5" /> }
              @if (m.meta?.['kind'] === 'setup') { <cap-icon [name]="m.meta?.['status'] === 'failed' ? 'alert' : 'terminal'" [size]="14" class="mt-0.5" [class.text-red-600]="m.meta?.['status'] === 'failed'" /> }
              <span class="min-w-0 flex-1">{{ m.text }}
                @if (m.meta?.['kind'] === 'setup' && m.meta?.['output']) {
                  <details class="mt-1" [open]="m.meta?.['status'] === 'failed'"><summary class="cursor-pointer text-xs select-none">Sortie du script de préparation</summary>
                    <pre class="mt-1 max-h-72 overflow-auto rounded bg-stone-100 p-2 text-xs whitespace-pre-wrap dark:bg-stone-900">{{ m.meta?.['output'] }}</pre></details>
                }
              </span>
              @if (m.meta?.['kind'] === 'rewind' && store.isOwner()) {
                <button class="btn-ghost shrink-0 !py-0.5 text-xs" (click)="undoRewind(m)" [disabled]="busy()">Annuler</button>
              }
            </div>
          } @else {
            <div class="my-4 min-w-0">
              @if (m.thinking) {
                <details class="mb-1 text-sm text-stone-500">
                  <summary class="cursor-pointer select-none">Raisonnement</summary>
                  <div class="mt-1 border-l-2 border-stone-200 pl-3 whitespace-pre-wrap [overflow-wrap:anywhere] dark:border-stone-700">{{ m.thinking }}</div>
                </details>
              }
              @if (m.text) { <div class="prose-chat" capCodeBlocks [innerHTML]="m.text | markdown"></div> }
              @for (t of m.toolCalls; track t.id) { <cap-tool-card [call]="t" (openFile)="openFile.emit($event)" /> }
              @if (m.stopReason === 'error') { <div class="mt-1 text-sm text-red-600">La réponse du modèle s’est terminée en erreur.</div> }
            </div>
          }
        }
        @if (store.activeRun()?.status === 'running' || store.activeRun()?.status === 'queued' || store.activeRun()?.status === 'interrupting') {
          <div class="my-3 flex items-center gap-2 text-sm text-stone-500">
            <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500"></span>
            {{ store.activeRun()?.status === 'queued' ? 'Démarrage de la sandbox et de Pi…' : store.activeRun()?.status === 'interrupting' ? 'Arrêt en cours…' : 'Pi travaille…' }}
          </div>
        }
      </div>
    </div>
    @if (viewing(); as a) {
      <div class="fixed inset-0 z-50 flex flex-col bg-black/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" [attr.aria-label]="a.fileName" tabindex="-1"
        (click)="viewing.set(null)" (keydown.escape)="viewing.set(null)" #viewer>
        <div class="mb-3 flex items-center gap-3 text-sm text-stone-200" (click)="$event.stopPropagation()">
          <span class="truncate font-mono">{{ a.fileName }}</span>
          <span class="text-stone-400">{{ a.size | bytes }}</span>
          <a class="ml-auto rounded px-2 py-1 hover:bg-white/10" [href]="attachmentUrl(a)" [download]="a.fileName">Télécharger</a>
          <button class="rounded p-1 hover:bg-white/10" (click)="viewing.set(null)" aria-label="Fermer"><cap-icon name="x" [size]="18" /></button>
        </div>
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <img [src]="attachmentUrl(a)" [alt]="a.fileName" class="max-h-full max-w-full rounded object-contain shadow-2xl" (click)="$event.stopPropagation()" />
        </div>
      </div>
    }
  `,
  host: { class: 'block h-full' },
})
export class Conversation {
  protected readonly linkify = linkify;

  /** Pièce jointe affichée en grand. */
  protected readonly viewing = signal<AttachmentDto | null>(null);
  private readonly viewerRef = viewChild<ElementRef<HTMLElement>>('viewer');

  protected attachmentUrl(a: AttachmentDto): string {
    return `/api/v1/workspaces/${this.store.workspace()!.id}/attachments/${a.id}`;
  }

  protected attachmentIcon(a: AttachmentDto): string {
    return a.kind === 'image' ? 'image' : a.kind === 'archive' ? 'archive' : 'file';
  }

  /** Type lisible : extension du nom, sinon nature détectée. */
  protected attachmentType(a: AttachmentDto): string {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(a.fileName)?.[1];
    if (ext) return ext.toUpperCase();
    return { image: 'Image', text: 'Texte', archive: 'Archive', binary: 'Fichier' }[a.kind];
  }

  /** Skills en tête d'un message (« /skill:a /skill:b texte ») affichés comme des blocs. */
  protected skillParts(text: string): { skills: string[]; rest: string } {
    const skills: string[] = [];
    let rest = text;
    for (let m = /^\s*\/skill:(\S+)/.exec(rest); m; m = /^\s*\/skill:(\S+)/.exec(rest)) {
      skills.push(m[1]);
      rest = rest.slice(m[0].length);
    }
    return { skills, rest: skills.length ? rest.trimStart() : text };
  }

  protected readonly store = inject(WorkspaceStore);
  readonly openFile = output<string>();
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly stick = signal(true);

  constructor() {
    effect(() => {
      // Focus sur la visionneuse à l'ouverture (Échap pour fermer).
      const el = this.viewerRef();
      if (el) queueMicrotask(() => el.nativeElement.focus());
    });
    effect(() => {
      // Défilement automatique tant que l'utilisateur est en bas de la conversation.
      this.store.messages();
      if (this.stick()) queueMicrotask(() => {
        const el = this.scroller().nativeElement;
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  protected readonly busy = signal(false);
  private readonly toast = inject(ToastService);

  /** Un message utilisateur dont le run a un point de restauration (et aucun run en cours). */
  protected canRewind(m: MessageDto): boolean {
    return this.store.isOwner() && !!m.runId && !this.store.activeRun() && this.store.runs().some((r) => r.id === m.runId && r.status !== 'queued');
  }

  protected async rewind(m: MessageDto): Promise<void> {
    const ok = confirm('Revenir à l’état des fichiers d’avant ce message ?\n\nLes modifications faites ensuite (par Pi ou manuellement) seront annulées. La conversation est conservée et vous pourrez annuler ce retour en arrière.');
    if (!ok) return;
    await this.run(() => this.store.rewind({ runId: m.runId! }), 'Fichiers restaurés');
  }

  protected async undoRewind(m: MessageDto): Promise<void> {
    const from = m.meta?.['fromGeneration'];
    if (typeof from !== 'number') return;
    await this.run(() => this.store.rewind({ generation: from }), 'Retour en arrière annulé');
  }

  private async run(fn: () => Promise<void>, ok: string): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
      this.toast.show(ok, 'success');
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected onScroll(): void {
    const el = this.scroller().nativeElement;
    this.stick.set(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

}
