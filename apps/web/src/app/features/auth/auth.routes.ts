import type { Routes } from '@angular/router';
import { guestGuard } from '../../core/guards';

export const AUTH_ROUTES: Routes = [
  { path: 'login', canActivate: [guestGuard], loadComponent: () => import('./login').then((m) => m.LoginPage) },
  { path: 'mfa', loadComponent: () => import('./mfa').then((m) => m.MfaPage) },
  { path: 'mfa-enroll', loadComponent: () => import('./mfa-enroll').then((m) => m.MfaEnrollPage) },
  { path: 'register', canActivate: [guestGuard], loadComponent: () => import('./register').then((m) => m.RegisterPage) },
  { path: 'forgot-password', loadComponent: () => import('./password').then((m) => m.ForgotPasswordPage) },
  { path: 'reset-password', loadComponent: () => import('./password').then((m) => m.ResetPasswordPage) },
  { path: 'verify-email', loadComponent: () => import('./password').then((m) => m.VerifyEmailPage) },
  { path: '', pathMatch: 'full', redirectTo: 'login' },
];
