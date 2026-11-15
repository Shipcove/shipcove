import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { filter } from 'rxjs';
import type { WorkspaceDto } from '@cap/contracts';
import { Api } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { ConversationsService } from '../core/conversations.service';
import { ThemeService } from '../core/theme.service';
import { ToastService } from '../core/toast.service';
import { Icon } from '../shared/icon';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const COLLAPSED_KEY = 'cap.sidebar.collapsedRepos';

/**
 * Disposition principale : nouvelle conversation, conversations regroupées par dépôt Git puis
 * celles sans dépôt par date, liens secondaires et compte en bas.
 */
@Component({
  selector: 'cap-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgTemplateOutlet, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-screen overflow-hidden">
      @if (!collapsed()) {
        <aside class="flex w-72 shrink-0 flex-col border-r border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60" aria-label="Navigation principale">
          <div class="flex items-center gap-2 px-4 py-3">
            <div class="flex h-7 w-7 items-center justify-center rounded-md bg-accent-600 font-mono text-sm font-bold text-white">π</div>
            <span class="text-sm font-semibold">Shipcove</span>
            <button class="btn-ghost ml-auto !p-1" (click)="collapsed.set(true)" aria-label="Masquer la navigation"><cap-icon name="sidebar" /></button>
          </div>
          <div class="px-2">
            <a routerLink="/" [queryParams]="{ new: 1 }" class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-stone-800 hover:bg-stone-200/70 dark:text-stone-200 dark:hover:bg-stone-800">
              <cap-icon name="plus" /> Nouvelle conversation
            </a>
          </div>

          <nav class="mt-2 flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversations">
            @for (g of conversations.byRepository(); track g.key) {
              <div class="mt-3">
                <div class="group flex items-center rounded-md pr-1">
                  <button class="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-left text-xs font-semibold text-stone-500 hover:text-stone-800 dark:hover:text-stone-200" (click)="toggleRepo(g.key)" [attr.aria-expanded]="!isCollapsed(g.key)" [title]="g.host + '/' + g.fullName">
                    <cap-icon name="git" [size]="13" />
                    <span class="truncate">{{ g.name }}</span>
                    <cap-icon [name]="isCollapsed(g.key) ? 'chevronRight' : 'chevronDown'" [size]="12" class="opacity-60" />
                    <span class="ml-auto font-normal opacity-0 group-hover:opacity-100">{{ g.items.length }}</span>
                  </button>
                  <a [routerLink]="['/']" [queryParams]="{ repo: g.key }" class="rounded p-0.5 text-stone-500 opacity-0 group-hover:opacity-100 hover:bg-stone-200 focus:opacity-100 dark:hover:bg-stone-700"
                    [attr.aria-label]="'Nouvelle conversation dans ' + g.fullName" title="Nouvelle conversation dans ce dépôt"><cap-icon name="plus" [size]="12" /></a>
                </div>
                @if (!isCollapsed(g.key)) {
                  @for (w of g.items; track w.id) { <ng-container *ngTemplateOutlet="item; context: { $implicit: w }" /> }
                }
              </div>
            }
            @if (conversations.withoutRepository().length) {
              <div class="mt-4 px-2.5 text-xs font-semibold text-stone-500">Conversations</div>
              @for (g of conversations.withoutRepository(); track g.label) {
                <div class="mt-2 px-2.5 text-[11px] text-stone-400">{{ g.label }}</div>
                @for (w of g.items; track w.id) { <ng-container *ngTemplateOutlet="item; context: { $implicit: w }" /> }
              }
            }
            @if (!conversations.all().length) {
              <p class="mt-4 px-2.5 text-xs text-stone-500">Vos conversations apparaîtront ici.</p>
            }
          </nav>

          <div class="border-t border-stone-200 px-2 py-2 dark:border-stone-800">
            @for (item of nav(); track item.path) {
              <a [routerLink]="item.path" routerLinkActive="bg-stone-200 dark:bg-stone-800 font-medium"
                class="flex items-center gap-2.5 rounded-md px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-200/70 dark:text-stone-400 dark:hover:bg-stone-800">
                <cap-icon [name]="item.icon" [size]="15" />
                <span class="flex-1">{{ item.label }}</span>
                @if (item.path === '/notifications' && unread() > 0) { <span class="badge bg-accent-600 text-white">{{ unread() }}</span> }
              </a>
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

    <ng-template #item let-w>
      <div class="group/item relative">
        <a [routerLink]="['/workspaces', w.id]" routerLinkActive="bg-stone-200 font-medium text-stone-900 dark:bg-stone-800 dark:text-stone-100"
          class="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-6 text-sm text-stone-700 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800"
          [class.group-hover/item:pr-8]="w.access === 'owner'" [title]="w.name">
          <span class="truncate">{{ w.name }}</span>
          @if (w.access === 'shared_read') { <cap-icon name="share" [size]="12" class="shrink-0 text-stone-400" /> }
          @if (w.activeRunStatus === 'running' || w.activeRunStatus === 'queued') { <span class="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-500 group-hover/item:hidden" title="Pi travaille"></span> }
        </a>
        @if (w.access === 'owner') {
          <button class="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded p-1 text-stone-500 group-hover/item:block hover:bg-stone-300/70 hover:text-red-600 focus-visible:block dark:hover:bg-stone-700"
            (click)="remove(w)" [disabled]="deleting() === w.id" [attr.aria-label]="'Supprimer « ' + w.name + ' »'" title="Supprimer la conversation">
            <cap-icon name="trash" [size]="13" />
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class Shell implements OnInit, OnDestroy {
  protected readonly auth = inject(AuthStore);
  protected readonly theme = inject(ThemeService);
  protected readonly conversations = inject(ConversationsService);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly collapsed = signal(false);
  protected readonly unread = signal(0);
  protected readonly deleting = signal<string | null>(null);
  private readonly toast = inject(ToastService);
  private readonly collapsedRepos = signal<Set<string>>(readCollapsed());
  private timer: ReturnType<typeof setInterval> | null = null;

  protected readonly nav = computed<NavItem[]>(() => [
    { path: '/usage', label: 'Consommation', icon: 'chart' },
    { path: '/extensions', label: 'Skills & MCP', icon: 'puzzle' },
    { path: '/notifications', label: 'Notifications', icon: 'bell' },
    { path: '/settings', label: 'Paramètres', icon: 'settings' },
    ...(this.auth.isAdmin() ? [{ path: '/admin', label: 'Administration', icon: 'shield' }] : []),
  ]);

  protected readonly initials = computed(() =>
    (this.auth.me()?.displayName ?? '?')
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  protected isCollapsed(key: string): boolean {
    return this.collapsedRepos().has(key);
  }

  protected toggleRepo(key: string): void {
    const next = new Set(this.collapsedRepos());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.collapsedRepos.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* stockage indisponible : préférence non conservée */
    }
  }

  ngOnInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 20_000);
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => void this.refresh());
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Suppression définitive : sandbox, sauvegardes, fichiers et historique. */
  protected async remove(w: WorkspaceDto): Promise<void> {
    if (!confirm(`Supprimer définitivement « ${w.name} » ?\n\nLa sandbox, ses sauvegardes, les fichiers, pièces jointes et tout l’historique seront effacés.${w.activeRunStatus ? '\nPi est en train de travailler : sa tâche sera interrompue.' : ''}`)) return;
    this.deleting.set(w.id);
    try {
      await this.api.delete(`/workspaces/${w.id}`);
      this.conversations.remove(w.id);
      if (this.router.url.startsWith(`/workspaces/${w.id}`)) await this.router.navigateByUrl('/');
      this.toast.show('Conversation supprimée', 'success');
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.deleting.set(null);
    }
  }

  protected toggleTheme(): void {
    this.theme.set(this.theme.isDark() ? 'light' : 'dark');
  }

  private async refresh(): Promise<void> {
    await this.conversations.refresh();
    try {
      const n = await this.api.get<{ unreadCount: number }>('/notifications', { unread: 'true' });
      this.unread.set(n.unreadCount);
    } catch {
      /* rafraîchissement silencieux */
    }
  }
}

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export type { WorkspaceDto };
