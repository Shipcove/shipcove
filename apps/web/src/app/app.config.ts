import { provideHttpClient, withFetch, withXsrfConfiguration } from '@angular/common/http';
import { provideBrowserGlobalErrorListeners, provideZonelessChangeDetection, type ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { httpFeatures, modeProviders, routerFeatures } from './core/mode';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), ...routerFeatures),
    // CSRF : le cookie `cap_csrf` (lié à la session côté serveur) est renvoyé dans `X-CSRF-Token`.
    provideHttpClient(withFetch(), withXsrfConfiguration({ cookieName: 'cap_csrf', headerName: 'X-CSRF-Token' }), ...httpFeatures),
    ...modeProviders,
  ],
};
