import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AdminUserDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AgoPipe, CreditsPipe } from '../../shared/pipes';
import { SettingsSection } from './settings-section';
import { t } from '../../core/i18n';

interface Policy {
  id: string;
  scope: string;
  subjectId: string | null;
  limit5h: string | null;
  limit7d: string | null;
  exempt: boolean;
  version: number;
  createdAt: string;
  active: boolean;
}

@Component({
  selector: 'cap-admin-quotas',
  imports: [FormsModule, SettingsSection, AgoPipe, CreditsPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Quotas & crédits') }}</h1>
    <p class="text-sm text-stone-500">{{ t('Fenêtres glissantes 5 h et 7 jours appliquées simultanément. Quotas strictement personnels : un compteur par utilisateur, toutes conversations confondues. Distinct des limites CPU/RAM/disque.') }}</p>
    <div class="mt-4"><cap-settings-section section="quotas" [title]="t('Activation et réservation')" /></div>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Politiques actives') }}</h2>
    <div class="card overflow-x-auto"><table class="table">
      <thead><tr><th>{{ t('Portée') }}</th><th>{{ t('Sujet') }}</th><th>5 h</th><th>{{ t('7 j') }}</th><th>{{ t('Exempté') }}</th><th>{{ t('Version') }}</th><th></th></tr></thead>
      <tbody>@for (p of policies(); track p.id) {
        <tr><td>{{ p.scope }}</td><td class="text-xs">{{ subjectName(p) }}</td><td>{{ p.limit5h | credits }}</td><td>{{ p.limit7d | credits }}</td><td>{{ p.exempt ? 'oui' : 'non' }}</td><td>v{{ p.version }} · {{ p.createdAt | ago }}</td>
        <td class="text-right"><button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="removePolicy(p)">{{ t('Retirer') }}</button></td></tr>
      } @empty { <tr><td colspan="7" class="text-stone-500">{{ t('Aucune politique : consommation illimitée.') }}</td></tr> }</tbody>
    </table></div>
    <form class="card mt-3 grid gap-2 p-4 md:grid-cols-6" (ngSubmit)="savePolicy()">
      <select class="input" name="sc" [(ngModel)]="p.scope"><option value="global_user_default">{{ t('Défaut par utilisateur') }}</option><option value="user">{{ t('Utilisateur') }}</option></select>
      @if (p.scope === 'user') { <select class="input md:col-span-2" name="su" [(ngModel)]="p.subjectId">@for (u of users(); track u.id) { <option [value]="u.id">{{ u.displayName }} ({{ u.email }})</option> }</select> }
      <input class="input" name="l5" [placeholder]="t('limite 5 h (vide = ∞)')" [(ngModel)]="p.limit5h" />
      <input class="input" name="l7" [placeholder]="t('limite 7 j (vide = ∞)')" [(ngModel)]="p.limit7d" />
      <label class="flex items-center gap-1 text-sm"><input type="checkbox" name="ex" [(ngModel)]="p.exempt" /> {{ t('Exempté') }}</label>
      <button class="btn-primary md:col-span-6 md:w-fit">{{ t('Enregistrer la politique') }}</button>
    </form>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Ajustement administratif') }}</h2>
    <form class="card grid gap-2 p-4 md:grid-cols-4" (ngSubmit)="adjust()">
      <select class="input" name="au" [(ngModel)]="a.userId">@for (u of users(); track u.id) { <option [value]="u.id">{{ u.displayName }}</option> }</select>
      <input class="input" name="aa" [placeholder]="t('Montant (négatif = crédit rendu)')" [(ngModel)]="a.amount" />
      <input class="input" name="ar" [placeholder]="t('Motif')" [(ngModel)]="a.reason" />
      <button class="btn-secondary">{{ t('Appliquer') }}</button>
    </form>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Ledger (500 dernières écritures)') }}</h2>
    <div class="card max-h-96 overflow-auto"><table class="table">
      <thead><tr><th>{{ t('Date') }}</th><th>{{ t('Utilisateur') }}</th><th>{{ t('Type') }}</th><th>{{ t('Montant') }}</th><th>{{ t('Tokens (e/s/cl/ce)') }}</th><th>{{ t('Motif') }}</th></tr></thead>
      <tbody>@for (l of ledger(); track l['id']) {
        <tr><td class="text-xs">{{ l['occurredAt'] | ago }}</td><td class="text-xs">{{ userName(l['userId']) }}</td><td>{{ l['kind'] }}@if (l['estimated']) { <span class="text-amber-600"> {{ t('(estimé)') }}</span> }</td><td>{{ l['amount'] | credits: 4 }}</td>
        <td class="text-xs">{{ l['inputTokens'] ?? '—' }}/{{ l['outputTokens'] ?? '—' }}/{{ l['cacheReadTokens'] ?? '—' }}/{{ l['cacheWriteTokens'] ?? '—' }}</td><td class="text-xs">{{ l['reason'] }}</td></tr>
      }</tbody>
    </table></div>
  `,
})
export class AdminQuotas implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly policies = signal<Policy[]>([]);
  protected readonly users = signal<AdminUserDto[]>([]);
  protected readonly ledger = signal<Array<Record<string, never>>>([]);
  protected p = { scope: 'global_user_default', subjectId: '', limit5h: '', limit7d: '', exempt: false };
  protected a = { userId: '', amount: '', reason: '' };

  async ngOnInit() {
    const [p, u, l] = await Promise.all([this.api.get<Policy[]>('/admin/quotas/policies'), this.api.get<AdminUserDto[]>('/admin/users'), this.api.get<Array<Record<string, never>>>('/admin/quotas/ledger')]);
    this.policies.set(p);
    this.users.set(u);
    this.ledger.set(l);
  }
  protected subjectName(p: Policy) {
    if (!p.subjectId) return '—';
    return this.users().find((u) => u.id === p.subjectId)?.displayName ?? p.subjectId;
  }
  protected userName(id: string) {
    return this.users().find((u) => u.id === id)?.displayName ?? id;
  }
  private async act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      this.toast.show(ok, 'success');
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected savePolicy() {
    return this.act(
      () =>
        this.api.put('/admin/quotas/policies', {
          scope: this.p.scope,
          subjectId: this.p.scope === 'global_user_default' ? null : this.p.subjectId,
          limit5h: this.p.limit5h === '' ? null : String(Number(this.p.limit5h)),
          limit7d: this.p.limit7d === '' ? null : String(Number(this.p.limit7d)),
          exempt: this.p.exempt,
        }),
      t('Politique enregistrée'),
    );
  }
  protected removePolicy(p: Policy) {
    return this.act(() => this.api.delete(`/admin/quotas/policies/${p.id}`), t('Politique retirée'));
  }
  protected adjust() {
    return this.act(() => this.api.post('/admin/quotas/adjustments', { userId: this.a.userId, amount: String(Number(this.a.amount)), reason: this.a.reason }), t('Ajustement enregistré'));
  }
}
