import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { GitConnectionDto, ProjectDto, RemoteRepositoryDto, TeamDto } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'cap-projects',
  imports: [FormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-5xl px-6 py-8">
      <div class="flex items-center"><h1 class="text-2xl font-semibold">Projets</h1><button class="btn-primary ml-auto" (click)="creating.set(!creating())"><cap-icon name="plus" [size]="14" /> Nouveau projet</button></div>
      @if (creating()) {
        <form class="card mt-4 grid gap-3 p-4 md:grid-cols-2" (ngSubmit)="create()">
          <div><label class="label" for="pt">Équipe</label><select id="pt" class="input" name="team" [(ngModel)]="teamId" required>@for (t of teams(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }</select></div>
          <div><label class="label" for="pn">Nom</label><input id="pn" class="input" name="name" [(ngModel)]="name" required /></div>
          <div class="md:col-span-2"><label class="label" for="pd">Description</label><input id="pd" class="input" name="desc" [(ngModel)]="description" /></div>
          <div class="md:col-span-2">
            <label class="label">Source</label>
            <div class="flex gap-4 text-sm">
              <label class="flex items-center gap-1"><input type="radio" name="src" value="blank" [(ngModel)]="source" /> Projet vierge</label>
              <label class="flex items-center gap-1"><input type="radio" name="src" value="repo" [(ngModel)]="source" /> Dépôt Git</label>
            </div>
          </div>
          @if (source === 'repo') {
            <div><label class="label" for="pc">Connexion Git</label>
              <select id="pc" class="input" name="conn" [(ngModel)]="connectionId" (ngModelChange)="loadRepos()">
                <option value="">— choisir —</option>@for (c of connections(); track c.id) { <option [value]="c.id">{{ c.host }} · {{ c.accountLogin }}</option> }
              </select>
              @if (connections().length === 0) { <p class="mt-1 text-xs text-stone-500">Aucune connexion : <a routerLink="/settings/git" class="underline">rattachez un compte GitHub/GitLab</a>.</p> }
            </div>
            <div class="relative"><label class="label" for="pr">Dépôt</label>
              <button type="button" id="pr" class="input flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60" (click)="toggleRepos()" [disabled]="!connectionId" aria-haspopup="listbox" [attr.aria-expanded]="reposOpen()">
                @if (repo) {
                  <span class="truncate font-mono text-sm">{{ repo }}</span>
                } @else {
                  <span class="truncate text-stone-400">{{ !connectionId ? 'Choisissez d’abord une connexion' : loadingRepos() ? 'Chargement des dépôts…' : 'Choisir un dépôt' }}</span>
                }
                <cap-icon name="chevronDown" [size]="14" class="ml-auto shrink-0 text-stone-400" />
              </button>
              @if (reposOpen()) {
                <div class="fixed inset-0 z-20" (click)="reposOpen.set(false)"></div>
                <div class="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900">
                  <div class="border-b border-stone-100 p-2 dark:border-stone-800">
                    <input #repoSearch class="input !py-1.5" name="repoQuery" placeholder="Rechercher un dépôt…" autocomplete="off" [ngModel]="repoQuery()" (ngModelChange)="repoQuery.set($event); activeIndex.set(0)" (keydown)="repoKey($event)" aria-label="Rechercher un dépôt" />
                  </div>
                  <ul role="listbox" aria-label="Dépôts" class="max-h-72 overflow-y-auto p-1">
                    @for (r of filteredRepos(); track r.fullName; let i = $index) {
                      <li role="option" [attr.aria-selected]="r.fullName === repo" (click)="chooseRepo(r)" (mouseenter)="activeIndex.set(i)" class="cursor-pointer rounded-lg px-3 py-2" [class.bg-stone-100]="i === activeIndex()" [class.dark:bg-stone-800]="i === activeIndex()">
                        <div class="flex items-center gap-2">
                          <span class="truncate font-mono text-sm">{{ r.fullName }}</span>
                          @if (r.private) { <span class="badge shrink-0 bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300">privé</span> }
                          @if (r.fullName === repo) { <cap-icon name="check" [size]="14" class="ml-auto shrink-0 text-accent-600" /> }
                        </div>
                        @if (r.description) { <div class="truncate text-xs text-stone-500">{{ r.description }}</div> }
                      </li>
                    } @empty {
                      <li class="px-3 py-2 text-sm text-stone-500">{{ loadingRepos() ? 'Chargement des dépôts…' : repoQuery() ? 'Aucun dépôt ne correspond.' : 'Aucun dépôt accessible avec cette connexion.' }}</li>
                    }
                  </ul>
                  @if (repos().length) { <div class="border-t border-stone-100 px-3 py-1.5 text-xs text-stone-500 dark:border-stone-800">{{ filteredRepos().length }} / {{ repos().length }} dépôt(s)</div> }
                </div>
              }
              @if (reposError()) { <p class="mt-1 text-xs text-red-600">{{ reposError() }} <button type="button" class="underline" (click)="loadRepos()">Réessayer</button></p> }
            </div>
          }
          <div class="md:col-span-2"><button class="btn-primary" [disabled]="busy() || (source === 'repo' && !repo)">Créer</button></div>
        </form>
      }
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        @for (p of projects(); track p.id) {
          <a [routerLink]="['/projects', p.id]" class="card p-4 hover:border-accent-500">
            <div class="flex items-center gap-2"><cap-icon name="folder" /><span class="font-medium">{{ p.name }}</span><span class="ml-auto text-xs text-stone-500">{{ p.teamName }}</span></div>
            <div class="mt-1 truncate text-xs text-stone-500">{{ p.repository ? p.repository.host + '/' + p.repository.fullName : 'Projet vierge' }} · {{ p.myWorkspaceCount }} workspace(s)</div>
          </a>
        } @empty { <p class="text-sm text-stone-500">Aucun projet.</p> }
      </div>
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class ProjectsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  protected readonly projects = signal<ProjectDto[]>([]);
  protected readonly teams = signal<TeamDto[]>([]);
  protected readonly connections = signal<GitConnectionDto[]>([]);
  protected readonly repos = signal<RemoteRepositoryDto[]>([]);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected teamId = '';
  protected name = '';
  protected description = '';
  protected source: 'blank' | 'repo' = 'blank';
  protected connectionId = '';
  protected repo = '';
  protected readonly reposOpen = signal(false);
  protected readonly loadingRepos = signal(false);
  protected readonly reposError = signal('');
  protected readonly repoQuery = signal('');
  protected readonly activeIndex = signal(0);
  private readonly repoSearch = viewChild<ElementRef<HTMLInputElement>>('repoSearch');
  protected readonly filteredRepos = computed(() => {
    const q = this.repoQuery().trim().toLowerCase();
    const list = this.repos();
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)) : list;
  });

  async ngOnInit() {
    const [p, t, c] = await Promise.all([this.api.get<ProjectDto[]>('/projects'), this.api.get<TeamDto[]>('/teams'), this.api.get<GitConnectionDto[]>('/me/git-connections')]);
    this.projects.set(p);
    this.teams.set(t);
    this.connections.set(c);
    if (!this.teamId && t[0]) this.teamId = t[0].id;
    // Une seule connexion Git : présélectionnée.
    if (c.length === 1) this.connectionId = c[0].id;
  }

  /** Passage sur « Dépôt Git » : les dépôts de la connexion choisie sont chargés. */
  protected onSource(source: 'blank' | 'repo') {
    if (source === 'repo') this.ensureRepos();
  }

  private ensureRepos() {
    if (this.connectionId && !this.repos().length && !this.loadingRepos() && !this.reposError()) void this.loadRepos();
  }

  protected async loadRepos() {
    this.repo = '';
    this.repos.set([]);
    this.reposError.set('');
    if (!this.connectionId) return;
    this.loadingRepos.set(true);
    try {
      this.repos.set(await this.api.get<RemoteRepositoryDto[]>(`/me/git-connections/${this.connectionId}/repositories`));
    } catch (e) {
      this.reposError.set(e instanceof ApiError ? e.message : 'Impossible de lister les dépôts.');
    } finally {
      this.loadingRepos.set(false);
    }
  }

  protected toggleRepos() {
    this.ensureRepos();
    this.reposOpen.set(!this.reposOpen());
    if (this.reposOpen()) {
      this.repoQuery.set('');
      const i = this.repos().findIndex((r) => r.fullName === this.repo);
      this.activeIndex.set(Math.max(0, i));
      setTimeout(() => this.repoSearch()?.nativeElement.focus());
    }
  }

  protected chooseRepo(r: RemoteRepositoryDto) {
    this.repo = r.fullName;
    if (!this.name.trim()) this.name = r.fullName.split('/').pop() ?? r.fullName;
    if (!this.description.trim() && r.description) this.description = r.description;
    this.reposOpen.set(false);
  }

  protected repoKey(ev: KeyboardEvent) {
    const n = this.filteredRepos().length;
    if (ev.key === 'ArrowDown') this.activeIndex.set(Math.min(n - 1, this.activeIndex() + 1));
    else if (ev.key === 'ArrowUp') this.activeIndex.set(Math.max(0, this.activeIndex() - 1));
    else if (ev.key === 'Enter') {
      const r = this.filteredRepos()[this.activeIndex()];
      if (r) this.chooseRepo(r);
    } else if (ev.key === 'Escape') this.reposOpen.set(false);
    else return;
    ev.preventDefault();
  }

  protected async create() {
    this.busy.set(true);
    try {
      const p = await this.api.post<ProjectDto>('/projects', {
        teamId: this.teamId,
        name: this.name,
        description: this.description || undefined,
        repository: this.source === 'repo' ? { gitConnectionId: this.connectionId, fullName: this.repo } : undefined,
      });
      await this.router.navigate(['/projects', p.id]);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
