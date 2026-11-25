import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AuthProviderPublic, AuthProvidersResponse } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { AuthLayout } from './auth-layout';
import { t, tr } from '../../core/i18n';

@Component({
  selector: 'cap-login',
  imports: [FormsModule, RouterLink, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout [title]="t('Connexion')" [subtitle]="t('Plateforme de coding agents')">
      @if (error()) { <div class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">{{ error() }}</div> }
      @if (providers()?.localEnabled !== false) {
        <form (ngSubmit)="submit()" class="space-y-4">
          <div>
            <label class="label" for="login">{{ t('Email ou identifiant') }}</label>
            <input id="login" class="input" name="login" autocomplete="username" [(ngModel)]="login" required />
          </div>
          <div>
            <label class="label" for="password">{{ t('Mot de passe') }}</label>
            <input id="password" class="input" type="password" name="password" autocomplete="current-password" [(ngModel)]="password" required />
          </div>
          <button class="btn-primary w-full" [disabled]="busy()">{{ busy() ? t('Connexion…') : t('Se connecter') }}</button>
          <div class="flex justify-between text-xs">
            <a routerLink="/auth/forgot-password" class="text-stone-500 hover:underline">{{ t('Mot de passe oublié ?') }}</a>
            @if (providers()?.registrationEnabled) { <a routerLink="/auth/register" class="text-stone-500 hover:underline">{{ t('Créer un compte') }}</a> }
          </div>
        </form>
      }
      @if (providers()?.providers?.length) {
        <div class="my-4 flex items-center gap-2 text-xs text-stone-400"><div class="h-px flex-1 bg-stone-200 dark:bg-stone-800"></div>{{ t('ou') }}<div class="h-px flex-1 bg-stone-200 dark:bg-stone-800"></div></div>
        <div class="space-y-2">
          @for (p of providers()!.providers; track p.id) {
            @if (p.type === 'ldap') {
              <button class="btn-secondary w-full" (click)="ldap.set(p.id)">{{ t('Annuaire : {name}', { name: p.name }) }}</button>
            } @else {
              <a class="btn-secondary w-full" [href]="ssoUrl(p)">{{ t('Continuer avec {name}', { name: p.name }) }}</a>
            }
          }
        </div>
        @if (ldap()) {
          <form (ngSubmit)="submitLdap()" class="mt-4 space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800">
            <input id="ldap-login" class="input" name="lu" [placeholder]="t('Identifiant annuaire')" autocomplete="username" [attr.aria-label]="t('Identifiant annuaire')" [(ngModel)]="login" />
            <input id="ldap-password" class="input" name="lp" type="password" [placeholder]="t('Mot de passe annuaire')" autocomplete="current-password" [attr.aria-label]="t('Mot de passe annuaire')" [(ngModel)]="password" />
            <button class="btn-primary w-full" [disabled]="busy()">{{ t('Se connecter via l’annuaire') }}</button>
          </form>
        }
      }
    </cap-auth-layout>
  `,
})
export class LoginPage implements OnInit {
  protected readonly t = t;
  private readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected login = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly providers = signal<AuthProvidersResponse | null>(null);
  protected readonly ldap = signal<string | null>(null);

  async ngOnInit() {
    this.providers.set(await this.auth.providers().catch(() => null));
    const err = this.route.snapshot.queryParamMap.get('error');
    if (err) this.error.set(err);
    const sso = this.route.snapshot.queryParamMap.get('sso_error');
    if (sso) this.error.set(SSO_ERRORS[sso] ?? SSO_ERRORS['sso_failed']);
  }

  /** Démarrage SSO avec retour vers la page demandée. */
  protected ssoUrl(p: AuthProviderPublic): string {
    return `${p.startUrl}?returnTo=${encodeURIComponent(this.next())}`;
  }

  private next(): string {
    const n = this.route.snapshot.queryParamMap.get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : '/';
  }

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.auth.login(this.login, this.password);
      await this.afterLogin(r.status);
    } catch (err) {
      this.error.set(err instanceof ApiError ? tr(err.message) : t('Connexion impossible'));
    } finally {
      this.busy.set(false);
    }
  }

  async submitLdap() {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ status: string }>('/auth/ldap/login', { providerId: this.ldap(), username: this.login, password: this.password });
      if (r.status === 'authenticated') await this.auth.load();
      await this.afterLogin(r.status);
    } catch (err) {
      this.error.set(err instanceof ApiError ? tr(err.message) : t('Connexion impossible'));
    } finally {
      this.busy.set(false);
    }
  }

  private async afterLogin(status: string) {
    if (status === 'mfa_required') await this.router.navigate(['/auth/mfa'], { queryParams: { next: this.next() } });
    else if (status === 'mfa_enrollment_required') await this.router.navigate(['/auth/mfa-enroll'], { queryParams: { next: this.next() } });
    else await this.router.navigateByUrl(this.next());
  }
}

/** Codes d'échec SSO renvoyés par l'API (jamais de détail technique dans l'URL). */
export const SSO_ERRORS: Record<string, string> = {
  sso_failed: t('La connexion via le fournisseur d’identité a échoué. Réessayez ou contactez votre administrateur.'),
  sso_expired: t('La demande de connexion a expiré ou a déjà été utilisée. Recommencez.'),
  sso_denied: t('Le fournisseur d’identité a refusé la connexion.'),
  provider_disabled: t('Ce fournisseur d’identité est désactivé.'),
  email_unverified: t('Votre fournisseur d’identité n’atteste pas votre adresse email : vérifiez-la chez lui, ou demandez à votre administrateur de vous créer un compte.'),
  account_exists: t('Un compte utilise déjà cette adresse email. Connectez-vous avec ce compte puis rattachez cette identité depuis vos paramètres.'),
  account_suspended: t('Ce compte est suspendu.'),
  email_missing: t('Le fournisseur ne transmet pas d’adresse email : impossible de créer le compte.'),
  provisioning_disabled: t('Aucun compte n’est associé à cette identité et la création automatique est désactivée. Contactez votre administrateur.'),
  mfa_required_by_idp: t('Une authentification multifacteur auprès du fournisseur est exigée.'),
  not_allowed: t('Votre compte n’est pas autorisé à se connecter (organisation ou groupe non autorisé).'),
  identity_linked_elsewhere: t('Cette identité est déjà rattachée à un autre compte.'),
};
