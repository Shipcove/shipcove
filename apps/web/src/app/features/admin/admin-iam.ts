import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { SettingsSection } from './settings-section';

interface ProviderAdmin {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  autoProvision: boolean;
  config: Record<string, unknown>;
  secretConfigured: boolean;
  lastTestAt: string | null;
  lastTestResult: string | null;
}

const TEMPLATES: Record<string, object> = {
  oidc: { issuer: 'https://keycloak.exemple.com/realms/entreprise', clientId: 'coding-platform', scopes: ['openid', 'profile', 'email'], requireMfaClaim: false },
  saml: { entryPoint: 'https://idp.exemple.com/sso', issuer: 'coding-platform', idpCert: '-----BEGIN CERTIFICATE-----…', emailAttribute: 'email', nameAttribute: 'displayName', wantAssertionsSigned: true },
  ldap: { url: 'ldaps://ldap.exemple.com', bindDn: 'cn=svc,dc=exemple,dc=com', searchBase: 'ou=people,dc=exemple,dc=com', searchFilter: '(|(uid={{username}})(sAMAccountName={{username}}))', emailAttribute: 'mail', nameAttribute: 'cn', usernameAttribute: 'uid', startTls: false },
  github: { host: 'github.com', clientId: '', allowLogin: true },
  gitlab: { host: 'gitlab.com', clientId: '', allowLogin: true },
};

@Component({
  selector: 'cap-admin-iam',
  imports: [FormsModule, SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">IAM & connexion</h1>
    <div class="mt-4"><cap-settings-section section="auth" title="Connexion locale, inscriptions, MFA et sessions" /></div>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">Fournisseurs d’identité</h2>
    <div class="space-y-3">
      @for (p of providers(); track p.id) {
        <div class="card p-4 text-sm">
          <div class="flex items-center gap-2"><span class="font-medium">{{ p.name }}</span><span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ p.type }}</span>
            <span class="badge" [class]="p.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'">{{ p.enabled ? 'activé' : 'désactivé' }}</span>
            @if (p.secretConfigured) { <span class="text-xs text-stone-500">secret dans Vault</span> }
            <span class="ml-auto flex gap-1">
              <button class="btn-ghost !py-0.5 text-xs" (click)="test(p)">Tester</button>
              <button class="btn-ghost !py-0.5 text-xs" (click)="toggle(p)">{{ p.enabled ? 'Désactiver' : 'Activer' }}</button>
              <button class="btn-ghost !py-0.5 text-xs" (click)="edit(p)">Modifier</button>
              <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(p)">Supprimer</button>
            </span>
          </div>
          @if (p.lastTestResult) { <div class="mt-1 text-xs text-stone-500">Dernier test : {{ p.lastTestResult }}</div> }
          <div class="mt-1 text-xs text-stone-500">URL de rappel : <code>{{ callback(p) }}</code></div>
        </div>
      } @empty { <p class="text-sm text-stone-500">Aucun fournisseur externe configuré (la connexion locale suffit).</p> }
    </div>
    <form class="card mt-4 space-y-2 p-4" (ngSubmit)="save()">
      <div class="font-medium">{{ editing() ? 'Modifier' : 'Ajouter' }} un fournisseur</div>
      <div class="grid gap-2 md:grid-cols-3">
        <select class="input" name="type" [(ngModel)]="form.type" (ngModelChange)="useTemplate()" [disabled]="!!editing()"><option value="oidc">OIDC / Keycloak</option><option value="saml">SAML 2.0</option><option value="ldap">LDAP / Active Directory</option><option value="github">OAuth GitHub</option><option value="gitlab">OAuth GitLab</option></select>
        <input class="input" name="name" placeholder="Nom affiché" [(ngModel)]="form.name" required />
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="ap" [(ngModel)]="form.autoProvision" /> Création automatique des comptes</label>
      </div>
      <label class="label">Configuration (JSON, sans secret)</label>
      <textarea class="input font-mono text-xs" rows="8" name="cfg" [(ngModel)]="configText"></textarea>
      <input class="input" type="password" name="sec" placeholder="Secret (client secret / mot de passe de liaison) — stocké dans Vault" [(ngModel)]="secret" />
      <div class="flex gap-2"><button class="btn-primary">Enregistrer</button>@if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">Annuler</button> }</div>
    </form>
  `,
})
export class AdminIam implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly providers = signal<ProviderAdmin[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected form = { type: 'oidc', name: '', autoProvision: true };
  protected configText = JSON.stringify(TEMPLATES['oidc'], null, 2);
  protected secret = '';

  async ngOnInit() {
    this.providers.set(await this.api.get<ProviderAdmin[]>('/admin/auth-providers').catch(() => []));
  }
  protected callback(p: ProviderAdmin) {
    return `${location.origin}/api/v1/auth/sso/${p.id}/callback`;
  }
  protected useTemplate() {
    this.configText = JSON.stringify(TEMPLATES[this.form.type], null, 2);
  }
  protected edit(p: ProviderAdmin) {
    this.editing.set(p.id);
    this.form = { type: p.type, name: p.name, autoProvision: p.autoProvision };
    this.configText = JSON.stringify(p.config, null, 2);
    this.secret = '';
  }
  protected reset() {
    this.editing.set(null);
    this.form = { type: 'oidc', name: '', autoProvision: true };
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
    if (this.secret) config = { ...config, [this.form.type === 'ldap' ? 'bindPassword' : 'clientSecret']: this.secret };
    const body = { ...this.form, enabled: false, config };
    const id = this.editing();
    await this.act(() => (id ? this.api.put(`/admin/auth-providers/${id}`, body) : this.api.post('/admin/auth-providers', body)), 'Fournisseur enregistré');
    this.reset();
  }
  protected toggle(p: ProviderAdmin) {
    return this.act(() => this.api.post(`/admin/auth-providers/${p.id}/${p.enabled ? 'disable' : 'enable'}`));
  }
  protected test(p: ProviderAdmin) {
    return this.act(async () => {
      const r = await this.api.post<{ ok: boolean; detail: string }>(`/admin/auth-providers/${p.id}/test`);
      this.toast.show(r.detail, r.ok ? 'success' : 'error', 8000);
    });
  }
  protected remove(p: ProviderAdmin) {
    if (confirm(`Supprimer ${p.name} ?`)) return this.act(() => this.api.delete(`/admin/auth-providers/${p.id}`));
    return;
  }
}
