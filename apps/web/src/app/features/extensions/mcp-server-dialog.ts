import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { McpDiscoveryResult, McpServerDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { MultiSelect, type MultiSelectOption } from '../../shared/multi-select';
import { t } from '../../core/i18n';

/** Même règle que l'API : ces noms sont toujours traités comme secrets. */
const SENSITIVE = /auth|token|key|secret|pass|pwd|cookie|credential|session|signature/i;

interface Row {
  key: string;
  value: string;
  secret: boolean;
  /** Secret déjà enregistré (valeur jamais renvoyée) : vide = conservé. */
  stored: boolean;
}

/** Configuration lue dans un bloc JSON `mcpServers` (format Claude Desktop / Cursor), ou un serveur seul. */
export function parseMcpJson(text: string): { name: string; url: string; headers: Record<string, string> } {
  const root = JSON.parse(text) as Record<string, unknown>;
  const servers = (root['mcpServers'] ?? root['servers'] ?? null) as Record<string, Record<string, unknown>> | null;
  let name = '';
  let cfg: Record<string, unknown> = root;
  if (servers && typeof servers === 'object') {
    const first = Object.entries(servers)[0];
    if (!first) throw new Error(t('Aucun serveur dans ce JSON.'));
    [name, cfg] = first;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)])) : {});
  const url = str(cfg['url']) ?? str(cfg['serverUrl']);
  if (!url && str(cfg['command'])) throw new Error(t('Serveur stdio (« command ») : non pris en charge. Seuls les serveurs Streamable HTTP (« url ») le sont.'));
  if (!url) throw new Error(t('Pas d’« url » dans ce JSON.'));
  return {
    name: (name || str(cfg['name']) || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''),
    url,
    headers: rec(cfg['headers']),
  };
}

/**
 * Ajout ou modification d'un serveur MCP : formulaire (ou JSON collé), en-têtes libres avec case
 * « secret », test de connexion avant l'enregistrement, puis choix des outils proposés à l'agent.
 */
