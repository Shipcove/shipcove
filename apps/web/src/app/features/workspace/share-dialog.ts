import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ConversationShareDto, UserSummaryDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';
import { t } from '../../core/i18n';

/** Partage nominatif, lecture seule, révocable, ouvert à tout utilisateur actif de la plateforme. */
@Component({
  selector: 'cap-share-dialog',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-24" (click)="closed.emit()">
      <div class="card w-full max-w-md p-5 shadow-xl" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div class="mb-1 flex items-center"><h2 id="share-title" class="font-semibold">{{ t('Partager la conversation') }}</h2><button class="btn-ghost ml-auto !p-1" (click)="closed.emit()" [attr.aria-label]="t('Fermer')"><cap-icon name="x" /></button></div>
        <p class="mb-3 text-xs text-stone-500">{{ t('Lecture seule. Le destinataire ne peut ni lancer Pi, ni modifier la conversation, ni approuver d’opération Git, ni ouvrir les previews.') }}</p>
        <input class="input" [placeholder]="t('Rechercher un utilisateur (nom, identifiant, e-mail)…')" [(ngModel)]="q" (ngModelChange)="search()" name="q" />
        @for (u of results(); track u.id) {
          <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" (click)="add(u)">
            <span class="font-medium">{{ u.displayName }}</span><span class="text-stone-500">&#64;{{ u.username }}</span><cap-icon name="plus" [size]="13" class="ml-auto" />
          </button>
        }
        <div class="mt-4 text-xs font-medium text-stone-500 uppercase">{{ t('Accès accordés') }}</div>
        @for (s of shares(); track s.id) {
          <div class="flex items-center gap-2 py-1.5 text-sm" [class.opacity-50]="s.revokedAt">
            <span>{{ s.user.displayName }}</span><span class="text-stone-500">&#64;{{ s.user.username }}</span>
            @if (!s.revokedAt) { <button class="btn-ghost ml-auto !px-2 !py-0.5 text-xs text-red-600" (click)="revoke(s)">{{ t('Révoquer') }}</button> }
            @else { <span class="ml-auto text-xs">{{ t('révoqué') }}</span> }
          </div>
        } @empty { <p class="py-2 text-sm text-stone-500">{{ t('Conversation privée.') }}</p> }
      </div>
    </div>
  `,
})
export class ShareDialog implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly store = inject(WorkspaceStore);
  readonly closed = output<void>();
  protected q = '';
  protected readonly results = signal<UserSummaryDto[]>([]);
  protected readonly shares = signal<ConversationShareDto[]>([]);

  ngOnInit() {
    void this.load();
  }

  private conv() {
    return this.store.workspace()!.conversationId;
  }

  async load() {
    this.shares.set(await this.api.get<ConversationShareDto[]>(`/conversations/${this.conv()}/shares`));
  }

  protected async search() {
    if (this.q.length < 2) return this.results.set([]);
    const all = await this.api.get<UserSummaryDto[]>('/users/search', { q: this.q }).catch(() => []);
    this.results.set(all.filter((u) => u.id !== this.store.workspace()!.ownerId));
  }

  protected async add(u: UserSummaryDto) {
    try {
      await this.api.post(`/conversations/${this.conv()}/shares`, { userId: u.id });
      this.q = '';
      this.results.set([]);
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected async revoke(s: ConversationShareDto) {
    await this.api.delete(`/conversations/${this.conv()}/shares/${s.id}`).catch((e) => this.toast.error(e));
    await this.load();
  }
}
