import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import type { AuthProviderAdminDto } from '@cap/contracts';
import { SettingsSection } from './settings-section';
import { t, tr } from '../../core/i18n';

const TEMPLATES: Record<string, object> = {
  oidc: { issuer: 'https://keycloak.exemple.com/realms/entreprise', clientId: 'shipcove', scopes: ['openid', 'profile', 'email'], usernameClaim: 'preferred_username', emailClaim: 'email', nameClaim: 'name', mfa: 'auto', requireVerifiedEmail: false },
  saml: { entryPoint: 'https://idp.exemple.com/realms/entreprise/protocol/saml', issuer: 'shipcove', idpCert: 'MIIC…', emailAttribute: 'email', nameAttribute: 'displayName', usernameAttribute: 'username', wantAssertionsSigned: true, wantAuthnResponseSigned: false, mfa: 'auto' },
  ldap: { url: 'ldaps://ldap.exemple.com', bindDn: 'cn=svc,dc=exemple,dc=com', searchBase: 'ou=people,dc=exemple,dc=com', searchFilter: '(|(uid={{username}})(sAMAccountName={{username}}))', usernameAttribute: 'uid', emailAttribute: 'mail', nameAttribute: 'cn', startTls: false, tlsRejectUnauthorized: true },
  github: { host: 'github.com', clientId: '', allowLogin: true, allowedOrganizations: [] },
  gitlab: { host: 'gitlab.com', clientId: '', allowLogin: true, allowedGroups: [], requireVerifiedEmail: false },
};

/** Champ secret par type (écrit dans Vault, jamais relu par l'interface). */
const SECRET_FIELD: Record<string, { key: string; label: string; multiline?: boolean }> = {
  oidc: { key: 'clientSecret', label: t('Secret client (vide pour un client public)') },
  saml: { key: 'privateKey', label: t('Clé privée PEM de signature des requêtes (facultatif)'), multiline: true },
  ldap: { key: 'bindPassword', label: t('Mot de passe du compte de service') },
  github: { key: 'clientSecret', label: t('Secret client OAuth') },
  gitlab: { key: 'clientSecret', label: t('Secret client OAuth') },
};

