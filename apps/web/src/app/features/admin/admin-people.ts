import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AdminUserDto, InvitationDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AgoPipe } from '../../shared/pipes';

@Component({
  selector: 'cap-admin-users',
  imports: [FormsModule, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Utilisateurs</h1>
    <div class="mt-3 flex gap-2"><input class="input sm:!w-72" placeholder="Rechercher…" [(ngModel)]="q" (ngModelChange)="load()" name="q" /></div>
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

/** Invitations à rejoindre la plateforme : lien d'inscription envoyé par email, valable 7 jours. */
@Component({
  selector: 'cap-admin-invitations',
  imports: [FormsModule, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Invitations</h1>
    <p class="text-sm text-stone-500">La personne invitée reçoit un lien d’inscription valable 7 jours, même si l’inscription libre est désactivée.</p>
    <form class="mt-3 flex gap-2" (ngSubmit)="invite()">
      <input class="input min-w-0 sm:!w-80" type="email" name="email" placeholder="adresse@exemple.com" [(ngModel)]="email" required aria-label="Email à inviter" />
      <button class="btn-primary" [disabled]="!email.trim()">Inviter</button>
    </form>
    <div class="card mt-3 overflow-x-auto"><table class="table">
      <thead><tr><th>Email</th><th>Envoyée</th><th>État</th><th></th></tr></thead>
      <tbody>@for (i of invitations(); track i.id) {
        <tr>
          <td>{{ i.email }}</td>
          <td class="text-xs">{{ i.createdAt | ago }}</td>
          <td class="text-xs">{{ i.acceptedAt ? 'acceptée' : expired(i.expiresAt) ? 'expirée' : 'en attente' }}</td>
          <td class="text-right">@if (!i.acceptedAt) { <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="revoke(i.id)">Révoquer</button> }</td>
        </tr>
      } @empty { <tr><td colspan="4" class="text-sm text-stone-500">Aucune invitation.</td></tr> }</tbody>
    </table></div>
  `,
})
export class AdminInvitations implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly invitations = signal<InvitationDto[]>([]);
  protected email = '';
  async ngOnInit() {
    this.invitations.set(await this.api.get<InvitationDto[]>('/admin/invitations'));
  }
  protected expired(at: string) {
    return new Date(at).getTime() < Date.now();
  }
  protected async invite() {
    try {
      await this.api.post('/admin/invitations', { email: this.email.trim() });
      this.toast.show('Invitation envoyée', 'success');
      this.email = '';
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected async revoke(id: string) {
    await this.api.delete(`/admin/invitations/${id}`).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
}
