import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AdminModelDto, AdminUserDto, LiteLlmConnectionDto, LiteLlmSyncResultDto, PlatformSettings } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { AgoPipe } from '../../shared/pipes';

interface EditForm {
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  allowed: Array<{ id: string; displayName: string; username: string }>;
}

/**
 * Modèles : connexion au proxy LiteLLM (URL + clé, dans Vault), découverte des modèles déclarés
 * dans LiteLLM, activation, modèle par défaut, liste blanche d'utilisateurs et coefficients.
 */
@Component({
  selector: 'cap-admin-models',
  imports: [FormsModule, Icon, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Modèles (LiteLLM)</h1>
    <p class="text-sm text-stone-500">Les modèles se déclarent dans LiteLLM ; la plateforme les découvre via son API. Vous choisissez ici ceux qui sont proposés, à qui, et leur coût en crédits.</p>

    <form class="card mt-4 space-y-3 p-4" (ngSubmit)="saveConnection()" aria-label="Connexion à LiteLLM">
      <div class="flex items-center gap-2">
        <div class="font-medium">Connexion à LiteLLM</div>
        @if (connection(); as c) {
          <span class="badge" [class]="c.source === 'admin' ? 'bg-accent-100 text-accent-700' : 'bg-stone-200 text-stone-600'">{{ c.source === 'admin' ? 'réglée ici' : 'valeur de déploiement' }}</span>
        }
      </div>
      <p class="text-xs text-stone-500">Utilisez un proxy LiteLLM existant plutôt que celui de la plateforme : son URL telle que les services de la plateforme la joignent, et une clé d’administration (clé maître ou clé virtuelle autorisée à lire <code>/model/info</code>). La clé est stockée dans Vault et n’est jamais réaffichée.</p>
      <div class="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
        <input class="input font-mono text-sm" name="url" [(ngModel)]="url" placeholder="https://litellm.exemple.com" aria-label="URL de LiteLLM" required />
        <input class="input font-mono text-sm" type="password" name="key" [(ngModel)]="key" autocomplete="off" aria-label="Clé maître LiteLLM"
          [placeholder]="connection()?.keyConfigured ? 'Clé enregistrée — laisser vide pour la conserver' : 'sk-…'" />
        <button type="button" class="btn-secondary" (click)="testConnection()" [disabled]="busy() || !url">Tester</button>
        <button class="btn-primary" [disabled]="busy() || !url">Enregistrer</button>
      </div>
      @if (testResult(); as t) {
        <p class="text-xs" [class.text-emerald-700]="t.ok" [class.text-red-600]="!t.ok" role="status">
          @if (t.ok) { Connexion réussie : {{ t.models?.length }} modèle(s) — {{ t.models?.slice(0, 8)?.join(', ') }}{{ (t.models?.length ?? 0) > 8 ? '…' : '' }} }
          @else { Échec : {{ t.detail }} }
        </p>
      }
    </form>

    <div class="mt-6 flex items-center gap-2">
      <h2 class="font-semibold">Modèles disponibles</h2>
      <span class="text-xs text-stone-500">{{ enabledCount() }} activé(s) sur {{ models().length }}</span>
      <button class="btn-secondary ml-auto" (click)="reload()" [disabled]="busy()" title="Interroger LiteLLM (également fait toutes les 10 minutes)">
        <cap-icon name="refresh" [size]="14" [class.animate-spin]="reloading()" /> Recharger les modèles
      </button>
    </div>
    <p class="mt-1 text-xs text-stone-500">Un modèle nouvellement découvert est <strong>désactivé</strong> : vérifiez ses coefficients (préremplis depuis les prix connus de LiteLLM, 1 crédit = 0,001 $) avant de l’activer. Sans liste blanche, un modèle activé est accessible à tous.</p>

    <div class="card mt-3 overflow-x-auto"><table class="table">
      <thead><tr><th>Modèle</th><th>Activé</th><th>Par défaut</th><th>Accès</th><th>Crédits / 1 000 tokens<br /><span class="font-normal normal-case">entrée / sortie</span></th><th>État</th><th></th></tr></thead>
      <tbody>@for (m of models(); track m.id) {
        <tr [class.opacity-60]="!m.enabled">
          <td>
            <div class="font-medium">{{ m.displayName }}</div>
            <div class="font-mono text-xs text-stone-500">{{ m.litellmModel }} · {{ m.provider }}</div>
          </td>
          <td>
            <label class="inline-flex cursor-pointer items-center">
              <input type="checkbox" class="peer sr-only" [checked]="m.enabled" (change)="patch(m, { enabled: !m.enabled })" [attr.aria-label]="(m.enabled ? 'Désactiver ' : 'Activer ') + m.displayName" />
              <span class="relative h-5 w-9 rounded-full bg-stone-300 transition-colors peer-checked:bg-accent-600 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4 dark:bg-stone-700"></span>
            </label>
          </td>
          <td>
            <input type="radio" name="default" [checked]="m.isDefault" [disabled]="!m.enabled" (change)="patch(m, { isDefault: true })" [attr.aria-label]="'Modèle par défaut : ' + m.displayName" />
          </td>
          <td class="text-xs">
            @if (m.allowedUsers.length) {
              <span [title]="names(m)">{{ m.allowedUsers.length }} utilisateur(s)</span>
            } @else { <span class="text-stone-500">Tout le monde</span> }
          </td>
          <td class="text-xs tabular-nums">@if (m.coefficients; as c) { {{ num(c.input) }} / {{ num(c.output) }} <span class="text-stone-400">(cache {{ num(c.cacheRead) }} / {{ num(c.cacheWrite) }})</span> }</td>
          <td class="text-xs">
            @if (!m.available) { <span class="text-red-600">{{ m.lastSyncError ?? 'indisponible' }}</span> }
            @else { <span class="text-emerald-700">disponible</span> }
            @if (m.lastSyncAt) { <div class="text-stone-400">vu {{ m.lastSyncAt | ago }}</div> }
          </td>
          <td class="text-right whitespace-nowrap">
            <button class="btn-ghost !py-0.5 text-xs" (click)="test(m)">Tester</button>
            <button class="btn-ghost !py-0.5 text-xs" (click)="edit(m)">Régler</button>
            @if (!m.available) { <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(m)">Retirer</button> }
          </td>
        </tr>
      } @empty {
        <tr><td colspan="7" class="text-sm text-stone-500">Aucun modèle. Déclarez des modèles dans LiteLLM puis cliquez sur « Recharger les modèles ».</td></tr>
      }</tbody>
    </table></div>

    @if (editing(); as m) {
      <form class="card mt-4 space-y-3 p-4" (ngSubmit)="save()" aria-label="Réglages du modèle">
        <div class="flex items-center gap-2">
          <div class="font-medium">Réglages de <span class="font-mono">{{ m.litellmModel }}</span></div>
          <button type="button" class="btn-ghost ml-auto !p-1" (click)="editing.set(null)" aria-label="Fermer"><cap-icon name="x" /></button>
        </div>
        <div class="grid gap-2 md:grid-cols-3">
          <div><label class="label" for="dn">Nom affiché</label><input id="dn" class="input" name="dn" [(ngModel)]="f.displayName" required /></div>
          <div><label class="label" for="cw">Fenêtre de contexte (tokens)</label><input id="cw" class="input" type="number" name="cw" [(ngModel)]="f.contextWindow" /></div>
          <div><label class="label" for="mo">Sortie max (tokens)</label><input id="mo" class="input" type="number" name="mo" [(ngModel)]="f.maxOutputTokens" /></div>
        </div>
        <div class="flex flex-wrap gap-4 text-sm">
          <label class="flex items-center gap-1.5"><input type="checkbox" name="im" [(ngModel)]="f.supportsImages" /> Images en entrée</label>
          <label class="flex items-center gap-1.5"><input type="checkbox" name="re" [(ngModel)]="f.supportsReasoning" /> Raisonnement</label>
        </div>
        <div>
          <div class="label">Coefficients (crédits pour 1 000 tokens ; une modification crée une nouvelle version)</div>
          <div class="grid gap-2 md:grid-cols-4">
            <label class="text-xs text-stone-500">Entrée<input class="input mt-0.5" name="ci" [(ngModel)]="f.input" /></label>
            <label class="text-xs text-stone-500">Sortie<input class="input mt-0.5" name="co" [(ngModel)]="f.output" /></label>
            <label class="text-xs text-stone-500">Cache lu<input class="input mt-0.5" name="cr" [(ngModel)]="f.cacheRead" /></label>
            <label class="text-xs text-stone-500">Cache écrit<input class="input mt-0.5" name="cwr" [(ngModel)]="f.cacheWrite" /></label>
          </div>
        </div>
        <div>
          <div class="label">Liste blanche (vide : accessible à tous les utilisateurs)</div>
          <div class="flex flex-wrap items-center gap-1.5">
            @for (u of f.allowed; track u.id) {
              <span class="badge flex items-center gap-1 bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200">{{ u.displayName }} <span class="text-stone-500">&#64;{{ u.username }}</span>
                <button type="button" (click)="unallow(u.id)" [attr.aria-label]="'Retirer ' + u.displayName"><cap-icon name="x" [size]="11" /></button></span>
            } @empty { <span class="text-sm text-stone-500">Tout le monde</span> }
          </div>
          <div class="relative mt-2 md:max-w-sm">
            <input class="input" name="uq" placeholder="Ajouter un utilisateur…" autocomplete="off" [(ngModel)]="userQuery" (ngModelChange)="searchUsers()" aria-label="Rechercher un utilisateur à autoriser" />
            @if (userResults().length) {
              <div class="absolute z-20 mt-1 w-full rounded-lg border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900">
                @for (u of userResults(); track u.id) {
                  <button type="button" class="menu-item" (click)="allow(u)">{{ u.displayName }} <span class="text-xs text-stone-500">{{ u.email }}</span></button>
                }
              </div>
            }
          </div>
        </div>
        <button class="btn-primary">Enregistrer</button>
      </form>
    }

    <form class="card mt-6 space-y-2 p-4" (ngSubmit)="saveTitleModel()">
      <div class="font-medium">Titres automatiques des conversations</div>
      <p class="text-sm text-stone-500">Après le premier message, ce modèle propose un titre court (appel non décompté des quotas, liste blanche non appliquée). Sans modèle, le début du message sert de titre. Un titre renommé par l’utilisateur n’est jamais remplacé.</p>
      <div class="flex gap-2">
        <select class="input md:max-w-sm" name="titleModel" [(ngModel)]="titleModelId" aria-label="Modèle des titres">
          <option [ngValue]="null">Aucun (début du message)</option>
          @for (m of models(); track m.id) { @if (m.enabled) { <option [ngValue]="m.id">{{ m.displayName }}</option> } }
        </select>
        <button class="btn-primary">Enregistrer</button>
      </div>
    </form>
  `,
})
export class AdminModels implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly models = signal<AdminModelDto[]>([]);
  protected readonly connection = signal<LiteLlmConnectionDto | null>(null);
  protected readonly testResult = signal<{ ok: boolean; models?: string[]; detail?: string } | null>(null);
  protected readonly busy = signal(false);
  protected readonly reloading = signal(false);
  protected readonly editing = signal<AdminModelDto | null>(null);
  protected readonly userResults = signal<AdminUserDto[]>([]);
  protected readonly enabledCount = computed(() => this.models().filter((m) => m.enabled).length);
  protected url = '';
  protected key = '';
  protected userQuery = '';
  protected titleModelId: string | null = null;
  protected f: EditForm = emptyForm();

  async ngOnInit() {
    const [c, s] = await Promise.all([this.api.get<LiteLlmConnectionDto>('/admin/litellm/connection'), this.api.get<PlatformSettings>('/admin/settings')]);
    this.connection.set(c);
    this.url = c.url;
    this.titleModelId = s.conversations.titleModelId;
    await this.load();
  }

  private async load() {
    this.models.set(await this.api.get<AdminModelDto[]>('/admin/models'));
  }

  /** « 1.50000000 » → « 1.5 ». */
  protected num(v: string) {
    return String(Number(v));
  }

  protected names(m: AdminModelDto) {
    return m.allowedUsers.map((u) => u.displayName).join(', ');
  }

  protected async testConnection() {
    this.busy.set(true);
    try {
      this.testResult.set(await this.api.post('/admin/litellm/connection/test', { url: this.url.trim(), ...(this.key ? { masterKey: this.key } : {}) }));
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveConnection() {
    this.busy.set(true);
    try {
      const r = await this.api.put<{ connection: LiteLlmConnectionDto; sync: LiteLlmSyncResultDto | null; syncError: string | null }>('/admin/litellm/connection', {
        url: this.url.trim(),
        ...(this.key ? { masterKey: this.key } : {}),
      });
      this.connection.set(r.connection);
      this.key = '';
      this.testResult.set(null);
      if (r.sync) this.toast.show(`Connexion enregistrée. ${syncSummary(r.sync)}`, 'success', 8000);
      else this.toast.show(`Connexion enregistrée, mais la découverte des modèles a échoué : ${r.syncError}`, 'error', 10_000);
      await this.load();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async reload() {
    this.busy.set(true);
    this.reloading.set(true);
    try {
      const r = await this.api.post<LiteLlmSyncResultDto>('/admin/models/reload');
      this.toast.show(syncSummary(r), 'success', 8000);
      await this.load();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
      this.reloading.set(false);
    }
  }

  protected async patch(m: AdminModelDto, body: Record<string, unknown>) {
    try {
      await this.api.patch(`/admin/models/${m.id}`, body);
    } catch (e) {
      this.toast.error(e);
    }
    await this.load();
  }

  protected edit(m: AdminModelDto) {
    this.editing.set(m);
    this.f = {
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
      input: this.num(m.coefficients?.input ?? '0'),
      output: this.num(m.coefficients?.output ?? '0'),
      cacheRead: this.num(m.coefficients?.cacheRead ?? '0'),
      cacheWrite: this.num(m.coefficients?.cacheWrite ?? '0'),
      allowed: [...m.allowedUsers],
    };
    this.userQuery = '';
    this.userResults.set([]);
  }

  protected async searchUsers() {
    const q = this.userQuery.trim();
    if (q.length < 2) return this.userResults.set([]);
    const list = await this.api.get<AdminUserDto[]>('/admin/users', { q }).catch(() => []);
    this.userResults.set(list.filter((u) => u.status === 'active' && !this.f.allowed.some((a) => a.id === u.id)).slice(0, 8));
  }

  protected allow(u: AdminUserDto) {
    this.f.allowed = [...this.f.allowed, { id: u.id, displayName: u.displayName, username: u.username }];
    this.userQuery = '';
    this.userResults.set([]);
  }

  protected unallow(id: string) {
    this.f.allowed = this.f.allowed.filter((u) => u.id !== id);
  }

  protected async save() {
    const m = this.editing();
    if (!m) return;
    const n = (v: string | number) => String(Number(v));
    try {
      await this.api.patch(`/admin/models/${m.id}`, {
        displayName: this.f.displayName,
        contextWindow: Number(this.f.contextWindow),
        maxOutputTokens: Number(this.f.maxOutputTokens),
        supportsImages: this.f.supportsImages,
        supportsReasoning: this.f.supportsReasoning,
        allowedUserIds: this.f.allowed.map((u) => u.id),
        coefficients: { input: n(this.f.input), output: n(this.f.output), cacheRead: n(this.f.cacheRead), cacheWrite: n(this.f.cacheWrite) },
      });
      this.toast.show('Modèle enregistré', 'success');
      this.editing.set(null);
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async saveTitleModel() {
    try {
      await this.api.patch('/admin/settings', { section: 'conversations', values: { titleModelId: this.titleModelId } });
      this.toast.show('Modèle des titres enregistré', 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async test(m: AdminModelDto) {
    const r = await this.api.post<{ ok: boolean; latencyMs: number; detail: string }>(`/admin/models/${m.id}/test`).catch((e) => ({ ok: false, latencyMs: 0, detail: String(e.message) }));
    this.toast.show(r.ok ? `OK (${r.latencyMs} ms) : ${r.detail}` : `Échec : ${r.detail}`, r.ok ? 'success' : 'error', 8000);
    await this.load();
  }

  protected async remove(m: AdminModelDto) {
    if (!confirm(`Retirer ${m.displayName} du catalogue ? L’historique de consommation est conservé.`)) return;
    await this.api.delete(`/admin/models/${m.id}`).catch((e) => this.toast.error(e));
    await this.load();
  }
}

function emptyForm(): EditForm {
  return { displayName: '', contextWindow: 128000, maxOutputTokens: 8192, supportsImages: false, supportsReasoning: false, input: '0', output: '0', cacheRead: '0', cacheWrite: '0', allowed: [] };
}

function syncSummary(r: LiteLlmSyncResultDto): string {
  const parts = [`${r.discovered} modèle(s) dans LiteLLM`];
  if (r.added.length) parts.push(`${r.added.length} nouveau(x), désactivé(s) : ${r.added.join(', ')}`);
  if (r.missing.length) parts.push(`${r.missing.length} absent(s) de LiteLLM : ${r.missing.join(', ')}`);
  return parts.join(' · ') + '.';
}
