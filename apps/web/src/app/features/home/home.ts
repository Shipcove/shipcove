import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { AuthStore } from '../../core/auth.store';
import { RepoPicker, type RepoChoice } from '../../shared/repo-picker';
import { Composer } from '../workspace/composer';
import { WorkspaceStore } from '../workspace/workspace.store';
import { DraftWorkspaceStore } from './draft.store';

/**
 * Accueil : une nouvelle conversation, avec la même zone de saisie que dans une conversation
 * (modèle, effort, mode, quotas, pièces jointes, commandes slash) et le choix facultatif d'un dépôt Git.
 */
@Component({
  selector: 'cap-home',
  imports: [Composer, RepoPicker],
  providers: [DraftWorkspaceStore, { provide: WorkspaceStore, useExisting: DraftWorkspaceStore }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full' },
  template: `
    <div class="flex h-full flex-col items-center justify-center overflow-y-auto pb-24">
      <div class="w-full max-w-3xl">
        <h1 class="mb-6 px-6 text-center text-3xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">{{ greeting() }}</h1>
        <cap-composer>
          <cap-repo-picker composerStart #picker [value]="draft.repository()" (valueChange)="setRepository($event)" />
        </cap-composer>
        <p class="px-6 text-center text-xs text-stone-500">
          @if (draft.repository(); as r) { Pi travaillera sur <span class="font-mono">{{ r.fullName }}</span> dans une sandbox isolée. }
          @else { Sans dépôt, Pi dispose d’une sandbox vide. Choisissez un dépôt pour travailler sur votre code. }
        </p>
      </div>
    </div>
  `,
})
export class HomePage implements OnInit {
  protected readonly auth = inject(AuthStore);
  protected readonly draft = inject(DraftWorkspaceStore);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly picker = viewChild.required<RepoPicker>('picker');

  protected readonly greeting = computed(() => {
    const first = (this.auth.me()?.displayName ?? '').split(/\s+/)[0];
    const h = new Date().getHours();
    const hello = h >= 18 || h < 5 ? 'Bonsoir' : 'Bonjour';
    return first ? `${hello} ${first}, on construit quoi ?` : 'On construit quoi ?';
  });

  ngOnInit(): void {
    void this.draft.init();
    // « Nouvelle conversation dans ce dépôt » depuis la barre latérale : ?repo=hôte/groupe/projet
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const [host, ...rest] = (q.get('repo') ?? '').split('/');
      if (host && rest.length >= 2) void this.picker().preselect(host, rest.join('/'));
      else if (q.has('new')) this.draft.repository.set(null);
      setTimeout(() => document.querySelector<HTMLTextAreaElement>('cap-composer textarea')?.focus());
    });
  }

  protected setRepository(r: RepoChoice | null): void {
    this.draft.repository.set(r);
  }
}
