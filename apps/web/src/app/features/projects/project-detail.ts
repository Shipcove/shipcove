import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ProjectDto, WorkspaceDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { ProjectEnvironment } from './project-environment';
import { AgoPipe } from '../../shared/pipes';

@Component({
  selector: 'cap-project-detail',
  imports: [FormsModule, RouterLink, Icon, AgoPipe, ProjectEnvironment],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-5xl px-6 py-8">
      @if (project(); as p) {
        <div class="text-xs text-stone-500">{{ p.teamName }}</div>
        <h1 class="text-2xl font-semibold">{{ p.name }}</h1>
        <p class="text-sm text-stone-500">{{ p.description }}</p>
        <div class="mt-2 text-sm">
          @if (p.repository) { <a [href]="p.repository.webUrl" target="_blank" rel="noopener" class="font-mono text-accent-700 hover:underline">{{ p.repository.host }}/{{ p.repository.fullName }}</a> · branche par défaut {{ p.repository.defaultBranch }} }
          @else { <span class="text-stone-500">Projet vierge (sans dépôt)</span> }
        </div>
        <form class="card mt-6 flex flex-wrap items-end gap-2 p-4" (ngSubmit)="create()">
          <div class="flex-1"><label class="label" for="wn">Nouveau workspace personnel</label><input id="wn" class="input" name="name" [(ngModel)]="name" placeholder="ex. refonte de l’authentification" required /></div>
          @if (p.repository) { <div><label class="label" for="wb">Branche</label><input id="wb" class="input" name="branch" [(ngModel)]="branch" [placeholder]="p.repository.defaultBranch" /></div> }
          <button class="btn-primary" [disabled]="busy()"><cap-icon name="plus" [size]="14" /> Créer</button>
        </form>
        <p class="mt-2 text-xs text-stone-500">Chaque workspace a ses propres fichiers et sa conversation ; le partage du code passe par Git.</p>
        <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">Mes workspaces</h2>
        <div class="card divide-y divide-stone-100 dark:divide-stone-800">
          @for (w of workspaces(); track w.id) {
            <div class="flex items-center gap-3 px-4 py-3">
              <a [routerLink]="['/workspaces', w.id]" class="min-w-0 flex-1"><div class="truncate font-medium hover:underline">{{ w.name }}</div><div class="text-xs text-stone-500">{{ w.status }} · {{ w.lastActivityAt ?? w.createdAt | ago }}</div></a>
              @if (w.access === 'owner') {
                @if (!w.archivedAt) { <button class="btn-ghost !py-1 text-xs" (click)="archive(w)" title="Archiver"><cap-icon name="archive" [size]="14" /></button> }
                @else { <button class="btn-ghost !py-1 text-xs" (click)="unarchive(w)">Désarchiver</button> }
                <button class="btn-ghost !py-1 text-xs text-red-600" (click)="remove(w)" title="Supprimer"><cap-icon name="trash" [size]="14" /></button>
              }
            </div>
          } @empty { <p class="px-4 py-4 text-sm text-stone-500">Aucun workspace sur ce projet.</p> }
        </div>
        <cap-project-environment [projectId]="p.id" />
      }
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class ProjectDetailPage implements OnInit {
  readonly projectId = input.required<string>();
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  protected readonly project = signal<ProjectDto | null>(null);
  protected readonly workspaces = signal<WorkspaceDto[]>([]);
  protected readonly busy = signal(false);
  protected name = '';
  protected branch = '';

  async ngOnInit() {
    this.project.set(await this.api.get<ProjectDto>(`/projects/${this.projectId()}`));
    this.workspaces.set(await this.api.get<WorkspaceDto[]>('/workspaces', { projectId: this.projectId() }));
  }

  protected async create() {
    this.busy.set(true);
    try {
      const w = await this.api.post<WorkspaceDto>('/workspaces', { projectId: this.projectId(), name: this.name, branch: this.branch || undefined });
      await this.router.navigate(['/workspaces', w.id]);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
  protected async archive(w: WorkspaceDto) {
    await this.act(() => this.api.post(`/workspaces/${w.id}/archive`));
  }
  protected async unarchive(w: WorkspaceDto) {
    await this.act(() => this.api.post(`/workspaces/${w.id}/unarchive`));
  }
  protected async remove(w: WorkspaceDto) {
    if (!confirm(`Supprimer définitivement « ${w.name} » (fichiers, conversation, sauvegardes) ?`)) return;
    await this.act(() => this.api.delete(`/workspaces/${w.id}`));
  }
  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
