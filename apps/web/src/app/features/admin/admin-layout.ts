import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'cap-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col md:flex-row">
      <!-- Mobile : onglets défilants en haut ; à partir de 768 px : menu latéral. -->
      <nav class="flex shrink-0 gap-1 overflow-x-auto border-b border-stone-200 px-2 py-2 md:w-52 md:flex-col md:gap-0 md:space-y-0.5 md:overflow-y-auto md:border-r md:border-b-0 md:p-3 dark:border-stone-800" aria-label="Administration">
        <div class="mb-2 hidden px-2 text-xs font-semibold tracking-wide text-stone-500 uppercase md:block">Administration</div>
        @for (l of links; track l.path) {
          <a [routerLink]="l.path" routerLinkActive="bg-stone-200 dark:bg-stone-800 font-medium" [routerLinkActiveOptions]="{ exact: l.path === '/admin' }"
            class="block shrink-0 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap hover:bg-stone-200/70 dark:hover:bg-stone-800">{{ l.label }}</a>
        }
      </nav>
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto"><div class="mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-6"><router-outlet /></div></div>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class AdminLayout {
  protected readonly links = [
    { path: '/admin', label: 'Vue d’ensemble' },
    { path: '/admin/users', label: 'Utilisateurs' },
    { path: '/admin/invitations', label: 'Invitations' },
    { path: '/admin/repositories', label: 'Dépôts & environnements' },
    { path: '/admin/iam', label: 'IAM & connexion' },
    { path: '/admin/git', label: 'Forges Git' },
    { path: '/admin/models', label: 'Modèles (LiteLLM)' },
    { path: '/admin/quotas', label: 'Quotas & crédits' },
    { path: '/admin/sandboxes', label: 'Sandboxes & previews' },
    { path: '/admin/extensions', label: 'Skills & MCP' },
    { path: '/admin/secrets', label: 'Secrets & stockage' },
    { path: '/admin/notifications', label: 'Notifications & SMTP' },
    { path: '/admin/audit', label: 'Audit & rétention' },
  ];
}
