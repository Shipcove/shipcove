import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { GitForgeAdminDto, GitProviderKind } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AgoPipe } from '../../shared/pipes';
import { SettingsSection } from './settings-section';
import { t, tr } from '../../core/i18n';

const PROVIDERS: Array<{ id: GitProviderKind; label: string; fixedHost?: string; help: string }> = [
  { id: 'github', label: 'GitHub.com', fixedHost: 'github.com', help: t('GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.') },
  { id: 'github_enterprise', label: 'GitHub Enterprise Server', help: t('Sur votre instance : Settings → Developer settings → OAuth Apps.') },
  { id: 'gitlab', label: 'GitLab.com', fixedHost: 'gitlab.com', help: t('GitLab → Admin / Groupe → Applications (confidentielle).') },
  { id: 'gitlab_self_managed', label: t('GitLab auto-hébergé'), help: t('Admin Area → Applications → New application (confidentielle).') },
];

/** Forges Git : une application OAuth par forge, déclarée par l'administrateur plateforme. */
@Component({
  selector: 'cap-admin-git',
  imports: [FormsModule, AgoPipe, SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Forges Git') }}</h1>
    <p class="mt-1 text-sm text-stone-500">{{ t('Les utilisateurs rattachent leurs comptes GitHub / GitLab par OAuth via les forges déclarées ici. Les secrets client sont conservés dans Vault ; les jetons des utilisateurs sont renouvelés automatiquement et ne quittent jamais le serveur.') }}</p>
    <div class="mt-4 space-y-3">
      @for (f of forges(); track f.id) {
        <div class="card p-4 text-sm" [attr.aria-label]="t('Forge {name}', { name: f.name })">
          <div class="flex flex-wrap items-center gap-2"><span class="font-medium">{{ f.name }}</span>
            <span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ label(f.provider) }}</span>
            <span class="text-xs text-stone-500">{{ f.host }}</span>
            <span class="badge" [class]="f.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'">{{ f.enabled ? t('activée') : t('désactivée') }}</span>
            <span class="text-xs text-stone-500">{{ f.connections }} connexion(s)</span>
            <span class="ml-auto flex gap-1">
              <button class="btn-ghost !py-0.5 text-xs" (click)="test(f)">{{ t('Tester') }}</button>
              <button class="btn-ghost !py-0.5 text-xs" (click)="toggle(f)">{{ f.enabled ? t('Désactiver') : t('Activer') }}</button>
              <button class="btn-ghost !py-0.5 text-xs" (click)="edit(f)">{{ t('Modifier') }}</button>
              <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(f)">{{ t('Supprimer') }}</button>
            </span>
          </div>
          <div class="mt-1 text-xs text-stone-500">{{ t('URL de rappel à déclarer dans l’application OAuth :') }} <code class="select-all">{{ f.callbackUrl }}</code></div>
          <div class="mt-0.5 text-xs text-stone-500">{{ t('Portées :') }} <code>{{ f.scopes.join(' ') }}</code> · {{ f.secretConfigured ? t('secret dans Vault') : t('secret absent') }}</div>
          @if (f.lastTestResult) { <div class="mt-0.5 text-xs" [class.text-red-600]="f.lastTestResult.startsWith('Échec')">{{ t('Dernier test {when} : {result}', { when: (f.lastTestAt | ago), result: tr(f.lastTestResult) }) }}</div> }
        </div>
      } @empty { <p class="text-sm text-stone-500">{{ t('Aucune forge configurée : les utilisateurs ne peuvent pas encore rattacher de compte Git.') }}</p> }
    </div>

    <form class="card mt-4 grid gap-2 p-4 md:grid-cols-2" (ngSubmit)="save()" [attr.aria-label]="t('Formulaire de forge')">
      <div class="font-medium md:col-span-2">{{ editing() ? t('Modifier la forge') : t('Ajouter une forge') }}</div>
      <label class="text-sm">{{ t('Type') }}
        <select class="input mt-1" name="provider" [(ngModel)]="form.provider" [disabled]="!!editing()">
          @for (p of providers; track p.id) { <option [value]="p.id">{{ p.label }}</option> }
        </select>
      </label>
      <label class="text-sm">{{ t('Nom affiché') }} <input class="input mt-1" name="name" [(ngModel)]="form.name" required [placeholder]="t('GitHub de l’entreprise')" /></label>
      <label class="text-sm">{{ t('Hôte') }} <input class="input mt-1" name="host" [(ngModel)]="form.host" [disabled]="!!fixedHost() || !!editing()" [placeholder]="fixedHost() ?? t('gitlab.exemple.com')" /></label>
      <label class="text-sm">Client ID (Application ID) <input class="input mt-1" name="clientId" [(ngModel)]="form.clientId" required /></label>
      <label class="text-sm md:col-span-2">{{ t('Secret client') }} <input class="input mt-1" type="password" name="secret" autocomplete="off" [(ngModel)]="form.clientSecret" [placeholder]="editing() ? t('Laisser vide pour conserver le secret existant') : t('Stocké dans Vault')" /></label>
      <label class="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" name="enabled" [(ngModel)]="form.enabled" /> {{ t('Activer (visible par les utilisateurs)') }}</label>
      <p class="text-xs text-stone-500 md:col-span-2">{{ help() }} {{ t('Après enregistrement, déclarez l’URL de rappel affichée sur la forge puis utilisez « Tester ».') }}</p>
      <div class="flex gap-2 md:col-span-2"><button class="btn-primary">{{ t('Enregistrer') }}</button>@if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">{{ t('Annuler') }}</button> }</div>
    </form>

    <div class="mt-6"><cap-settings-section section="git" [title]="t('Réglages Git')" /></div>
  `,
})
export class AdminGit implements OnInit {
  protected readonly t = t;
  protected readonly tr = tr;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly providers = PROVIDERS;
  protected readonly forges = signal<GitForgeAdminDto[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected form = { provider: 'github' as GitProviderKind, name: '', host: '', clientId: '', clientSecret: '', enabled: true };

  async ngOnInit() {
    this.forges.set(await this.api.get<GitForgeAdminDto[]>('/admin/git-forges'));
  }

  protected label(p: GitProviderKind) {
    return PROVIDERS.find((x) => x.id === p)?.label ?? p;
  }
  protected fixedHost() {
    return PROVIDERS.find((x) => x.id === this.form.provider)?.fixedHost ?? null;
  }
  protected help() {
    return PROVIDERS.find((x) => x.id === this.form.provider)?.help ?? '';
  }
  protected edit(f: GitForgeAdminDto) {
    this.editing.set(f.id);
    this.form = { provider: f.provider, name: f.name, host: f.host, clientId: f.clientId, clientSecret: '', enabled: f.enabled };
  }
  protected reset() {
    this.editing.set(null);
    this.form = { provider: 'github', name: '', host: '', clientId: '', clientSecret: '', enabled: true };
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
  private body(f: { provider: GitProviderKind; name: string; host: string; clientId: string; enabled: boolean }, secret?: string) {
    return { provider: f.provider, name: f.name, host: this.fixedHost() ?? f.host, clientId: f.clientId, enabled: f.enabled, ...(secret ? { clientSecret: secret } : {}) };
  }
  protected save() {
    const id = this.editing();
    const body = this.body(this.form, this.form.clientSecret);
    return this.act(async () => {
      await (id ? this.api.put(`/admin/git-forges/${id}`, body) : this.api.post('/admin/git-forges', body));
      this.reset();
    }, t('Forge enregistrée'));
  }
  protected toggle(f: GitForgeAdminDto) {
    return this.act(() => this.api.put(`/admin/git-forges/${f.id}`, { provider: f.provider, name: f.name, host: f.host, clientId: f.clientId, enabled: !f.enabled }));
  }
  protected test(f: GitForgeAdminDto) {
    return this.act(async () => {
      const r = await this.api.post<{ ok: boolean; detail: string }>(`/admin/git-forges/${f.id}/test`);
      this.toast.show(tr(r.detail), r.ok ? 'success' : 'error', 8000);
    });
  }
  protected remove(f: GitForgeAdminDto) {
    if (!confirm(t('Supprimer {name} ? Les {n} connexion(s) des utilisateurs seront révoquées.', { name: f.name, n: f.connections }))) return;
    return this.act(() => this.api.delete(`/admin/git-forges/${f.id}`), t('Forge supprimée'));
  }
}
