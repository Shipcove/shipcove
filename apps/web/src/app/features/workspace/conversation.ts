import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, output, signal, viewChild } from '@angular/core';
import type { AttachmentDto, MessageDto } from '@cap/contracts';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { BytesPipe, CodeBlocksDirective, MarkdownPipe, TokensPipe, linkify } from '../../shared/pipes';
import { ToolCard, toolLabel, toolSummary } from './tool-card';
import { ScreenshotStrip } from './screenshot-strip';
import { buildTimeline, summarizeSteps } from './timeline';
import { WorkspaceStore } from './workspace.store';
import { t, tk } from '../../core/i18n';

@Component({
  selector: 'cap-conversation',
  imports: [NgTemplateOutlet, ToolCard, ScreenshotStrip, MarkdownPipe, CodeBlocksDirective, BytesPipe, TokensPipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #scroller class="h-full overflow-x-hidden overflow-y-auto" (scroll)="onScroll()" (wheel)="onWheel($event)">
      <div #content class="mx-auto max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
        @if (store.messages().length === 0) {
          <div class="mt-20 text-center text-stone-500">
            <div class="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent-100 font-mono text-xl font-bold text-accent-700 dark:bg-accent-700/20">π</div>
            <p class="font-medium text-stone-700 dark:text-stone-300">{{ t('Que voulez-vous construire ?') }}</p>
            <p class="mt-1 text-sm">{{ t('Pi travaille dans une sandbox isolée : il lit, modifie et teste le code. Chaque modification est sauvegardée.') }}</p>
          </div>
        }
        @for (row of timeline(); track row.key) {
          @if (row.kind === 'message' && row.m.role === 'user') { @let m = row.m;
            <div class="group my-4 flex items-start justify-end gap-1">
              @if (canRewind(m)) {
                <button class="btn-ghost mt-1.5 !p-1 opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100 focus:opacity-100" (click)="rewind(m)" [disabled]="busy()" [title]="t('Revenir à l’état des fichiers d’avant ce message')" [attr.aria-label]="t('Revenir avant ce message')"><cap-icon name="undo" [size]="14" /></button>
              }
              <div class="max-w-[85%] min-w-0 rounded-2xl bg-stone-200/80 px-4 py-2.5 text-[0.925rem] [overflow-wrap:anywhere] dark:bg-stone-800">@let parts = skillParts(m.text);
                @for (sk of parts.skills; track sk) { <span class="mr-1.5 font-medium text-sky-700 dark:text-sky-400" [title]="'/skill:' + sk"><span class="opacity-60">/</span>{{ sk }}</span> }
                <span class="whitespace-pre-wrap">@for (seg of linkify(parts.rest); track $index) {@if (seg.href) {<a class="external-link text-accent-700 underline dark:text-accent-500" [href]="seg.href" target="_blank" rel="noopener noreferrer">{{ seg.text }}</a>} @else {<span>{{ seg.text }}</span>}}</span>
                @if (m.attachments.length) {
                  <div class="mt-2 flex flex-wrap gap-1.5" role="list" [attr.aria-label]="t('Fichiers joints')">
                    @for (a of m.attachments; track a.id) {
                      @if (a.kind === 'image' && store.isOwner()) {
                        <button role="listitem" class="group relative overflow-hidden rounded-lg border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900"
                          (click)="viewing.set(a)" [attr.aria-label]="t('Agrandir {name}', { name: a.fileName })" [title]="a.fileName + ' · ' + (a.size | bytes)">
                          <img [src]="attachmentUrl(a)" [alt]="a.fileName" loading="lazy" class="h-24 w-auto max-w-48 object-cover" height="96" />
                          <span class="absolute right-1 bottom-1 rounded bg-black/55 p-0.5 text-white opacity-0 transition group-hover:opacity-100 touch:opacity-100"><cap-icon name="maximize" [size]="12" /></span>
                        </button>
                      } @else if (store.isOwner()) {
                        <a role="listitem" class="flex max-w-64 items-center gap-2 rounded-lg border border-stone-300 bg-white/70 px-2.5 py-1.5 text-xs hover:border-accent-400 dark:border-stone-700 dark:bg-stone-900"
                          [href]="attachmentUrl(a)" [download]="a.fileName" [title]="t('Télécharger {name}', { name: a.fileName })">
                          <cap-icon [name]="attachmentIcon(a)" [size]="16" class="shrink-0 text-stone-500" />
                          <span class="min-w-0"><span class="block truncate font-medium">{{ a.fileName }}</span><span class="block text-stone-500">{{ attachmentType(a) }} · {{ a.size | bytes }}</span></span>
                          <cap-icon name="download" [size]="13" class="shrink-0 text-stone-400" />
                        </a>
                      } @else {
                        <span role="listitem" class="flex max-w-64 items-center gap-2 rounded-lg border border-stone-300 bg-white/70 px-2.5 py-1.5 text-xs dark:border-stone-700 dark:bg-stone-900" [title]="t('Contenu accessible au propriétaire de la conversation uniquement')">
                          <cap-icon [name]="attachmentIcon(a)" [size]="16" class="shrink-0 text-stone-500" />
                          <span class="min-w-0"><span class="block truncate font-medium">{{ a.fileName }}</span><span class="block text-stone-500">{{ attachmentType(a) }} · {{ a.size | bytes }}</span></span>
                        </span>
                      }
                    }
                  </div>
                }
              </div>
            </div>
          } @else if (row.kind === 'message' && row.m.meta?.['kind'] === 'compaction') { @let m = row.m; @let failed = m.meta?.['status'] === 'failed';
            <div class="my-4" role="note" [attr.aria-label]="m.text">
              <div class="flex items-center gap-3 text-xs" [class]="failed ? 'text-red-600' : 'text-stone-500'">
                <span class="h-px flex-1" [class]="failed ? 'bg-red-200 dark:bg-red-900' : 'bg-stone-300 dark:bg-stone-700'"></span>
                <span class="flex items-center gap-1.5"><cap-icon [name]="failed ? 'alert' : 'minimize'" [size]="13" />{{ m.text }}
                  @if (!failed && m.meta?.['tokensBefore']) { <span class="text-stone-400">· {{ t('{tokens} tokens avant', { tokens: ($any(m.meta?.['tokensBefore']) | tokens) }) }}</span> }</span>
                <span class="h-px flex-1" [class]="failed ? 'bg-red-200 dark:bg-red-900' : 'bg-stone-300 dark:bg-stone-700'"></span>
              </div>
              @if (m.meta?.['summary']) {
                <details class="mx-auto mt-1 max-w-xl text-sm text-stone-600 dark:text-stone-400">
                  <summary class="cursor-pointer text-center text-xs select-none">{{ t('Voir le résumé') }}</summary>
                  <div class="prose-chat mt-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800" [innerHTML]="$any(m.meta?.['summary']) | markdown"></div>
                </details>
              }
            </div>
          } @else if (row.kind === 'message') { @let m = row.m;
            <div class="my-3 flex items-start gap-2 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm text-stone-600 [overflow-wrap:anywhere] dark:border-stone-700 dark:text-stone-400" [attr.aria-label]="m.meta?.['kind'] === 'rewind' ? t('Retour en arrière') : m.meta?.['kind'] === 'setup' ? t('Préparation de l’environnement') : null">
              @if (m.meta?.['kind'] === 'rewind') { <cap-icon name="undo" [size]="14" class="mt-0.5" /> }
              @if (m.meta?.['kind'] === 'branch_switched') { <cap-icon name="git" [size]="14" class="mt-0.5" /> }
              @if (m.meta?.['kind'] === 'setup') { <cap-icon [name]="m.meta?.['status'] === 'failed' ? 'alert' : 'terminal'" [size]="14" class="mt-0.5" [class.text-red-600]="m.meta?.['status'] === 'failed'" /> }
              <span class="min-w-0 flex-1">{{ m.text }}
                @if (m.meta?.['kind'] === 'setup' && m.meta?.['output']) {
                  <details class="mt-1" [open]="m.meta?.['status'] === 'failed'"><summary class="cursor-pointer text-xs select-none">{{ t('Sortie du script de préparation') }}</summary>
                    <pre class="mt-1 max-h-72 overflow-auto rounded bg-stone-100 p-2 text-xs whitespace-pre-wrap dark:bg-stone-900">{{ m.meta?.['output'] }}</pre></details>
                }
              </span>
              @if (m.meta?.['kind'] === 'rewind' && store.isOwner()) {
                <button class="btn-ghost shrink-0 !py-0.5 text-xs" (click)="undoRewind(m)" [disabled]="busy()">{{ t('Annuler') }}</button>
              }
            </div>
          } @else if (row.kind === 'text') {
            <div class="prose-chat my-3 min-w-0" capCodeBlocks [innerHTML]="row.m.text | markdown"></div>
          } @else if (row.kind === 'interactive') {
            <div class="my-2 min-w-0"><cap-tool-card [call]="row.call" (openFile)="openFile.emit($event)" /></div>
          } @else if (row.kind === 'images') {
            <div class="-mt-1 mb-2 min-w-0"><cap-screenshot-strip [images]="row.images" /></div>
          } @else if (row.kind === 'error') {
            <div class="my-2 text-sm text-red-600">{{ t('La réponse du modèle s’est terminée en erreur.') }}</div>
          } @else if (row.steps.length === 1) {
            <div class="my-2 min-w-0">
              <ng-container *ngTemplateOutlet="stepTpl; context: { $implicit: row.steps[0] }" />
            </div>
          } @else { @let s = summary(row.steps); @let open = openGroups().has(row.key);
            <!-- Une commande en échec n'est signalée que sur sa propre carte (croix), pas sur le groupe. -->
            <div class="my-2 min-w-0 rounded-lg border border-stone-200 dark:border-stone-800">
              <button class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800/70"
                (click)="toggleGroup(row.key)" [attr.aria-expanded]="open" [attr.aria-label]="(open ? t('Replier {steps}', { steps: stepsLabel(s) }) : t('Déplier {steps}', { steps: stepsLabel(s) }))">
                <cap-icon [name]="open ? 'chevronDown' : 'chevronRight'" [size]="14" class="shrink-0 text-stone-400" />
                <span class="shrink-0 font-medium">{{ stepsLabel(s) }}</span>
                @if (!open) {
                  <span class="min-w-0 truncate font-mono text-xs text-stone-500">
                    @if (s.last.kind === 'tool') { {{ toolLabel(s.last.call.toolName) }} · {{ toolSummary(s.last.call) }} } @else { {{ t('Raisonnement…') }} }
                  </span>
                }
                <span class="ml-auto flex shrink-0 items-center gap-2 text-xs">
                  @if (s.running) { <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500" [attr.aria-label]="t('En cours')"></span> }
                  @else if (s.last.kind === 'tool') {
                    @switch (s.last.call.status) {
                      @case ('failed') {}
                      @case ('blocked') { <cap-icon name="lock" [size]="14" class="text-amber-600" /> }
                      @default { <cap-icon name="check" [size]="14" class="text-emerald-600" /> }
                    }
                  }
                </span>
              </button>
              @if (open) {
                <div class="border-t border-stone-200 px-2 py-1 dark:border-stone-800">
                  @for (step of row.steps; track step.key) { <ng-container *ngTemplateOutlet="stepTpl; context: { $implicit: step }" /> }
                </div>
              }
            </div>
          }
        }
        <ng-template #stepTpl let-step>
          @if (step.kind === 'thinking') {
            <details class="my-1 text-sm text-stone-500">
              <summary class="cursor-pointer select-none">{{ t('Raisonnement') }}</summary>
              <div class="mt-1 border-l-2 border-stone-200 pl-3 whitespace-pre-wrap [overflow-wrap:anywhere] dark:border-stone-700">{{ step.text }}</div>
            </details>
          } @else {
            <cap-tool-card [call]="step.call" [showImages]="false" (openFile)="openFile.emit($event)" />
          }
        </ng-template>
        @if (store.compacting()) {
          <div class="my-3 flex items-center gap-2 text-sm text-stone-500" role="status">
            <span class="h-2 w-2 animate-pulse rounded-full bg-amber-500"></span> {{ t('Compaction du contexte en cours…') }}
          </div>
        } @else if (store.activeRun()?.status === 'running' || store.activeRun()?.status === 'queued' || store.activeRun()?.status === 'interrupting') {
          <div class="my-3 flex items-center gap-2 text-sm text-stone-500">
            <span class="h-2 w-2 animate-pulse rounded-full bg-accent-500"></span>
            {{ store.activeRun()?.status === 'queued' ? t('Démarrage de la sandbox et de Pi…') : store.activeRun()?.status === 'interrupting' ? t('Arrêt en cours…') : t('Pi travaille…') }}
            @if (runElapsed(); as d) { <span class="tabular-nums text-stone-400" [title]="t('Durée du run')">· {{ d }}</span> }
          </div>
        }
      </div>
    </div>
    @if (!atBottom()) {
      <!-- Retour en bas : visible seulement quand on a remonté. -->
      <button class="absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 shadow-md transition hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-white"
        (click)="scrollToBottom(true)" [attr.aria-label]="t('Revenir en bas de la conversation')" [title]="t('Revenir en bas')">
        <cap-icon name="chevronDown" [size]="16" />
      </button>
    }
    @if (viewing(); as a) {
      <div class="fixed inset-0 z-50 flex flex-col bg-black/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" [attr.aria-label]="a.fileName" tabindex="-1"
        (click)="viewing.set(null)" (keydown.escape)="viewing.set(null)" #viewer>
        <div class="mb-3 flex items-center gap-3 text-sm text-stone-200" (click)="$event.stopPropagation()">
          <span class="truncate font-mono">{{ a.fileName }}</span>
          <span class="text-stone-400">{{ a.size | bytes }}</span>
          <a class="ml-auto rounded px-2 py-1 hover:bg-white/10" [href]="attachmentUrl(a)" [download]="a.fileName">{{ t('Télécharger') }}</a>
          <button class="rounded p-1 hover:bg-white/10" (click)="viewing.set(null)" [attr.aria-label]="t('Fermer')"><cap-icon name="x" [size]="18" /></button>
        </div>
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <img [src]="attachmentUrl(a)" [alt]="a.fileName" class="max-h-full max-w-full rounded object-contain shadow-2xl" (click)="$event.stopPropagation()" />
        </div>
      </div>
    }
  `,
  host: { class: 'relative block h-full' },
})
export class Conversation {
  protected readonly t = t;
  protected readonly linkify = linkify;
  protected readonly toolLabel = toolLabel;
  protected readonly toolSummary = toolSummary;
  protected readonly summary = summarizeSteps;

  /** Fil affiché : raisonnements et commandes consécutifs regroupés. */
  protected readonly timeline = computed(() => buildTimeline(this.store.messages()));
  /** Groupes dépliés (repliés par défaut), par clé stable. */
  protected readonly openGroups = signal<ReadonlySet<string>>(new Set());

  protected toggleGroup(key: string): void {
    this.openGroups.update((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  protected stepsLabel(s: { thinking: number; tools: number }): string {
    const parts: string[] = [];
    if (s.tools) parts.push(s.tools > 1 ? t('{n} actions', { n: s.tools }) : t('{n} action', { n: s.tools }));
    if (s.thinking) parts.push(s.thinking > 1 ? t('{n} raisonnements', { n: s.thinking }) : t('{n} raisonnement', { n: s.thinking }));
    return parts.join(' · ');
  }

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
    return t({ image: tk('Image'), text: tk('Texte'), archive: tk('Archive'), binary: tk('Fichier') }[a.kind]);
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
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');
  /**
   * Suivi du bas (comme OpenHands) : coupé seulement quand l'utilisateur remonte, rétabli quand il
   * revient en bas. Un contenu qui grandit d'un coup (grosse sortie, capture) ne le coupe jamais.
   */
  private follow = true;
  /** En bas (à 20 px près) : sinon, bouton de retour en bas. */
  protected readonly atBottom = signal(true);
  private lastScrollTop = 0;
  private readonly runActive = computed(() => !!this.store.activeRun());
  /** Horloge du chronomètre du run, avancée chaque seconde tant qu'un run est actif. */
  private readonly now = signal(Date.now());
  /** Durée du run en cours depuis son démarrage (`null` sans heure de début). */
  protected readonly runElapsed = computed(() => {
    const started = this.store.activeRun()?.startedAt;
    if (!started) return null;
    return formatElapsed(Math.max(0, this.now() - Date.parse(started)));
  });

  constructor() {
    effect((onCleanup) => {
      // Chronomètre : une mise à jour par seconde, seulement pendant un run.
      if (!this.runActive()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => {
      // Focus sur la visionneuse à l'ouverture (Échap pour fermer).
      const el = this.viewerRef();
      if (el) queueMicrotask(() => el.nativeElement.focus());
    });
    effect(() => {
      // Nouveaux contenus : suivis tant que l'utilisateur n'a pas remonté.
      this.store.messages();
      if (this.follow) requestAnimationFrame(() => this.pinToBottom());
    });
    effect(() => {
      // Envoi d'un message : retour en bas et suivi rétabli.
      if (this.store.scrollToBottomRequests()) requestAnimationFrame(() => this.scrollToBottom(false));
    });
    // Hauteur qui change après coup (images, coloration du code, groupe déplié, flux de texte) :
    // le bas reste collé tant que le suivi est actif.
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => {
        if (this.follow) this.pinToBottom();
        else this.updateAtBottom();
      });
      ro.observe(this.content().nativeElement);
      ro.observe(this.scroller().nativeElement);
      destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  /** Bas atteint, à 20 px près. */
  private isAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 20;
  }

  private updateAtBottom(): void {
    this.atBottom.set(this.isAtBottom(this.scroller().nativeElement));
  }

  private pinToBottom(): void {
    const el = this.scroller().nativeElement;
    el.scrollTop = el.scrollHeight;
    this.lastScrollTop = el.scrollTop;
    this.atBottom.set(true);
  }

  /** Retour en bas (bouton, envoi d'un message) : le suivi reprend. */
  protected scrollToBottom(smooth: boolean): void {
    this.follow = true;
    const el = this.scroller().nativeElement;
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      this.atBottom.set(true);
    } else {
      this.pinToBottom();
    }
  }

  protected readonly busy = signal(false);
  private readonly toast = inject(ToastService);

  /** Un message utilisateur dont le run a un point de restauration (et aucun run en cours). */
  protected canRewind(m: MessageDto): boolean {
    return this.store.isOwner() && !!m.runId && !this.store.activeRun() && this.store.runs().some((r) => r.id === m.runId && r.status !== 'queued');
  }

  protected async rewind(m: MessageDto): Promise<void> {
    const ok = confirm(t('Revenir à l’état des fichiers d’avant ce message ?\n\nLes modifications faites ensuite (par Pi ou manuellement) seront annulées. La conversation est conservée et vous pourrez annuler ce retour en arrière.'));
    if (!ok) return;
    await this.run(() => this.store.rewind({ runId: m.runId! }), t('Fichiers restaurés'));
  }

  protected async undoRewind(m: MessageDto): Promise<void> {
    const from = m.meta?.['fromGeneration'];
    if (typeof from !== 'number') return;
    await this.run(() => this.store.rewind({ generation: from }), t('Retour en arrière annulé'));
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
    const bottom = this.isAtBottom(el);
    // Remontée par l'utilisateur (un contenu qui rétrécit laisse, lui, la vue en bas).
    if (el.scrollTop < this.lastScrollTop - 1 && !bottom) this.follow = false;
    if (bottom) this.follow = true;
    this.lastScrollTop = el.scrollTop;
    this.atBottom.set(bottom);
  }

  /** Molette vers le haut : suivi coupé tout de suite, avant même l'événement de défilement. */
  protected onWheel(e: WheelEvent): void {
    if (e.deltaY < 0) this.follow = false;
  }

}

/** Durée lisible : « 12 s », « 3 min 05 s », « 1 h 02 min ». */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}
