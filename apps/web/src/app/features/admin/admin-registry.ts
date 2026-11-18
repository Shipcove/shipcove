import { ChangeDetectionStrategy, Component, OnInit, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { RegistryMirrorConfigDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { t } from '../../core/i18n';

interface Row {
  registry: string;
  prefix: string;
  username: string;
  password: string;
  passwordSet: boolean;
}

interface Preview {
  image: string;
  pulled: string;
  authenticated: boolean;
  fallback: string | null;
}

/**
 * Miroir de registre (Harbor, Nexus, Artifactory, registry:2…) pour les images des services
 * d'appui : chaque registre d'origine est servi sous un préfixe du miroir.
 */
@Component({
  selector: 'cap-admin-registry',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card mt-4 space-y-3 p-4" (ngSubmit)="save()" [attr.aria-label]="t('Miroir de registre')">
      <div class="font-medium">{{ t('Miroir de registre') }}</div>
      <p class="text-xs text-stone-500">
        {{ t('Pour un déploiement sans accès direct aux registres publics : les images des services ci-dessus sont téléchargées depuis votre miroir.') }}
        {{ t('Exemple :') }} <code>docker.io</code> → <code>harbor.corp/dockerhub</code> {{ t('transforme') }} <code>redis:7.4-alpine</code> {{ t('en') }} <code>harbor.corp/dockerhub/library/redis:7.4-alpine</code>.
        {{ t('Les identifiants (compte robot en lecture) sont stockés dans Vault et ne sont jamais réaffichés. Le téléchargement est fait par le moteur Docker de l’hôte : un miroir en HTTP ou avec un certificat interne doit y être déclaré') }}
        (<code>insecure-registries</code>, <code>/etc/docker/certs.d</code>).
      </p>
      <div class="space-y-2">
        @for (r of rows(); track $index; let i = $index) {
          <div class="grid items-center gap-2 md:grid-cols-[10rem_1fr_10rem_12rem_auto]">
            <input class="input font-mono text-sm" [name]="'reg' + i" [(ngModel)]="r.registry" placeholder="docker.io" [attr.aria-label]="t('Registre d’origine')" required />
            <input class="input font-mono text-sm" [name]="'pre' + i" [(ngModel)]="r.prefix" placeholder="harbor.corp/dockerhub" [attr.aria-label]="t('Préfixe sur le miroir')" required />
            <input class="input text-sm" [name]="'usr' + i" [(ngModel)]="r.username" [placeholder]="t('Utilisateur (facultatif)')" autocomplete="off" [attr.aria-label]="t('Utilisateur du miroir')" />
            <input class="input text-sm" type="password" [name]="'pwd' + i" [(ngModel)]="r.password" autocomplete="new-password" [attr.aria-label]="t('Mot de passe ou jeton du miroir')"
              [placeholder]="r.passwordSet ? t('Enregistré — vide pour conserver') : t('Mot de passe ou jeton')" />
            <button type="button" class="btn-ghost !p-1.5 text-stone-500 hover:text-red-600" (click)="removeRow(i)" [attr.aria-label]="t('Retirer ce miroir')"><cap-icon name="trash" [size]="14" /></button>
          </div>
        } @empty { <p class="text-sm text-stone-500">{{ t('Aucun miroir : les images sont téléchargées depuis leur registre d’origine.') }}</p> }
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button type="button" class="btn-secondary" (click)="addRow()"><cap-icon name="plus" [size]="14" /> {{ t('Ajouter un registre') }}</button>
        <label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="fallback" [(ngModel)]="fallback" />
          {{ t('Repli sur le registre d’origine si le miroir échoue') }}</label>
        <button class="btn-primary ml-auto" [disabled]="busy()">{{ t('Enregistrer') }}</button>
      </div>
      @if (preview().length) {
        <div class="rounded-lg bg-stone-50 p-3 text-xs dark:bg-stone-800/60" [attr.aria-label]="t('Aperçu des images des services')">
          <div class="mb-1 font-medium text-stone-600 dark:text-stone-300">{{ t('Images téléchargées pour le catalogue') }}</div>
          @for (p of preview(); track p.image) {
            <div class="flex flex-wrap items-center gap-1.5 font-mono">
              <span class="text-stone-500">{{ p.image }}</span>
              @if (p.pulled !== p.image) {
                <span>→ {{ p.pulled }}</span>
                @if (p.authenticated) { <span class="badge bg-amber-100 font-sans text-amber-800"><cap-icon name="lock" [size]="10" /> {{ t('authentifié') }}</span> }
                @if (p.fallback) { <span class="font-sans text-stone-400">{{ t('(repli autorisé)') }}</span> }
              } @else { <span class="font-sans text-stone-400">{{ t('(registre d’origine)') }}</span> }
            </div>
          }
        </div>
      }
    </form>
  `,
})
export class AdminRegistry implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  /** Images du catalogue des services, pour l'aperçu. */
  readonly images = input<string[]>([]);
  protected readonly rows = signal<Row[]>([]);
  protected readonly preview = signal<Preview[]>([]);
  protected readonly busy = signal(false);
  protected fallback = false;

  constructor() {
    // Aperçu recalculé quand le catalogue change.
    effect(() => {
      this.images();
      untracked(() => void this.refreshPreview());
    });
  }

  async ngOnInit() {
    this.apply(await this.api.get<RegistryMirrorConfigDto>('/admin/registry-mirrors'));
  }

  private apply(c: RegistryMirrorConfigDto) {
    this.rows.set(c.mirrors.map((m) => ({ registry: m.registry, prefix: m.prefix, username: m.username ?? '', password: '', passwordSet: m.passwordSet })));
    this.fallback = c.fallbackToUpstream;
  }

  async refreshPreview() {
    const images = this.images();
    this.preview.set(images.length ? await this.api.post<Preview[]>('/admin/registry-mirrors/preview', { images }).catch(() => []) : []);
  }

  protected addRow() {
    this.rows.update((l) => [...l, { registry: l.length ? '' : 'docker.io', prefix: '', username: '', password: '', passwordSet: false }]);
  }

  protected removeRow(i: number) {
    this.rows.update((l) => l.filter((_, j) => j !== i));
  }

  protected async save() {
    this.busy.set(true);
    try {
      const c = await this.api.put<RegistryMirrorConfigDto>('/admin/registry-mirrors', {
        fallbackToUpstream: this.fallback,
        mirrors: this.rows().map((r) => ({
          registry: r.registry.trim(),
          prefix: r.prefix.trim(),
          ...(r.username.trim() ? { username: r.username.trim() } : {}),
          ...(r.password ? { password: r.password } : {}),
        })),
      });
      this.apply(c);
      await this.refreshPreview();
      this.toast.show(t('Miroir enregistré : appliqué au prochain démarrage de service'), 'success');
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
