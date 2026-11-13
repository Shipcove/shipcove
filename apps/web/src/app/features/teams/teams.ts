import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { TeamDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'cap-teams',
  imports: [RouterLink, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-4xl px-6 py-8">
      <div class="flex items-center"><h1 class="text-2xl font-semibold">Équipes</h1></div>
      @if (auth.isAdmin()) {
        <form class="card mt-4 flex flex-wrap items-end gap-2 p-4" (ngSubmit)="create()">
          <div><label class="label" for="tn">Nom</label><input id="tn" class="input" name="name" [(ngModel)]="name" required /></div>
          <div><label class="label" for="ts">Identifiant</label><input id="ts" class="input" name="slug" [(ngModel)]="slug" pattern="[a-z0-9-]+" required /></div>
          <button class="btn-primary">Créer l’équipe</button>
        </form>
      }
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        @for (t of teams(); track t.id) {
          <a [routerLink]="['/teams', t.id]" class="card p-4 hover:border-accent-500">
            <div class="font-medium">{{ t.name }}</div>
            <div class="text-xs text-stone-500">{{ t.memberCount }} membre(s) · {{ t.projectCount }} projet(s) · {{ t.myRole === 'team_admin' ? 'administrateur' : 'membre' }}</div>
          </a>
        } @empty { <p class="text-sm text-stone-500">Vous n’appartenez à aucune équipe. Demandez une invitation à un administrateur.</p> }
      </div>
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class TeamsPage implements OnInit {
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly teams = signal<TeamDto[]>([]);
  protected name = '';
  protected slug = '';
  async ngOnInit() {
    this.teams.set(await this.api.get<TeamDto[]>('/teams'));
  }
  protected async create() {
    try {
      await this.api.post('/teams', { name: this.name, slug: this.slug });
      this.name = this.slug = '';
      await this.ngOnInit();
      await this.auth.load();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
