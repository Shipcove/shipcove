import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'cap-mfa',
  imports: [FormsModule, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout title="Vérification en deux étapes" subtitle="Saisissez le code de votre application d’authentification, ou un code de récupération.">
      @if (error()) { <div class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">{{ error() }}</div> }
      <form (ngSubmit)="submit()" class="space-y-4">
        <input class="input text-center font-mono text-lg tracking-widest" name="code" autocomplete="one-time-code" inputmode="text" [(ngModel)]="code" placeholder="123456" required autofocus />
        <button class="btn-primary w-full" [disabled]="busy()">Vérifier</button>
      </form>
    </cap-auth-layout>
  `,
})
export class MfaPage {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected code = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.verifyMfa(this.code.trim());
      const n = this.route.snapshot.queryParamMap.get('next');
      await this.router.navigateByUrl(n && n.startsWith('/') && !n.startsWith('//') ? n : '/');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'rate_limited' || err.status === 401 && err.code === 'unauthenticated')) {
        await this.router.navigate(['/auth/login'], { queryParams: { error: err.message } });
        return;
      }
      this.error.set(err instanceof ApiError ? err.message : 'Code invalide');
    } finally {
      this.busy.set(false);
    }
  }
}
