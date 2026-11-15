import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import type { ModelDto, WorkspaceDto } from '@cap/contracts';
import { Api, idempotencyKey } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ConversationsService } from '../../core/conversations.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { RepoPicker, type RepoChoice } from '../../shared/repo-picker';

const MODEL_KEY = 'cap.home.modelId';

/**
 * Accueil : une nouvelle conversation. Le dépôt Git est facultatif ; la conversation est créée
 * au premier envoi, puis son titre est généré automatiquement.
 */
@Component({
  selector: 'cap-home',
  imports: [FormsModule, Icon, RepoPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full', '(document:click)': 'modelMenu.set(false)' },
  template: `
    <div class="flex h-full flex-col items-center justify-center overflow-y-auto px-6 pb-24">
      <div class="w-full max-w-3xl">
        <h1 class="mb-6 text-center text-3xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">{{ greeting() }}</h1>
        <div class="rounded-2xl border border-stone-200 bg-white shadow-sm focus-within:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-600">
          <textarea #input class="block max-h-72 min-h-24 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[0.95rem] leading-6 placeholder:text-stone-400 focus:outline-none"
            rows="3" [(ngModel)]="text" name="text" (input)="autosize()" (keydown)="onKey($event)" [disabled]="busy()"
            placeholder="Décrivez ce que Pi doit faire…" aria-label="Message"></textarea>
          <div class="flex items-center gap-1 px-2 pb-2">
            <cap-repo-picker #picker [(value)]="repository" />
            <div class="relative ml-auto">
              <button type="button" class="rounded-md px-2 py-1 text-[13px] text-stone-800 hover:bg-stone-200/70 dark:text-stone-200 dark:hover:bg-stone-800" (click)="$event.stopPropagation(); modelMenu.set(!modelMenu())" aria-haspopup="menu" [attr.aria-expanded]="modelMenu()">
                {{ model()?.displayName ?? 'Modèle' }}
              </button>
              @if (modelMenu()) {
                <div class="absolute right-0 bottom-full z-30 mb-2 max-h-80 w-72 overflow-y-auto rounded-xl border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900" role="menu">
                  @for (m of models(); track m.id) {
                    <button class="menu-item" role="menuitemradio" [attr.aria-checked]="m.id === model()?.id" (click)="chooseModel(m)" [disabled]="!m.available">
                      <span class="flex-1">{{ m.displayName }}</span>
                      @if (!m.available) { <span class="text-xs text-stone-400">indisponible</span> }
                      @if (m.id === model()?.id) { <cap-icon name="check" class="text-sky-600" /> }
                    </button>
                  } @empty { <p class="px-3 py-2 text-sm text-stone-500">Aucun modèle activé.</p> }
                </div>
              }
            </div>
            <button class="btn-primary !rounded-lg !p-1.5" (click)="send()" [disabled]="busy() || !text.trim() || !model()" aria-label="Envoyer" title="Envoyer (Entrée)">
              @if (busy()) { <span class="block h-[18px] w-[18px] animate-spin rounded-full border-2 border-current border-t-transparent"></span> } @else { <cap-icon name="enter" [size]="18" /> }
            </button>
          </div>
        </div>
        <p class="mt-3 text-center text-xs text-stone-500">
          @if (repository(); as r) { Pi travaillera sur <span class="font-mono">{{ r.fullName }}</span> dans une sandbox isolée. }
          @else { Sans dépôt, Pi dispose d’une sandbox vide. Choisissez un dépôt pour travailler sur votre code. }
        </p>
      </div>
    </div>
  `,
})
export class HomePage implements OnInit {
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(ToastService);
  private readonly conversations = inject(ConversationsService);
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');
  private readonly picker = viewChild.required<RepoPicker>('picker');

  protected text = '';
  protected readonly repository = signal<RepoChoice | null>(null);
  protected readonly models = signal<ModelDto[]>([]);
  protected readonly modelId = signal<string | null>(readModel());
  protected readonly modelMenu = signal(false);
  protected readonly busy = signal(false);

  protected readonly model = computed<ModelDto | null>(() => {
    const list = this.models().filter((m) => m.available);
    return list.find((m) => m.id === this.modelId()) ?? list.find((m) => m.isDefault) ?? list[0] ?? null;
  });

  protected readonly greeting = computed(() => {
    const first = (this.auth.me()?.displayName ?? '').split(/\s+/)[0];
    const h = new Date().getHours();
    const hello = h >= 18 || h < 5 ? 'Bonsoir' : 'Bonjour';
    return first ? `${hello} ${first}, on construit quoi ?` : 'On construit quoi ?';
  });

  async ngOnInit(): Promise<void> {
    setTimeout(() => this.input()?.nativeElement.focus());
    // « Nouvelle conversation dans ce dépôt » depuis la barre latérale : ?repo=hôte/groupe/projet
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const [host, ...rest] = (q.get('repo') ?? '').split('/');
      if (host && rest.length >= 2) void this.picker().preselect(host, rest.join('/'));
      else if (q.has('new')) this.repository.set(null);
      setTimeout(() => this.input()?.nativeElement.focus());
    });
    this.models.set(await this.api.get<ModelDto[]>('/models').catch(() => []));
  }

  protected chooseModel(m: ModelDto): void {
    this.modelId.set(m.id);
    this.modelMenu.set(false);
    try {
      localStorage.setItem(MODEL_KEY, m.id);
    } catch {
      /* préférence non conservée */
    }
  }

  protected autosize(): void {
    const el = this.input()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 288)}px`;
  }

  protected onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    const text = this.text.trim();
    const model = this.model();
    if (!text || !model || this.busy()) return;
    this.busy.set(true);
    try {
      const r = this.repository();
      const ws = await this.api.post<WorkspaceDto>('/workspaces', {
        modelId: model.id,
        ...(r ? { repository: { gitConnectionId: r.gitConnectionId, fullName: r.fullName } } : {}),
      });
      this.conversations.upsert(ws);
      await this.api.post(`/workspaces/${ws.id}/messages`, { text, attachmentIds: [], delivery: 'new_run', modelId: model.id }, { 'Idempotency-Key': idempotencyKey() });
      this.text = '';
      await this.router.navigate(['/workspaces', ws.id]);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}

function readModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}
