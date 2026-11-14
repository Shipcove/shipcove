import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { LlmRequestDto, UsageSummaryDto, WindowUsageDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AgoPipe } from '../../shared/pipes';
import { QUOTA_DANGER, QUOTA_WARN, formatReset, quotaBarClass, quotaPct, quotaTextClass, windowLabel } from '../../shared/quota';

interface Breakdown {
  days: number;
  byModel: Array<{ model: string; requests: number; credits: string }>;
  byWorkspace: Array<{ workspace_id: string; name: string | null; credits: string; requests: number }>;
}

/**
 * Consommation côté utilisateur : quotas en pourcentage uniquement (jamais de crédits ni de tokens),
 * répartition de l'usage en part relative. Le détail chiffré reste réservé à l'administration.
 */
@Component({
  selector: 'cap-usage',
  imports: [AgoPipe, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-5xl px-6 py-8">
      <h1 class="text-2xl font-semibold">Consommation</h1>
      <p class="mt-1 text-sm text-stone-500">Part de vos quotas utilisée sur des fenêtres glissantes de 5 heures et de 7 jours. À 100 %, l’agent est suspendu jusqu’à la réinitialisation.</p>
      @if (summary(); as s) {
        @if (!s.quotasEnabled) { <p class="mt-2 text-sm text-stone-500">Les quotas sont désactivés par l’administration.</p> }
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div class="card p-4"><div class="mb-3 font-medium">Vos quotas</div>
            @for (w of s.user.windows; track w.window) { <ng-container *ngTemplateOutlet="bar; context: { $implicit: w, label: label(w.window) }" /> }
          </div>
          @for (t of teamsWithLimits(); track t.teamId) {
            <div class="card p-4"><div class="mb-3 font-medium">Équipe {{ t.teamName }}</div>
              @for (w of t.windows; track w.window) { <ng-container *ngTemplateOutlet="bar; context: { $implicit: w, label: label(w.window) }" /> }
            </div>
          }
        </div>
      }
      <ng-template #bar let-w let-label="label">
        @let p = pct(w);
        <div class="mb-4 last:mb-0">
          <div class="flex items-baseline gap-2 text-sm"><span>{{ label }}</span>
            @if (p !== null && w.resetsAt) { <span class="ml-auto text-xs text-stone-500">Réinitialisation {{ reset(w.resetsAt) }}</span> }
            <span class="w-16 text-right tabular-nums" [class.ml-auto]="p === null || !w.resetsAt" [class]="textClass(p)">{{ p === null ? 'Illimité' : p + ' %' }}</span></div>
          @if (p !== null) {
            <div class="mt-1.5 h-2 rounded bg-stone-200 dark:bg-stone-800"><div class="h-2 rounded" [class]="barClass(p)" [style.width.%]="p"></div></div>
            @if (p >= dangerAt) { <div class="mt-1 text-xs text-red-600">Quota presque épuisé.</div> } @else if (p >= warnAt) { <div class="mt-1 text-xs text-orange-600">Vous approchez de votre limite.</div> }
          }
        </div>
      </ng-template>

      @if (breakdown(); as b) {
        <div class="mt-8 grid gap-4 md:grid-cols-2">
          <div>
            <h2 class="mb-2 text-sm font-semibold text-stone-500 uppercase">Par workspace ({{ b.days }} jours)</h2>
            <div class="card p-4">
              @for (r of shares(b.byWorkspace, 'name', 'workspace_id'); track r.key) {
                <div class="mb-3 last:mb-0"><div class="flex text-sm"><span class="truncate">{{ r.label }}</span><span class="ml-auto tabular-nums text-stone-500">{{ r.pct }} %</span></div>
                  <div class="mt-1 h-1.5 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1.5 rounded bg-accent-500" [style.width.%]="r.pct"></div></div></div>
              } @empty { <p class="text-sm text-stone-500">Aucune activité.</p> }
            </div>
          </div>
          <div>
            <h2 class="mb-2 text-sm font-semibold text-stone-500 uppercase">Par modèle ({{ b.days }} jours)</h2>
            <div class="card p-4">
              @for (r of shares(b.byModel, 'model', 'model'); track r.key) {
                <div class="mb-3 last:mb-0"><div class="flex text-sm"><span class="truncate font-mono text-xs">{{ r.label }}</span><span class="ml-auto tabular-nums text-stone-500">{{ r.pct }} %</span></div>
                  <div class="mt-1 h-1.5 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1.5 rounded bg-accent-500" [style.width.%]="r.pct"></div></div></div>
              } @empty { <p class="text-sm text-stone-500">Aucune activité.</p> }
            </div>
          </div>
        </div>
      }
      <h2 class="mt-8 mb-2 text-sm font-semibold text-stone-500 uppercase">Dernières requêtes</h2>
      <div class="card overflow-x-auto"><table class="table">
        <thead><tr><th>Date</th><th>Modèle</th><th>Statut</th><th>Latence</th></tr></thead>
        <tbody>@for (r of requests(); track r.id) {
          <tr><td class="text-xs">{{ r.createdAt | ago }}</td><td class="font-mono text-xs">{{ r.model }}</td><td>{{ status(r.status) }}</td><td>{{ r.latencyMs ? r.latencyMs + ' ms' : '—' }}</td></tr>
        }</tbody>
      </table></div>
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class UsagePage implements OnInit {
  private readonly api = inject(Api);
  protected readonly summary = signal<UsageSummaryDto | null>(null);
  protected readonly breakdown = signal<Breakdown | null>(null);
  protected readonly requests = signal<LlmRequestDto[]>([]);
  protected readonly teamsWithLimits = computed(() => (this.summary()?.teams ?? []).filter((t) => t.windows.some((w) => quotaPct(w) !== null)));

  protected readonly pct = quotaPct;
  protected readonly barClass = quotaBarClass;
  protected readonly textClass = quotaTextClass;
  protected readonly reset = formatReset;
  protected readonly label = (w: WindowUsageDto['window']) => windowLabel(w);
  protected readonly warnAt = QUOTA_WARN;
  protected readonly dangerAt = QUOTA_DANGER;

  async ngOnInit() {
    const [s, b, r] = await Promise.all([this.api.get<UsageSummaryDto>('/usage'), this.api.get<Breakdown>('/usage/breakdown'), this.api.get<LlmRequestDto[]>('/usage/requests')]);
    this.summary.set(s);
    this.breakdown.set(b);
    this.requests.set(r);
  }

  /** Part relative de chaque ligne dans la consommation totale (aucune valeur absolue affichée). */
  protected shares<T extends { credits: string; requests: number }>(rows: T[], labelKey: keyof T, idKey: keyof T) {
    const total = rows.reduce((s, r) => s + Number(r.credits), 0);
    return rows
      .map((r) => ({ key: String(r[idKey]), label: String(r[labelKey] ?? '—'), pct: total > 0 ? Math.round((Number(r.credits) / total) * 100) : 0 }))
      .sort((a, b) => b.pct - a.pct);
  }

  protected status(s: string): string {
    return ({ settled: 'Terminée', failed: 'Échec', rejected: 'Refusée (quota)', reserved: 'En cours', streaming: 'En cours', pending_reconciliation: 'Terminée' } as Record<string, string>)[s] ?? s;
  }
}
