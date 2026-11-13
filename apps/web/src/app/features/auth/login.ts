import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AuthProvidersResponse } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'cap-login',
  imports: [FormsModule, RouterLink, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout title="Connexion" subtitle="Plateforme de coding agents">
      @if (error()) { <div class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">{{ error() }}</div> }
      @if (providers()?.localEnabled !== false) {
        <form (ngSubmit)="submit()" class="space-y-4">
          <div>
            <label class="label" for="login">Email ou identifiant</label>
            <input id="login" class="input" name="login" autocomplete="username" [(ngModel)]="login" required />
          </div>
          <div>
            <label class="label" for="password">Mot de passe</label>
            <input id="password" class="input" type="password" name="password" autocomplete="current-password" [(ngModel)]="password" required />
          </div>
          <button class="btn-primary w-full" [disabled]="busy()">{{ busy() ? 'Connexion…' : 'Se connecter' }}</button>
          <div class="flex justify-between text-xs">
            <a routerLink="/auth/forgot-password" class="text-stone-500 hover:underline">Mot de passe oublié ?</a>
            @if (providers()?.registrationEnabled) { <a routerLink="/auth/register" class="text-stone-500 hover:underline">Créer un compte</a> }
          </div>
        </form>
      }
      @if (providers()?.providers?.length) {
        <div class="my-4 flex items-center gap-2 text-xs text-stone-400"><div class="h-px flex-1 bg-stone-200 dark:bg-stone-800"></div>ou<div class="h-px flex-1 bg-stone-200 dark:bg-stone-800"></div></div>
        <div class="space-y-2">
          @for (p of providers()!.providers; track p.id) {
            @if (p.type === 'ldap') {
              <button class="btn-secondary w-full" (click)="ldap.set(p.id)">Annuaire : {{ p.name }}</button>
            } @else {
              <a class="btn-secondary w-full" [href]="p.startUrl">Continuer avec {{ p.name }}</a>
            }
          }
        </div>
        @if (ldap()) {
          <form (ngSubmit)="submitLdap()" class="mt-4 space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800">
            <input class="input" name="lu" placeholder="Identifiant annuaire" [(ngModel)]="login" />
            <input class="input" name="lp" type="password" placeholder="Mot de passe annuaire" [(ngModel)]="password" />
            <button class="btn-primary w-full" [disabled]="busy()">Se connecter via l’annuaire</button>
          </form>
        }
      }
    </cap-auth-layout>
  `,
})
export class LoginPage implements OnInit {
  private readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected login = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly providers = signal<AuthProvidersResponse | null>(null);
  protected readonly ldap = signal<string | null>(null);

  async ngOnInit() {
    this.providers.set(await this.auth.providers().catch(() => null));
    const err = this.route.snapshot.queryParamMap.get('error');
    if (err) this.error.set(err);
  }

  private next(): string {
    const n = this.route.snapshot.queryParamMap.get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : '/';
  }

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.auth.login(this.login, this.password);
      await this.afterLogin(r.status);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Connexion impossible');
    } finally {
      this.busy.set(false);
    }
  }

  async submitLdap() {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ status: string }>('/auth/ldap/login', { providerId: this.ldap(), username: this.login, password: this.password });
      if (r.status === 'authenticated') await this.auth.load();
      await this.afterLogin(r.status);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Connexion impossible');
    } finally {
      this.busy.set(false);
    }
  }

  private async afterLogin(status: string) {
    if (status === 'mfa_required') await this.router.navigate(['/auth/mfa'], { queryParams: { next: this.next() } });
    else if (status === 'mfa_enrollment_required') await this.router.navigate(['/auth/mfa-enroll'], { queryParams: { next: this.next() } });
    else await this.router.navigateByUrl(this.next());
  }
}
