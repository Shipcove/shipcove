import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import type { MeResponse, TotpEnrollResponse } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { QrCode } from '../../shared/qr-code';
import { AuthLayout } from './auth-layout';
import { t, tr } from '../../core/i18n';

/** Enrôlement TOTP (imposé par la politique ou volontaire). */
@Component({
  selector: 'cap-mfa-enroll',
  imports: [FormsModule, AuthLayout, QrCode],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout [title]="t('Activer la double authentification')" [subtitle]="t('Requis par la politique de sécurité de votre organisation.')">
      @if (error()) { <div class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">{{ error() }}</div> }
      @if (codes().length === 0) {
        @if (enroll(); as e) {
          <ol class="mb-4 list-decimal space-y-2 pl-4 text-sm text-stone-600 dark:text-stone-300">
            <li>{{ t('Scannez ce QR code avec votre application d’authentification (Google Authenticator, Authy, 1Password…).') }}</li>
            <li>{{ t('Saisissez le code à 6 chiffres affiché.') }}</li>
          </ol>
          <div class="mb-3 flex justify-center">
            <cap-qr-code [value]="e.otpauthUrl" [size]="200" label="QR code de configuration TOTP" />
          </div>
          <details class="mb-4 text-sm text-stone-600 dark:text-stone-300">
            <summary class="cursor-pointer text-center text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300">{{ t('Impossible de scanner ?') }}</summary>
            <a [href]="e.otpauthUrl" class="btn-secondary mt-2 w-full">{{ t('Ouvrir dans l’application') }}</a>
            <p class="mt-2 text-xs text-stone-500">{{ t('Ou saisissez cette clé manuellement :') }}</p>
            <div class="mt-1 rounded-md bg-stone-100 p-2 text-center font-mono text-xs break-all select-all dark:bg-stone-800">{{ e.secret }}</div>
          </details>
          <form (ngSubmit)="confirm()" class="space-y-3">
            <input class="input text-center font-mono text-lg tracking-widest" name="code" inputmode="numeric" maxlength="6" [(ngModel)]="code" placeholder="123456" required />
            <button class="btn-primary w-full" [disabled]="busy()">{{ t('Activer') }}</button>
          </form>
        } @else {
          <p class="text-sm text-stone-500">{{ t('Préparation…') }}</p>
        }
      } @else {
        <p class="mb-3 text-sm">{{ t('Conservez ces codes de récupération en lieu sûr. Ils ne seront plus affichés.') }}</p>
        <div class="mb-4 grid grid-cols-2 gap-1 rounded-md bg-stone-100 p-3 font-mono text-sm dark:bg-stone-800">
          @for (c of codes(); track c) { <span>{{ c }}</span> }
        </div>
        <button class="btn-primary w-full" (click)="done()">{{ t('J’ai conservé mes codes') }}</button>
      }
    </cap-auth-layout>
  `,
})
export class MfaEnrollPage implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly enroll = signal<TotpEnrollResponse | null>(null);
  protected readonly codes = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected code = '';

  async ngOnInit() {
    try {
      this.enroll.set(await this.api.post<TotpEnrollResponse>('/auth/mfa/totp/enroll'));
    } catch (err) {
      this.error.set(err instanceof ApiError ? tr(err.message) : t('Enrôlement impossible'));
    }
  }

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ codes: string[]; user: MeResponse }>('/auth/mfa/totp/confirm', { code: this.code });
      this.auth.me.set(r.user);
      this.codes.set(r.codes);
    } catch (err) {
      this.error.set(err instanceof ApiError ? tr(err.message) : t('Code invalide'));
    } finally {
      this.busy.set(false);
    }
  }

  async done() {
    const n = this.route.snapshot.queryParamMap.get('next');
    await this.router.navigateByUrl(n && n.startsWith('/') && !n.startsWith('//') ? n : '/');
  }
}
