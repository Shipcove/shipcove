import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api, ApiError } from '../../core/api.service';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'cap-register',
  imports: [FormsModule, RouterLink, AuthLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cap-auth-layout title="Créer un compte">
      @if (done()) {
        <p class="text-sm">{{ done() === 'verification_sent' ? 'Un email de vérification vous a été envoyé.' : 'Compte créé.' }}</p>
        <a routerLink="/auth/login" class="btn-primary mt-4 w-full">Se connecter</a>
      } @else {
        @if (error()) { <div class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">{{ error() }}</div> }
        <form (ngSubmit)="submit()" class="space-y-3">
          <div><label class="label" for="em">Email</label><input id="em" class="input" type="email" name="email" [(ngModel)]="form.email" required /></div>
          <div><label class="label" for="us">Identifiant</label><input id="us" class="input" name="username" [(ngModel)]="form.username" required /></div>
          <div><label class="label" for="dn">Nom affiché</label><input id="dn" class="input" name="displayName" [(ngModel)]="form.displayName" required /></div>
          <div><label class="label" for="pw">Mot de passe (12 caractères min.)</label><input id="pw" class="input" type="password" name="password" autocomplete="new-password" [(ngModel)]="form.password" required minlength="12" /></div>
          <button class="btn-primary w-full" [disabled]="busy()">Créer le compte</button>
        </form>
      }
    </cap-auth-layout>
  `,
})
export class RegisterPage {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  protected form = { email: '', username: '', displayName: '', password: '' };
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly done = signal<string | null>(null);

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      const invitationToken = this.route.snapshot.queryParamMap.get('invitation') ?? undefined;
      const r = await this.api.post<{ status: string }>('/auth/register', { ...this.form, invitationToken });
      this.done.set(r.status);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Inscription impossible');
    } finally {
      this.busy.set(false);
    }
  }
}
