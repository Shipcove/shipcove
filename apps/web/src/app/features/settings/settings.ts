import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AuthProviderPublic, AuthProvidersResponse, GitConnectionDto, GitForgesPublicDto, LinkedIdentityDto, SessionInfo } from '@cap/contracts';
import { SSO_ERRORS } from '../auth/login';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { AgoPipe } from '../../shared/pipes';
import { t } from '../../core/i18n';

type Tab = 'profile' | 'security' | 'git';

@Component({
  selector: 'cap-settings',
  imports: [FormsModule, RouterLink, Icon, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-3xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 class="text-2xl font-semibold">{{ t('Paramètres') }}</h1>
      <nav class="mt-4 flex gap-1 overflow-x-auto border-b border-stone-200 dark:border-stone-800">
        @for (tb of tabs; track tb.id) {
          <button class="shrink-0 px-3 py-2 text-sm whitespace-nowrap" [class]="current() === tb.id ? 'border-b-2 border-accent-600 font-medium' : 'text-stone-500'" (click)="current.set(tb.id)">{{ tb.label }}</button>
        }
      </nav>
      @switch (current()) {
        @case ('profile') {
          <div class="card mt-4 space-y-1 p-4 text-sm">
            <div><span class="text-stone-500">{{ t('Nom :') }}</span> {{ auth.me()?.displayName }}</div>
            <div><span class="text-stone-500">{{ t('Identifiant :') }}</span> {{ auth.me()?.username }}</div>
            <div><span class="text-stone-500">{{ t('Email :') }}</span> {{ auth.me()?.email }} @if (!auth.me()?.emailVerified) { <span class="text-amber-600">{{ t('(non vérifié)') }}</span> }</div>
            <div><span class="text-stone-500">{{ t('Rôle :') }}</span> {{ auth.me()?.platformRole === 'platform_admin' ? t('Administrateur plateforme') : t('Utilisateur') }}</div>
          </div>
        }
        @case ('security') {
          <form class="card mt-4 space-y-2 p-4" (ngSubmit)="changePassword()">
            <div class="font-medium">{{ t('Changer le mot de passe') }}</div>
            <input class="input" type="password" name="cur" autocomplete="current-password" [placeholder]="t('Mot de passe actuel')" [(ngModel)]="currentPassword" />
            <input class="input" type="password" name="new" autocomplete="new-password" [placeholder]="t('Nouveau mot de passe (12 caractères min.)')" [(ngModel)]="newPassword" />
            <button class="btn-primary">{{ t('Enregistrer') }}</button>
          </form>
          <div class="card mt-4 p-4">
            <div class="font-medium">{{ t('Double authentification (TOTP)') }}</div>
            @if (auth.me()?.mfaEnabled) {
              <p class="mt-1 text-sm text-emerald-700">{{ t('Activée.') }}</p>
              <div class="mt-2 flex flex-wrap gap-2">
                <button class="btn-secondary" (click)="regenerate()">{{ t('Régénérer les codes de récupération') }}</button>
                <input class="input !w-56" type="password" name="mfapw" [placeholder]="t('Mot de passe pour désactiver')" [(ngModel)]="disablePassword" />
                <button class="btn-secondary text-red-600" (click)="disableMfa()">{{ t('Désactiver') }}</button>
              </div>
              @if (codes().length) { <div class="mt-3 grid grid-cols-2 gap-1 rounded bg-stone-100 p-2 font-mono text-sm dark:bg-stone-800">@for (c of codes(); track c) { <span>{{ c }}</span> }</div> }
            } @else {
              <p class="mt-1 text-sm text-stone-500">{{ t('Non activée.') }}</p>
              <a routerLink="/auth/mfa-enroll" [queryParams]="{ next: '/settings' }" class="btn-primary mt-2">{{ t('Activer') }}</a>
            }
          </div>
          <div class="card mt-4 p-4" [attr.aria-label]="t('Identités de connexion')">
            <div class="font-medium">{{ t('Identités de connexion') }}</div>
            <p class="mt-1 text-sm text-stone-500">{{ t('Comptes d’entreprise ou Git permettant de vous connecter. Un compte n’est jamais associé automatiquement par son adresse email : rattachez-le ici.') }}</p>
            @for (i of identities(); track i.id) {
              <div class="mt-2 flex items-center gap-2 border-t border-stone-100 pt-2 text-sm dark:border-stone-800">
                <div class="min-w-0 flex-1"><div class="font-medium">{{ i.provider }} <span class="text-xs font-normal text-stone-500">{{ typeLabel(i.type) }}</span></div>
                  <div class="text-xs text-stone-500">{{ i.email ?? '—' }} · {{ i.lastLoginAt ? t('dernière connexion {when}', { when: (i.lastLoginAt | ago) }) : t('jamais utilisée') }}</div></div>
                <button class="btn-ghost text-xs text-red-600" (click)="unlink(i)">{{ t('Retirer') }}</button>
              </div>
            } @empty { <p class="mt-2 text-sm text-stone-500">{{ t('Aucune identité externe rattachée.') }}</p> }
            @if (linkable().length) {
              <div class="mt-3 flex flex-wrap gap-2">
                @for (p of linkable(); track p.id) { <a class="btn-secondary" [href]="linkUrl(p)">{{ t('Rattacher {name}', { name: p.name }) }}</a> }
              </div>
            }
          </div>
          <div class="card mt-4 p-4">
            <div class="flex items-center"><div class="font-medium">{{ t('Sessions actives') }}</div><button class="btn-ghost ml-auto text-xs" (click)="revokeOthers()">{{ t('Fermer les autres sessions') }}</button></div>
            @for (s of sessions(); track s.id) {
              <div class="flex items-center gap-2 border-t border-stone-100 py-2 text-sm dark:border-stone-800">
                <div class="min-w-0 flex-1"><div class="truncate">{{ s.userAgent ?? t('Navigateur inconnu') }}</div><div class="text-xs text-stone-500">{{ s.ip }} · {{ s.authMethod }} · {{ t('vue {when}', { when: (s.lastSeenAt | ago) }) }}</div></div>
                @if (s.current) { <span class="badge bg-emerald-100 text-emerald-800">{{ t('Actuelle') }}</span> } @else { <button class="btn-ghost text-xs" (click)="revoke(s)">{{ t('Révoquer') }}</button> }
              </div>
            }
          </div>
        }
        @case ('git') {
          <p class="mt-4 text-sm text-stone-500">{{ t('Rattachez vos comptes GitHub / GitLab, indépendamment de votre méthode de connexion. Les jetons sont conservés dans Vault, renouvelés automatiquement et ne sont jamais transmis aux sandboxes.') }}</p>
          <div class="card mt-4 divide-y divide-stone-100 dark:divide-stone-800" [attr.aria-label]="t('Connexions Git')">
            @for (c of connections(); track c.id) {
              <div class="flex items-center gap-2 px-4 py-3 text-sm"><cap-icon name="git" /><span class="font-medium">{{ c.accountLogin }}</span>
                <span class="text-stone-500">{{ c.host }}</span>
                @if (c.status !== 'active') { <span class="badge bg-amber-100 text-amber-800">{{ c.status === 'expired' ? t('expirée') : c.status }}</span> }
                <span class="ml-auto flex gap-1">
                  @if (c.status !== 'active' && forgeFor(c.host); as f) { <a class="btn-ghost text-xs" [href]="oauthUrl(f.id)">{{ t('Reconnecter') }}</a> }
                  <button class="btn-ghost text-xs text-red-600" (click)="removeConnection(c)">{{ t('Détacher') }}</button>
                </span></div>
            } @empty { <p class="px-4 py-3 text-sm text-stone-500">{{ t('Aucune connexion Git.') }}</p> }
          </div>
          @if (forges().length) {
            <div class="mt-3 flex flex-wrap gap-2">@for (f of forges(); track f.id) { <a class="btn-secondary" [href]="oauthUrl(f.id)"><cap-icon name="git" /> {{ t('Connecter via {name}', { name: f.name }) }}</a> }</div>
          } @else {
            <p class="mt-3 text-sm text-stone-500">{{ t('Aucune forge n’est configurée : demandez à un administrateur d’ajouter GitHub ou GitLab (Administration → Forges Git).') }}</p>
          }
          @if (allowPat()) {
            <form class="card mt-4 grid gap-2 p-4 md:grid-cols-3" (ngSubmit)="addToken()">
              <div class="font-medium md:col-span-3">{{ t('Ajouter un jeton d’accès personnel') }}</div>
              <select class="input" name="prov" [(ngModel)]="provider"><option value="github">GitHub.com</option><option value="github_enterprise">GitHub Enterprise</option><option value="gitlab">GitLab.com</option><option value="gitlab_self_managed">GitLab self-managed</option></select>
              <input class="input" name="host" [placeholder]="t('Hôte (self-hosted)')" [(ngModel)]="host" [disabled]="provider === 'github' || provider === 'gitlab'" />
              <input class="input" type="password" name="tok" [placeholder]="t('Jeton')" [(ngModel)]="token" />
              <button class="btn-primary md:col-span-3 md:w-fit">{{ t('Rattacher') }}</button>
            </form>
          }
        }
      }
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class SettingsPage implements OnInit {
  protected readonly t = t;
  readonly tab = input<Tab>();
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly tabs: Array<{ id: Tab; label: string }> = [
    { id: 'profile', label: t('Profil') },
    { id: 'security', label: t('Sécurité') },
    { id: 'git', label: t('Connexions Git') },
  ];
  protected readonly current = signal<Tab>('profile');
  protected readonly sessions = signal<SessionInfo[]>([]);
  protected readonly connections = signal<GitConnectionDto[]>([]);
  protected readonly forges = signal<GitForgesPublicDto['forges']>([]);
  protected readonly allowPat = signal(false);
  protected readonly codes = signal<string[]>([]);
  protected readonly identities = signal<LinkedIdentityDto[]>([]);
  /** Fournisseurs à redirection activés (LDAP : connexion directe, pas de rattachement par redirection). */
  protected readonly linkable = signal<AuthProviderPublic[]>([]);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected currentPassword = '';
  protected newPassword = '';
  protected disablePassword = '';
  protected provider = 'github';
  protected host = '';
  protected token = '';

  async ngOnInit() {
    if (this.tab()) this.current.set(this.tab()!);
    this.sessions.set(await this.api.get<SessionInfo[]>('/auth/sessions'));
    this.connections.set(await this.api.get<GitConnectionDto[]>('/me/git-connections'));
    const git = await this.api.get<GitForgesPublicDto>('/me/git-connections/oauth/providers').catch(() => null);
    this.forges.set(git?.forges ?? []);
    this.allowPat.set(git?.allowPersonalTokens ?? false);
    this.identities.set(await this.api.get<LinkedIdentityDto[]>('/auth/identities').catch(() => []));
    const providers = await this.api.get<AuthProvidersResponse>('/auth/providers').catch(() => null);
    const linked = new Set(this.identities().map((i) => i.providerId));
    this.linkable.set((providers?.providers ?? []).filter((p) => p.startUrl && !linked.has(p.id)));
    const q = this.route.snapshot.queryParamMap;
    // Retour d'un rattachement de compte Git (OAuth).
    if (q.get('git_linked') || q.get('git_error')) {
      this.current.set('git');
      if (q.get('git_linked')) this.toast.show(t('Compte Git rattaché'), 'success');
      else this.toast.show(GIT_ERRORS[q.get('git_error')!] ?? GIT_ERRORS['failed'], 'error', 8000);
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
    // Retour d'un rattachement SSO.
    if (q.get('linked') || q.get('sso_error')) {
      this.current.set('security');
      if (q.get('linked')) this.toast.show(t('Identité rattachée à votre compte'), 'success');
      else this.toast.show(SSO_ERRORS[q.get('sso_error')!] ?? SSO_ERRORS['sso_failed'], 'error', 8000);
      void this.router.navigate([], { queryParams: { tab: 'security' }, replaceUrl: true });
    }
  }

  protected oauthUrl(forgeId: string): string {
    return `/api/v1/me/git-connections/oauth/${forgeId}/start?returnTo=${encodeURIComponent('/settings/git')}`;
  }
  protected forgeFor(host: string) {
    return this.forges().find((f) => f.host === host) ?? null;
  }
  protected linkUrl(p: AuthProviderPublic): string {
    return `${p.startUrl}?link=1&returnTo=${encodeURIComponent('/settings?tab=security')}`;
  }
  protected typeLabel(type: string): string {
    return ({ oidc: 'OIDC', saml: 'SAML', ldap: t('Annuaire LDAP'), github: 'GitHub', gitlab: 'GitLab' } as Record<string, string>)[type] ?? type;
  }
  protected unlink(i: LinkedIdentityDto) {
    if (!confirm(t('Retirer l’identité {name} ?', { name: i.provider }))) return;
    return this.act(() => this.api.delete(`/auth/identities/${i.id}`), t('Identité retirée'));
  }

  private async act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) this.toast.show(ok, 'success');
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected changePassword() {
    return this.act(() => this.api.post('/auth/password/change', { currentPassword: this.currentPassword, newPassword: this.newPassword }), t('Mot de passe modifié'));
  }
  protected async regenerate() {
    try {
      this.codes.set((await this.api.post<{ codes: string[] }>('/auth/mfa/recovery-codes')).codes);
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected async disableMfa() {
    await this.act(() => this.api.post('/auth/mfa/disable', { password: this.disablePassword }), t('Double authentification désactivée'));
    await this.auth.load();
  }
  protected revoke(s: SessionInfo) {
    return this.act(() => this.api.delete(`/auth/sessions/${s.id}`));
  }
  protected revokeOthers() {
    return this.act(() => this.api.post('/auth/sessions/revoke-others'), t('Autres sessions fermées'));
  }
  protected async addToken() {
    await this.act(() => this.api.post('/me/git-connections/token', { provider: this.provider, host: this.host || 'github.com', token: this.token }), t('Compte rattaché'));
    this.token = '';
  }
  protected removeConnection(c: GitConnectionDto) {
    return this.act(() => this.api.delete(`/me/git-connections/${c.id}`));
  }
}

const GIT_ERRORS: Record<string, string> = {
  denied: t('Autorisation refusée sur la forge.'),
  expired: t('La demande de connexion a expiré ou a déjà été utilisée. Recommencez.'),
  forge_unavailable: t('Cette forge n’est plus disponible.'),
  forge_error: t('La forge n’a pas pu être contactée ou a refusé l’échange. Réessayez ou contactez votre administrateur.'),
  account_conflict: t('Ce compte est déjà rattaché.'),
  failed: t('Le rattachement du compte Git a échoué.'),
};
