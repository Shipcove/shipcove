import { provideHttpClient, withFetch, withXsrfConfiguration } from '@angular/common/http';
import { provideBrowserGlobalErrorListeners, provideZonelessChangeDetection, type ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    // CSRF : le cookie `cap_csrf` (lié à la session côté serveur) est renvoyé dans `X-CSRF-Token`.
    provideHttpClient(withFetch(), withXsrfConfiguration({ cookieName: 'cap_csrf', headerName: 'X-CSRF-Token' })),
  ],
};
