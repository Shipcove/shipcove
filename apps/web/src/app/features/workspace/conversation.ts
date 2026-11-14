import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, output, signal, viewChild } from '@angular/core';
import { Icon } from '../../shared/icon';
import { MarkdownPipe, TokensPipe } from '../../shared/pipes';
import { ToolCard } from './tool-card';
import { WorkspaceStore } from './workspace.store';

@Component({
  selector: 'cap-conversation',
  imports: [ToolCard, MarkdownPipe, TokensPipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #scroller class="h-full overflow-x-hidden overflow-y-auto" (scroll)="onScroll()">
      <div class="mx-auto max-w-3xl px-6 py-6">
        @if (store.messages().length === 0) {
          <div class="mt-20 text-center text-stone-500">
            <div class="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent-100 font-mono text-xl font-bold text-accent-700 dark:bg-accent-700/20">π</div>
            <p class="font-medium text-stone-700 dark:text-stone-300">Que voulez-vous construire ?</p>
            <p class="mt-1 text-sm">Pi travaille dans une sandbox isolée : il lit, modifie et teste le code. Chaque modification est sauvegardée.</p>
          </div>
        }
        @for (m of store.messages(); track m.id) {
          @if (m.role === 'user') {
            <div class="my-4 flex justify-end">
              <div class="max-w-[85%] min-w-0 rounded-2xl bg-stone-200/80 px-4 py-2.5 text-[0.925rem] [overflow-wrap:anywhere] dark:bg-stone-800"><span class="whitespace-pre-wrap">{{ m.text }}</span>
                @if (m.attachments.length) {
                  <div class="mt-2 flex flex-wrap gap-1">
                    @for (a of m.attachments; track a.id) { <span class="badge bg-white/70 dark:bg-stone-700"><cap-icon name="paperclip" [size]="11" />{{ a.fileName }}</span> }
                  </div>
                }
              </div>
            </div>
          } @else if (m.role === 'system') {
            <div class="my-3 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm text-stone-600 [overflow-wrap:anywhere] dark:border-stone-700 dark:text-stone-400">{{ m.text }}</div>
          } @else {
            <div class="my-4 min-w-0">
              @if (m.thinking) {
                <details class="mb-1 text-sm text-stone-500">
                  <summary class="cursor-pointer select-none">Raisonnement</summary>
                  <div class="mt-1 border-l-2 border-stone-200 pl-3 whitespace-pre-wrap [overflow-wrap:anywhere] dark:border-stone-700">{{ m.thinking }}</div>
                </details>
              }
              @if (m.text) { <div class="prose-chat" [innerHTML]="m.text | markdown"></div> }
              @for (t of m.toolCalls; track t.id) { <cap-tool-card [call]="t" (openFile)="openFile.emit($event)" /> }
              @if (m.usage) {
                <div class="mt-1 text-[11px] text-stone-400">
                  entrée {{ m.usage.inputTokens | tokens }} · sortie {{ m.usage.outputTokens | tokens }}
                  @if (m.usage.cacheReadTokens) { · cache lu {{ m.usage.cacheReadTokens | tokens }} }
                  @if (m.usage.cacheWriteTokens) { · cache écrit {{ m.usage.cacheWriteTokens | tokens }} }
                </div>
              }
              @if (m.stopReason === 'error') { <div class="mt-1 text-sm text-red-600">La réponse du modèle s’est terminée en erreur.</div> }
            </div>
          }
        }
        @if (store.activeRun()?.status === 'running' || store.activeRun()?.status === 'queued') {
          <div class="my-3 flex items-center gap-2 text-sm text-stone-500">
            <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500"></span>
            {{ store.activeRun()?.status === 'queued' ? 'Démarrage de la sandbox et de Pi…' : 'Pi travaille…' }}
          </div>
        }
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class Conversation {
  protected readonly store = inject(WorkspaceStore);
  readonly openFile = output<string>();
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly stick = signal(true);

  constructor() {
    effect(() => {
      // Défilement automatique tant que l'utilisateur est en bas de la conversation.
      this.store.messages();
      if (this.stick()) queueMicrotask(() => {
        const el = this.scroller().nativeElement;
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  protected onScroll(): void {
    const el = this.scroller().nativeElement;
    this.stick.set(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

}
