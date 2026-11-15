import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { QuotaWindowDto, UsageBreakdownDto, UsageRequestDto, UsageSummaryDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AgoPipe } from '../../shared/pipes';
import { QUOTA_DANGER, QUOTA_WARN, formatReset, quotaBarClass, quotaPct, quotaTextClass, windowLabel } from '../../shared/quota';

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
              @for (r of b.byWorkspace; track r.workspaceId) {
                <div class="mb-3 last:mb-0"><div class="flex text-sm"><span class="truncate">{{ r.name ?? '—' }}</span><span class="ml-auto tabular-nums text-stone-500">{{ r.percent }} %</span></div>
                  <div class="mt-1 h-1.5 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1.5 rounded bg-accent-500" [style.width.%]="r.percent"></div></div></div>
              } @empty { <p class="text-sm text-stone-500">Aucune activité.</p> }
            </div>
          </div>
          <div>
            <h2 class="mb-2 text-sm font-semibold text-stone-500 uppercase">Par modèle ({{ b.days }} jours)</h2>
            <div class="card p-4">
              @for (r of b.byModel; track r.model) {
                <div class="mb-3 last:mb-0"><div class="flex text-sm"><span class="truncate font-mono text-xs">{{ r.model }}</span><span class="ml-auto tabular-nums text-stone-500">{{ r.percent }} %</span></div>
                  <div class="mt-1 h-1.5 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1.5 rounded bg-accent-500" [style.width.%]="r.percent"></div></div></div>
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
  protected readonly breakdown = signal<UsageBreakdownDto | null>(null);
  protected readonly requests = signal<UsageRequestDto[]>([]);

  protected readonly pct = quotaPct;
  protected readonly barClass = quotaBarClass;
  protected readonly textClass = quotaTextClass;
  protected readonly reset = formatReset;
  protected readonly label = (w: QuotaWindowDto['window']) => windowLabel(w);
  protected readonly warnAt = QUOTA_WARN;
  protected readonly dangerAt = QUOTA_DANGER;

  async ngOnInit() {
    const [s, b, r] = await Promise.all([this.api.get<UsageSummaryDto>('/usage'), this.api.get<UsageBreakdownDto>('/usage/breakdown'), this.api.get<UsageRequestDto[]>('/usage/requests')]);
    this.summary.set(s);
    this.breakdown.set(b);
    this.requests.set(r);
  }

  protected status(s: string): string {
    return ({ completed: 'Terminée', failed: 'Échec', rejected: 'Refusée (quota)', in_progress: 'En cours' } as Record<string, string>)[s] ?? s;
  }
}
