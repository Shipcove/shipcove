import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ModelDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

type AdminModel = ModelDto & { allowedTeamIds: string[]; litellmParams: Record<string, unknown>; lastSyncError: string | null; secretConfigured: boolean };

const EMPTY = {
  litellmModel: '',
  displayName: '',
  params: '{\n  "model": "anthropic/claude-sonnet-4-5"\n}',
  apiKey: '',
  contextWindow: 200000,
  maxOutputTokens: 16384,
  supportsImages: true,
  supportsReasoning: true,
  enabled: true,
  isDefault: false,
  allowedTeamIds: [] as string[],
  input: '3',
  output: '15',
  cacheRead: '0.3',
  cacheWrite: '3.75',
};

@Component({
  selector: 'cap-admin-models',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Modèles (LiteLLM)</h1>
    <p class="text-sm text-stone-500">Tous les appels LLM de Pi passent par LiteLLM. Les coefficients sont exprimés en <strong>crédits pour 1 000 tokens</strong> ; une modification crée une nouvelle version sans affecter les consommations passées.</p>
    <div class="card mt-3 overflow-x-auto"><table class="table">
      <thead><tr><th>Modèle</th><th>Contexte</th><th>Coefficients (entrée/sortie/cache lu/écrit)</th><th>État</th><th></th></tr></thead>
      <tbody>@for (m of models(); track m.id) {
        <tr>
          <td><div class="font-medium">{{ m.displayName }} @if (m.isDefault) { <span class="badge bg-accent-100 text-accent-700">défaut</span> }</div><div class="font-mono text-xs text-stone-500">{{ m.litellmModel }}</div></td>
          <td class="text-xs">{{ m.contextWindow }} / sortie {{ m.maxOutputTokens }}</td>
          <td class="text-xs">@if (m.coefficients; as c) { v{{ c.version }} : {{ c.input }} / {{ c.output }} / {{ c.cacheRead }} / {{ c.cacheWrite }} }</td>
          <td class="text-xs">{{ m.enabled ? 'activé' : 'désactivé' }} · {{ m.available ? 'disponible' : 'indisponible' }} @if (m.lastSyncError) { <div class="text-red-600">{{ m.lastSyncError }}</div> }</td>
          <td class="text-right whitespace-nowrap"><button class="btn-ghost !py-0.5 text-xs" (click)="test(m)">Tester</button><button class="btn-ghost !py-0.5 text-xs" (click)="edit(m)">Modifier</button><button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(m)">Supprimer</button></td>
        </tr>
      }</tbody>
    </table></div>
    <form class="card mt-4 grid gap-2 p-4 md:grid-cols-4" (ngSubmit)="save()">
      <div class="font-medium md:col-span-4">{{ editing() ? 'Modifier le modèle' : 'Ajouter un modèle' }}</div>
      <div><label class="label">Nom LiteLLM</label><input class="input" name="lm" [(ngModel)]="f.litellmModel" required /></div>
      <div><label class="label">Nom affiché</label><input class="input" name="dn" [(ngModel)]="f.displayName" required /></div>
      <div><label class="label">Fenêtre de contexte</label><input class="input" type="number" name="cw" [(ngModel)]="f.contextWindow" /></div>
      <div><label class="label">Sortie max</label><input class="input" type="number" name="mo" [(ngModel)]="f.maxOutputTokens" /></div>
      <div class="md:col-span-2"><label class="label">litellm_params (JSON, sans secret)</label><textarea class="input font-mono text-xs" rows="4" name="pa" [(ngModel)]="f.params"></textarea></div>
      <div class="md:col-span-2"><label class="label">Clé API du fournisseur (stockée dans Vault, jamais réaffichée)</label><input class="input" type="password" name="ak" [(ngModel)]="f.apiKey" />
        <div class="mt-2 flex flex-wrap gap-3 text-sm">
          <label><input type="checkbox" name="im" [(ngModel)]="f.supportsImages" /> Images</label>
          <label><input type="checkbox" name="re" [(ngModel)]="f.supportsReasoning" /> Raisonnement</label>
          <label><input type="checkbox" name="en" [(ngModel)]="f.enabled" /> Activé</label>
          <label><input type="checkbox" name="de" [(ngModel)]="f.isDefault" /> Par défaut</label>
        </div>
      </div>
      <div><label class="label">Entrée</label><input class="input" name="ci" [(ngModel)]="f.input" /></div>
      <div><label class="label">Sortie</label><input class="input" name="co" [(ngModel)]="f.output" /></div>
      <div><label class="label">Cache lu</label><input class="input" name="cr" [(ngModel)]="f.cacheRead" /></div>
      <div><label class="label">Cache écrit</label><input class="input" name="cwr" [(ngModel)]="f.cacheWrite" /></div>
      <div class="md:col-span-4"><label class="label">Équipes autorisées (aucune = toutes)</label>
        <div class="flex flex-wrap gap-3 text-sm">@for (t of teams(); track t['id']) { <label><input type="checkbox" [checked]="f.allowedTeamIds.includes(t['id'])" (change)="toggleTeam(t['id'])" /> {{ t['name'] }}</label> }</div>
      </div>
      <div class="flex gap-2 md:col-span-4"><button class="btn-primary">Enregistrer</button>@if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">Annuler</button> }</div>
    </form>
  `,
})
export class AdminModels implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly models = signal<AdminModel[]>([]);
  protected readonly teams = signal<Array<Record<string, string>>>([]);
  protected readonly editing = signal<string | null>(null);
  protected f = { ...EMPTY, allowedTeamIds: [] as string[] };

  async ngOnInit() {
    this.models.set(await this.api.get<AdminModel[]>('/admin/models'));
    this.teams.set(await this.api.get('/admin/teams'));
  }
  protected toggleTeam(id: string) {
    this.f.allowedTeamIds = this.f.allowedTeamIds.includes(id) ? this.f.allowedTeamIds.filter((x) => x !== id) : [...this.f.allowedTeamIds, id];
  }
  protected edit(m: AdminModel) {
    this.editing.set(m.id);
    this.f = {
      litellmModel: m.litellmModel,
      displayName: m.displayName,
      params: JSON.stringify(m.litellmParams, null, 2),
      apiKey: '',
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
      enabled: m.enabled,
      isDefault: m.isDefault,
      allowedTeamIds: [...m.allowedTeamIds],
      input: m.coefficients?.input ?? '0',
      output: m.coefficients?.output ?? '0',
      cacheRead: m.coefficients?.cacheRead ?? '0',
      cacheWrite: m.coefficients?.cacheWrite ?? '0',
    };
  }
  protected reset() {
    this.editing.set(null);
    this.f = { ...EMPTY, allowedTeamIds: [] };
  }
  protected async save() {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(this.f.params);
    } catch {
      this.toast.show('litellm_params : JSON invalide', 'error');
      return;
    }
    const n = (v: string | number) => String(Number(v));
    const body = {
      litellmModel: this.f.litellmModel,
      displayName: this.f.displayName,
      litellmParams: params,
      apiKey: this.f.apiKey || undefined,
      contextWindow: Number(this.f.contextWindow),
      maxOutputTokens: Number(this.f.maxOutputTokens),
      supportsImages: this.f.supportsImages,
      supportsReasoning: this.f.supportsReasoning,
      enabled: this.f.enabled,
      isDefault: this.f.isDefault,
      allowedTeamIds: this.f.allowedTeamIds,
      coefficients: { input: n(this.f.input), output: n(this.f.output), cacheRead: n(this.f.cacheRead), cacheWrite: n(this.f.cacheWrite) },
    };
    try {
      const id = this.editing();
      if (id) await this.api.put(`/admin/models/${id}`, body);
      else await this.api.post('/admin/models', body);
      this.toast.show('Modèle enregistré et synchronisé avec LiteLLM', 'success');
      this.reset();
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected async test(m: AdminModel) {
    const r = await this.api.post<{ ok: boolean; latencyMs: number; detail: string }>(`/admin/models/${m.id}/test`).catch((e) => ({ ok: false, latencyMs: 0, detail: String(e.message) }));
    this.toast.show(r.ok ? `OK (${r.latencyMs} ms) : ${r.detail}` : `Échec : ${r.detail}`, r.ok ? 'success' : 'error', 8000);
    await this.ngOnInit();
  }
  protected async remove(m: AdminModel) {
    if (!confirm(`Supprimer ${m.displayName} ?`)) return;
    await this.api.delete(`/admin/models/${m.id}`).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
}

