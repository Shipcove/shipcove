import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import type { LlmRequestDto, UsageSummaryDto, WindowUsageDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AgoPipe, CreditsPipe, TokensPipe } from '../../shared/pipes';

interface Breakdown {
  days: number;
  byModel: Array<{ model: string; requests: number; input: number; output: number; cache_read: number; cache_write: number; credits: string; cost: string | null }>;
  byWorkspace: Array<{ workspace_id: string; name: string | null; credits: string; requests: number }>;
}

/** Consommation : crédits (quotas internes), tokens par catégorie et coût provider, distincts. */
@Component({
  selector: 'cap-usage',
  imports: [AgoPipe, CreditsPipe, TokensPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-6xl px-6 py-8">
      <h1 class="text-2xl font-semibold">Consommation</h1>
      <p class="mt-1 text-sm text-stone-500">Les <strong>crédits</strong> sont des quotas internes pondérés par modèle (fenêtres glissantes 5 h et 7 j), distincts des <strong>tokens</strong> consommés, du <strong>coût provider</strong> et de la <strong>taille de contexte</strong>.</p>
      @if (summary(); as s) {
        @if (!s.quotasEnabled) { <p class="mt-2 text-sm text-amber-700">Les quotas sont désactivés par l’administration (la consommation reste mesurée).</p> }
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div class="card p-4"><div class="mb-2 font-medium">Vos crédits</div>
            @for (w of s.user.windows; track w.window) { <div class="mb-3">{{ line(w) }}</div> }
          </div>
          @for (t of s.teams; track t.teamId) {
            <div class="card p-4"><div class="mb-2 font-medium">Équipe {{ t.teamName }}</div>
              @for (w of t.windows; track w.window) { <div class="mb-1 text-sm">{{ line(w) }}</div> }
            </div>
          }
        </div>
      }
      @if (breakdown(); as b) {
        <h2 class="mt-8 mb-2 text-sm font-semibold text-stone-500 uppercase">Par modèle ({{ b.days }} jours)</h2>
        <div class="card overflow-x-auto"><table class="table">
          <thead><tr><th>Modèle</th><th>Requêtes</th><th>Entrée</th><th>Sortie</th><th>Cache lu</th><th>Cache écrit</th><th>Crédits</th><th>Coût provider</th></tr></thead>
          <tbody>@for (m of b.byModel; track m.model) { <tr><td class="font-mono text-xs">{{ m.model }}</td><td>{{ m.requests }}</td><td>{{ m.input | tokens }}</td><td>{{ m.output | tokens }}</td><td>{{ m.cache_read | tokens }}</td><td>{{ m.cache_write | tokens }}</td><td>{{ m.credits | credits }}</td><td>{{ m.cost ? '$' + (+m.cost).toFixed(4) : '—' }}</td></tr> }</tbody>
        </table></div>
        <h2 class="mt-8 mb-2 text-sm font-semibold text-stone-500 uppercase">Par conversation (workspace)</h2>
        <div class="card overflow-x-auto"><table class="table">
          <thead><tr><th>Workspace</th><th>Requêtes</th><th>Crédits</th></tr></thead>
          <tbody>@for (w of b.byWorkspace; track w.workspace_id) { <tr><td>{{ w.name ?? '—' }}</td><td>{{ w.requests }}</td><td>{{ w.credits | credits }}</td></tr> }</tbody>
        </table></div>
      }
      <h2 class="mt-8 mb-2 text-sm font-semibold text-stone-500 uppercase">Dernières requêtes</h2>
      <div class="card overflow-x-auto"><table class="table">
        <thead><tr><th>Date</th><th>Modèle</th><th>Statut</th><th>Entrée</th><th>Sortie</th><th>Cache lu/écrit</th><th>Crédits</th><th>Latence</th></tr></thead>
        <tbody>@for (r of requests(); track r.id) {
          <tr><td class="text-xs">{{ r.createdAt | ago }}</td><td class="font-mono text-xs">{{ r.model }}</td><td>{{ r.status }}@if (r.estimated) { <span class="text-amber-600"> (estimé)</span> }</td>
          <td>{{ r.inputTokens | tokens }}</td><td>{{ r.outputTokens | tokens }}</td><td>{{ r.cacheReadTokens | tokens }} / {{ r.cacheWriteTokens | tokens }}</td><td>{{ r.credits | credits: 4 }}</td><td>{{ r.latencyMs ? r.latencyMs + ' ms' : '—' }}</td></tr>
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

  async ngOnInit() {
    const [s, b, r] = await Promise.all([this.api.get<UsageSummaryDto>('/usage'), this.api.get<Breakdown>('/usage/breakdown'), this.api.get<LlmRequestDto[]>('/usage/requests')]);
    this.summary.set(s);
    this.breakdown.set(b);
    this.requests.set(r);
  }

  protected line(w: WindowUsageDto): string {
    const label = w.window === '5h' ? '5 heures' : '7 jours';
    if (w.exempt) return `${label} : ${fmt(w.used)} crédits (exempté)`;
    return `${label} : ${fmt(w.used)} utilisés${Number(w.reserved) > 0 ? ` + ${fmt(w.reserved)} réservés` : ''} / ${w.limit === null ? 'illimité' : fmt(w.limit)} — reste ${w.remaining === null ? '∞' : fmt(w.remaining)}`;
  }
}

function fmt(v: string) {
  return Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}
