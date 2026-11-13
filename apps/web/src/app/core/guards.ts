import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthStore } from './auth.store';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const me = auth.loaded() ? auth.me() : await auth.load();
  return me ? true : router.createUrlTree(['/auth/login'], { queryParams: { next: state.url } });
};

/** Confort d'interface uniquement : l'API vérifie le rôle à chaque requête. */
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const me = auth.loaded() ? auth.me() : await auth.load();
  return me?.platformRole === 'platform_admin' ? true : router.createUrlTree(['/']);
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const me = auth.loaded() ? auth.me() : await auth.load();
  return me ? router.createUrlTree(['/']) : true;
};
