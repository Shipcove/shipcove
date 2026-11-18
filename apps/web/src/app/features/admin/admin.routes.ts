import type { Routes } from '@angular/router';

export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./admin-layout').then((m) => m.AdminLayout),
    children: [
      { path: '', loadComponent: () => import('./admin-overview').then((m) => m.AdminOverview) },
      { path: 'users', loadComponent: () => import('./admin-people').then((m) => m.AdminUsers) },
      { path: 'invitations', loadComponent: () => import('./admin-people').then((m) => m.AdminInvitations) },
      { path: 'iam', loadComponent: () => import('./admin-iam').then((m) => m.AdminIam) },
      { path: 'git', loadComponent: () => import('./admin-git').then((m) => m.AdminGit) },
      { path: 'models', loadComponent: () => import('./admin-models').then((m) => m.AdminModels) },
      { path: 'quotas', loadComponent: () => import('./admin-quotas').then((m) => m.AdminQuotas) },
      { path: 'sandboxes', loadComponent: () => import('./admin-platform').then((m) => m.AdminSandboxes) },
      { path: 'extensions', loadComponent: () => import('./admin-platform').then((m) => m.AdminExtensions) },
      { path: 'secrets', loadComponent: () => import('./admin-platform').then((m) => m.AdminSecrets) },
      { path: 'notifications', loadComponent: () => import('./admin-platform').then((m) => m.AdminNotifications) },
      { path: 'audit', loadComponent: () => import('./admin-platform').then((m) => m.AdminAudit) },
    ],
  },
];
