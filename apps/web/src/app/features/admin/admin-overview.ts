import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import type { AdminOverviewDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { CreditsPipe } from '../../shared/pipes';

@Component({
  selector: 'cap-admin-overview',
  imports: [CreditsPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Vue d’ensemble</h1>
    @if (o(); as o) {
      <div class="mt-4 grid gap-3 md:grid-cols-4">
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Utilisateurs</div><div class="text-2xl font-semibold">{{ o.users.active }}</div><div class="text-xs text-stone-500">{{ o.users.total }} au total · {{ o.users.suspended }} suspendu(s)</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Équipes</div><div class="text-2xl font-semibold">{{ o.teams }}</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Workspaces</div><div class="text-2xl font-semibold">{{ o.workspaces.total }}</div><div class="text-xs text-stone-500">{{ o.workspaces.running }} actif(s)</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Sandboxes actives</div><div class="text-2xl font-semibold">{{ o.sandboxes.active }}</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Appels LLM 24 h</div><div class="text-2xl font-semibold">{{ o.llm.requests24h }}</div><div class="text-xs text-stone-500">{{ o.llm.errors24h }} erreur(s) · p95 {{ o.llm.p95LatencyMs ?? '—' }} ms</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Crédits 24 h</div><div class="text-2xl font-semibold">{{ o.llm.credits24h | credits }}</div><div class="text-xs text-stone-500">coût provider \${{ (+o.llm.costUsd24h).toFixed(2) }}</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Checkpoints</div><div class="text-2xl font-semibold" [class.text-red-600]="o.checkpoints.unsyncedWorkspaces">{{ o.checkpoints.unsyncedWorkspaces }}</div><div class="text-xs text-stone-500">workspace(s) non synchronisé(s) · {{ o.checkpoints.failed24h }} échec(s) 24 h</div></div>
        <div class="card p-4"><div class="text-xs text-stone-500 uppercase">Jobs</div><div class="text-2xl font-semibold">{{ o.jobs.pending }}</div><div class="text-xs text-stone-500">en attente · {{ o.jobs.failed }} en échec définitif</div></div>
      </div>
      <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">Santé</h2>
      <div class="card divide-y divide-stone-100 dark:divide-stone-800">
        @for (h of health(); track h.name) {
          <div class="flex items-center gap-2 px-4 py-2 text-sm"><span class="h-2 w-2 rounded-full" [class]="h.status === 'up' ? 'bg-emerald-500' : 'bg-red-500'"></span><span class="font-medium">{{ h.name }}</span><span class="text-stone-500">{{ h.detail }}</span></div>
        }
      </div>
    }
  `,
})
export class AdminOverview implements OnInit {
  private readonly api = inject(Api);
  protected readonly o = signal<AdminOverviewDto | null>(null);
  protected readonly health = signal<Array<{ name: string; status: string; detail?: string }>>([]);
  async ngOnInit() {
    const o = await this.api.get<AdminOverviewDto>('/admin/overview');
    this.o.set(o);
    this.health.set(Object.entries(o.health).map(([name, v]) => ({ name, ...v })));
  }
}
