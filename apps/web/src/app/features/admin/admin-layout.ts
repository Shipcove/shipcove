import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'cap-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full">
      <nav class="w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-stone-200 p-3 dark:border-stone-800" aria-label="Administration">
        <div class="mb-2 px-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">Administration</div>
        @for (l of links; track l.path) {
          <a [routerLink]="l.path" routerLinkActive="bg-stone-200 dark:bg-stone-800 font-medium" [routerLinkActiveOptions]="{ exact: l.path === '/admin' }"
            class="block rounded-md px-2.5 py-1.5 text-sm hover:bg-stone-200/70 dark:hover:bg-stone-800">{{ l.label }}</a>
        }
      </nav>
      <div class="min-w-0 flex-1 overflow-y-auto"><div class="mx-auto max-w-6xl px-6 py-6"><router-outlet /></div></div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class AdminLayout {
  protected readonly links = [
    { path: '/admin', label: 'Vue d’ensemble' },
    { path: '/admin/users', label: 'Utilisateurs' },
    { path: '/admin/teams', label: 'Équipes' },
    { path: '/admin/iam', label: 'IAM & connexion' },
    { path: '/admin/models', label: 'Modèles (LiteLLM)' },
    { path: '/admin/quotas', label: 'Quotas & crédits' },
    { path: '/admin/sandboxes', label: 'Sandboxes & previews' },
    { path: '/admin/extensions', label: 'Skills & MCP' },
    { path: '/admin/secrets', label: 'Secrets & stockage' },
    { path: '/admin/notifications', label: 'Notifications & SMTP' },
    { path: '/admin/audit', label: 'Audit & rétention' },
  ];
}
