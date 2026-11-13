import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { McpServerDto, SkillDto, TeamDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';

/** Skills et serveurs MCP visibles par l'utilisateur (global, équipe, personnel). */
@Component({
  selector: 'cap-extensions',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-5xl px-6 py-8">
      <h1 class="text-2xl font-semibold">Skills & MCP</h1>
      <p class="mt-1 text-sm text-stone-500">Les skills sont des instructions chargées par Pi ; ils ne confèrent aucun privilège. Les outils MCP sont filtrés par les politiques globales, d’équipe et personnelles.</p>

      <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">Skills</h2>
      <div class="card divide-y divide-stone-100 dark:divide-stone-800">
        @for (s of skills(); track s.id) {
          <div class="flex items-start gap-3 px-4 py-3 text-sm">
            <cap-icon name="puzzle" class="mt-0.5" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2"><span class="font-mono font-medium">{{ s.name }}</span><span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ s.scope }}</span><span class="badge" [class]="s.status === 'published' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'">{{ s.status }}</span><span class="text-xs text-stone-400">v{{ s.latestVersion }} · {{ s.digest.slice(0, 12) }}</span></div>
              <div class="text-stone-600 dark:text-stone-400">{{ s.description }}</div>
              @if (s.findings.length) { <ul class="mt-1 list-disc pl-5 text-xs text-amber-700">@for (f of s.findings; track f) { <li>{{ f }}</li> }</ul> }
            </div>
            @if (s.status === 'published') {
              <label class="flex items-center gap-1 text-xs"><input type="checkbox" [checked]="s.enabledForMe" (change)="toggleSkill(s, $event)" /> actif pour moi</label>
            }
            @if (s.scope === 'personal' && s.status === 'draft') { <button class="btn-secondary !py-1 text-xs" (click)="publish(s)">Publier</button> }
          </div>
        } @empty { <p class="px-4 py-3 text-sm text-stone-500">Aucun skill.</p> }
      </div>
      <form class="card mt-3 space-y-2 p-4" (ngSubmit)="createSkill()">
        <div class="font-medium">Nouveau skill</div>
        <div class="grid gap-2 md:grid-cols-3">
          <input class="input" name="sn" placeholder="nom-du-skill" [(ngModel)]="skillName" pattern="[a-z0-9-]+" required />
          <input class="input md:col-span-2" name="sd" placeholder="Description (quand l’utiliser)" [(ngModel)]="skillDesc" required />
          <select class="input" name="ss" [(ngModel)]="skillScope"><option value="personal">Personnel</option>@if (adminTeams().length) { <option value="team">Équipe</option> }@if (auth.isAdmin()) { <option value="global">Global</option> }</select>
          @if (skillScope === 'team') { <select class="input" name="st" [(ngModel)]="skillTeam">@for (t of adminTeams(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }</select> }
        </div>
        <textarea class="input font-mono text-xs" rows="8" name="sb" [(ngModel)]="skillBody" placeholder="Contenu de SKILL.md (instructions)"></textarea>
        <button class="btn-primary">Créer</button>
      </form>

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
        <select class="input" name="ms" [(ngModel)]="mcp.scope"><option value="personal">Personnel</option>@if (adminTeams().length) { <option value="team">Équipe</option> }@if (auth.isAdmin()) { <option value="global">Global</option> }</select>
        @if (mcp.scope === 'team') { <select class="input" name="mteam" [(ngModel)]="mcp.teamId">@for (t of adminTeams(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }</select> }
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
  protected readonly adminTeams = signal<TeamDto[]>([]);
  protected skillName = '';
  protected skillDesc = '';
  protected skillScope: 'personal' | 'team' | 'global' = 'personal';
  protected skillTeam = '';
  protected skillBody = '';
  protected mcp = { name: '', transport: 'streamable_http', scope: 'personal', teamId: '', url: '', auth: '', command: '', args: '' };

  async ngOnInit() {
    const [s, m, t] = await Promise.all([this.api.get<SkillDto[]>('/skills'), this.api.get<McpServerDto[]>('/mcp-servers'), this.api.get<TeamDto[]>('/teams')]);
    this.skills.set(s);
    this.servers.set(m);
    this.adminTeams.set(t.filter((x) => x.myRole === 'team_admin'));
    if (!this.skillTeam && this.adminTeams()[0]) this.skillTeam = this.mcp.teamId = this.adminTeams()[0].id;
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
    return (m.scope === 'personal' && m.ownerId === this.auth.me()?.id) || (m.scope === 'global' && this.auth.isAdmin()) || (m.scope === 'team' && this.adminTeams().some((t) => t.id === m.teamId));
  }

  protected toggleSkill(s: SkillDto, e: Event) {
    return this.act(() => this.api.put(`/skills/${s.id}/installation`, { scope: 'personal', enabled: (e.target as HTMLInputElement).checked }));
  }
  protected publish(s: SkillDto) {
    return this.act(() => this.api.post(`/skills/${s.id}/status`, { status: 'published' }));
  }
  protected createSkill() {
    const md = `---\nname: ${this.skillName}\ndescription: ${this.skillDesc.replace(/\n/g, ' ')}\n---\n\n${this.skillBody}`;
    return this.act(
      () => this.api.post('/skills', { name: this.skillName, description: this.skillDesc, scope: this.skillScope, teamId: this.skillScope === 'team' ? this.skillTeam : null, files: [{ path: 'SKILL.md', content: md }] }),
      'Skill créé',
    );
  }
  protected createServer() {
    const m = this.mcp;
    return this.act(
      () =>
        this.api.post('/mcp-servers', {
          name: m.name,
          transport: m.transport,
          scope: m.scope,
          teamId: m.scope === 'team' ? m.teamId : null,
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
