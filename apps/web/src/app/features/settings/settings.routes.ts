import type { Routes } from '@angular/router';

export const SETTINGS_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./settings').then((m) => m.SettingsPage) },
  { path: 'git', loadComponent: () => import('./settings').then((m) => m.SettingsPage), data: { tab: 'git' } },
];
