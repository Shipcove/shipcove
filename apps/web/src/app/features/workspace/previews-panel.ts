import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PreviewPortDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';
import { t } from '../../core/i18n';

/** Previews : ports exposés via la Preview Gateway (origine distincte). */
@Component({
  selector: 'cap-previews-panel',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full space-y-3 overflow-y-auto p-4 text-sm">
      <form class="flex items-end gap-2" (ngSubmit)="openPort()">
        <div><label class="label" for="port">Port</label><input id="port" class="input !w-28 !py-1" type="number" name="port" min="1024" max="65535" [(ngModel)]="port" /></div>
        <div class="flex-1"><label class="label" for="plabel">{{ t('Libellé') }}</label><input id="plabel" class="input !py-1" name="label" [(ngModel)]="label" [placeholder]="t('ex. serveur de dev')" /></div>
        <button class="btn-secondary !py-1">{{ t('Exposer') }}</button>
      </form>
      <p class="text-xs text-stone-500">{{ t('Au plus {n} ports simultanés. Les previews s’ouvrent sur un domaine séparé et ne reçoivent pas vos cookies de session.', { n: store.config()?.previews?.maxPortsPerWorkspace ?? 3 }) }}</p>
      @for (p of previews(); track p.id) {
        <div class="card flex items-center gap-2 p-3">
          <cap-icon name="globe" [size]="14" />
          <span class="font-mono">:{{ p.port }}</span><span class="text-stone-500">{{ p.label }}</span>
          <button class="btn-secondary ml-auto !py-1" (click)="visit(p)">{{ t('Ouvrir') }}</button>
          <button class="btn-ghost !p-1" (click)="close(p)" [attr.aria-label]="t('Fermer la preview')"><cap-icon name="x" [size]="14" /></button>
        </div>
        @if (fallback()?.id === p.id) {
          <p class="-mt-1 px-1 text-xs text-stone-500">
            {{ t('Le navigateur a bloqué l’ouverture de l’onglet :') }}
            <a class="text-accent-700 underline dark:text-accent-500" [href]="fallback()!.url" target="_blank" rel="noopener noreferrer" (click)="fallback.set(null)">{{ t('ouvrir la preview') }}</a>
          </p>
        }
      } @empty {
        <p class="text-stone-500">{{ t('Aucune preview ouverte. Demandez à l’agent de démarrer un serveur (ex.') }} <code>npm run dev -- --host 0.0.0.0 --port 5173</code>).</p>
      }
    </div>
  `,
  host: { class: 'block h-full' },
})
export class PreviewsPanel implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly store = inject(WorkspaceStore);
  protected readonly previews = signal<PreviewPortDto[]>([]);
  protected port = 5173;
  protected label = '';

  ngOnInit() {
    void this.load();
  }

  private base() {
    return `/workspaces/${this.store.workspace()!.id}/previews`;
  }

  async load() {
    this.previews.set(await this.api.get<PreviewPortDto[]>(this.base()).catch(() => []));
  }

  protected async openPort() {
    try {
      await this.api.post(this.base(), { port: Number(this.port), label: this.label || undefined });
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }

  /** Lien de secours quand le navigateur bloque l'ouverture de l'onglet. */
  protected readonly fallback = signal<{ id: string; url: string } | null>(null);

  /**
   * L'onglet est ouvert pendant le clic (sinon le bloqueur de fenêtres le refuse après l'appel
   * réseau), coupé de l'application (`opener = null`), puis dirigé vers le lien signé de la preview.
   * `noopener` n'est pas utilisable ici : `window.open` renverrait toujours `null`.
   */
  protected async visit(p: PreviewPortDto) {
    this.fallback.set(null);
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    try {
      const { url } = await this.api.post<{ url: string }>(`${this.base()}/${p.id}/link`);
      if (w && !w.closed) w.location.replace(url);
      else this.fallback.set({ id: p.id, url });
    } catch (err) {
      w?.close();
      this.toast.error(err);
    }
  }

  protected async close(p: PreviewPortDto) {
    await this.api.delete(`${this.base()}/${p.id}`).catch((e) => this.toast.error(e));
    await this.load();
  }
}
