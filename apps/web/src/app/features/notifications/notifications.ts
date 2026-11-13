import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { NotificationDto, NotificationPreferenceDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AgoPipe } from '../../shared/pipes';

const LABELS: Record<string, string> = {
  'run.completed': 'Fin de run',
  'run.failed': 'Échec de run',
  'approval.required': 'Approbation Git requise',
  'quota.reached': 'Quota atteint',
  'quota.available': 'Quota de nouveau disponible',
  'checkpoint.failed': 'Échec de sauvegarde',
  invitation: 'Invitations',
  security: 'Sécurité',
};

@Component({
  selector: 'cap-notifications',
  imports: [FormsModule, RouterLink, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full overflow-y-auto"><div class="mx-auto max-w-3xl px-6 py-8">
      <div class="flex items-center"><h1 class="text-2xl font-semibold">Notifications</h1><button class="btn-secondary ml-auto" (click)="markAll()">Tout marquer comme lu</button></div>
      <div class="card mt-4 divide-y divide-stone-100 dark:divide-stone-800">
        @for (n of items(); track n.id) {
          <div class="flex gap-3 px-4 py-3" [class.bg-accent-50]="!n.readAt" [class.dark:bg-stone-800/50]="!n.readAt">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium">{{ n.title }}</div>
              <div class="text-sm text-stone-600 dark:text-stone-400">{{ n.body }}</div>
              <div class="mt-1 text-xs text-stone-500">{{ label(n.type) }} · {{ n.createdAt | ago }}</div>
            </div>
            @if (n.link) { <a [routerLink]="n.link" class="btn-ghost self-center text-xs" (click)="read(n)">Ouvrir</a> }
            @if (!n.readAt) { <button class="btn-ghost self-center text-xs" (click)="read(n)">Lu</button> }
          </div>
        } @empty { <p class="px-4 py-6 text-sm text-stone-500">Aucune notification.</p> }
      </div>
      <h2 class="mt-8 mb-2 text-sm font-semibold text-stone-500 uppercase">Préférences</h2>
      <div class="card overflow-hidden"><table class="table">
        <thead><tr><th>Événement</th><th>Dans l’application</th><th>Email</th></tr></thead>
        <tbody>@for (p of prefs(); track p.type) {
          <tr><td>{{ label(p.type) }} @if (p.locked) { <span class="text-xs text-stone-500">(imposé)</span> }</td>
            <td><input type="checkbox" [checked]="p.inApp" [disabled]="p.locked" (change)="save(p, 'inApp', $event)" [attr.aria-label]="label(p.type) + ' in-app'" /></td>
            <td><input type="checkbox" [checked]="p.email" [disabled]="p.locked" (change)="save(p, 'email', $event)" [attr.aria-label]="label(p.type) + ' email'" /></td></tr>
        }</tbody>
      </table></div>
    </div></div>
  `,
  host: { class: 'block h-full' },
})
export class NotificationsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly items = signal<NotificationDto[]>([]);
  protected readonly prefs = signal<NotificationPreferenceDto[]>([]);

  async ngOnInit() {
    this.items.set((await this.api.get<{ items: NotificationDto[] }>('/notifications')).items);
    this.prefs.set(await this.api.get<NotificationPreferenceDto[]>('/notifications/preferences'));
  }
  protected label(t: string) {
    return LABELS[t] ?? t;
  }
  protected async read(n: NotificationDto) {
    await this.api.post('/notifications/read', { ids: [n.id] });
    await this.ngOnInit();
  }
  protected async markAll() {
    await this.api.post('/notifications/read', {});
    await this.ngOnInit();
  }
  protected async save(p: NotificationPreferenceDto, key: 'inApp' | 'email', e: Event) {
    const value = (e.target as HTMLInputElement).checked;
    try {
      await this.api.put('/notifications/preferences', { type: p.type, inApp: key === 'inApp' ? value : p.inApp, email: key === 'email' ? value : p.email });
      await this.ngOnInit();
    } catch (err) {
      this.toast.error(err);
    }
  }
}
