import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { InvitationDto, TeamDto, TeamMemberDto, UserSummaryDto, EnvVarDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/toast.service';
import { AgoPipe } from '../../shared/pipes';
import { EnvVarsEditor } from '../projects/project-environment';

@Component({
  selector: 'cap-team-detail',
  imports: [FormsModule, AgoPipe, EnvVarsEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-4xl px-6 py-8">
      <h1 class="text-2xl font-semibold">{{ team()?.name }}</h1>
      <p class="text-sm text-stone-500">{{ team()?.description }}</p>
      <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">Membres</h2>
      <div class="card overflow-hidden">
        <table class="table">
          <thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th></th></tr></thead>
          <tbody>
            @for (m of members(); track m.userId) {
              <tr>
                <td>{{ m.displayName }}</td><td class="text-stone-500">{{ m.username }}</td>
                <td>
                  @if (isAdmin()) {
                    <select class="input !w-auto !py-0.5 text-xs" [ngModel]="m.role" (ngModelChange)="setRole(m, $event)" [name]="'r' + m.userId">
                      <option value="member">Membre</option><option value="team_admin">Administrateur</option>
                    </select>
                  } @else { {{ m.role === 'team_admin' ? 'Administrateur' : 'Membre' }} }
                </td>
                <td class="text-right">@if (isAdmin() || m.userId === auth.me()?.id) { <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(m)">{{ m.userId === auth.me()?.id ? 'Quitter' : 'Retirer' }}</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (isAdmin()) {
        <div class="mt-6 grid gap-4 md:grid-cols-2">
          <div class="card p-4">
            <div class="mb-2 font-medium">Ajouter un utilisateur existant</div>
            <input class="input" placeholder="Rechercher…" [(ngModel)]="q" (ngModelChange)="search()" name="q" />
            @for (u of results(); track u.id) {
              <button class="mt-1 flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" (click)="add(u)">{{ u.displayName }} <span class="text-stone-500">&#64;{{ u.username }}</span></button>
            }
          </div>
          <form class="card space-y-2 p-4" (ngSubmit)="invite()">
            <div class="font-medium">Inviter par email</div>
            <input class="input" type="email" name="email" placeholder="collegue@exemple.com" [(ngModel)]="email" required />
            <select class="input" name="role" [(ngModel)]="role"><option value="member">Membre</option><option value="team_admin">Administrateur</option></select>
            <button class="btn-primary">Envoyer l’invitation</button>
          </form>
        </div>
        <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">Invitations</h2>
        <div class="card divide-y divide-stone-100 dark:divide-stone-800">
          @for (i of invitations(); track i.id) {
            <div class="flex items-center gap-2 px-4 py-2 text-sm"><span>{{ i.email }}</span><span class="text-stone-500">{{ i.acceptedAt ? 'acceptée' : 'expire ' + (i.expiresAt | ago) }}</span>
              @if (!i.acceptedAt) { <button class="btn-ghost ml-auto !py-0.5 text-xs" (click)="revokeInvite(i)">Révoquer</button> }</div>
          } @empty { <p class="px-4 py-3 text-sm text-stone-500">Aucune invitation.</p> }
        </div>
      }
      <h2 class="mt-6 mb-1 text-sm font-semibold text-stone-500 uppercase">Variables et secrets de l’équipe</h2>
      <p class="mb-2 text-xs text-stone-500">Injectés dans les sandboxes de tous les projets de l’équipe (une variable de projet du même nom l’emporte). Secrets conservés dans Vault, jamais réaffichés, masqués dans les sorties.</p>
      <cap-env-vars [endpoint]="'/teams/' + teamId() + '/environment/variables'" [variables]="envVars()" [canManage]="isAdmin()" label="Variables de l’équipe" (changed)="loadEnv()" />
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class TeamDetailPage implements OnInit {
  readonly teamId = input.required<string>();
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly team = signal<TeamDto | null>(null);
  protected readonly members = signal<TeamMemberDto[]>([]);
  protected readonly invitations = signal<InvitationDto[]>([]);
  protected readonly results = signal<UserSummaryDto[]>([]);
  protected readonly envVars = signal<EnvVarDto[]>([]);
  protected readonly isAdmin = computed(() => this.team()?.myRole === 'team_admin' || this.auth.isAdmin());
  protected q = '';
  protected email = '';
  protected role: 'member' | 'team_admin' = 'member';

  async ngOnInit() {
    const id = this.teamId();
    this.team.set(await this.api.get<TeamDto>(`/teams/${id}`));
    this.members.set(await this.api.get<TeamMemberDto[]>(`/teams/${id}/members`));
    if (this.isAdmin()) this.invitations.set(await this.api.get<InvitationDto[]>(`/teams/${id}/invitations`).catch(() => []));
    await this.loadEnv();
  }
  async loadEnv() {
    this.envVars.set(await this.api.get<EnvVarDto[]>(`/teams/${this.teamId()}/environment/variables`).catch(() => []));
  }
  protected async search() {
    if (this.q.length < 2) return this.results.set([]);
    this.results.set(await this.api.get<UserSummaryDto[]>(`/users/search/${this.teamId()}/${encodeURIComponent(this.q)}`).catch(() => []));
  }
  protected async add(u: UserSummaryDto) {
    await this.run(() => this.api.post(`/teams/${this.teamId()}/members`, { userId: u.id, role: 'member' }));
    this.results.set([]);
    this.q = '';
  }
  protected setRole(m: TeamMemberDto, role: string) {
    return this.run(() => this.api.patch(`/teams/${this.teamId()}/members/${m.userId}`, { role }));
  }
  protected remove(m: TeamMemberDto) {
    return this.run(() => this.api.delete(`/teams/${this.teamId()}/members/${m.userId}`));
  }
  protected async invite() {
    await this.run(() => this.api.post(`/teams/${this.teamId()}/invitations`, { email: this.email, role: this.role }));
    this.email = '';
  }
  protected revokeInvite(i: InvitationDto) {
    return this.run(() => this.api.delete(`/teams/${this.teamId()}/invitations/${i.id}`));
  }
  private async run(fn: () => Promise<unknown>) {
    try {
      await fn();
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
