import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import type { McpServerDto, SkillCategoryDto, SkillDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';

/** Skills et serveurs MCP visibles par l'utilisateur (global, personnel). */
@Component({
  selector: 'cap-extensions',
  imports: [FormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <h1 class="text-2xl font-semibold">Skills & MCP</h1>
      <p class="mt-1 text-sm text-stone-500">Les skills sont des instructions chargées par Pi ; ils ne confèrent aucun privilège. Les outils MCP sont filtrés par les politiques globales et personnelles.</p>

      <section class="mt-6" aria-labelledby="skills-title">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="skills-title" class="text-lg font-semibold">Skills</h2>
          <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-sm font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            <span class="h-2 w-2 rounded-full bg-emerald-500"></span>{{ enabledCount() }} activé(s) sur {{ publishedCount() }}
          </span>
          <div class="ml-auto flex gap-2">
            <button class="btn-secondary !py-1.5 text-sm" (click)="zipInput.click()" [disabled]="importing()" title="Importer un skill depuis une archive .zip (SKILL.md, dossiers et fichiers)">
              <cap-icon name="paperclip" [size]="14" /> {{ importing() ? 'Import…' : 'Importer .zip' }}</button>
            <a routerLink="/extensions/skills/new" class="btn-primary !py-1.5 text-sm"><cap-icon name="plus" [size]="14" /> Nouveau skill</a>
            <input #zipInput type="file" accept=".zip,application/zip" class="hidden" (change)="importZip($event)" />
          </div>
        </div>
        <p class="mt-1 text-sm text-stone-500">Pi voit la description des skills activés et charge leur contenu quand la tâche s’y prête. Un skill est fait de fichiers markdown, organisés en dossiers si besoin.</p>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <div class="flex gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800/70" role="tablist" aria-label="Filtrer les skills">
            @for (f of filters(); track f.id) {
              <button role="tab" class="rounded-md px-3 py-1 text-sm" [attr.aria-selected]="filter() === f.id"
                [class]="filter() === f.id ? 'bg-white font-medium shadow-sm dark:bg-stone-900' : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200'" (click)="setFilter(f.id)">
                {{ f.label }} <span class="text-stone-400 tabular-nums">{{ f.count }}</span></button>
            }
          </div>
          @if (categories().length) {
            <select class="input !w-auto !py-1.5" [ngModel]="category()" (ngModelChange)="category.set($event)" aria-label="Catégorie">
              <option value="all">Toutes les catégories</option>
              @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
              <option value="none">Sans catégorie</option>
            </select>
          }
          <input class="input !w-full !py-1.5 sm:!w-64" placeholder="Rechercher un skill…" [ngModel]="query()" (ngModelChange)="query.set($event)" aria-label="Rechercher un skill" />
        </div>

        @for (g of groups(); track g.id) {
          <div class="mt-5" [attr.aria-label]="'Catégorie ' + g.name" data-skill-group>
            @if (groups().length > 1 || g.id !== 'none') {
              <div class="mb-2 flex items-baseline gap-2">
                <h3 class="text-sm font-semibold text-stone-700 dark:text-stone-300">{{ g.name }}</h3>
                <span class="text-xs text-stone-400">{{ g.enabled }} activé(s) · {{ g.skills.length }}</span>
                @if (g.description) { <span class="hidden truncate text-xs text-stone-500 sm:inline">— {{ g.description }}</span> }
              </div>
            }
            <div class="grid gap-3 md:grid-cols-2">
              @for (s of g.skills; track s.id) {
            <article class="flex flex-col rounded-xl border p-4 transition-colors"
              [class]="s.enabledForMe ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'"
              [attr.aria-label]="s.name + (s.enabledForMe ? ', activé' : ', désactivé')" data-skill-card>
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" [class]="s.enabledForMe ? 'bg-emerald-600 text-white' : 'bg-stone-200 text-stone-500 dark:bg-stone-800'">
                  <cap-icon [name]="s.enabledForMe ? 'check' : 'puzzle'" [size]="16" />
                </div>
                <div class="min-w-0 flex-1">
                  <a [routerLink]="['/extensions/skills', s.id]" class="block truncate font-mono font-medium hover:underline">{{ s.name }}</a>
                  <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
                    <span class="badge bg-stone-200/70 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ s.scope === 'global' ? 'Global' : 'Personnel' }}</span>
                    @if (s.status === 'pending_review') { <span class="badge bg-amber-100 text-amber-800" title="Un administrateur doit valider ce skill avant que Pi puisse l’utiliser">En attente de validation</span> }
                    <span>{{ s.fileCount }} fichier(s)</span>
                    @if (s.findings.length) { <span class="inline-flex items-center gap-0.5 text-amber-700" [title]="s.findings.join('\n')"><cap-icon name="alert" [size]="12" /> {{ s.findings.length }}</span> }
                  </div>
                </div>
                @if (s.status !== 'pending_review') {
                  <label class="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium" [class]="s.enabledForMe ? 'text-emerald-700 dark:text-emerald-400' : 'text-stone-500'">
                    <span class="hidden sm:inline">{{ s.enabledForMe ? 'Activé' : 'Désactivé' }}</span>
                    <input type="checkbox" class="peer sr-only" [checked]="s.enabledForMe" (change)="toggleSkill(s)" [attr.aria-label]="(s.enabledForMe ? 'Désactiver ' : 'Activer ') + s.name" />
                    <span class="relative h-6 w-11 rounded-full bg-stone-300 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5 dark:bg-stone-700"></span>
                  </label>
                }
              </div>
              <p class="mt-2 line-clamp-2 text-sm text-stone-600 dark:text-stone-400" [title]="s.description">{{ s.description }}</p>
              <div class="mt-auto flex justify-end gap-1 pt-2">
                <a [routerLink]="['/extensions/skills', s.id]" class="btn-ghost !py-1 text-xs"><cap-icon [name]="s.canManage ? 'edit' : 'eye'" [size]="13" /> {{ s.canManage ? 'Modifier' : 'Voir' }}</a>
              </div>
            </article>
              }
            </div>
          </div>
        } @empty {
          <p class="mt-3 text-sm text-stone-500">{{ skills().length ? 'Aucun skill ne correspond.' : 'Aucun skill pour l’instant : créez-en un ou importez une archive .zip.' }}</p>
        }
      </section>

      <h2 class="mt-8 mb-2 text-sm font-semibold text-stone-500 uppercase">Serveurs MCP</h2>
      <div class="space-y-3">
        @for (m of servers(); track m.id) {
          <div class="card p-4 text-sm">
            <div class="flex items-center gap-2">
              <span class="font-mono font-medium">{{ m.name }}</span><span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ m.scope }}</span>
              <span class="badge bg-stone-100 text-stone-600 dark:bg-stone-800">{{ m.transport === 'stdio' ? 'stdio (dans la sandbox)' : 'Streamable HTTP' }}</span>
              <span class="badge" [class]="m.health === 'healthy' ? 'bg-emerald-100 text-emerald-800' : m.health === 'unhealthy' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-600'">{{ m.health }}</span>
              @if (!m.enabled) { <span class="badge bg-stone-300 text-stone-700">désactivé</span> }
              @if (canManage(m)) {
                <span class="ml-auto flex gap-1">
                  @if (m.transport === 'streamable_http') { <button class="btn-ghost !py-0.5 text-xs" (click)="discover(m)">Découvrir les outils</button> }
                  <button class="btn-ghost !py-0.5 text-xs" (click)="toggleServer(m)">{{ m.enabled ? 'Désactiver' : 'Activer' }}</button>
                  <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="removeServer(m)">Supprimer</button>
                </span>
              }
            </div>
            <div class="mt-1 text-xs text-stone-500">{{ m.description }} {{ m.url ?? m.command }}</div>
            <div class="mt-2 flex flex-wrap gap-1">
              @for (t of m.tools; track t.id) {
                <button class="badge font-mono" [class]="t.effective === 'allowed' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700 line-through'" (click)="toggleTool(m, t.name, t.effective)" [title]="'Cliquer pour ' + (t.effective === 'allowed' ? 'refuser' : 'autoriser') + ' pour moi'">{{ t.name }}</button>
              } @empty { <span class="text-xs text-stone-500">Aucun outil connu.</span> }
            </div>
          </div>
        } @empty { <p class="text-sm text-stone-500">Aucun serveur MCP.</p> }
      </div>
      <form class="card mt-3 grid gap-2 p-4 md:grid-cols-3" (ngSubmit)="createServer()">
        <div class="font-medium md:col-span-3">Ajouter un serveur MCP</div>
        <input class="input" name="mn" placeholder="nom" [(ngModel)]="mcp.name" required />
        <select class="input" name="mt" [(ngModel)]="mcp.transport"><option value="streamable_http">Streamable HTTP</option><option value="stdio">stdio</option></select>
        <select class="input" name="ms" [(ngModel)]="mcp.scope"><option value="personal">Personnel</option>@if (auth.isAdmin()) { <option value="global">Global</option> }</select>
        @if (mcp.transport === 'streamable_http') { <input class="input md:col-span-2" name="mu" placeholder="https://mcp.exemple.com/mcp" [(ngModel)]="mcp.url" /> <input class="input" type="password" name="mauth" placeholder="Authorization (facultatif, stocké dans Vault)" [(ngModel)]="mcp.auth" /> }
        @else { <input class="input md:col-span-2" name="mc" placeholder="commande (ex. npx)" [(ngModel)]="mcp.command" /> <input class="input" name="ma" placeholder="arguments séparés par des espaces" [(ngModel)]="mcp.args" /> }
        <button class="btn-primary md:col-span-3 md:w-fit">Ajouter</button>
      </form>
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class ExtensionsPage implements OnInit {
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
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
      { id: 'none', name: 'Sans catégorie', description: '', skills: list.filter((s) => !s.categoryId || !known.has(s.categoryId)) },
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
      { id: 'all' as const, label: 'Tous', count: l.length },
      { id: 'enabled' as const, label: 'Activés', count: l.filter((s) => s.enabledForMe).length },
      { id: 'disabled' as const, label: 'Désactivés', count: l.filter((s) => s.status === 'published' && !s.enabledForMe).length },
      ...(pending ? [{ id: 'pending' as const, label: 'En attente', count: pending }] : []),
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
  protected mcp = { name: '', transport: 'streamable_http', scope: 'personal', url: '', auth: '', command: '', args: '' };

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



  /** Import d'une archive .zip : skill personnel, ouvert ensuite dans l'éditeur. */
  protected async importZip(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('scope', 'personal');
    this.importing.set(true);
    try {
      const r = await this.api.upload<{ id: string; findings: string[]; ignored: string[] }>('/skills/import', form);
      this.toast.show(r.ignored.length ? `Skill importé — ${r.ignored.length} fichier(s) non markdown ignoré(s) : ${r.ignored.slice(0, 5).join(', ')}${r.ignored.length > 5 ? '…' : ''}` : 'Skill importé', 'success', r.ignored.length ? 12_000 : 5000);
      await this.router.navigate(['/extensions/skills', r.id]);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.importing.set(false);
    }
  }

  protected createServer() {
    const m = this.mcp;
    return this.act(
      () =>
        this.api.post('/mcp-servers', {
          name: m.name,
          transport: m.transport,
          scope: m.scope,
          url: m.transport === 'streamable_http' ? m.url : undefined,
          command: m.transport === 'stdio' ? m.command : undefined,
          args: m.transport === 'stdio' && m.args ? m.args.split(/\s+/) : [],
          headers: m.auth ? { Authorization: m.auth } : {},
        }),
      'Serveur ajouté',
    );
  }
  protected discover(m: McpServerDto) {
    return this.act(() => this.api.post(`/mcp-servers/${m.id}/discover`), 'Découverte terminée');
  }
  protected toggleServer(m: McpServerDto) {
    return this.act(() => this.api.patch(`/mcp-servers/${m.id}`, { enabled: !m.enabled }));
  }
  protected removeServer(m: McpServerDto) {
    if (!confirm(`Supprimer ${m.name} ?`)) return;
    return this.act(() => this.api.delete(`/mcp-servers/${m.id}`));
  }
  protected toggleTool(m: McpServerDto, tool: string, current: 'allowed' | 'denied') {
    return this.act(() => this.api.put(`/mcp-servers/${m.id}/permissions`, { toolName: tool, scope: 'personal', effect: current === 'allowed' ? 'deny' : 'allow' }));
  }
}
