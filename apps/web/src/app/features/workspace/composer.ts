import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { AgentMode, AttachmentDto, ModelDto, SkillDto, ThinkingLevel, QuotaWindowDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { BytesPipe } from '../../shared/pipes';
import { QUOTA_DANGER, QUOTA_WARN, formatReset, quotaBarClass, quotaPct, quotaStroke, quotaTextClass, windowLabel } from '../../shared/quota';
import { WorkspaceStore } from './workspace.store';

type Menu = 'plus' | 'model' | 'effort' | 'more' | 'mode' | 'usage' | 'slash' | null;

const EFFORTS: Array<{ id: ThinkingLevel; label: string }> = [
  { id: 'off', label: 'Désactivé' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Faible' },
  { id: 'medium', label: 'Moyen' },
  { id: 'high', label: 'Élevé' },
  { id: 'xhigh', label: 'Maximal' },
];

const MODES: Array<{ id: AgentMode; label: string; description: string }> = [
  { id: 'autonomous', label: 'Autonome', description: 'Pi lit, modifie et exécute librement dans sa sandbox' },
  { id: 'plan', label: 'Plan', description: 'Lecture seule : Pi explore et propose un plan sans rien modifier' },
];

/** Commandes de la plateforme, proposées avant les skills. */
const BUILTIN_COMMANDS: Array<{ command: string; name: string; description: string }> = [
  { command: '/compact', name: 'compact', description: 'Compacter le contexte de la conversation (instructions facultatives à la suite)' },
];

/** Nombre de modèles affichés directement (les autres sont sous « Plus de modèles »). */
const TOP_MODELS = 4;

/**
 * Zone de saisie : pièces jointes (vignettes), menu « + » (fichiers, commandes slash, connecteurs),
 * envoi (mis en file d'attente pendant une génération) et interruption ;
 * barre d'état : modèle + effort, mode, consommation.
 */
@Component({
  selector: 'cap-composer',
  imports: [FormsModule, RouterLink, Icon, BytesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'onDocumentClick($event)', '(document:keydown)': 'onGlobalKey($event)' },
  template: `
    <div class="mx-auto max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      @if (store.quotaPaused(); as q) {
        <div class="mb-2 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" role="status">
          <cap-icon name="alert" /> {{ pausedLabel(q.window) }}. L’agent est suspendu.
          <button class="btn-secondary ml-auto !py-1" (click)="resume()">Reprendre</button>
        </div>
      }

      <div class="relative rounded-2xl border border-stone-200 bg-white shadow-sm transition-colors dark:border-stone-700 dark:bg-stone-900"
        [class.ring-2]="dragging()" [class.ring-accent-500]="dragging()"
        (dragover)="$event.preventDefault(); dragging.set(true)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)">

        @if (attachments().length) {
          <div class="flex flex-wrap gap-2 px-3 pt-3">
            @for (a of attachments(); track a.id) {
              <div class="group relative h-28 w-28 overflow-hidden rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-800"
                [class.!border-red-400]="a.status === 'rejected'" [title]="a.rejectionReason ?? a.fileName">
                @if (previews()[a.id]) {
                  <img [src]="previews()[a.id]" [alt]="a.fileName" class="h-full w-full object-cover" />
                } @else {
                  <div class="flex h-full flex-col justify-between p-2 text-xs">
                    <cap-icon name="file" [size]="18" class="text-stone-400" />
                    <div><div class="line-clamp-2 font-medium break-all">{{ a.fileName }}</div><div class="text-stone-400">{{ a.size | bytes }}</div></div>
                  </div>
                }
                <button class="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 group-hover:opacity-100 touch:opacity-100 focus:opacity-100" (click)="remove(a)" [attr.aria-label]="'Retirer ' + a.fileName"><cap-icon name="x" [size]="12" /></button>
              </div>
            }
          </div>
        }

        @if (menu() === 'slash') {
          <div id="slash-listbox" class="absolute bottom-full left-2 z-30 mb-2 max-h-72 w-96 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="listbox" aria-label="Commandes slash">
            @for (c of slashFiltered(); track c.command; let i = $index) {
              <button [id]="'slash-opt-' + i" tabindex="-1" class="flex w-full flex-col items-start rounded-lg px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800" [class.bg-stone-100]="i === slashActive()" [class.dark:bg-stone-800]="i === slashActive()"
                (click)="useSlash(c.command)" (mousemove)="slashActive.set(i)" (mousedown)="$event.preventDefault()" role="option" [attr.aria-selected]="i === slashActive()">
                <span class="font-mono text-sm">{{ c.command }}</span><span class="line-clamp-1 text-xs text-stone-500">{{ c.description }}</span>
              </button>
            } @empty {
              <p class="px-3 py-2 text-sm text-stone-500">Aucune commande. Activez des skills dans « Skills & MCP ».</p>
            }
          </div>
        }

        @if (store.queued().length) {
          <div class="space-y-1 px-3 pt-3" aria-label="Messages en file d'attente">
            @for (q of store.queued(); track q.messageId) {
              <div class="flex items-center gap-2 rounded-lg bg-stone-100 px-3 py-1.5 text-sm dark:bg-stone-800">
                <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-500"></span>
                @if (editingQueued() === q.messageId) {
                  <textarea class="input min-w-0 flex-1 resize-y !py-1 text-sm" rows="2" [(ngModel)]="queuedDraft" name="queuedDraft" aria-label="Modifier le message en attente"
                    (keydown)="onQueuedKey($event, q.messageId)"></textarea>
                  <button class="btn-ghost shrink-0 !px-2 !py-0.5 text-xs" (click)="saveQueued(q.messageId)" [disabled]="!queuedDraft.trim()">Enregistrer</button>
                  <button class="btn-ghost shrink-0 !px-2 !py-0.5 text-xs" (click)="editingQueued.set(null)">Annuler</button>
                } @else {
                  <span class="min-w-0 flex-1 truncate" [title]="q.text">{{ q.text }}</span>
                  <span class="shrink-0 text-xs text-stone-500">En file d’attente</span>
                  @if (store.isOwner()) {
                    <button class="btn-ghost shrink-0 !p-1" (click)="editQueued(q)" title="Modifier" [attr.aria-label]="'Modifier le message en attente : ' + q.text"><cap-icon name="edit" [size]="13" /></button>
                    <button class="btn-ghost shrink-0 !p-1 hover:text-red-600" (click)="removeQueued(q.messageId)" title="Supprimer" [attr.aria-label]="'Supprimer le message en attente : ' + q.text"><cap-icon name="trash" [size]="13" /></button>
                  }
                }
              </div>
            }
          </div>
        }

        <div class="flex items-center gap-1 px-2 py-2">
          <div class="relative">
            <button class="btn-ghost !rounded-lg !p-1.5" [class.bg-stone-200]="menu() === 'plus'" [class.dark:bg-stone-700]="menu() === 'plus'" (click)="toggle('plus', $event)" aria-label="Ajouter" [disabled]="!store.isOwner()"><cap-icon name="plus" [size]="18" /></button>
            @if (menu() === 'plus') {
              <div class="absolute bottom-full left-0 z-30 mb-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
                <button class="menu-item" role="menuitem" (click)="pickFiles()"><cap-icon name="paperclip" /> <span class="flex-1 truncate">Ajouter des fichiers ou des photos</span><kbd class="text-xs text-stone-400">Ctrl+U</kbd></button>
                <button class="menu-item" role="menuitem" (click)="openSlash()"><span class="flex h-4 w-4 items-center justify-center rounded border border-current text-[10px] font-bold">/</span> <span class="flex-1">Commandes slash</span></button>
                <button class="menu-item" role="menuitem" (click)="connectors()"><cap-icon name="puzzle" /> <span class="flex-1">Ajouter des connecteurs</span></button>
              </div>
            }
          </div>
          <input #fileInput type="file" multiple class="hidden" (change)="onFiles($event)" />
          <div class="flex min-w-0 flex-1 flex-wrap items-center">
            @for (s of selectedSkills(); track s.command) {
              <span class="group/skill relative ml-2 inline-block shrink-0 cursor-default py-1.5 text-[0.95rem] leading-6 font-medium text-sky-600 dark:text-sky-400"
                tabindex="0" [attr.aria-label]="'Skill ' + s.name + (s.description ? ' : ' + s.description : '')" data-skill-chip>
                <span class="opacity-60">/</span>{{ s.name }}
                <span role="tooltip" class="pointer-events-auto invisible absolute bottom-full left-0 z-40 mb-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-stone-200 bg-white p-4 font-normal opacity-0 shadow-[0_8px_30px_rgb(0_0_0/0.12)] transition-opacity delay-150 group-hover/skill:visible group-hover/skill:opacity-100 group-focus-visible/skill:visible group-focus-visible/skill:opacity-100 dark:border-stone-700 dark:bg-stone-900">
                  <span class="block font-mono text-sm text-stone-500">{{ s.command }}</span>
                  <span class="mt-1.5 block max-h-60 overflow-y-auto text-sm leading-relaxed whitespace-pre-line text-stone-800 dark:text-stone-200">{{ s.description || 'Aucune description.' }}</span>
                </span>
              </span>
            }
            <textarea #textarea class="block h-9 max-h-60 min-w-40 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-[0.95rem] leading-6 placeholder:text-stone-400 focus:outline-none" rows="1"
              [placeholder]="selectedSkills().length ? 'Ajoutez vos instructions (facultatif)' : store.draft ? 'Décrivez ce que Pi doit faire…' : running() ? 'Message mis en file d’attente jusqu’à la fin de la tâche en cours…' : 'Tapez / pour les commandes.'" [(ngModel)]="text" name="text"
              (ngModelChange)="onTextChange()" (keydown)="onKey($event)" (paste)="onPaste($event)" [disabled]="!store.isOwner()" aria-label="Message"
              role="combobox" aria-autocomplete="list" aria-controls="slash-listbox" [attr.aria-expanded]="menu() === 'slash'"
              [attr.aria-activedescendant]="menu() === 'slash' && slashFiltered().length ? 'slash-opt-' + slashActive() : null"></textarea>
          </div>
          @if (running()) {
            @if (store.activeRun()?.status === 'interrupting') {
              <button class="btn-ghost !rounded-lg !p-1.5" disabled aria-label="Arrêt en cours" title="Arrêt en cours…"><span class="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"></span></button>
            } @else {
              <button class="btn-ghost !rounded-lg !p-1.5" (click)="interrupt()" aria-label="Interrompre" title="Interrompre"><span class="block h-3.5 w-3.5 rounded-sm bg-current"></span></button>
            }
          }
          <button class="btn-ghost !rounded-lg !p-1.5" (click)="submit()" [disabled]="!canSend() || (!text.trim() && !selectedSkills().length)"
            [attr.aria-label]="running() ? 'Mettre en file d’attente' : 'Envoyer'" [title]="running() ? 'Mettre en file d’attente (Entrée)' : 'Envoyer (Entrée)'"><cap-icon name="enter" [size]="18" /></button>
        </div>
      </div>

      <div class="mt-1.5 flex items-center justify-end gap-1 text-[13px]">
        <div class="mr-auto min-w-0 shrink"><ng-content select="[composerStart]" /></div>
        <div class="relative">
          <button class="flex min-w-0 items-center rounded-md px-2 py-1 hover:bg-stone-200/70 dark:hover:bg-stone-800" [class.bg-stone-200]="isModelMenu()" [class.dark:bg-stone-800]="isModelMenu()" (click)="toggle('model', $event)" [disabled]="!store.isOwner()" aria-haspopup="menu">
            <span class="max-w-[9rem] truncate text-stone-800 sm:max-w-none dark:text-stone-200">{{ store.currentModel()?.displayName ?? 'Modèle' }}</span>
            @if (store.currentModel()?.supportsReasoning) { <span class="ml-1 text-stone-500">{{ effortLabel() }}</span> }
          </button>
          @if (isModelMenu()) {
            <div class="absolute right-0 bottom-full z-30 mb-2 max-sm:fixed max-sm:inset-x-3 max-sm:right-3 max-sm:bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] max-sm:w-auto max-sm:max-w-none w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
              @for (m of topModels(); track m.id; let i = $index) {
                <button class="menu-item" role="menuitemradio" [attr.aria-checked]="m.id === store.currentModel()?.id" (click)="setModel(m)">
                  <span class="flex-1">{{ m.displayName }}</span>
                  @if (m.id === store.currentModel()?.id) { <cap-icon name="check" class="text-sky-600" /> } @else { <span class="text-xs text-stone-400">{{ i + 1 }}</span> }
                </button>
              }
              <div class="my-1 h-px bg-stone-200 dark:bg-stone-800"></div>
              <div class="relative">
                <button class="menu-item" [class.bg-stone-100]="menu() === 'effort'" [class.dark:bg-stone-800]="menu() === 'effort'" (click)="toggle('effort', $event)" [disabled]="!store.currentModel()?.supportsReasoning" role="menuitem" aria-haspopup="menu">
                  <span class="flex-1">Effort</span><span class="text-stone-500">{{ effortLabel() }}</span><cap-icon name="chevronRight" [size]="14" />
                </button>
                @if (menu() === 'effort') {
                  <div class="absolute bottom-0 left-full z-40 ml-2 max-sm:bottom-full max-sm:left-auto max-sm:right-0 max-sm:mb-1 max-sm:ml-0 w-48 max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
                    @for (e of efforts; track e.id) {
                      <button class="menu-item" role="menuitemradio" [attr.aria-checked]="e.id === store.workspace()?.thinkingLevel" (click)="setEffort(e.id)">
                        <span class="flex-1">{{ e.label }}</span>@if (e.id === store.workspace()?.thinkingLevel) { <cap-icon name="check" class="text-sky-600" /> }
                      </button>
                    }
                  </div>
                }
              </div>
              @if (moreModels().length) {
                <div class="relative">
                  <button class="menu-item" [class.bg-stone-100]="menu() === 'more'" [class.dark:bg-stone-800]="menu() === 'more'" (click)="toggle('more', $event)" role="menuitem" aria-haspopup="menu">
                    <span class="flex-1">Plus de modèles</span><cap-icon name="chevronRight" [size]="14" />
                  </button>
                  @if (menu() === 'more') {
                    <div class="absolute bottom-0 left-full z-40 ml-2 max-sm:bottom-full max-sm:left-auto max-sm:right-0 max-sm:mb-1 max-sm:ml-0 max-h-80 w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
                      @for (m of moreModels(); track m.id) {
                        <button class="menu-item" role="menuitemradio" [attr.aria-checked]="m.id === store.currentModel()?.id" (click)="setModel(m)">
                          <span class="flex-1">{{ m.displayName }}</span>@if (m.id === store.currentModel()?.id) { <cap-icon name="check" class="text-sky-600" /> }
                        </button>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>

        <div class="relative">
          <button class="rounded-md px-2 py-1 text-stone-800 hover:bg-stone-200/70 dark:text-stone-200 dark:hover:bg-stone-800" [class.bg-stone-200]="menu() === 'mode'" [class.dark:bg-stone-800]="menu() === 'mode'" (click)="toggle('mode', $event)" [disabled]="!store.isOwner()" aria-haspopup="menu">{{ modeLabel() }}</button>
          @if (menu() === 'mode') {
            <div class="absolute right-0 bottom-full z-30 mb-2 max-sm:fixed max-sm:inset-x-3 max-sm:right-3 max-sm:bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] max-sm:w-auto max-sm:max-w-none w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
              @for (m of modes; track m.id; let i = $index) {
                <button class="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-stone-100 dark:hover:bg-stone-800" role="menuitemradio" [attr.aria-checked]="m.id === store.workspace()?.agentMode" (click)="setMode(m.id)">
                  <span class="flex-1"><span class="block text-sm">{{ m.label }}</span><span class="block text-xs text-stone-500">{{ m.description }}</span></span>
                  @if (m.id === store.workspace()?.agentMode) { <cap-icon name="check" class="mt-0.5 text-sky-600" /> } @else { <span class="text-xs text-stone-400">{{ i + 1 }}</span> }
                </button>
              }
              <p class="px-3 pt-1 pb-2 text-[11px] text-stone-400">Les publications Git exigent toujours votre approbation.</p>
            </div>
          }
        </div>

        <div class="relative">
          <button class="rounded-md p-1 hover:bg-stone-200/70 dark:hover:bg-stone-800" [class.bg-stone-200]="menu() === 'usage'" [class.dark:bg-stone-800]="menu() === 'usage'" (click)="toggle('usage', $event)" aria-label="Utilisation des quotas" [title]="usageTitle()">
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2.5" class="text-stone-200 dark:text-stone-700" />
              <circle cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5" stroke-linecap="round" transform="rotate(-90 10 10)"
                [attr.stroke]="stroke(usagePct())" [attr.stroke-dasharray]="ringDash()" />
            </svg>
          </button>
          @if (menu() === 'usage') {
            <div class="absolute right-0 bottom-full z-30 mb-2 max-sm:fixed max-sm:inset-x-3 max-sm:right-3 max-sm:bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] max-sm:w-auto max-sm:max-w-none w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white p-4 shadow-lg dark:border-stone-700 dark:bg-stone-900">
              <div class="mb-3 flex items-center text-sm"><span class="text-stone-500">Utilisation des quotas</span><a routerLink="/usage" class="ml-auto font-medium hover:underline" (click)="menu.set(null)">Tout voir →</a></div>
              @if (!store.usage()?.quotasEnabled) { <p class="mb-2 text-xs text-stone-500">Les quotas sont désactivés.</p> }
              @for (w of usageRows(); track w.label) {
                <div class="mb-3">
                  <div class="flex items-baseline gap-2 text-sm"><span class="shrink-0 font-medium whitespace-nowrap">{{ w.label }}</span><span class="ml-auto min-w-0 truncate text-xs whitespace-nowrap text-stone-500">{{ w.reset }}</span>
                    <span class="w-12 shrink-0 text-right whitespace-nowrap text-xs tabular-nums" [class]="textClass(w.pct)">{{ w.pct === null ? 'Illimité' : w.pct + '\u00a0%' }}</span></div>
                  @if (w.pct !== null) {
                    <div class="mt-1.5 h-1.5 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1.5 rounded transition-all" [class]="barClass(w.pct)" [style.width.%]="w.pct"></div></div>
                  }
                </div>
              }
              @if (usagePct() >= warnAt) {
                <p class="text-xs" [class]="textClass(usagePct())">{{ usagePct() >= dangerAt ? 'Quota presque épuisé : l’agent sera suspendu à 100\u00a0%.' : 'Vous approchez de votre limite.' }}</p>
              }
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class Composer {
  protected readonly store = inject(WorkspaceStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  private readonly textareaRef = viewChild.required<ElementRef<HTMLTextAreaElement>>('textarea');

  protected text = '';
  /** Miroir réactif du texte saisi (filtre des commandes slash). */
  private readonly textSig = signal('');
  protected readonly menu = signal<Menu>(null);
  protected readonly attachments = signal<AttachmentDto[]>([]);
  protected readonly previews = signal<Record<string, string>>({});
  protected readonly dragging = signal(false);
  protected readonly sending = signal(false);
  private readonly skills = signal<SkillDto[]>([]);
  protected readonly efforts = EFFORTS;
  protected readonly modes = MODES;

  /** Run actif (démarrage, génération, pause quota) : les nouveaux messages vont en file d'attente. */
  protected readonly running = computed(() => this.store.activeRun() !== null);
  protected readonly canSend = computed(() => this.store.isOwner() && !this.sending());
  protected readonly isModelMenu = computed(() => ['model', 'effort', 'more'].includes(this.menu() ?? ''));
  protected readonly topModels = computed(() => this.orderedModels().slice(0, TOP_MODELS));
  protected readonly moreModels = computed(() => this.orderedModels().slice(TOP_MODELS));
  protected readonly effortLabel = computed(() => EFFORTS.find((e) => e.id === this.store.workspace()?.thinkingLevel)?.label ?? 'Moyen');
  protected readonly modeLabel = computed(() => MODES.find((m) => m.id === this.store.workspace()?.agentMode)?.label ?? 'Autonome');

  protected readonly slashCommands = computed(() => [
    ...BUILTIN_COMMANDS,
    ...this.skills()
      .filter((s) => s.enabledForMe)
      .map((s) => ({ command: `/skill:${s.name}`, name: s.name, description: s.description })),
  ]);
  /** Skills choisis : blocs dans la zone de saisie, envoyés en tête du message. */
  protected readonly selectedSkills = signal<Array<{ command: string; name: string; description: string }>>([]);
  protected readonly slashFiltered = computed(() => {
    const t = this.textSig();
    const q = t.startsWith('/') ? t.slice(1).split(/\s/)[0].toLowerCase() : '';
    return this.slashCommands().filter((c) => c.command.slice(1).toLowerCase().includes(q));
  });
  /** Message en attente en cours de modification. */
  protected readonly editingQueued = signal<string | null>(null);
  protected queuedDraft = '';

  protected editQueued(q: { messageId: string; text: string }): void {
    this.queuedDraft = q.text;
    this.editingQueued.set(q.messageId);
  }

  protected async saveQueued(messageId: string): Promise<void> {
    const text = this.queuedDraft.trim();
    if (!text) return;
    try {
      await this.store.editQueued(messageId, text);
      this.editingQueued.set(null);
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected onQueuedKey(e: KeyboardEvent, messageId: string): void {
    e.stopPropagation();
    if (e.key === 'Escape') this.editingQueued.set(null);
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.saveQueued(messageId);
    }
  }

  protected async removeQueued(messageId: string): Promise<void> {
    try {
      await this.store.removeQueued(messageId);
      if (this.editingQueued() === messageId) this.editingQueued.set(null);
    } catch (err) {
      this.toast.error(err);
    }
  }

  /** Commande sélectionnée au clavier dans le menu slash (index dans la liste filtrée). */
  protected readonly slashActive = signal(0);

  private moveSlash(delta: number): void {
    const n = this.slashFiltered().length;
    if (!n) return;
    this.slashActive.update((i) => (Math.min(i, n - 1) + delta + n) % n);
    queueMicrotask(() => document.getElementById(`slash-opt-${this.slashActive()}`)?.scrollIntoView({ block: 'nearest' }));
  }

  /** Fenêtres du quota personnel en pourcentage ; jamais de crédits. */
  protected readonly warnAt = QUOTA_WARN;
  protected readonly dangerAt = QUOTA_DANGER;
  protected readonly barClass = quotaBarClass;
  protected readonly textClass = quotaTextClass;
  protected readonly stroke = quotaStroke;
  protected readonly usageRows = computed(() => {
    const u = this.store.usage();
    if (!u) return [];
    const rows = u.user.windows.map((w) => this.row(w, windowLabel(w.window)));
    return rows;
  });
  protected readonly usagePct = computed(() => Math.max(0, ...this.usageRows().map((r) => r.pct ?? 0)));
  protected readonly ringDash = computed(() => {
    const c = 2 * Math.PI * 7.5;
    return `${(c * this.usagePct()) / 100} ${c}`;
  });
  protected readonly usageTitle = computed(() => (this.usageRows().length ? this.usageRows().map((r) => `${r.label} : ${r.pct ?? '—'} %`).join(' · ') : 'Consommation'));

  private orderedModels(): ModelDto[] {
    const list = [...this.store.models()];
    return list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
  }

  protected pausedLabel(window: string): string {
    const labels: Record<string, string> = {
      '5h': 'Quota atteint (limite de 5 heures)',
      '7d': 'Quota atteint (7 jours glissants)',
    };
    return labels[window] ?? 'Quota atteint';
  }

  private row(w: QuotaWindowDto, label: string) {
    const pct = quotaPct(w);
    const reset = pct !== null && w.resetsAt ? `Réinitialisation ${formatReset(w.resetsAt)}` : '';
    return { label, pct, reset };
  }

  /* ------------------------------- Menus ------------------------------- */

  protected toggle(m: Exclude<Menu, null>, e: Event): void {
    e.stopPropagation();
    if (m === 'effort' || m === 'more') {
      this.menu.set(this.menu() === m ? 'model' : m);
      return;
    }
    this.menu.set(this.isOpen(m) ? null : m);
    if (m === 'model' || m === 'usage') void this.store.refreshUsage();
  }

  private isOpen(m: Menu): boolean {
    return m === 'model' ? this.isModelMenu() : this.menu() === m;
  }

  protected onDocumentClick(e: MouseEvent): void {
    if (this.menu() && !this.host.nativeElement.contains(e.target as Node)) this.menu.set(null);
  }

  protected onGlobalKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u' && this.store.isOwner()) {
      e.preventDefault();
      this.pickFiles();
      return;
    }
    if (e.key === 'Escape') this.menu.set(null);
    // Raccourcis numériques dans les menus ouverts (comme dans Claude Code).
    if (/^[1-9]$/.test(e.key) && (this.menu() === 'model' || this.menu() === 'mode')) {
      const i = Number(e.key) - 1;
      if (this.menu() === 'model' && this.topModels()[i]) void this.setModel(this.topModels()[i]);
      if (this.menu() === 'mode' && MODES[i]) void this.setMode(MODES[i].id);
      e.preventDefault();
    }
  }

  protected pickFiles(): void {
    this.menu.set(null);
    this.fileInput().nativeElement.click();
  }

  protected openSlash(): void {
    if (!this.text.startsWith('/')) this.text = '/';
    this.textSig.set(this.text);
    this.slashActive.set(0);
    void this.loadSkills();
    this.menu.set('slash');
    queueMicrotask(() => this.textareaRef().nativeElement.focus());
  }

  protected connectors(): void {
    this.menu.set(null);
    void this.router.navigateByUrl('/extensions');
  }

  /** Skill choisi : ajouté comme un bloc (retiré d'un seul Retour arrière), le texte « /… » tapé est effacé. */
  protected useSlash(command: string): void {
    if (BUILTIN_COMMANDS.some((c) => c.command === command)) {
      // Commande de la plateforme : reste dans le texte, des instructions peuvent suivre.
      this.text = `${command} `;
      this.textSig.set(this.text);
      this.menu.set(null);
      queueMicrotask(() => this.textareaRef().nativeElement.focus());
      return;
    }
    const skill = this.slashCommands().find((c) => c.command === command);
    if (skill && !this.selectedSkills().some((s) => s.command === command)) this.selectedSkills.update((l) => [...l, skill]);
    this.text = this.text.startsWith('/') ? this.text.replace(/^\/\S*\s?/, '') : this.text;
    this.textSig.set(this.text);
    this.menu.set(null);
    queueMicrotask(() => {
      this.autosize();
      this.textareaRef().nativeElement.focus();
    });
  }

  private async loadSkills(): Promise<void> {
    if (this.skills().length) return;
    this.skills.set(await this.api.get<SkillDto[]>('/skills').catch(() => []));
  }

  protected async setModel(m: ModelDto): Promise<void> {
    this.menu.set(null);
    await this.store.setModel(m.id).catch((e) => this.toast.error(e));
  }

  protected async setEffort(level: ThinkingLevel): Promise<void> {
    this.menu.set(null);
    await this.store.update({ thinkingLevel: level }).catch((e) => this.toast.error(e));
  }

  protected async setMode(mode: AgentMode): Promise<void> {
    this.menu.set(null);
    await this.store.update({ agentMode: mode }).catch((e) => this.toast.error(e));
    if (this.running()) this.toast.show('Le mode s’appliquera au prochain run.', 'info');
  }

  /* ------------------------------- Saisie ------------------------------ */

  protected onTextChange(): void {
    // « /skill:nom » tapé en entier puis espace : transformé en bloc.
    const typed = /^\/skill:(\S+)\s/.exec(this.text);
    if (typed && this.slashCommands().some((c) => c.name === typed[1])) {
      this.useSlash(`/skill:${typed[1]}`);
      return;
    }
    this.textSig.set(this.text);
    this.slashActive.set(0);
    this.autosize();
    if (this.text.startsWith('/') && !this.text.includes(' ')) {
      void this.loadSkills();
      this.menu.set('slash');
    } else if (this.menu() === 'slash') {
      this.menu.set(null);
    }
  }

  private autosize(): void {
    const el = this.textareaRef().nativeElement;
    el.style.height = 'auto';
    // Une ligne (36 px) au minimum, 240 px au maximum puis défilement.
    el.style.height = `${Math.max(36, Math.min(el.scrollHeight, 240))}px`;
  }

  protected onKey(e: KeyboardEvent): void {
    // Retour arrière en début de saisie : le dernier skill est retiré d'un coup, comme un bloc.
    const el = e.target as HTMLTextAreaElement;
    if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0 && this.selectedSkills().length) {
      e.preventDefault();
      this.selectedSkills.update((l) => l.slice(0, -1));
      return;
    }
    if (this.menu() === 'slash' && !e.isComposing) {
      // Menu slash : flèches pour la sélection (le curseur du champ ne bouge pas), Entrée/Tab pour valider.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSlash(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      const list = this.slashFiltered();
      const chosen = list[Math.min(this.slashActive(), list.length - 1)];
      if (chosen && ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey))) {
        e.preventDefault();
        this.useSlash(chosen.command);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.menu.set(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    const skills = this.selectedSkills().map((s) => s.command);
    const text = [...skills, this.text.trim()].filter(Boolean).join(' ');
    if (!this.text.trim() && !skills.length) return;
    if (this.sending()) return;
    const ready = this.attachments().filter((a) => a.status === 'ready');
    this.sending.set(true);
    try {
      // Pendant une génération, le message est mis en file d'attente (traité à la fin de la tâche en cours).
      // `/compact [instructions]` : compaction du contexte (en file d'attente pendant une génération).
      const command = !skills.length && /^\/compact(\s|$)/.test(this.text.trim()) ? 'compact' : undefined;
      await this.store.send(text, command ? [] : ready.map((a) => a.id), this.running() ? 'follow_up' : 'new_run', undefined, command);
      this.text = '';
      this.textSig.set('');
      this.selectedSkills.set([]);
      this.attachments.set([]);
      this.previews.set({});
      queueMicrotask(() => this.autosize());
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.sending.set(false);
    }
  }

  protected async interrupt() {
    await this.store.interrupt().catch((e) => this.toast.error(e));
  }

  protected async resume() {
    await this.store.resume().catch((e) => this.toast.error(e));
  }

  /* ---------------------------- Pièces jointes ---------------------------- */

  protected onFiles(e: Event): void {
    const files = (e.target as HTMLInputElement).files;
    if (files) void this.upload([...files]);
    (e.target as HTMLInputElement).value = '';
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer?.files.length) void this.upload([...e.dataTransfer.files]);
  }

  protected onPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      void this.upload(files);
    }
  }

  private async upload(files: File[]): Promise<void> {
    const cfg = this.store.config()?.attachments;
    const accepted: File[] = [];
    for (const f of files) {
      if (cfg && f.size > cfg.maxFileMb * 1024 * 1024) {
        this.toast.show(`${f.name} dépasse ${cfg.maxFileMb} Mo`, 'error');
        continue;
      }
      accepted.push(f);
    }
    if (cfg && this.attachments().length + accepted.length > cfg.maxFilesPerMessage) {
      this.toast.show(`${cfg.maxFilesPerMessage} fichiers au maximum par message`, 'error');
      accepted.splice(Math.max(0, cfg.maxFilesPerMessage - this.attachments().length));
    }
    if (!accepted.length) return;
    try {
      const res = await this.store.uploadAttachments(accepted);
      this.attachments.update((l) => [...l, ...res]);
      for (const a of res) {
        if (a.status === 'rejected') this.toast.show(`${a.fileName} refusé : ${a.rejectionReason}`, 'error');
        const local = files.find((f) => f.name === a.fileName);
        if (a.kind === 'image' && local) this.previews.update((p) => ({ ...p, [a.id]: URL.createObjectURL(local) }));
      }
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected async remove(a: AttachmentDto): Promise<void> {
    await this.store.removeAttachment(a.id);
    this.attachments.update((l) => l.filter((x) => x.id !== a.id));
  }
}

