import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import type { WorkspaceDto } from '@cap/contracts';
import { Api } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { ThemeService } from '../core/theme.service';
import { Icon } from '../shared/icon';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  exact?: boolean;
}

/** Disposition principale : navigation latérale + workspaces récents groupés par projet. */
@Component({
  selector: 'cap-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-screen overflow-hidden">
      @if (!collapsed()) {
        <aside class="flex w-64 shrink-0 flex-col border-r border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60" aria-label="Navigation principale">
          <div class="flex items-center gap-2 px-4 py-3">
            <div class="flex h-7 w-7 items-center justify-center rounded-md bg-accent-600 font-mono text-sm font-bold text-white">π</div>
            <span class="text-sm font-semibold">Coding Agent Platform</span>
            <button class="btn-ghost ml-auto !p-1" (click)="collapsed.set(true)" aria-label="Masquer la navigation"><cap-icon name="sidebar" /></button>
          </div>
          <nav class="space-y-0.5 px-2">
            @for (item of nav(); track item.path) {
              <a [routerLink]="item.path" routerLinkActive="bg-stone-200 dark:bg-stone-800 font-medium" [routerLinkActiveOptions]="{ exact: !!item.exact }"
                class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-stone-700 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800">
                <cap-icon [name]="item.icon" />
                <span class="flex-1">{{ item.label }}</span>
                @if (item.path === '/notifications' && unread() > 0) {
                  <span class="badge bg-accent-600 text-white">{{ unread() }}</span>
                }
              </a>
            }
          </nav>
          <div class="mt-4 flex-1 overflow-y-auto px-2 pb-2">
            @for (group of groups(); track group.project) {
              <div class="mt-3 px-2.5 text-[11px] font-medium tracking-wide text-stone-500 uppercase">{{ group.project }}</div>
              @for (w of group.items; track w.id) {
                <a [routerLink]="['/workspaces', w.id]" routerLinkActive="bg-stone-200 dark:bg-stone-800"
                  class="flex items-center gap-2 truncate rounded-md px-2.5 py-1.5 text-sm text-stone-700 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full" [class]="w.status === 'running' ? 'bg-emerald-500' : w.status === 'error' ? 'bg-red-500' : 'bg-stone-400'"></span>
                  <span class="truncate">{{ w.name }}</span>
                  @if (w.access === 'shared_read') { <cap-icon name="share" [size]="12" class="text-stone-400" /> }
                  @if (w.activeRunStatus === 'running') { <span class="ml-auto h-2 w-2 animate-pulse rounded-full bg-accent-500" title="Pi travaille"></span> }
                </a>
              }
            }
          </div>
          <div class="flex items-center gap-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
            <div class="flex h-7 w-7 items-center justify-center rounded-full bg-stone-300 text-xs font-semibold dark:bg-stone-700">{{ initials() }}</div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ auth.me()?.displayName }}</div>
              <div class="truncate text-xs text-stone-500">{{ auth.me()?.email }}</div>
            </div>
            <button class="btn-ghost !p-1.5" (click)="toggleTheme()" [attr.aria-label]="theme.isDark() ? 'Thème clair' : 'Thème sombre'"><cap-icon [name]="theme.isDark() ? 'sun' : 'moon'" /></button>
            <button class="btn-ghost !p-1.5" (click)="auth.logout()" aria-label="Se déconnecter"><cap-icon name="logout" /></button>
          </div>
        </aside>
      } @else {
        <button class="btn-ghost fixed top-2 left-2 z-30 !p-1.5" (click)="collapsed.set(false)" aria-label="Afficher la navigation"><cap-icon name="sidebar" /></button>
      }
      <main class="min-w-0 flex-1 overflow-hidden">
        <router-outlet />
      </main>
    </div>
  `,
})
export class Shell implements OnInit, OnDestroy {
  protected readonly auth = inject(AuthStore);
  protected readonly theme = inject(ThemeService);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly collapsed = signal(false);
  protected readonly workspaces = signal<WorkspaceDto[]>([]);
  protected readonly unread = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  protected readonly nav = computed<NavItem[]>(() => [
    { path: '/', label: 'Accueil', icon: 'home', exact: true },
    { path: '/projects', label: 'Projets', icon: 'folder' },
    { path: '/teams', label: 'Équipes', icon: 'users' },
    { path: '/usage', label: 'Consommation', icon: 'chart' },
    { path: '/extensions', label: 'Skills & MCP', icon: 'puzzle' },
    { path: '/notifications', label: 'Notifications', icon: 'bell' },
    { path: '/settings', label: 'Paramètres', icon: 'settings' },
    ...(this.auth.isAdmin() ? [{ path: '/admin', label: 'Administration', icon: 'shield' }] : []),
  ]);

  protected readonly groups = computed(() => {
    const map = new Map<string, WorkspaceDto[]>();
    for (const w of this.workspaces()) {
      if (w.archivedAt) continue;
      map.set(w.projectName, [...(map.get(w.projectName) ?? []), w]);
    }
    return [...map.entries()].map(([project, items]) => ({ project, items }));
  });

  protected readonly initials = computed(() =>
    (this.auth.me()?.displayName ?? '?')
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  ngOnInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 20_000);
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => void this.refresh());
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  protected toggleTheme(): void {
    this.theme.set(this.theme.isDark() ? 'light' : 'dark');
  }

  private async refresh(): Promise<void> {
    try {
      this.workspaces.set(await this.api.get<WorkspaceDto[]>('/workspaces'));
      const n = await this.api.get<{ unreadCount: number }>('/notifications', { unread: 'true' });
      this.unread.set(n.unreadCount);
    } catch {
      /* rafraîchissement silencieux */
    }
  }
}
