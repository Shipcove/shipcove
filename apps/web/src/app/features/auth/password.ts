import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api, ApiError } from '../../core/api.service';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'cap-forgot',
  imports: [FormsModule, RouterLink, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout title="Mot de passe oublié">
      @if (sent()) {
        <p class="text-sm">Si un compte correspond, un email de réinitialisation a été envoyé.</p>
      } @else {
        <form (ngSubmit)="submit()" class="space-y-3">
          <input class="input" type="email" name="email" placeholder="vous@exemple.com" [(ngModel)]="email" required />
          <button class="btn-primary w-full">Envoyer le lien</button>
        </form>
      }
      <a routerLink="/auth/login" class="mt-4 block text-center text-xs text-stone-500 hover:underline">Retour à la connexion</a>
    </cap-auth-layout>
  `,
})
export class ForgotPasswordPage {
  private readonly api = inject(Api);
  protected email = '';
  protected readonly sent = signal(false);
  async submit() {
    await this.api.post('/auth/password/forgot', { email: this.email }).catch(() => undefined);
    this.sent.set(true);
  }
}

@Component({
  selector: 'cap-reset',
  imports: [FormsModule, RouterLink, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout title="Nouveau mot de passe">
      @if (done()) {
        <p class="text-sm">Mot de passe modifié. Toutes vos sessions ont été fermées.</p>
        <a routerLink="/auth/login" class="btn-primary mt-4 w-full">Se connecter</a>
      } @else {
        @if (error()) { <div class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error() }}</div> }
        <form (ngSubmit)="submit()" class="space-y-3">
          <input class="input" type="password" name="pw" autocomplete="new-password" placeholder="12 caractères minimum" [(ngModel)]="password" required minlength="12" />
          <button class="btn-primary w-full">Enregistrer</button>
        </form>
      }
    </cap-auth-layout>
  `,
})
export class ResetPasswordPage {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  protected password = '';
  protected readonly done = signal(false);
  protected readonly error = signal('');
  async submit() {
    try {
      await this.api.post('/auth/password/reset', { token: this.route.snapshot.queryParamMap.get('token'), password: this.password });
      this.done.set(true);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Échec');
    }
  }
}

@Component({
  selector: 'cap-verify',
  imports: [RouterLink, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout title="Vérification de l’email">
      <p class="text-sm">{{ message() }}</p>
      <a routerLink="/auth/login" class="btn-primary mt-4 w-full">Se connecter</a>
    </cap-auth-layout>
  `,
})
export class VerifyEmailPage implements OnInit {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  protected readonly message = signal('Vérification…');
  async ngOnInit() {
    try {
      await this.api.post('/auth/verify-email', { token: this.route.snapshot.queryParamMap.get('token') });
      this.message.set('Adresse vérifiée. Vous pouvez vous connecter.');
    } catch (err) {
      this.message.set(err instanceof ApiError ? err.message : 'Lien invalide');
    }
  }
}