@Component({
  selector: 'cap-mcp-server-dialog',
  imports: [FormsModule, Icon, MultiSelect],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 px-4 pt-16 pb-8" (click)="closed.emit()">
      <div class="card w-full max-w-2xl p-5 shadow-xl" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="mcp-title" (keydown.escape)="closed.emit()">
        <div class="mb-3 flex items-center">
          <h2 id="mcp-title" class="font-semibold">
            {{ step() === 'tools' ? t('{name} : outils proposés à l’agent', { name: name }) : server() ? t('Modifier {name}', { name: server()!.name }) : t('Ajouter un serveur MCP') }}
          </h2>
          <button class="btn-ghost ml-auto !p-1" (click)="closed.emit()" [attr.aria-label]="t('Fermer')"><cap-icon name="x" /></button>
        </div>

        @if (step() === 'tools') {
          <p class="mb-2 text-sm text-stone-500">{{ t('Décochez les outils que l’agent ne doit pas utiliser. Vous pourrez changer ce choix plus tard.') }}</p>
          <cap-multi-select [options]="toolOptions()" [(value)]="toolSelection" [ariaLabel]="t('Outils proposés à l’agent')" [placeholder]="t('Aucun outil sélectionné')" />
          <div class="mt-4 flex justify-end gap-2">
            <button class="btn-secondary" (click)="closed.emit()">{{ t('Plus tard') }}</button>
            <button class="btn-primary" (click)="saveTools()" [disabled]="busy()">{{ t('Enregistrer') }}</button>
          </div>
        } @else {
          @if (!server()) {
            <div class="mb-3 flex gap-1 text-sm" role="tablist">
              <button role="tab" class="rounded-md px-3 py-1" [attr.aria-selected]="tab() === 'form'" [class]="tab() === 'form' ? 'bg-stone-200 font-medium dark:bg-stone-800' : 'text-stone-500'" (click)="tab.set('form')">{{ t('Formulaire') }}</button>
              <button role="tab" class="rounded-md px-3 py-1" [attr.aria-selected]="tab() === 'json'" [class]="tab() === 'json' ? 'bg-stone-200 font-medium dark:bg-stone-800' : 'text-stone-500'" (click)="tab.set('json')">{{ t('Coller une config JSON') }}</button>
            </div>
          }

          @if (tab() === 'json') {
            <p class="mb-2 text-sm text-stone-500">{{ t('Collez le bloc « mcpServers » donné par la documentation du serveur (format Claude Desktop, Cursor…) : le formulaire sera rempli, à vérifier avant l’ajout.') }}</p>
            <textarea class="input font-mono text-xs" rows="12" spellcheck="false" [(ngModel)]="json" name="json" [attr.aria-label]="t('Configuration JSON')"
              placeholder='{ "mcpServers": { "jira": { "url": "http://mcp-jira:8000/mcp", "headers": { "X-Api-Token": "…" } } } }'></textarea>
            @if (jsonError()) { <p class="mt-1 text-xs text-red-600">{{ jsonError() }}</p> }
            <div class="mt-3 flex justify-end"><button class="btn-primary" (click)="importJson()">{{ t('Remplir le formulaire') }}</button></div>
          } @else {
            <form class="space-y-3 text-sm" (ngSubmit)="submit()">
              <div class="grid gap-2 md:grid-cols-[1fr_auto]">
                <label class="block">
                  <span class="text-xs font-medium text-stone-600 dark:text-stone-400">{{ t('Nom') }}</span>
                  <input class="input font-mono" name="name" [(ngModel)]="name" [disabled]="!!server()" required pattern="[A-Za-z0-9_-]+" maxlength="64" placeholder="jira" />
                  @if (!server()) { <span class="text-xs text-stone-500">{{ t('Lettres, chiffres, - et _ ; préfixe des outils côté agent.') }}</span> }
                </label>
                <label class="block">
                  <span class="text-xs font-medium text-stone-600 dark:text-stone-400">{{ t('Portée') }}</span>
                  <select class="input" name="scope" [(ngModel)]="scope" [disabled]="!!server()">
                    <option value="personal">{{ t('Personnel') }}</option>
                    @if (isAdmin()) { <option value="global">Global</option> }
                  </select>
                </label>
              </div>
              <label class="block">
                <span class="text-xs font-medium text-stone-600 dark:text-stone-400">{{ t('Description (facultatif)') }}</span>
                <input class="input" name="description" [(ngModel)]="description" maxlength="1000" />
              </label>


              <label class="block">
                <span class="text-xs font-medium text-stone-600 dark:text-stone-400">URL</span>
                <input class="input font-mono" name="url" type="url" [(ngModel)]="url" required placeholder="https://mcp.exemple.com/mcp" />
                @if (scope === 'personal') { <span class="text-xs text-stone-500">{{ t('Serveur personnel : son hôte doit être autorisé par un administrateur (Administration → MCP).') }}</span> }
              </label>

              <div>
                <div class="mb-1 flex items-center text-xs font-medium text-stone-600 dark:text-stone-400">
                  <span>{{ t('En-têtes HTTP') }}</span>
                  <span class="ml-auto pr-9">{{ t('Secret') }}</span>
                </div>
                @for (r of rows(); track $index; let i = $index) {
                  <div class="mb-1.5 flex items-center gap-1.5">
                    <input class="input w-2/5 font-mono text-xs" [name]="'k' + i" [(ngModel)]="r.key" (ngModelChange)="autoSecret(r)" placeholder="X-Api-Token" [attr.aria-label]="t('Nom')" />
                    <input class="input flex-1 font-mono text-xs" [name]="'v' + i" [(ngModel)]="r.value" [type]="r.secret ? 'password' : 'text'" autocomplete="off"
                      [placeholder]="r.stored ? t('•••• enregistré (vide : conservé)') : t('valeur')" [attr.aria-label]="t('Valeur')" />
                    <input type="checkbox" class="h-4 w-4" [name]="'s' + i" [(ngModel)]="r.secret" [disabled]="sensitive(r.key)" [title]="sensitive(r.key) ? t('Nom sensible : toujours secret') : t('Stocker dans Vault, ne plus afficher')" [attr.aria-label]="t('Secret')" />
                    <button type="button" class="btn-ghost !p-1 text-stone-500 hover:text-red-600" (click)="removeRow(i)" [attr.aria-label]="t('Retirer')"><cap-icon name="trash" [size]="14" /></button>
                  </div>
                }
                <button type="button" class="btn-ghost !px-1.5 !py-0.5 text-xs" (click)="addRow()"><cap-icon name="plus" [size]="12" /> {{ t('Ajouter un en-tête') }}</button>
                <p class="mt-1 text-xs text-stone-500">
                  {{ t('Les secrets sont chiffrés dans Vault et ne sont plus affichés.') }}
                </p>
              </div>

              @if (result(); as r) {
                <div class="rounded-md border px-3 py-2 text-sm" [class]="r.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'" role="status">
                  @if (r.ok) { ✓ {{ t('Connecté') }}{{ r.server ? ' : ' + r.server : '' }} — {{ t('{n} outil(s) trouvé(s)', { n: r.tools?.length ?? 0 }) }} }
                  @else { ✗ <span class="break-words">{{ r.detail }}</span> }
                </div>
              }

              <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button type="button" class="btn-secondary mr-auto" (click)="test()" [disabled]="busy() || !url">{{ busy() === 'test' ? t('Test…') : t('Tester la connexion') }}</button>
                <button type="button" class="btn-secondary" (click)="closed.emit()">{{ t('Annuler') }}</button>
                <button class="btn-primary" [disabled]="!!busy()">{{ server() ? t('Enregistrer') : t('Ajouter et choisir les outils') }}</button>
              </div>
            </form>
          }
        }
      </div>
    </div>
  `,
})
export class McpServerDialog implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  /** Serveur à modifier ; absent : ajout. */
  readonly server = input<McpServerDto | null>(null);
  readonly isAdmin = input(false);
  readonly closed = output<void>();
  readonly saved = output<void>();

  protected readonly tab = signal<'form' | 'json'>('form');
  protected readonly step = signal<'config' | 'tools'>('config');
  protected readonly busy = signal<'test' | 'save' | null>(null);
  protected readonly result = signal<McpDiscoveryResult | null>(null);
  protected readonly rows = signal<Row[]>([]);
  protected readonly jsonError = signal('');
  protected name = '';
  protected description = '';
  protected scope: 'personal' | 'global' = 'personal';
  protected url = '';
  protected json = '';
  /** Secrets enregistrés au départ (noms tels que dans `secretKeys`). */
  private storedSecrets: string[] = [];
  private createdId: string | null = null;
  private discoveredTools: Array<{ name: string; description: string }> = [];
  protected toolSelection: string[] = [];
  protected readonly toolOptions = signal<MultiSelectOption[]>([]);
  protected readonly sensitive = (k: string) => SENSITIVE.test(k);

  ngOnInit() {
    const s = this.server();
    if (!s) return this.addRow();
    this.name = s.name;
    this.description = s.description;
    this.scope = s.scope;
    this.url = s.url ?? '';
    this.storedSecrets = [...s.secretKeys];
    const rows: Row[] = Object.entries(s.headers ?? {}).map(([key, value]) => ({ key, value, secret: false, stored: false }));
    for (const k of s.secretKeys) {
      if (k.startsWith('header:')) rows.push({ key: k.slice(7), value: '', secret: true, stored: true });
      else rows.push({ key: k, value: '', secret: true, stored: true });
    }
    this.rows.set(rows.length ? rows : [{ key: '', value: '', secret: false, stored: false }]);
  }

  protected addRow() {
    this.rows.update((r) => [...r, { key: '', value: '', secret: false, stored: false }]);
  }

  protected removeRow(i: number) {
    this.rows.update((r) => r.filter((_, j) => j !== i));
  }

  /** Un nom sensible (token, authorization…) est toujours secret. */
  protected autoSecret(r: Row) {
    if (SENSITIVE.test(r.key)) r.secret = true;
  }

  protected importJson() {
    this.jsonError.set('');
    try {
      const c = parseMcpJson(this.json);
      this.name = c.name || this.name;
      this.url = c.url;
      const rows: Row[] = Object.entries(c.headers).map(([key, value]) => ({ key, value, secret: SENSITIVE.test(key), stored: false }));
      this.rows.set(rows.length ? rows : [{ key: '', value: '', secret: false, stored: false }]);
      this.tab.set('form');
    } catch (e) {
      this.jsonError.set(e instanceof SyntaxError ? t('JSON illisible : {error}', { error: e.message }) : (e as Error).message);
    }
  }

  /** Lignes remplies, réparties en en-têtes publics et secrets. */
  private collect() {
    const rows = this.rows().filter((r) => r.key.trim());
    const headers: Record<string, string> = {};
    const secretHeaders: Record<string, string> = {};
    for (const r of rows) {
      const key = r.key.trim();
      if (r.secret || SENSITIVE.test(key)) {
        if (r.value) secretHeaders[key] = r.value;
      } else headers[key] = r.value;
    }
    // Secrets enregistrés dont la ligne a disparu, a été renommée ou est devenue publique : retirés.
    const kept = new Set(rows.filter((r) => r.stored && (r.secret || SENSITIVE.test(r.key))).map((r) => `header:${r.key.trim()}`));
    const removeSecrets = this.storedSecrets.filter((k) => !kept.has(k));
    const missing = rows.find((r) => !r.value && !r.stored && r.secret);
    return { headers, secretHeaders, removeSecrets, missing };
  }

  protected async test() {
    const c = this.collect();
    this.busy.set('test');
    this.result.set(null);
    try {
      this.result.set(
        await this.api.post<McpDiscoveryResult>('/mcp-servers/test', {
          scope: this.scope,
          url: this.url,
          headers: c.headers,
          secretHeaders: c.secretHeaders,
          ...(this.server() ? { serverId: this.server()!.id } : {}),
        }),
      );
    } catch (e) {
      this.result.set({ ok: false, detail: (e as Error).message });
    } finally {
      this.busy.set(null);
    }
  }

  protected async submit() {
    const c = this.collect();
    if (c.missing) return this.toast.show(t('Valeur manquante pour « {name} ».', { name: c.missing.key }), 'error');
    this.busy.set('save');
    try {
      const s = this.server();
      let discovery: McpDiscoveryResult | null;
      if (s) {
        const r = await this.api.patch<{ discovery: McpDiscoveryResult | null }>(`/mcp-servers/${s.id}`, {
          description: this.description,
          url: this.url,
          headers: c.headers,
          secretHeaders: c.secretHeaders,
          removeSecrets: c.removeSecrets,
        });
        discovery = r.discovery;
        this.result.set(discovery);
        if (discovery && !discovery.ok) {
          this.toast.show(t('Enregistré, mais le serveur ne répond pas correctement.'), 'error');
          this.saved.emit();
          return;
        }
        this.toast.show(t('Serveur modifié'), 'success');
        this.saved.emit();
        this.closed.emit();
        return;
      }
      const r = await this.api.post<{ id: string; discovery: McpDiscoveryResult | null }>('/mcp-servers', {
        name: this.name,
        description: this.description,
        scope: this.scope,
        transport: 'streamable_http',
        url: this.url,
        headers: c.headers,
        secretHeaders: c.secretHeaders,
      });
      this.createdId = r.id;
      discovery = r.discovery;
      this.saved.emit();
      if (discovery?.ok && discovery.tools?.length) {
        // Étape suivante : choix des outils, tous proposés par défaut.
        this.discoveredTools = discovery.tools;
        this.toolOptions.set(discovery.tools.map((x) => ({ value: x.name, label: x.name, description: x.description })));
        this.toolSelection = discovery.tools.map((x) => x.name);
        this.step.set('tools');
        return;
      }
      if (discovery && !discovery.ok) {
        this.toast.show(t('Serveur ajouté, mais la connexion a échoué : {error}', { error: discovery.detail ?? '' }), 'error');
      } else this.toast.show(t('Serveur ajouté'), 'success');
      this.closed.emit();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(null);
    }
  }

  protected async saveTools() {
    if (!this.createdId) return;
    this.busy.set('save');
    try {
      const on = new Set(this.toolSelection);
      await this.api.put(`/mcp-servers/${this.createdId}/selection`, { scope: this.scope, denied: this.discoveredTools.map((x) => x.name).filter((n) => !on.has(n)) });
      this.toast.show(t('Serveur ajouté'), 'success');
      this.saved.emit();
      this.closed.emit();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(null);
    }
  }
}

/** Sélection courante d'un serveur : outils autorisés (refus globaux compris, verrouillés). */
export const selectionOf = (m: McpServerDto) => m.tools.filter((x) => x.effective === 'allowed').map((x) => x.name);

/** Options du sélecteur d'outils pour un utilisateur (ou un administrateur sur un serveur global). */
export function toolOptionsFor(m: McpServerDto, adminGlobal: boolean): MultiSelectOption[] {
  return m.tools.map((x) => ({
    value: x.name,
    label: x.name,
    description: x.description,
    locked: !adminGlobal && x.lockedByAdmin,
    lockedReason: t('Refusé par l’administrateur'),
  }));
}
