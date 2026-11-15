import type { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard } from './core/guards';

export const routes: Routes = [
  {
    path: 'auth',
    loadChildren: () => import('./features/auth/auth.routes').then((m) => m.AUTH_ROUTES),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      { path: '', loadComponent: () => import('./features/home/home').then((m) => m.HomePage) },
      { path: 'workspaces/:workspaceId', loadComponent: () => import('./features/workspace/workspace-page').then((m) => m.WorkspacePage) },
      { path: 'usage', loadComponent: () => import('./features/usage/usage').then((m) => m.UsagePage) },
      { path: 'notifications', loadComponent: () => import('./features/notifications/notifications').then((m) => m.NotificationsPage) },
      { path: 'settings', loadChildren: () => import('./features/settings/settings.routes').then((m) => m.SETTINGS_ROUTES) },
      { path: 'extensions', loadComponent: () => import('./features/extensions/extensions').then((m) => m.ExtensionsPage) },
      { path: 'extensions/skills/:skillId', loadComponent: () => import('./features/extensions/skill-editor').then((m) => m.SkillEditor) },
      { path: 'admin', canActivate: [adminGuard], loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
    ],
  },
  { path: '**', redirectTo: '' },
];

export { guestGuard };
