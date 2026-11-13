import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PreviewPortDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';

/** Previews : ports exposés via la Preview Gateway (origine distincte). */
@Component({
  selector: 'cap-previews-panel',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full space-y-3 overflow-y-auto p-4 text-sm">
      <form class="flex items-end gap-2" (ngSubmit)="openPort()">
        <div><label class="label" for="port">Port</label><input id="port" class="input !w-28 !py-1" type="number" name="port" min="1024" max="65535" [(ngModel)]="port" /></div>
        <div class="flex-1"><label class="label" for="plabel">Libellé</label><input id="plabel" class="input !py-1" name="label" [(ngModel)]="label" placeholder="ex. serveur de dev" /></div>
        <button class="btn-secondary !py-1">Exposer</button>
      </form>
      <p class="text-xs text-stone-500">Au plus {{ store.config()?.previews?.maxPortsPerWorkspace ?? 3 }} ports simultanés. Les previews s’ouvrent sur un domaine séparé et ne reçoivent pas vos cookies de session.</p>
      @for (p of previews(); track p.id) {
        <div class="card flex items-center gap-2 p-3">
          <cap-icon name="globe" [size]="14" />
          <span class="font-mono">:{{ p.port }}</span><span class="text-stone-500">{{ p.label }}</span>
          <button class="btn-secondary ml-auto !py-1" (click)="visit(p)">Ouvrir</button>
          <button class="btn-ghost !p-1" (click)="close(p)" aria-label="Fermer la preview"><cap-icon name="x" [size]="14" /></button>
        </div>
      } @empty {
        <p class="text-stone-500">Aucune preview ouverte. Demandez à Pi de démarrer un serveur (ex. <code>npm run dev -- --host 0.0.0.0 --port 5173</code>).</p>
      }
    </div>
  `,
  host: { class: 'block h-full' },
})
export class PreviewsPanel implements OnInit {
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

  protected async visit(p: PreviewPortDto) {
    const w = window.open('about:blank', '_blank', 'noopener');
    try {
      const { url } = await this.api.post<{ url: string }>(`${this.base()}/${p.id}/link`);
      if (w) w.location.href = url;
      else window.open(url, '_blank', 'noopener');
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
