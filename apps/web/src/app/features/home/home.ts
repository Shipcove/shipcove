import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { NotificationDto, UsageSummaryDto, WorkspaceDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { Icon } from '../../shared/icon';
import { AgoPipe } from '../../shared/pipes';
import { QUOTA_WARN, formatReset, quotaBarClass, quotaPct, quotaTextClass } from '../../shared/quota';

@Component({
  selector: 'cap-home',
  imports: [RouterLink, Icon, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto">
      <div class="mx-auto max-w-5xl px-6 py-8">
        <h1 class="text-2xl font-semibold">Bonjour {{ auth.me()?.displayName }}</h1>
        <p class="mt-1 text-sm text-stone-500">Reprenez un workspace ou démarrez une nouvelle tâche.</p>
        <div class="mt-6 grid gap-4 md:grid-cols-3">
          @for (w of windows(); track w.window) {
            @let p = pct(w);
            <div class="card p-4">
              <div class="text-xs text-stone-500 uppercase">Quota · {{ w.window === '5h' ? '5 heures' : '7 jours' }}</div>
              @if (p === null) {
                <div class="mt-1 text-2xl font-semibold">Illimité</div>
              } @else {
                <div class="mt-1 text-2xl font-semibold tabular-nums" [class]="p >= warnAt ? textClass(p) : ''">{{ p }} %<span class="text-sm font-normal text-stone-500"> utilisé</span></div>
                <div class="mt-2 h-1.5 rounded bg-stone-200 dark:bg-stone-800"><div class="h-1.5 rounded" [class]="barClass(p)" [style.width.%]="p"></div></div>
                @if (w.resetsAt) { <div class="mt-1.5 text-xs text-stone-500">Réinitialisation {{ reset(w.resetsAt) }}</div> }
              }
            </div>
          }
          <a routerLink="/projects" class="card flex items-center gap-3 p-4 hover:border-accent-500">
            <cap-icon name="plus" [size]="20" /><div><div class="font-medium">Nouveau workspace</div><div class="text-xs text-stone-500">Depuis un projet existant</div></div>
          </a>
        </div>
        <h2 class="mt-8 mb-2 text-sm font-semibold tracking-wide text-stone-500 uppercase">Workspaces récents</h2>
        <div class="card divide-y divide-stone-100 dark:divide-stone-800">
          @for (w of recent(); track w.id) {
            <a [routerLink]="['/workspaces', w.id]" class="flex items-center gap-3 px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-800/50">
              <span class="h-2 w-2 rounded-full" [class]="w.status === 'running' ? 'bg-emerald-500' : 'bg-stone-400'"></span>
              <div class="min-w-0 flex-1"><div class="truncate font-medium">{{ w.name }}</div><div class="text-xs text-stone-500">{{ w.projectName }}</div></div>
              @if (w.activeRunStatus) { <span class="badge bg-accent-100 text-accent-700">{{ w.activeRunStatus }}</span> }
              <span class="text-xs text-stone-500">{{ w.lastActivityAt ?? w.createdAt | ago }}</span>
            </a>
          } @empty {
            <p class="px-4 py-6 text-sm text-stone-500">Aucun workspace. Ouvrez un projet pour en créer un.</p>
          }
        </div>
        <h2 class="mt-8 mb-2 text-sm font-semibold tracking-wide text-stone-500 uppercase">Notifications non lues</h2>
        <div class="card divide-y divide-stone-100 dark:divide-stone-800">
          @for (n of notifications(); track n.id) {
            <a [routerLink]="n.link ?? '/notifications'" class="block px-4 py-2.5 text-sm hover:bg-stone-50 dark:hover:bg-stone-800/50">
              <div class="font-medium">{{ n.title }}</div><div class="text-xs text-stone-500">{{ n.body }} · {{ n.createdAt | ago }}</div>
            </a>
          } @empty { <p class="px-4 py-4 text-sm text-stone-500">Rien de nouveau.</p> }
        </div>
      </div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class HomePage implements OnInit {
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  protected readonly workspaces = signal<WorkspaceDto[]>([]);
  protected readonly usage = signal<UsageSummaryDto | null>(null);
  protected readonly notifications = signal<NotificationDto[]>([]);
  protected readonly recent = computed(() =>
    [...this.workspaces()].sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)).slice(0, 8),
  );
  protected readonly windows = computed(() => this.usage()?.user.windows ?? []);

  async ngOnInit() {
    const [w, u, n] = await Promise.all([
      this.api.get<WorkspaceDto[]>('/workspaces'),
      this.api.get<UsageSummaryDto>('/usage').catch(() => null),
      this.api.get<{ items: NotificationDto[] }>('/notifications', { unread: 'true' }).catch(() => ({ items: [] })),
    ]);
    this.workspaces.set(w);
    this.usage.set(u);
    this.notifications.set(n.items.slice(0, 5));
  }

  protected readonly pct = quotaPct;
  protected readonly barClass = quotaBarClass;
  protected readonly textClass = quotaTextClass;
  protected readonly reset = formatReset;
  protected readonly warnAt = QUOTA_WARN;
}
