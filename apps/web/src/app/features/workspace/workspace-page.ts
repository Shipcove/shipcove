import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../../core/api.service';
import { ConversationsService } from '../../core/conversations.service';
import { ConfirmService, deleteConversationDialog } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { LayoutService } from '../../core/layout.service';
import { Icon } from '../../shared/icon';
import { ApprovalsPanel } from './approvals-panel';
import { ChangesPanel } from './changes-panel';
import { Composer } from './composer';
import { Conversation } from './conversation';
import { FilesPane } from './files-pane';
import { GitPanel } from './git-panel';
import { PreviewsPanel } from './previews-panel';
import { ShareDialog } from './share-dialog';
import { WorkspaceStore } from './workspace.store';

type Tab = 'changes' | 'git' | 'approvals' | 'previews';
/** Volet de droite : un seul à la fois (panneau latéral ou explorateur de fichiers). */
type RightPane = 'panel' | 'files' | null;

/**
 * Écran workspace (SPEC §16.1 + PO-1) : conversation centrale et un volet droit exclusif —
 * panneau latéral (Modifications / Git / Approbations / Previews) ou explorateur de fichiers.
 */
@Component({
  selector: 'cap-workspace-page',
  imports: [FormsModule, Icon, Conversation, Composer, FilesPane, ChangesPanel, GitPanel, ApprovalsPanel, PreviewsPanel, ShareDialog],
  providers: [WorkspaceStore],
  host: { class: 'block h-full', '(document:keydown.escape)': 'closeOverlay()' },
  styles: `
    .cap-pane { animation: cap-pane 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes cap-pane { from { transform: translateX(24px); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .cap-pane { animation: none; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.workspace(); as ws) {
      <div class="flex h-full flex-col">
        <header class="flex items-center gap-x-2 gap-y-1 border-b border-stone-200 px-3 py-2 sm:px-4 dark:border-stone-800" [class.pl-11]="layout.desktop() && layout.collapsed()">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1.5 sm:gap-2">
              @if (renaming()) {
                <input #title class="input !py-0.5 font-semibold" [value]="ws.name" aria-label="Titre de la conversation" maxlength="120"
                  (keydown.enter)="rename(title.value)" (keydown.escape)="renaming.set(false)" (blur)="rename(title.value)" />
              } @else {
                <h1 class="min-w-0 truncate font-semibold" [class.cursor-text]="ws.access === 'owner'" (dblclick)="startRename()" [title]="ws.access === 'owner' ? 'Double-cliquez pour renommer' : ws.name">{{ ws.name }}</h1>
                @if (ws.access === 'owner') { <button class="btn-ghost shrink-0 !p-1 text-stone-400" (click)="startRename()" aria-label="Renommer la conversation"><cap-icon name="edit" [size]="13" /></button> }
              }
              <span class="badge shrink-0" [class]="statusClass()">{{ statusLabel() }}</span>
              @if (ws.access === 'shared_read') { <span class="badge shrink-0 bg-sky-100 text-sky-800" title="Lecture seule (partagé)">Lecture seule</span> }
              @if (ws.agentMode === 'plan') { <span class="badge hidden shrink-0 bg-sky-100 text-sky-800 sm:inline-flex" title="Pi n'a que des outils en lecture seule">Mode plan</span> }
            </div>
            <div class="flex min-w-0 items-center gap-2 text-xs text-stone-500">
              @if (ws.repository; as r) {
                <a [href]="r.webUrl" target="_blank" rel="noopener noreferrer" class="inline-flex min-w-0 items-center gap-1 hover:underline" [title]="r.host + '/' + r.fullName">
                  <cap-icon name="git" [size]="12" class="shrink-0" /><span class="truncate">{{ r.fullName }}</span></a>
                @if (ws.branch) { <span class="hidden truncate font-mono text-stone-400 sm:inline">· {{ ws.branch }}</span> }
              } @else {
                <span class="text-stone-400">Sans dépôt Git</span>
              }
              <span class="inline-flex shrink-0 items-center gap-1" [title]="syncTitle()" [class.text-red-600]="ws.syncState === 'unsynced'">
                <cap-icon [name]="ws.syncState === 'unsynced' ? 'cloudOff' : 'cloud'" [size]="13" />
                <span class="hidden sm:inline">{{ ws.syncState === 'syncing' ? 'Sauvegarde…' : ws.syncState === 'unsynced' ? 'Non synchronisé' : 'Sauvegardé' }}</span>
              </span>
              @if (store.streamState() === 'reconnecting') { <span class="shrink-0 text-amber-600">Reconnexion…</span> }
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1 sm:gap-2">
            @if (contextPct() !== null) {
              <div class="hidden w-28 text-[11px] text-stone-500 md:block" title="Remplissage de la fenêtre de contexte du modèle">
                Contexte {{ contextPct() }}%
                <div class="h-1 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1 rounded bg-accent-500" [style.width.%]="contextPct()"></div></div>
              </div>
            }
            @if (ws.access === 'owner') {
              @if (ws.status === 'running') {
                <button class="btn-secondary !px-2 !py-1 text-xs" (click)="stop()" [disabled]="!!store.activeRun()" title="Sauvegarde puis veille de la sandbox" aria-label="Mettre en veille">
                  <cap-icon name="moon" [size]="13" class="sm:hidden" /><span class="hidden sm:inline">Mettre en veille</span></button>
              } @else if (ws.status === 'ready' || ws.status === 'error') {
                <button class="btn-secondary !px-2 !py-1 text-xs" (click)="start()" aria-label="Démarrer"><cap-icon name="play" [size]="12" /><span class="hidden sm:inline"> Démarrer</span></button>
              }
              <button class="btn-ghost !p-1.5" (click)="sharing.set(true)" aria-label="Partager" title="Partager"><cap-icon name="share" /></button>
              <button class="btn-ghost hidden !p-1.5 text-stone-500 hover:text-red-600 sm:inline-flex" (click)="remove()" aria-label="Supprimer la conversation" title="Supprimer la conversation"><cap-icon name="trash" /></button>
            }
            <div class="flex items-center gap-0.5 rounded-md border border-stone-200 p-0.5 dark:border-stone-700" role="group" aria-label="Volet de droite">
              <button class="btn-ghost !p-1.5" [class.bg-stone-200]="pane() === 'files'" [class.dark:bg-stone-700]="pane() === 'files'" (click)="toggle('files')"
                [attr.aria-pressed]="pane() === 'files'" aria-label="Explorateur de fichiers" title="Explorateur de fichiers"><cap-icon name="file" /></button>
              <button class="btn-ghost !p-1.5" [class.bg-stone-200]="pane() === 'panel'" [class.dark:bg-stone-700]="pane() === 'panel'" (click)="toggle('panel')"
                [attr.aria-pressed]="pane() === 'panel'" aria-label="Panneau latéral" title="Modifications, Git, approbations, previews"><cap-icon name="panelRight" /></button>
            </div>
          </div>
        </header>
        @if (store.statusDetail() && ws.status !== 'running') { <div class="border-b border-stone-100 px-4 py-1 text-xs text-stone-500 dark:border-stone-800">{{ store.statusDetail() }}</div> }
        <div class="relative flex min-h-0 flex-1">
          <section class="flex min-w-0 flex-1 flex-col" [class.hidden]="pane() === 'files' && filesExpanded() && layout.wide()">
            <div class="min-h-0 flex-1"><cap-conversation (openFile)="openFile($event)" /></div>
            @if (ws.access === 'owner') { <cap-composer /> }
          </section>
          @if (pane() === 'files') {
            <!-- Volet par-dessus la conversation sous 1280 px (plein écran sur mobile). -->
            <aside class="bg-white dark:bg-stone-900" aria-label="Explorateur de fichiers"
              [class]="layout.wide() ? (filesExpanded() ? 'w-full shrink-0 border-l border-stone-200 dark:border-stone-800' : 'w-[50%] max-w-[1000px] min-w-[420px] shrink-0 border-l border-stone-200 dark:border-stone-800') : 'cap-pane fixed inset-0 z-40 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:absolute md:inset-y-0 md:right-0 md:left-auto md:w-[min(100%,720px)] md:border-l md:border-stone-200 md:shadow-2xl md:dark:border-stone-800'">
              <cap-files-pane [(openFiles)]="openFiles" [(active)]="filePath" [expanded]="filesExpanded()" [compact]="!layout.desktop()" [expandable]="layout.wide()"
                (toggleExpand)="filesExpanded.set(!filesExpanded())" (closed)="pane.set(null)" />
            </aside>
          }
          @if (pane() === 'panel') {
            <aside class="flex flex-col bg-white dark:bg-stone-900" aria-label="Panneau latéral"
              [class]="layout.wide() ? 'w-[44%] max-w-[900px] min-w-[360px] shrink-0 border-l border-stone-200 dark:border-stone-800' : 'cap-pane fixed inset-0 z-40 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:absolute md:inset-y-0 md:right-0 md:left-auto md:w-[min(100%,560px)] md:border-l md:border-stone-200 md:shadow-2xl md:dark:border-stone-800'">
              <div class="flex items-end border-b border-stone-200 dark:border-stone-800">
              <nav class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 pt-1.5" role="tablist">
                @for (t of tabs(); track t.id) {
                  <button role="tab" class="flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm" [attr.aria-selected]="tab() === t.id"
                    [class]="tab() === t.id ? 'bg-stone-100 font-medium dark:bg-stone-800' : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200'" (click)="tab.set(t.id)">
                    <cap-icon [name]="t.icon" [size]="14" />{{ t.label }}
                    @if (t.count) { <span class="badge bg-accent-600 text-white">{{ t.count }}</span> }
                  </button>
                }
              </nav>
                @if (!layout.wide()) {
                  <button class="btn-ghost mx-1 mb-1 shrink-0 !p-1.5" (click)="pane.set(null)" aria-label="Fermer le panneau" title="Fermer"><cap-icon name="x" [size]="16" /></button>
                }
              </div>
              <div class="min-h-0 flex-1">
                @switch (tab()) {
                  @case ('changes') { <cap-changes-panel (openFile)="openFile($event)" /> }
                  @case ('git') { <cap-git-panel /> }
                  @case ('approvals') { <cap-approvals-panel /> }
                  @case ('previews') { <cap-previews-panel /> }
                }
              </div>
            </aside>
          }
        </div>
      </div>
      @if (sharing()) { <cap-share-dialog (closed)="sharing.set(false)" /> }
    } @else {
      <div class="p-8 text-stone-500">{{ error() || 'Chargement de la conversation…' }}</div>
    }
  `,
})
export class WorkspacePage implements OnDestroy {
  readonly workspaceId = input.required<string>();
  readonly approval = input<string>();
  protected readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);
  protected readonly layout = inject(LayoutService);
  /** Volet ouvert d'office seulement s'il tient à côté de la conversation. */
  protected readonly pane = signal<RightPane>(this.layout.wide() ? 'panel' : null);
  protected readonly filesExpanded = signal(false);
  protected readonly tab = signal<Tab>('changes');
  protected readonly filePath = signal<string | null>(null);
  protected readonly openFiles = signal<string[]>([]);
  protected readonly sharing = signal(false);
  protected readonly renaming = signal(false);
  protected readonly error = signal('');
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly conversations = inject(ConversationsService);
  private readonly confirm = inject(ConfirmService);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('title');

  protected readonly tabs = computed(() => {
    const owner = this.store.isOwner();
    return [
      { id: 'changes' as Tab, label: 'Modifications', icon: 'diff', count: 0 },
      ...(owner
        ? [
            { id: 'git' as Tab, label: 'Git', icon: 'git', count: 0 },
            { id: 'approvals' as Tab, label: 'Approbations', icon: 'shield', count: this.store.pendingApprovals().length },
            { id: 'previews' as Tab, label: 'Previews', icon: 'globe', count: 0 },
          ]
        : []),
    ];
  });

  protected readonly contextPct = computed(() => this.store.contextPercent());

  protected readonly statusLabel = computed(() => {
    const ws = this.store.workspace();
    const run = this.store.activeRun();
    if (run?.status === 'running') return 'Pi travaille';
    if (run?.status === 'queued') return 'En file';
    if (run?.status === 'paused_quota') return 'Suspendu (quota)';
    return { ready: 'En veille', starting: 'Démarrage', running: 'Actif', stopping: 'Arrêt', archived: 'Archivé', error: 'Erreur' }[ws?.status ?? 'ready'];
  });
  protected readonly statusClass = computed(() => {
    const run = this.store.activeRun();
    if (run?.status === 'running') return 'bg-accent-100 text-accent-700';
    const s = this.store.workspace()?.status;
    return s === 'running' ? 'bg-emerald-100 text-emerald-800' : s === 'error' ? 'bg-red-100 text-red-800' : s === 'starting' || s === 'stopping' ? 'bg-amber-100 text-amber-800' : 'bg-stone-200 text-stone-700';
  });
  protected readonly syncTitle = computed(() => {
    const ws = this.store.workspace();
    return ws?.lastCheckpointAt ? `Dernier checkpoint : ${new Date(ws.lastCheckpointAt).toLocaleString('fr-FR')}` : 'Aucun checkpoint';
  });

  constructor() {
    effect(() => {
      const id = this.workspaceId();
      untracked(() => void this.store.open(id).catch((err) => this.error.set(err?.message ?? 'Conversation introuvable')));
    });
    effect(() => {
      if (this.approval()) {
        this.tab.set('approvals');
        this.pane.set('panel');
      }
    });
  }

  ngOnDestroy(): void {
    this.store.close();
  }

  /** Ouvre un fichier (onglet) dans l'explorateur, qui remplace le panneau latéral. */
  protected openFile(path: string): void {
    if (!this.openFiles().includes(path)) this.openFiles.update((l) => [...l, path]);
    this.filePath.set(path);
    this.pane.set('files');
  }

  /** Ouvre le volet demandé (fermant l'autre), ou le referme s'il est déjà ouvert. */
  /** Échap ferme le volet affiché par-dessus la conversation (petits écrans). */
  protected closeOverlay(): void {
    if (!this.layout.wide() && this.pane() && !this.sharing()) this.pane.set(null);
  }

  protected toggle(p: Exclude<RightPane, null>): void {
    this.pane.set(this.pane() === p ? null : p);
    if (this.pane() !== 'files') this.filesExpanded.set(false);
  }

  protected startRename(): void {
    if (this.store.workspace()?.access !== 'owner') return;
    this.renaming.set(true);
    setTimeout(() => this.titleInput()?.nativeElement.select());
  }

  /** Titre choisi par l'utilisateur : il ne sera plus remplacé par le titre automatique. */
  protected async rename(value: string): Promise<void> {
    if (!this.renaming()) return;
    this.renaming.set(false);
    const ws = this.store.workspace();
    const name = value.trim();
    if (!ws || !name || name === ws.name) return;
    try {
      await this.api.patch(`/workspaces/${ws.id}`, { name });
      this.store.workspace.update((w) => (w ? { ...w, name, titleSource: 'user' } : w));
      this.conversations.patch(ws.id, { name, titleSource: 'user' });
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async remove(): Promise<void> {
    const ws = this.store.workspace();
    if (!ws || !(await this.confirm.ask(deleteConversationDialog(ws.name, !!this.store.activeRun())))) return;
    try {
      await this.api.delete(`/workspaces/${ws.id}`);
      this.conversations.remove(ws.id);
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async setModel(id: string) {
    await this.store.setModel(id).catch((e) => this.toast.error(e));
  }
  protected async start() {
    await this.store.start().catch((e) => this.toast.error(e));
  }
  protected async stop() {
    await this.store.stop().catch((e) => this.toast.error(e));
  }
}
