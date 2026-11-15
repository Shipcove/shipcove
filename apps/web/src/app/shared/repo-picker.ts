import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { GitConnectionDto, RemoteRepositoryDto } from '@cap/contracts';
import { Api, ApiError } from '../core/api.service';
import { Icon } from './icon';

export interface RepoChoice {
  gitConnectionId: string;
  host: string;
  fullName: string;
}

/**
 * Choix facultatif d'un dépôt Git : bouton compact qui ouvre une liste filtrable des dépôts
 * accessibles avec les connexions Git de l'utilisateur.
 */
@Component({
  selector: 'cap-repo-picker',
  imports: [FormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative inline-block max-w-full', '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <button type="button" class="flex max-w-full items-center sm:max-w-80 gap-1.5 rounded-md px-2 py-1 text-[13px] hover:bg-stone-200/70 dark:hover:bg-stone-800"
      [class.bg-stone-200]="open()" [class.dark:bg-stone-800]="open()" (click)="toggle()" aria-haspopup="listbox" [attr.aria-expanded]="open()"
      [title]="value() ? value()!.host + '/' + value()!.fullName : 'Associer un dépôt Git (facultatif)'">
      <cap-icon name="git" [size]="14" class="shrink-0 text-stone-500" />
      @if (value(); as v) {
        <span class="truncate font-mono text-stone-800 dark:text-stone-200">{{ v.fullName }}</span>
      } @else {
        <span class="text-stone-500">Aucun dépôt</span>
      }
      <cap-icon name="chevronDown" [size]="12" class="shrink-0 text-stone-400" />
    </button>
    @if (open()) {
      <div class="fixed inset-0 z-20" (click)="open.set(false)"></div>
      <div class="absolute left-0 z-30 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900"
        [class.top-full]="placement() === 'below'" [class.mt-1]="placement() === 'below'" [class.bottom-full]="placement() === 'above'" [class.mb-1]="placement() === 'above'">
        @if (!connections().length) {
          <p class="p-3 text-sm text-stone-500">{{ loadingConnections() ? 'Chargement…' : 'Aucune connexion Git.' }}
            @if (!loadingConnections()) { <a routerLink="/settings/git" class="underline" (click)="open.set(false)">Rattachez un compte GitHub ou GitLab</a> pour travailler sur un dépôt. }
          </p>
        } @else {
          <div class="flex gap-2 border-b border-stone-100 p-2 dark:border-stone-800">
            @if (connections().length > 1) {
              <select class="input !w-auto !py-1.5 text-xs" [ngModel]="connectionId()" (ngModelChange)="selectConnection($event)" aria-label="Connexion Git">
                @for (c of connections(); track c.id) { <option [value]="c.id">{{ c.host }} · {{ c.accountLogin }}</option> }
              </select>
            }
            <input #search class="input !py-1.5" placeholder="Rechercher un dépôt…" autocomplete="off" [ngModel]="query()" (ngModelChange)="query.set($event); active.set(0)" (keydown)="onKey($event)" aria-label="Rechercher un dépôt" />
          </div>
          <ul role="listbox" aria-label="Dépôts" class="max-h-72 overflow-y-auto p-1">
            <li role="option" [attr.aria-selected]="!value()" (click)="choose(null)" class="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800">
              Aucun dépôt<span class="text-xs text-stone-400">— conversation libre</span>
              @if (!value()) { <cap-icon name="check" [size]="14" class="ml-auto text-accent-600" /> }
            </li>
            @for (r of filtered(); track r.fullName; let i = $index) {
              <li role="option" [attr.aria-selected]="r.fullName === value()?.fullName" (click)="choose(r)" (mouseenter)="active.set(i)" class="cursor-pointer rounded-lg px-3 py-2"
                [class.bg-stone-100]="i === active()" [class.dark:bg-stone-800]="i === active()">
                <div class="flex items-center gap-2">
                  <span class="truncate font-mono text-sm">{{ r.fullName }}</span>
                  @if (r.private) { <span class="badge shrink-0 bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300">privé</span> }
                  @if (r.fullName === value()?.fullName) { <cap-icon name="check" [size]="14" class="ml-auto shrink-0 text-accent-600" /> }
                </div>
                @if (r.description) { <div class="truncate text-xs text-stone-500">{{ r.description }}</div> }
              </li>
            } @empty {
              <li class="px-3 py-2 text-sm text-stone-500">{{ loading() ? 'Chargement des dépôts…' : query() ? 'Aucun dépôt ne correspond.' : 'Aucun dépôt accessible avec cette connexion.' }}</li>
            }
          </ul>
          @if (error()) { <p class="border-t border-stone-100 px-3 py-1.5 text-xs text-red-600 dark:border-stone-800">{{ error() }} <button type="button" class="underline" (click)="loadRepos()">Réessayer</button></p> }
          @else if (repos().length) { <div class="border-t border-stone-100 px-3 py-1.5 text-xs text-stone-500 dark:border-stone-800">{{ filtered().length }} / {{ repos().length }} dépôt(s)</div> }
        }
      </div>
    }
  `,
})
export class RepoPicker {
  private readonly api = inject(Api);
  readonly value = model<RepoChoice | null>(null);
  readonly placement = input<'above' | 'below'>('below');
  protected readonly open = signal(false);
  protected readonly connections = signal<GitConnectionDto[]>([]);
  protected readonly loadingConnections = signal(false);
  protected readonly connectionId = signal('');
  protected readonly repos = signal<RemoteRepositoryDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly query = signal('');
  protected readonly active = signal(0);
  private readonly cache = new Map<string, RemoteRepositoryDto[]>();
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private loaded: Promise<void> | null = null;

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.repos();
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)) : list;
  });

  /** Connexions actives de l'utilisateur (chargées une fois). */
  loadConnections(): Promise<void> {
    this.loaded ??= (async () => {
      this.loadingConnections.set(true);
      try {
        const c = (await this.api.get<GitConnectionDto[]>('/me/git-connections')).filter((x) => x.status === 'active');
        this.connections.set(c);
        if (!this.connectionId() && c[0]) this.connectionId.set(this.value()?.gitConnectionId ?? c[0].id);
      } finally {
        this.loadingConnections.set(false);
      }
    })();
    return this.loaded;
  }

  /** Présélection d'un dépôt par hôte et nom complet (lien « nouvelle conversation dans ce dépôt »). */
  async preselect(host: string, fullName: string): Promise<void> {
    await this.loadConnections();
    const c = this.connections().find((x) => x.host.toLowerCase() === host.toLowerCase());
    if (c) this.value.set({ gitConnectionId: c.id, host: c.host, fullName });
  }

  protected async toggle(): Promise<void> {
    this.open.set(!this.open());
    if (!this.open()) return;
    this.query.set('');
    await this.loadConnections();
    if (!this.repos().length) await this.loadRepos();
    this.active.set(0);
    setTimeout(() => this.search()?.nativeElement.focus());
  }

  protected selectConnection(id: string): void {
    this.connectionId.set(id);
    void this.loadRepos();
  }

  protected async loadRepos(): Promise<void> {
    const id = this.connectionId();
    this.error.set('');
    if (!id) return;
    const cached = this.cache.get(id);
    if (cached) return this.repos.set(cached);
    this.repos.set([]);
    this.loading.set(true);
    try {
      const list = await this.api.get<RemoteRepositoryDto[]>(`/me/git-connections/${id}/repositories`);
      this.cache.set(id, list);
      if (this.connectionId() === id) this.repos.set(list);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Impossible de lister les dépôts.');
    } finally {
      this.loading.set(false);
    }
  }

  protected choose(r: RemoteRepositoryDto | null): void {
    const c = this.connections().find((x) => x.id === this.connectionId());
    this.value.set(r && c ? { gitConnectionId: c.id, host: c.host, fullName: r.fullName } : null);
    this.open.set(false);
  }

  protected onKey(ev: KeyboardEvent): void {
    const n = this.filtered().length;
    if (ev.key === 'ArrowDown') this.active.set(Math.min(n - 1, this.active() + 1));
    else if (ev.key === 'ArrowUp') this.active.set(Math.max(0, this.active() - 1));
    else if (ev.key === 'Enter') {
      const r = this.filtered()[this.active()];
      if (r) this.choose(r);
    } else if (ev.key === 'Escape') this.open.set(false);
    else return;
    ev.preventDefault();
  }
}
