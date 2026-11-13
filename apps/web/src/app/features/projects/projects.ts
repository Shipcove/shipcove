import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { GitConnectionDto, ProjectDto, RemoteRepositoryDto, TeamDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
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
            <div><label class="label" for="pr">Dépôt</label>
              <input id="pr" class="input" name="repo" list="repos" [(ngModel)]="repo" placeholder="owner/nom" />
              <datalist id="repos">@for (r of repos(); track r.fullName) { <option [value]="r.fullName">{{ r.description }}</option> }</datalist>
            </div>
          }
          <div class="md:col-span-2"><button class="btn-primary" [disabled]="busy()">Créer</button></div>
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

  async ngOnInit() {
    const [p, t, c] = await Promise.all([this.api.get<ProjectDto[]>('/projects'), this.api.get<TeamDto[]>('/teams'), this.api.get<GitConnectionDto[]>('/me/git-connections')]);
    this.projects.set(p);
    this.teams.set(t);
    this.connections.set(c);
    if (!this.teamId && t[0]) this.teamId = t[0].id;
  }

  protected async loadRepos() {
    if (!this.connectionId) return;
    this.repos.set(await this.api.get<RemoteRepositoryDto[]>(`/me/git-connections/${this.connectionId}/repositories`).catch(() => []));
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
