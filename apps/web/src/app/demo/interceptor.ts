import { HttpErrorResponse, HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE } from '../core/mode';
import { DemoError, server } from './server';

/** Toutes les requêtes vers l'API sont servies par le backend simulé, avec un court délai réseau. */
export const demoInterceptor: HttpInterceptorFn = (req, next) => {
  const url = new URL(req.urlWithParams, location.href);
  const base = new URL(API_BASE, location.href).pathname;
  if (!url.pathname.startsWith(base)) return next(req);
  const path = url.pathname.slice(base.length) || '/';
  return new Observable((sub) => {
    const timer = setTimeout(() => {
      try {
        const body = server.handle({ method: req.method, path, query: url.searchParams, body: req.body });
        sub.next(new HttpResponse({ status: 200, body: structuredCloneSafe(body), url: req.url }));
        sub.complete();
      } catch (err) {
        const e = err instanceof DemoError ? err : new DemoError(500, 'internal_error', String(err));
        if (!(err instanceof DemoError)) console.error(err);
        sub.error(new HttpErrorResponse({ status: e.status, error: { error: { code: e.code, message: e.message } }, url: req.url }));
      }
    }, 120 + Math.random() * 120);
    return () => clearTimeout(timer);
  });
};

/** Copie de la réponse : l'application ne doit pas modifier l'état du serveur par référence. */
function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? (null as T) : (JSON.parse(JSON.stringify(v)) as T);
}
