import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { AgentMode, AttachmentDto, ModelDto, SkillDto, ThinkingLevel, WindowUsageDto } from '@cap/contracts';
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
    <div class="mx-auto max-w-3xl px-6 pb-3">
      @if (store.quotaPaused(); as q) {
        <div class="mb-2 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" role="status">
          <cap-icon name="alert" /> Quota atteint ({{ q.window === '5h' ? 'limite de 5 heures' : '7 jours glissants' }}). L’agent est suspendu.
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
                <button class="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 group-hover:opacity-100 focus:opacity-100" (click)="remove(a)" [attr.aria-label]="'Retirer ' + a.fileName"><cap-icon name="x" [size]="12" /></button>
              </div>
            }
          </div>
        }

        @if (menu() === 'slash') {
          <div class="absolute bottom-full left-2 z-30 mb-2 max-h-72 w-96 overflow-y-auto rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="listbox" aria-label="Commandes slash">
            @for (c of slashFiltered(); track c.command) {
              <button class="flex w-full flex-col items-start rounded-lg px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800" (click)="useSlash(c.command)" role="option">
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
                <span class="min-w-0 flex-1 truncate">{{ q.text }}</span>
                <span class="shrink-0 text-xs text-stone-500">En file d’attente</span>
              </div>
            }
          </div>
        }

        <div class="flex items-center gap-1 px-2 py-2">
          <div class="relative">
            <button class="btn-ghost !rounded-lg !p-1.5" [class.bg-stone-200]="menu() === 'plus'" [class.dark:bg-stone-700]="menu() === 'plus'" (click)="toggle('plus', $event)" aria-label="Ajouter" [disabled]="!store.isOwner()"><cap-icon name="plus" [size]="18" /></button>
            @if (menu() === 'plus') {
              <div class="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
                <button class="menu-item" role="menuitem" (click)="pickFiles()"><cap-icon name="paperclip" /> <span class="flex-1 truncate">Ajouter des fichiers ou des photos</span><kbd class="text-xs text-stone-400">Ctrl+U</kbd></button>
                <button class="menu-item" role="menuitem" (click)="openSlash()"><span class="flex h-4 w-4 items-center justify-center rounded border border-current text-[10px] font-bold">/</span> <span class="flex-1">Commandes slash</span></button>
                <button class="menu-item" role="menuitem" (click)="connectors()"><cap-icon name="puzzle" /> <span class="flex-1">Ajouter des connecteurs</span></button>
              </div>
            }
          </div>
          <input #fileInput type="file" multiple class="hidden" (change)="onFiles($event)" />
          <textarea #textarea class="block h-9 max-h-60 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-[0.95rem] leading-6 placeholder:text-stone-400 focus:outline-none" rows="1"
            [placeholder]="running() ? 'Message mis en file d’attente jusqu’à la fin de la tâche en cours…' : 'Tapez / pour les commandes.'" [(ngModel)]="text" name="text"
            (ngModelChange)="onTextChange()" (keydown)="onKey($event)" (paste)="onPaste($event)" [disabled]="!store.isOwner()" aria-label="Message"></textarea>
          @if (running()) {
            <button class="btn-ghost !rounded-lg !p-1.5" (click)="interrupt()" [disabled]="store.activeRun()?.status === 'interrupting'" aria-label="Interrompre" title="Interrompre"><span class="block h-3.5 w-3.5 rounded-sm bg-current"></span></button>
          }
          <button class="btn-ghost !rounded-lg !p-1.5" (click)="submit()" [disabled]="!canSend() || !text.trim()"
            [attr.aria-label]="running() ? 'Mettre en file d’attente' : 'Envoyer'" [title]="running() ? 'Mettre en file d’attente (Entrée)' : 'Envoyer (Entrée)'"><cap-icon name="enter" [size]="18" /></button>
        </div>
      </div>

      <div class="mt-1.5 flex items-center justify-end gap-1 text-[13px]">
        <div class="relative">
          <button class="rounded-md px-2 py-1 hover:bg-stone-200/70 dark:hover:bg-stone-800" [class.bg-stone-200]="isModelMenu()" [class.dark:bg-stone-800]="isModelMenu()" (click)="toggle('model', $event)" [disabled]="!store.isOwner()" aria-haspopup="menu">
            <span class="text-stone-800 dark:text-stone-200">{{ store.currentModel()?.displayName ?? 'Modèle' }}</span>
            @if (store.currentModel()?.supportsReasoning) { <span class="ml-1 text-stone-500">{{ effortLabel() }}</span> }
          </button>
          @if (isModelMenu()) {
            <div class="absolute right-0 bottom-full z-30 mb-2 w-72 rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
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
                  <div class="absolute bottom-0 left-full z-40 ml-2 w-48 rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
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
                    <div class="absolute bottom-0 left-full z-40 ml-2 max-h-80 w-64 overflow-y-auto rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
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
            <div class="absolute right-0 bottom-full z-30 mb-2 w-80 rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
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
            <div class="absolute right-0 bottom-full z-30 mb-2 w-[22rem] rounded-xl border border-stone-200 bg-white p-4 shadow-lg dark:border-stone-700 dark:bg-stone-900">
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
    .menu-item {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.6rem;
      border-radius: 0.5rem;
      padding: 0.4rem 0.75rem;
      text-align: left;
      font-size: 0.875rem;
    }
    .menu-item:hover:not(:disabled) {
      background: color-mix(in oklab, currentColor 8%, transparent);
    }
    .menu-item:disabled {
      opacity: 0.45;
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

  protected readonly slashCommands = computed(() =>
    this.skills()
      .filter((s) => s.enabledForMe)
      .map((s) => ({ command: `/skill:${s.name}`, description: s.description })),
  );
  protected readonly slashFiltered = computed(() => {
    const t = this.textSig();
    const q = t.startsWith('/') ? t.slice(1).split(/\s/)[0].toLowerCase() : '';
    return this.slashCommands().filter((c) => c.command.slice(1).toLowerCase().includes(q));
  });

  /** Fenêtres de quota en pourcentage (utilisateur puis équipes avec plafond) ; jamais de crédits. */
  protected readonly warnAt = QUOTA_WARN;
  protected readonly dangerAt = QUOTA_DANGER;
  protected readonly barClass = quotaBarClass;
  protected readonly textClass = quotaTextClass;
  protected readonly stroke = quotaStroke;
  protected readonly usageRows = computed(() => {
    const u = this.store.usage();
    if (!u) return [];
    const rows = u.user.windows.map((w) => this.row(w, windowLabel(w.window)));
    for (const t of u.teams) for (const w of t.windows) if (w.limit !== null) rows.push(this.row(w, `Équipe ${t.teamName} · ${w.window === '5h' ? '5 h' : '7 j'}`));
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

  private row(w: WindowUsageDto, label: string) {
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
    void this.loadSkills();
    this.menu.set('slash');
    queueMicrotask(() => this.textareaRef().nativeElement.focus());
  }

  protected connectors(): void {
    this.menu.set(null);
    void this.router.navigateByUrl('/extensions');
  }

  protected useSlash(command: string): void {
    this.text = `${command} `;
    this.textSig.set(this.text);
    this.menu.set(null);
    queueMicrotask(() => this.textareaRef().nativeElement.focus());
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
    this.textSig.set(this.text);
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (this.menu() === 'slash' && this.slashFiltered()[0]) {
        this.useSlash(this.slashFiltered()[0].command);
        return;
      }
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    const text = this.text.trim();
    if (!text || this.sending()) return;
    const ready = this.attachments().filter((a) => a.status === 'ready');
    this.sending.set(true);
    try {
      // Pendant une génération, le message est mis en file d'attente (traité à la fin de la tâche en cours).
      await this.store.send(text, ready.map((a) => a.id), this.running() ? 'follow_up' : 'new_run');
      this.text = '';
      this.textSig.set('');
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
    const form = new FormData();
    for (const f of files) {
      if (cfg && f.size > cfg.maxFileMb * 1024 * 1024) {
        this.toast.show(`${f.name} dépasse ${cfg.maxFileMb} Mo`, 'error');
        continue;
      }
      form.append('files', f, f.name);
    }
    if (!form.has('files')) return;
    try {
      const res = await this.api.upload<AttachmentDto[]>(`/workspaces/${this.store.workspace()!.id}/attachments`, form);
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
    await this.api.delete(`/workspaces/${this.store.workspace()!.id}/attachments/${a.id}`).catch(() => undefined);
    this.attachments.update((l) => l.filter((x) => x.id !== a.id));
  }
}

