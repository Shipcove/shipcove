import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { McpDiscoveryResult, McpServerDto, SkillCategoryDto, SkillDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { SkillScopeService } from './skill-scope.service';
import { MultiSelect } from '../../shared/multi-select';
import { McpServerDialog, selectionOf, toolOptionsFor } from './mcp-server-dialog';
import { t } from '../../core/i18n';

/** Skills et serveurs MCP visibles par l'utilisateur (global, personnel). */
@Component({
  selector: 'cap-extensions',
  imports: [FormsModule, RouterLink, Icon, DatePipe, MultiSelect, McpServerDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 class="text-2xl font-semibold">{{ t('Skills & MCP') }}</h1>
      <p class="mt-1 text-sm text-stone-500">{{ t('Les skills sont des instructions chargées par l’agent ; ils ne confèrent aucun privilège. Les outils MCP sont filtrés par les politiques globales et personnelles.') }}</p>

      <section class="mt-6" aria-labelledby="skills-title">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="skills-title" class="text-lg font-semibold">{{ t('Skills') }}</h2>
          <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-sm font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            <span class="h-2 w-2 rounded-full bg-emerald-500"></span>{{ t('{n} activé(s) sur {total}', { n: enabledCount(), total: publishedCount() }) }}
          </span>
          <div class="ml-auto flex gap-2">
            <button class="btn-secondary !py-1.5 text-sm" (click)="zipInput.click()" [disabled]="importing()" [title]="t('Importer un skill depuis une archive .zip (SKILL.md, dossiers et fichiers)')">
              <cap-icon name="paperclip" [size]="14" /> {{ importing() ? t('Import…') : t('Importer .zip') }}</button>
            <a routerLink="/extensions/skills/new" class="btn-primary !py-1.5 text-sm"><cap-icon name="plus" [size]="14" /> {{ t('Nouveau skill') }}</a>
            <input #zipInput type="file" accept=".zip,application/zip" class="hidden" (change)="importZip($event)" />
          </div>
        </div>
        <p class="mt-1 text-sm text-stone-500">{{ t('L’agent voit la description des skills activés et charge leur contenu quand la tâche s’y prête. Un skill est fait de fichiers markdown, organisés en dossiers si besoin.') }}</p>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <div class="flex gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800/70" role="tablist" [attr.aria-label]="t('Filtrer les skills')">
            @for (f of filters(); track f.id) {
              <button role="tab" class="rounded-md px-3 py-1 text-sm" [attr.aria-selected]="filter() === f.id"
                [class]="filter() === f.id ? 'bg-white font-medium shadow-sm dark:bg-stone-900' : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200'" (click)="setFilter(f.id)">
                {{ f.label }} <span class="text-stone-400 tabular-nums">{{ f.count }}</span></button>
            }
          </div>
          @if (categories().length) {
            <select class="input !w-auto !py-1.5" [ngModel]="category()" (ngModelChange)="category.set($event)" [attr.aria-label]="t('Catégorie')">
              <option value="all">{{ t('Toutes les catégories') }}</option>
              @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
              <option value="none">{{ t('Sans catégorie') }}</option>
            </select>
          }
          <input class="input !w-full !py-1.5 sm:!w-64" [placeholder]="t('Rechercher un skill…')" [ngModel]="query()" (ngModelChange)="query.set($event)" [attr.aria-label]="t('Rechercher un skill')" />
        </div>

        @for (g of groups(); track g.id) {
          <div class="mt-5" [attr.aria-label]="t('Catégorie {name}', { name: g.name })" data-skill-group>
            @if (groups().length > 1 || g.id !== 'none') {
              <div class="mb-2 flex items-baseline gap-2">
                <h3 class="text-sm font-semibold text-stone-700 dark:text-stone-300">{{ g.name }}</h3>
                <span class="text-xs text-stone-400">{{ t('{n} activé(s)', { n: g.enabled }) }} · {{ g.skills.length }}</span>
                @if (g.description) { <span class="hidden truncate text-xs text-stone-500 sm:inline">— {{ g.description }}</span> }
              </div>
            }
            <div class="grid gap-3 md:grid-cols-2">
              @for (s of g.skills; track s.id) {
            <article class="flex flex-col rounded-xl border p-4 transition-colors"
              [class]="s.enabledForMe ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'"
              [attr.aria-label]="s.name + (s.enabledForMe ? t(', activé') : t(', désactivé'))" data-skill-card>
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" [class]="s.enabledForMe ? 'bg-emerald-600 text-white' : 'bg-stone-200 text-stone-500 dark:bg-stone-800'">
                  <cap-icon [name]="s.enabledForMe ? 'check' : 'puzzle'" [size]="16" />
                </div>
                <div class="min-w-0 flex-1">
                  <a [routerLink]="['/extensions/skills', s.id]" class="block truncate font-mono font-medium hover:underline">{{ s.name }}</a>
                  <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
                    <span class="badge bg-stone-200/70 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ s.scope === 'global' ? 'Global' : 'Personnel' }}</span>
                    @if (s.status === 'pending_review') { <span class="badge bg-amber-100 text-amber-800" [title]="t('Un administrateur doit valider ce skill avant que l’agent puisse l’utiliser')">{{ t('En attente de validation') }}</span> }
                    <span>{{ t('{n} fichier(s)', { n: s.fileCount }) }}</span>
                    @if (s.findings.length) { <span class="inline-flex items-center gap-0.5 text-amber-700" [title]="s.findings.join('\n')"><cap-icon name="alert" [size]="12" /> {{ s.findings.length }}</span> }
                  </div>
                </div>
                @if (s.status !== 'pending_review') {
                  <label class="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium" [class]="s.enabledForMe ? 'text-emerald-700 dark:text-emerald-400' : 'text-stone-500'">
                    <span class="hidden sm:inline">{{ s.enabledForMe ? t('Activé') : t('Désactivé') }}</span>
                    <input type="checkbox" class="peer sr-only" [checked]="s.enabledForMe" (change)="toggleSkill(s)" [attr.aria-label]="s.enabledForMe ? t('Désactiver {name}', { name: s.name }) : t('Activer {name}', { name: s.name })" />
                    <span class="relative h-6 w-11 rounded-full bg-stone-300 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5 dark:bg-stone-700"></span>
                  </label>
                }
              </div>
              <p class="mt-2 line-clamp-2 text-sm text-stone-600 dark:text-stone-400" [title]="s.description">{{ s.description }}</p>
              <div class="mt-auto flex justify-end gap-1 pt-2">
                @if (auth.isAdmin()) {
                  <button class="btn-ghost !py-1 text-xs" (click)="setScope(s)" [disabled]="scoping() === s.id"
                    [title]="s.scope === 'global' ? t('Le skill redevient personnel (à vous) et n’est plus disponible pour les autres') : t('Rendre ce skill disponible pour tous les utilisateurs')">
                    <cap-icon name="globe" [size]="13" /> {{ s.scope === 'global' ? t('Retirer du global') : t('Rendre global') }}</button>
                }
                <a [routerLink]="['/extensions/skills', s.id]" class="btn-ghost !py-1 text-xs"><cap-icon [name]="s.canManage ? 'edit' : 'eye'" [size]="13" /> {{ s.canManage ? 'Modifier' : 'Voir' }}</a>
              </div>
            </article>
              }
            </div>
          </div>
        } @empty {
          <p class="mt-3 text-sm text-stone-500">{{ skills().length ? t('Aucun skill ne correspond.') : t('Aucun skill pour l’instant : créez-en un ou importez une archive .zip.') }}</p>
        }
      </section>

      <div class="mt-8 mb-2 flex items-center">
        <h2 class="text-sm font-semibold text-stone-500 uppercase">{{ t('Serveurs MCP') }}</h2>
        <button class="btn-primary ml-auto !py-1 text-sm" (click)="editing.set('new')"><cap-icon name="plus" [size]="14" /> {{ t('Ajouter un serveur MCP') }}</button>
      </div>
      <div class="space-y-3">
        @for (m of servers(); track m.id) {
          <div class="card p-4 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono font-medium">{{ m.name }}</span><span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ m.scope === 'global' ? 'Global' : t('Personnel') }}</span>
              <span class="badge bg-stone-100 text-stone-600 dark:bg-stone-800">{{ m.transport === 'stdio' ? t('stdio (dans la sandbox)') : 'Streamable HTTP' }}</span>
              <span class="badge" [class]="m.health === 'healthy' ? 'bg-emerald-100 text-emerald-800' : m.health === 'unhealthy' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-600'"
                [title]="m.lastHealthAt ? t('Dernier contrôle : {date}', { date: (m.lastHealthAt | date: 'short') ?? '' }) : ''">
                {{ m.health === 'healthy' ? t('connecté') : m.health === 'unhealthy' ? t('injoignable') : t('non vérifié') }}
              </span>
              @if (!m.enabled) { <span class="badge bg-stone-300 text-stone-700">{{ t('désactivé') }}</span> }
              @if (canManage(m)) {
                <span class="ml-auto flex gap-1">
                  @if (m.transport === 'streamable_http') { <button class="btn-ghost !py-0.5 text-xs" (click)="discover(m)" [title]="t('Recharger la liste des outils')"><cap-icon name="refresh" [size]="12" /> {{ t('Actualiser') }}</button> }
                  <button class="btn-ghost !py-0.5 text-xs" (click)="editing.set(m)"><cap-icon name="edit" [size]="12" /> {{ t('Modifier') }}</button>
                  <button class="btn-ghost !py-0.5 text-xs" (click)="toggleServer(m)">{{ m.enabled ? t('Désactiver') : t('Activer') }}</button>
                  <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="removeServer(m)">{{ t('Supprimer') }}</button>
                </span>
              }
            </div>
            <div class="mt-1 text-xs break-all text-stone-500">{{ m.description }} {{ m.url ?? m.command }}</div>
            @if (m.health === 'unhealthy' && m.healthDetail) {
              <div class="mt-2 flex items-start gap-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-300">
                <cap-icon name="alert" [size]="13" class="mt-0.5 shrink-0" /><span class="break-words">{{ m.healthDetail }}</span>
                @if (canManage(m) && m.transport === 'streamable_http') { <button class="ml-auto shrink-0 underline" (click)="discover(m)">{{ t('Réessayer') }}</button> }
              </div>
            }
            @if (m.tools.length) {
              <div class="mt-3">
                <div class="mb-1 flex items-center text-xs text-stone-500">
                  <span>{{ adminGlobal(m) ? t('Outils proposés à tous (règle globale)') : t('Outils proposés à l’agent') }}</span>
                  <span class="ml-2">{{ t('{n}/{total}', { n: (draft()[m.id] ?? selectionFor(m)).length, total: m.tools.length }) }}</span>
                </div>
                <cap-multi-select [options]="optionsFor(m)" [value]="draft()[m.id] ?? selectionFor(m)" (valueChange)="setDraft(m, $event)"
                  [ariaLabel]="t('Outils de {name}', { name: m.name })" [placeholder]="t('Aucun outil sélectionné')" />
                @if (draft()[m.id]) {
                  <div class="mt-2 flex justify-end gap-2">
                    <button class="btn-secondary !py-1 text-xs" (click)="cancelDraft(m)">{{ t('Annuler') }}</button>
                    <button class="btn-primary !py-1 text-xs" (click)="saveSelection(m)">{{ t('Enregistrer la sélection') }}</button>
                  </div>
                }
              </div>
            } @else {
              <p class="mt-2 text-xs text-stone-500">{{ m.transport === 'stdio' ? t('Outils découverts au premier lancement dans une sandbox.') : t('Aucun outil connu : actualisez une fois le serveur joignable.') }}</p>
            }
          </div>
        } @empty { <p class="text-sm text-stone-500">{{ t('Aucun serveur MCP.') }}</p> }
      </div>
      @if (editing(); as e) {
        <cap-mcp-server-dialog [server]="e === 'new' ? null : e" [isAdmin]="auth.isAdmin()" (closed)="editing.set(null)" (saved)="reloadServers()" />
      }
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class ExtensionsPage implements OnInit {
  protected readonly t = t;
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly scopes = inject(SkillScopeService);
  protected readonly skills = signal<SkillDto[]>([]);
  protected readonly servers = signal<McpServerDto[]>([]);
  protected readonly filter = signal<'all' | 'enabled' | 'disabled' | 'pending'>('all');
  protected readonly query = signal('');
  protected readonly category = signal<string>('all');
  protected readonly categories = signal<SkillCategoryDto[]>([]);
  /** Regroupement par catégorie (ordre défini par les administrateurs), « Sans catégorie » en dernier. */
  protected readonly groups = computed(() => {
    const list = this.visibleSkills();
    const cat = this.category();
    const known = new Set(this.categories().map((c) => c.id));
    const sections = [
      ...this.categories().map((c) => ({ id: c.id, name: c.name, description: c.description, skills: list.filter((s) => s.categoryId === c.id) })),
      { id: 'none', name: t('Sans catégorie'), description: '', skills: list.filter((s) => !s.categoryId || !known.has(s.categoryId)) },
    ];
    return sections
      .filter((g) => g.skills.length && (cat === 'all' || cat === g.id))
      .map((g) => ({ ...g, enabled: g.skills.filter((s) => s.enabledForMe).length }));
  });
  protected readonly importing = signal(false);
  private readonly router = inject(Router);
  protected readonly publishedCount = computed(() => this.skills().filter((s) => s.status === 'published').length);
  /**
   * Ordre figé au chargement (activés d'abord, puis par nom) : une carte qu'on vient de basculer
   * ne change pas de place, et reste visible dans le filtre en cours jusqu'au prochain changement de filtre.
   */
  private readonly order = signal<Map<string, number>>(new Map());
  private readonly sticky = signal<Set<string>>(new Set());
  protected readonly enabledCount = computed(() => this.skills().filter((s) => s.enabledForMe).length);
  protected readonly filters = computed(() => {
    const l = this.skills();
    const pending = l.filter((s) => s.status === 'pending_review').length;
    return [
      { id: 'all' as const, label: t('Tous'), count: l.length },
      { id: 'enabled' as const, label: t('Activés'), count: l.filter((s) => s.enabledForMe).length },
      { id: 'disabled' as const, label: t('Désactivés'), count: l.filter((s) => s.status === 'published' && !s.enabledForMe).length },
      ...(pending ? [{ id: 'pending' as const, label: t('En attente'), count: pending }] : []),
    ];
  });
  /** Activés d'abord, puis par nom ; filtre et recherche. */
  protected readonly visibleSkills = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    const sticky = this.sticky();
    const order = this.order();
    return this.skills()
      .filter((s) => sticky.has(s.id) || (f === 'enabled' ? s.enabledForMe : f === 'disabled' ? s.status === 'published' && !s.enabledForMe : f === 'pending' ? s.status === 'pending_review' : true))
      .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
      .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || a.name.localeCompare(b.name));
  });
  /** Serveur ouvert dans la fenêtre d'ajout / de modification. */
  protected readonly editing = signal<McpServerDto | 'new' | null>(null);
  /** Sélections d'outils modifiées, pas encore enregistrées (par serveur). */
  protected readonly draft = signal<Record<string, string[]>>({});

  async ngOnInit() {
    const [s, m, c] = await Promise.all([
      this.api.get<SkillDto[]>('/skills'),
      this.api.get<McpServerDto[]>('/mcp-servers'),
      this.api.get<SkillCategoryDto[]>('/skill-categories').catch(() => [] as SkillCategoryDto[]),
    ]);
    this.skills.set(s);
    this.categories.set(c);
    this.order.set(new Map([...s].sort((a, b) => Number(b.enabledForMe) - Number(a.enabledForMe) || a.name.localeCompare(b.name)).map((x, i) => [x.id, i])));
    this.sticky.set(new Set());
    this.servers.set(m);
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

  protected canManage(m: McpServerDto) {
    return (m.scope === 'personal' && m.ownerId === this.auth.me()?.id) || (m.scope === 'global' && this.auth.isAdmin());
  }

  protected setFilter(id: 'all' | 'enabled' | 'disabled' | 'pending') {
    this.sticky.set(new Set());
    this.filter.set(id);
  }

  /** Bascule immédiate dans la liste, rétablie en cas d'erreur. */
  protected async toggleSkill(s: SkillDto) {
    const enabled = !s.enabledForMe;
    this.sticky.update((set) => new Set([...set, s.id]));
    this.skills.update((l) => l.map((x) => (x.id === s.id ? { ...x, enabledForMe: enabled } : x)));
    try {
      await this.api.put(`/skills/${s.id}/installation`, { scope: 'personal', enabled });
    } catch (e) {
      this.skills.update((l) => l.map((x) => (x.id === s.id ? { ...x, enabledForMe: !enabled } : x)));
      this.toast.error(e);
    }
  }



  protected readonly scoping = signal<string | null>(null);

  /** Administrateur : rendre global un skill personnel, ou l'inverse (méthode unique, cf. SkillScopeService). */
  protected async setScope(s: SkillDto) {
    this.scoping.set(s.id);
    try {
      const scope = await this.scopes.toggle(s);
      // Mise à jour sur place : la carte garde sa position dans la liste.
      if (scope) this.skills.update((l) => l.map((x) => (x.id === s.id ? { ...x, scope, ownerId: scope === 'global' ? null : (this.auth.me()?.id ?? null), status: 'published' } : x)));
    } finally {
      this.scoping.set(null);
    }
  }

  /** Import d'une archive .zip : toujours un skill personnel (un administrateur peut ensuite le rendre global), ouvert dans l'éditeur. */
  protected async importZip(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file, file.name);
    this.importing.set(true);
    try {
      const r = await this.api.upload<{ id: string; findings: string[]; ignored: string[] }>('/skills/import', form);
      this.toast.show(r.ignored.length ? t('Skill importé — {n} fichier(s) non markdown ignoré(s) : {files}', { n: r.ignored.length, files: r.ignored.slice(0, 5).join(', ') + (r.ignored.length > 5 ? '…' : '') }) : t('Skill importé'), 'success', r.ignored.length ? 12_000 : 5000);
      await this.router.navigate(['/extensions/skills', r.id]);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.importing.set(false);
    }
  }

  /** Un administrateur règle la portée globale d'un serveur global ; sinon, chacun règle la sienne. */
  protected adminGlobal(m: McpServerDto) {
    return m.scope === 'global' && this.auth.isAdmin();
  }

  protected optionsFor(m: McpServerDto) {
    return toolOptionsFor(m, this.adminGlobal(m));
  }

  /** Sélection enregistrée : outils autorisés (pour un administrateur, au niveau global). */
  protected selectionFor(m: McpServerDto) {
    return this.adminGlobal(m) ? m.tools.filter((x) => !x.lockedByAdmin).map((x) => x.name) : selectionOf(m);
  }

  protected setDraft(m: McpServerDto, value: string[]) {
    this.draft.update((d) => ({ ...d, [m.id]: value }));
  }

  protected cancelDraft(m: McpServerDto) {
    this.draft.update((d) => Object.fromEntries(Object.entries(d).filter(([id]) => id !== m.id)));
  }

  /** Enregistre la sélection en une fois : les outils décochés deviennent des refus de la portée. */
  protected async saveSelection(m: McpServerDto) {
    const on = new Set(this.draft()[m.id] ?? []);
    const denied = m.tools.filter((x) => !on.has(x.name) && (this.adminGlobal(m) || !x.lockedByAdmin)).map((x) => x.name);
    await this.act(() => this.api.put(`/mcp-servers/${m.id}/selection`, { scope: this.adminGlobal(m) ? 'global' : 'personal', denied }), t('Sélection enregistrée'));
    this.cancelDraft(m);
  }

  protected async reloadServers() {
    this.servers.set(await this.api.get<McpServerDto[]>('/mcp-servers'));
  }

  protected async discover(m: McpServerDto) {
    try {
      const r = await this.api.post<McpDiscoveryResult>(`/mcp-servers/${m.id}/discover`);
      if (r.ok) this.toast.show(t('{n} outil(s) trouvé(s)', { n: r.tools?.length ?? 0 }), 'success');
      else this.toast.show(t('Serveur injoignable : {error}', { error: r.detail ?? '' }), 'error');
    } catch (e) {
      this.toast.error(e);
    }
    await this.reloadServers();
  }
  protected toggleServer(m: McpServerDto) {
    return this.act(() => this.api.patch(`/mcp-servers/${m.id}`, { enabled: !m.enabled }));
  }
  protected removeServer(m: McpServerDto) {
    if (!confirm(t('Supprimer {name} ?', { name: m.name }))) return;
    return this.act(() => this.api.delete(`/mcp-servers/${m.id}`));
  }

}
