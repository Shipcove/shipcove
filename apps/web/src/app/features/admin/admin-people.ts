import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AdminUserDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AgoPipe } from '../../shared/pipes';

@Component({
  selector: 'cap-admin-users',
  imports: [FormsModule, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Utilisateurs</h1>
    <div class="mt-3 flex gap-2"><input class="input !w-72" placeholder="Rechercher…" [(ngModel)]="q" (ngModelChange)="load()" name="q" /></div>
    <div class="card mt-3 overflow-x-auto"><table class="table">
      <thead><tr><th>Utilisateur</th><th>Rôle</th><th>Statut</th><th>MFA</th><th>Dernière connexion</th><th>Identités</th><th></th></tr></thead>
      <tbody>@for (u of users(); track u.id) {
        <tr>
          <td><div class="font-medium">{{ u.displayName }}</div><div class="text-xs text-stone-500">{{ u.email }} · {{ u.username }}</div></td>
          <td><select class="input !w-auto !py-0.5 text-xs" [ngModel]="u.platformRole" (ngModelChange)="update(u, { platformRole: $event })" [name]="'r' + u.id"><option value="user">Utilisateur</option><option value="platform_admin">Admin plateforme</option></select></td>
          <td>{{ u.status }}</td>
          <td>{{ u.mfaEnabled ? 'oui' : 'non' }}</td>
          <td class="text-xs">{{ u.lastLoginAt | ago }}</td>
          <td class="text-xs">@for (i of u.identities; track i.subject) { <div>{{ i.provider }}</div> }</td>
          <td class="space-x-1 text-right whitespace-nowrap">
            @if (u.status === 'active') { <button class="btn-ghost !py-0.5 text-xs" (click)="update(u, { status: 'suspended' })">Suspendre</button> }
            @else if (u.status === 'suspended') { <button class="btn-ghost !py-0.5 text-xs" (click)="update(u, { status: 'active' })">Réactiver</button> }
            <button class="btn-ghost !py-0.5 text-xs" (click)="post(u, 'revoke-sessions')">Sessions</button>
            @if (u.mfaEnabled) { <button class="btn-ghost !py-0.5 text-xs" (click)="post(u, 'reset-mfa')">Réinit. MFA</button> }
            <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(u)">Supprimer</button>
          </td>
        </tr>
      }</tbody>
    </table></div>
    <form class="card mt-4 grid gap-2 p-4 md:grid-cols-5" (ngSubmit)="create()">
      <div class="font-medium md:col-span-5">Créer un compte local</div>
      <input class="input" name="e" type="email" placeholder="email" [(ngModel)]="form.email" required />
      <input class="input" name="u" placeholder="identifiant" [(ngModel)]="form.username" required />
      <input class="input" name="d" placeholder="nom affiché" [(ngModel)]="form.displayName" required />
      <select class="input" name="ro" [(ngModel)]="form.platformRole"><option value="user">Utilisateur</option><option value="platform_admin">Admin</option></select>
      <button class="btn-primary">Créer (lien envoyé)</button>
    </form>
  `,
})
export class AdminUsers implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly users = signal<AdminUserDto[]>([]);
  protected q = '';
  protected form = { email: '', username: '', displayName: '', platformRole: 'user' };
  async ngOnInit() {
    await this.load();
  }
  async load() {
    this.users.set(await this.api.get<AdminUserDto[]>('/admin/users', { q: this.q }));
  }
  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected update(u: AdminUserDto, body: object) {
    return this.act(() => this.api.patch(`/admin/users/${u.id}`, body));
  }
  protected post(u: AdminUserDto, action: string) {
    return this.act(() => this.api.post(`/admin/users/${u.id}/${action}`));
  }
  protected remove(u: AdminUserDto) {
    if (confirm(`Supprimer ${u.email} ? Ses workspaces seront supprimés.`)) return this.act(() => this.api.delete(`/admin/users/${u.id}`));
    return;
  }
  protected create() {
    return this.act(() => this.api.post('/admin/users', this.form));
  }
}

@Component({
  selector: 'cap-admin-teams',
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Équipes</h1>
    <p class="text-sm text-stone-500">Les administrateurs d’équipe gèrent les membres. Le contenu des conversations privées n’est jamais accessible depuis l’administration.</p>
    <div class="card mt-3 overflow-x-auto"><table class="table">
      <thead><tr><th>Équipe</th><th>Membres</th><th>Projets</th><th></th></tr></thead>
      <tbody>@for (t of teams(); track t['id']) {
        <tr><td><a [routerLink]="['/teams', t['id']]" class="font-medium hover:underline">{{ t['name'] }}</a> <span class="text-xs text-stone-500">{{ t['slug'] }}</span></td><td>{{ t['members'] }}</td><td>{{ t['projects'] }}</td>
        <td class="text-right"><button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(t['id'])">Supprimer</button></td></tr>
      }</tbody>
    </table></div>
  `,
})
export class AdminTeams implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly teams = signal<Array<Record<string, string>>>([]);
  async ngOnInit() {
    this.teams.set(await this.api.get('/admin/teams'));
  }
  protected async remove(id: string) {
    if (!confirm('Supprimer cette équipe ?')) return;
    await this.api.delete(`/admin/teams/${id}`).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
}
