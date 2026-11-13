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
      { path: 'teams', loadComponent: () => import('./features/teams/teams').then((m) => m.TeamsPage) },
      { path: 'teams/:teamId', loadComponent: () => import('./features/teams/team-detail').then((m) => m.TeamDetailPage) },
      { path: 'projects', loadComponent: () => import('./features/projects/projects').then((m) => m.ProjectsPage) },
      { path: 'projects/:projectId', loadComponent: () => import('./features/projects/project-detail').then((m) => m.ProjectDetailPage) },
      { path: 'workspaces/:workspaceId', loadComponent: () => import('./features/workspace/workspace-page').then((m) => m.WorkspacePage) },
      { path: 'usage', loadComponent: () => import('./features/usage/usage').then((m) => m.UsagePage) },
      { path: 'notifications', loadComponent: () => import('./features/notifications/notifications').then((m) => m.NotificationsPage) },
      { path: 'settings', loadChildren: () => import('./features/settings/settings.routes').then((m) => m.SETTINGS_ROUTES) },
      { path: 'extensions', loadComponent: () => import('./features/extensions/extensions').then((m) => m.ExtensionsPage) },
      { path: 'admin', canActivate: [adminGuard], loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
    ],
  },
  { path: '**', redirectTo: '' },
];

export { guestGuard };
