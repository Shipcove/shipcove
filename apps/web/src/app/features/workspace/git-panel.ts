import { ChangeDetectionStrategy, Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import type { GitBranchesDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { ChangesPanel } from './changes-panel';
import { WorkspaceStore } from './workspace.store';
import { t } from '../../core/i18n';

/**
 * Onglet Git : branche de travail (sélecteur, suit les changements de branche faits par Pi) et
 * git diff du répertoire de travail par rapport à HEAD, fichier par fichier. Le reste (commits,
 * push, PR…) se fait en conversation avec Pi.
 */
@Component({
  selector: 'cap-git-panel',
  imports: [Icon, ChangesPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col">
      @if (store.isOwner()) {
      <div class="flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
        <cap-icon name="git" [size]="14" class="shrink-0 text-stone-500" />
        @if (branches(); as b) {
          @if (!b.available) {
            <span class="text-xs text-stone-500">{{ t('Branche indisponible : démarrez la conversation (ou rattachez un dépôt).') }}</span>
          } @else {
            <label class="sr-only" for="git-branch">{{ t('Branche de travail') }}</label>
            <select id="git-branch" class="input !w-auto max-w-full min-w-0 flex-1 !py-1 font-mono text-xs" (change)="checkout($event)"
              [disabled]="switching() || !!store.activeRun()" [title]="store.activeRun() ? t('Disponible quand l’agent a terminé sa réponse') : t('Changer de branche de travail')">
              <!-- Sélection portée par chaque option : un [value] sur le select serait appliqué avant
                   que l'option de la nouvelle branche n'existe (branche distante devenue locale). -->
              @if (!b.current) { <option value="" disabled selected>{{ t('HEAD détaché') }}</option> }
              <optgroup label="Branches locales">
                @for (br of b.local; track br.name) { <option [value]="br.name" [selected]="br.name === b.current">{{ br.name }}</option> }
              </optgroup>
              @if (b.remote.length) {
                <optgroup label="Branches distantes (origin)">
                  @for (br of b.remote; track br.name) { <option [value]="br.name" [selected]="br.name === b.current">{{ br.name }}</option> }
                </optgroup>
              }
            </select>
            @if (switching()) { <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-500" [attr.aria-label]="t('Changement de branche en cours')"></span> }
          }
        } @else {
          <span class="text-xs text-stone-500">{{ t('Chargement…') }}</span>
        }
      </div>
      }
      <div class="min-h-0 flex-1">
        <cap-changes-panel fixedScope="git_head" [refresh]="refresh()" (openFile)="openFile.emit($event)" />
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class GitPanel {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly store = inject(WorkspaceStore);
  readonly openFile = output<string>();
  protected readonly branches = signal<GitBranchesDto | null>(null);
  protected readonly switching = signal(false);
  protected readonly refresh = signal(0);
  private readonly workspaceId = computed(() => this.store.workspace()?.id ?? null);
  /** Sandbox démarrée / arrêtée : la branche devient (in)disponible. */
  private readonly sandboxStatus = computed(() => this.store.workspace()?.status ?? null);
  /** Fin d'un run : Pi a pu changer de branche. */
  private readonly runKey = computed(() => this.store.activeRun()?.id ?? null);
  /** Branche diffusée par la plateforme (`workspace.branch`) après un changement par Pi ou par vous. */
  private readonly liveBranch = computed(() => this.store.workspace()?.branch ?? null);

  constructor() {
    // Nouvelle branche : le diff par rapport à HEAD change même si aucun fichier n'a bougé.
    effect(() => {
      if (this.liveBranch()) untracked(() => this.refresh.update((v) => v + 1));
    });
    effect(() => {
      // Un `git switch` de Pi modifie des fichiers (checkpoint → filesVersion) ; on relit la branche.
      this.store.filesVersion();
      this.sandboxStatus();
      this.runKey();
      this.liveBranch();
      if (this.workspaceId() && this.store.isOwner()) untracked(() => void this.load());
    });
  }

  private loading: Promise<void> | null = null;
  private reloadAgain = false;

  /** Un chargement à la fois ; une demande reçue pendant ce temps en relance un après (jamais perdue). */
  async load(): Promise<void> {
    if (this.loading) {
      this.reloadAgain = true;
      return this.loading;
    }
    this.loading = (async () => {
      try {
        do {
          this.reloadAgain = false;
          try {
            this.branches.set(await this.api.get<GitBranchesDto>(`/workspaces/${this.workspaceId()}/git/branches`));
          } catch {
            this.branches.set({ available: false, current: null, local: [], remote: [] });
          }
        } while (this.reloadAgain);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  protected async checkout(ev: Event): Promise<void> {
    const select = ev.target as HTMLSelectElement;
    const branch = select.value;
    const previous = this.branches()?.current ?? '';
    if (!branch || branch === previous) return;
    this.switching.set(true);
    try {
      await this.api.post(`/workspaces/${this.workspaceId()}/git/checkout`, { branch });
      this.toast.show(t('Branche de travail : {branch}', { branch }), 'success');
    } catch (err) {
      select.value = previous;
      this.toast.error(err);
    } finally {
      this.switching.set(false);
      await this.load();
      this.refresh.update((v) => v + 1);
    }
  }
}