@Component({
  selector: 'cap-admin-iam',
  imports: [FormsModule, SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('IAM & connexion') }}</h1>
    <div class="mt-4"><cap-settings-section section="auth" [title]="t('Connexion locale, inscriptions, MFA et sessions')" /></div>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Fournisseurs d’identité') }}</h2>
    <div class="space-y-3">
      @for (p of providers(); track p.id) {
        <div class="card p-4 text-sm">
          <div class="flex items-center gap-2"><span class="font-medium">{{ p.name }}</span><span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ p.type }}</span>
            <span class="badge" [class]="p.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'">{{ p.enabled ? t('activé') : t('désactivé') }}</span>
            @if (p.secretConfigured) { <span class="text-xs text-stone-500">{{ t('secret dans Vault') }}</span> }
            <span class="ml-auto flex gap-1">
              <button class="btn-ghost !py-0.5 text-xs" (click)="test(p)">{{ t('Tester') }}</button>
              <button class="btn-ghost !py-0.5 text-xs" (click)="toggle(p)">{{ p.enabled ? t('Désactiver') : t('Activer') }}</button>
              <button class="btn-ghost !py-0.5 text-xs" (click)="edit(p)">{{ t('Modifier') }}</button>
              <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(p)">{{ t('Supprimer') }}</button>
            </span>
          </div>
          @if (p.lastTestResult) { <div class="mt-1 text-xs text-stone-500">{{ t('Dernier test : {result}', { result: tr(p.lastTestResult) }) }}</div> }
          @if (p.type !== 'ldap') {
            <div class="mt-1 text-xs text-stone-500">{{ p.type === 'saml' ? t('URL ACS à déclarer chez le fournisseur :') : t('URL de redirection à déclarer chez le fournisseur :') }} <code class="select-all">{{ p.callbackUrl }}</code></div>
          }
          @if (p.type === 'saml') { <div class="mt-1 text-xs text-stone-500">{{ t('Métadonnées SP :') }} <a class="underline" [href]="'/api/v1/auth/sso/' + p.id + '/metadata'" target="_blank" rel="noopener">{{ t('télécharger') }}</a></div> }
        </div>
      } @empty { <p class="text-sm text-stone-500">{{ t('Aucun fournisseur externe configuré (la connexion locale suffit).') }}</p> }
    </div>
    <form class="card mt-4 space-y-2 p-4" (ngSubmit)="save()">
      <div class="font-medium">{{ editing() ? t('Modifier un fournisseur') : t('Ajouter un fournisseur') }}</div>
      <div class="grid gap-2 md:grid-cols-3">
        <select class="input" name="type" [(ngModel)]="form.type" (ngModelChange)="useTemplate()" [disabled]="!!editing()"><option value="oidc">OIDC / Keycloak</option><option value="saml">SAML 2.0</option><option value="ldap">LDAP / Active Directory</option><option value="github">OAuth GitHub</option><option value="gitlab">OAuth GitLab</option></select>
        <input class="input" name="name" [placeholder]="t('Nom affiché')" [(ngModel)]="form.name" required />
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="ap" [(ngModel)]="form.autoProvision" /> {{ t('Création automatique des comptes') }}</label>
      </div>
      <label class="label">{{ t('Configuration (JSON, sans secret)') }}</label>
      <textarea class="input font-mono text-xs" rows="8" name="cfg" [(ngModel)]="configText"></textarea>
      @if (secretField().multiline) {
        <textarea class="input font-mono text-xs" rows="4" name="sec" [placeholder]="t('{label} — stocké dans Vault', { label: secretField().label })" [(ngModel)]="secret"></textarea>
      } @else {
        <input class="input" type="password" name="sec" autocomplete="off" [placeholder]="t('{label} — stocké dans Vault', { label: secretField().label })" [(ngModel)]="secret" />
      }
      <p class="text-xs text-stone-500">{{ t('MFA (mfa) : auto = la MFA locale s’applique sauf si le fournisseur atteste une MFA ; require_idp = MFA du fournisseur obligatoire ; trust_idp = le fournisseur impose la MFA ; local = toujours la politique locale. Laisser le secret vide conserve le secret existant.') }}</p>
      <div class="flex gap-2"><button class="btn-primary">{{ t('Enregistrer') }}</button>@if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">{{ t('Annuler') }}</button> }</div>
    </form>
  `,
})
export class AdminIam implements OnInit {
  protected readonly t = t;
  protected readonly tr = tr;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly providers = signal<AuthProviderAdminDto[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected form = { type: 'oidc', name: '', autoProvision: true };
  protected configText = JSON.stringify(TEMPLATES['oidc'], null, 2);
  protected secret = '';

  async ngOnInit() {
    this.providers.set(await this.api.get<AuthProviderAdminDto[]>('/admin/auth-providers').catch(() => []));
  }
  protected secretField() {
    return SECRET_FIELD[this.form.type];
  }
  protected useTemplate() {
    this.configText = JSON.stringify(TEMPLATES[this.form.type], null, 2);
  }
  protected edit(p: AuthProviderAdminDto) {
    this.editing.set(p.id);
    this.form = { type: p.type, name: p.name, autoProvision: p.autoProvision };
    this.configText = JSON.stringify(p.config, null, 2);
    this.secret = '';
  }
  protected reset() {
    this.editing.set(null);
    this.form = { type: 'oidc', name: '', autoProvision: true };
    this.secret = '';
    this.useTemplate();
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
  protected async save() {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(this.configText);
    } catch {
      this.toast.show('JSON invalide', 'error');
      return;
    }
    if (this.secret) config = { ...config, [SECRET_FIELD[this.form.type].key]: this.secret };
    const enabled = this.providers().find((p) => p.id === this.editing())?.enabled ?? false;
    const body = { ...this.form, enabled, config };
    const id = this.editing();
    await this.act(() => (id ? this.api.put(`/admin/auth-providers/${id}`, body) : this.api.post('/admin/auth-providers', body)), t('Fournisseur enregistré'));
    this.reset();
  }
  protected toggle(p: AuthProviderAdminDto) {
    return this.act(() => this.api.post(`/admin/auth-providers/${p.id}/${p.enabled ? 'disable' : 'enable'}`));
  }
  protected test(p: AuthProviderAdminDto) {
    return this.act(async () => {
      const r = await this.api.post<{ ok: boolean; detail: string }>(`/admin/auth-providers/${p.id}/test`);
      this.toast.show(tr(r.detail), r.ok ? 'success' : 'error', 8000);
    });
  }
  protected remove(p: AuthProviderAdminDto) {
    if (confirm(t('Supprimer {name} ?', { name: p.name }))) return this.act(() => this.api.delete(`/admin/auth-providers/${p.id}`));
    return;
  }
}
