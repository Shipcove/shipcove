import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { TokensPipe } from '../../shared/pipes';
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
  imports: [FormsModule, RouterLink, Icon, TokensPipe, Conversation, Composer, FilesPane, ChangesPanel, GitPanel, ApprovalsPanel, PreviewsPanel, ShareDialog],
  providers: [WorkspaceStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.workspace(); as ws) {
      <div class="flex h-full flex-col">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 px-4 py-2 dark:border-stone-800">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="truncate font-semibold">{{ ws.name }}</h1>
              <span class="badge" [class]="statusClass()">{{ statusLabel() }}</span>
              @if (ws.access === 'shared_read') { <span class="badge bg-sky-100 text-sky-800">Lecture seule (partagé)</span> }
            </div>
            <a [routerLink]="['/projects', ws.projectId]" class="text-xs text-stone-500 hover:underline">{{ ws.projectName }}</a>
            @if (ws.branch) { <span class="ml-1 font-mono text-xs text-stone-400">· {{ ws.branch }}</span> }
          </div>
          <span class="flex items-center gap-1 text-xs" [title]="syncTitle()" [class.text-red-600]="ws.syncState === 'unsynced'" [class.text-stone-500]="ws.syncState !== 'unsynced'">
            <cap-icon [name]="ws.syncState === 'unsynced' ? 'cloudOff' : 'cloud'" [size]="14" />{{ ws.syncState === 'syncing' ? 'Sauvegarde…' : ws.syncState === 'unsynced' ? 'Non synchronisé' : 'Sauvegardé' }}
          </span>
          @if (store.streamState() === 'reconnecting') { <span class="text-xs text-amber-600">Reconnexion au flux…</span> }
          <div class="ml-auto flex flex-wrap items-center gap-3">
            @if (ws.agentMode === 'plan') { <span class="badge bg-sky-100 text-sky-800" title="Pi n'a que des outils en lecture seule">Mode plan</span> }
            @if (contextPct() !== null) {
              <div class="w-28 text-[11px] text-stone-500" [title]="'Contexte : ' + (store.context().tokens | tokens) + ' / ' + (store.context().contextWindow | tokens) + ' tokens'">
                Contexte {{ contextPct() }}%
                <div class="h-1 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1 rounded bg-accent-500" [style.width.%]="contextPct()"></div></div>
              </div>
            }
            @if (ws.access === 'owner') {
              @if (ws.status === 'running') { <button class="btn-secondary !py-1 text-xs" (click)="stop()" [disabled]="!!store.activeRun()" title="Sauvegarde puis veille de la sandbox">Mettre en veille</button> }
              @else if (ws.status === 'ready' || ws.status === 'error') { <button class="btn-secondary !py-1 text-xs" (click)="start()"><cap-icon name="play" [size]="12" /> Démarrer</button> }
              <button class="btn-ghost !p-1.5" (click)="sharing.set(true)" aria-label="Partager"><cap-icon name="share" /></button>
            }
            <div class="flex items-center gap-0.5 rounded-md border border-stone-200 p-0.5 dark:border-stone-700" role="group" aria-label="Volet de droite">
              <button class="btn-ghost !p-1.5" [class.bg-stone-200]="pane() === 'files'" [class.dark:bg-stone-700]="pane() === 'files'" (click)="toggle('files')"
                [attr.aria-pressed]="pane() === 'files'" aria-label="Explorateur de fichiers" title="Explorateur de fichiers"><cap-icon name="file" /></button>
              <button class="btn-ghost !p-1.5" [class.bg-stone-200]="pane() === 'panel'" [class.dark:bg-stone-700]="pane() === 'panel'" (click)="toggle('panel')"
                [attr.aria-pressed]="pane() === 'panel'" aria-label="Panneau latéral" title="Modifications, Git, approbations, previews"><cap-icon name="panelRight" /></button>
            </div>
          </div>
          @if (store.statusDetail() && ws.status !== 'running') { <div class="w-full text-xs text-stone-500">{{ store.statusDetail() }}</div> }
        </header>
        <div class="flex min-h-0 flex-1">
          <section class="flex min-w-0 flex-1 flex-col" [class.hidden]="pane() === 'files' && filesExpanded()">
            <div class="min-h-0 flex-1"><cap-conversation (openFile)="openFile($event)" /></div>
            @if (ws.access === 'owner') { <cap-composer /> }
          </section>
          @if (pane() === 'files') {
            <aside class="shrink-0 border-l border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900" aria-label="Explorateur de fichiers"
              [class]="filesExpanded() ? 'w-full' : 'w-[50%] max-w-[1000px] min-w-[420px]'">
              <cap-files-pane [(openFiles)]="openFiles" [(active)]="filePath" [expanded]="filesExpanded()"
                (toggleExpand)="filesExpanded.set(!filesExpanded())" (closed)="pane.set(null)" />
            </aside>
          }
          @if (pane() === 'panel') {
            <aside class="flex w-[44%] max-w-[900px] min-w-[360px] shrink-0 flex-col border-l border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900" aria-label="Panneau latéral">
              <nav class="flex gap-0.5 border-b border-stone-200 px-2 pt-1.5 dark:border-stone-800" role="tablist">
                @for (t of tabs(); track t.id) {
                  <button role="tab" class="flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm" [attr.aria-selected]="tab() === t.id"
                    [class]="tab() === t.id ? 'bg-stone-100 font-medium dark:bg-stone-800' : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200'" (click)="tab.set(t.id)">
                    <cap-icon [name]="t.icon" [size]="14" />{{ t.label }}
                    @if (t.count) { <span class="badge bg-accent-600 text-white">{{ t.count }}</span> }
                  </button>
                }
              </nav>
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
      <div class="p-8 text-stone-500">{{ error() || 'Chargement du workspace…' }}</div>
    }
  `,
  host: { class: 'block h-full' },
})
export class WorkspacePage implements OnDestroy {
  readonly workspaceId = input.required<string>();
  readonly approval = input<string>();
  protected readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);
  protected readonly pane = signal<RightPane>('panel');
  protected readonly filesExpanded = signal(false);
  protected readonly tab = signal<Tab>('changes');
  protected readonly filePath = signal<string | null>(null);
  protected readonly openFiles = signal<string[]>([]);
  protected readonly sharing = signal(false);
  protected readonly error = signal('');

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

  protected readonly contextPct = computed(() => {
    const c = this.store.context();
    return c.tokens && c.contextWindow ? Math.min(100, Math.round((c.tokens / c.contextWindow) * 100)) : null;
  });

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
      void this.store.open(id).catch((err) => this.error.set(err?.message ?? 'Workspace introuvable'));
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
  protected toggle(p: Exclude<RightPane, null>): void {
    this.pane.set(this.pane() === p ? null : p);
    if (this.pane() !== 'files') this.filesExpanded.set(false);
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
