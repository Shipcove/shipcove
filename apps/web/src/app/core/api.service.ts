import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { t } from './i18n';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ApiErrorBody, ErrorCode } from '@cap/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network_error',
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

/** Client de l'API `/api/v1` (cookies de session + en-tête CSRF ajouté par HttpClient). */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  readonly base = '/api/v1';

  get<T>(url: string, params?: Params): Promise<T> {
    return this.wrap(this.http.get<T>(this.base + url, { params: toParams(params), withCredentials: true }));
  }
  post<T>(url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.wrap(this.http.post<T>(this.base + url, body ?? {}, { withCredentials: true, headers: new HttpHeaders(headers ?? {}) }));
  }
  put<T>(url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.wrap(this.http.put<T>(this.base + url, body ?? {}, { withCredentials: true, headers: new HttpHeaders(headers ?? {}) }));
  }
  patch<T>(url: string, body?: unknown): Promise<T> {
    return this.wrap(this.http.patch<T>(this.base + url, body ?? {}, { withCredentials: true }));
  }
  delete<T>(url: string): Promise<T> {
    return this.wrap(this.http.delete<T>(this.base + url, { withCredentials: true }));
  }
  upload<T>(url: string, form: FormData): Promise<T> {
    return this.wrap(this.http.post<T>(this.base + url, form, { withCredentials: true }));
  }

  private async wrap<T>(obs: import('rxjs').Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(obs);
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        const body = err.error as ApiErrorBody | null;
        if (body?.error) throw new ApiError(err.status, body.error.code, body.error.message, body.error.details, body.error.correlationId);
        if (err.status === 0) throw new ApiError(0, 'network_error', t('Serveur injoignable'));
        throw new ApiError(err.status, 'internal_error', err.message);
      }
      throw err;
    }
  }
}

function toParams(p?: Params): HttpParams | undefined {
  if (!p) return undefined;
  let params = new HttpParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
  return params;
}

/** Clé d'idempotence pour les opérations critiques (rejeu sûr). */
export function idempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
