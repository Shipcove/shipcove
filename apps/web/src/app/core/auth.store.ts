import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { AuthProvidersResponse, LoginResult, MeResponse } from '@cap/contracts';
import { Api, ApiError } from './api.service';

/** État d'authentification (signals). La vérité reste côté serveur (session). */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly me = signal<MeResponse | null>(null);
  readonly loaded = signal(false);
  readonly isAdmin = computed(() => this.me()?.platformRole === 'platform_admin');

  async load(): Promise<MeResponse | null> {
    try {
      this.me.set(await this.api.get<MeResponse>('/me'));
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 401 && err.code !== 'mfa_required')) console.error(err);
      this.me.set(null);
    }
    this.loaded.set(true);
    return this.me();
  }

  providers(): Promise<AuthProvidersResponse> {
    return this.api.get('/auth/providers');
  }

  async login(login: string, password: string): Promise<LoginResult> {
    const r = await this.api.post<LoginResult>('/auth/login', { login, password });
    if (r.status === 'authenticated') this.me.set(r.user);
    return r;
  }

  async verifyMfa(code: string): Promise<LoginResult> {
    const r = await this.api.post<LoginResult>('/auth/mfa/verify', { code });
    if (r.status === 'authenticated') this.me.set(r.user);
    return r;
  }

  async logout(): Promise<void> {
    await this.api.post('/auth/logout').catch(() => undefined);
    this.me.set(null);
    await this.router.navigateByUrl('/auth/login');
  }
}
