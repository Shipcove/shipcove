import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { AdminRegistry } from './admin-registry';
import { FormsModule } from '@angular/forms';
import type { ServiceCatalogDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

const EMPTY = { key: '', name: '', image: '', port: '' as number | '', health: '', env: '', defaultMemoryMb: 512, maxMemoryMb: 2048, enabled: true };

/**
 * Catalogue des services d'appui que Pi peut lancer à la demande (bases de données, caches,
 * files…). L'administrateur choisit les images, variables par défaut et limites ; rien ne démarre
 * tant que l'agent ne le demande pas.
 */
@Component({
  selector: 'cap-admin-services',
  imports: [FormsModule, AdminRegistry],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="mt-6 mb-1 text-sm font-semibold text-stone-500 uppercase">Services lancés par l’agent</h2>
    <p class="mb-2 text-sm text-stone-500">L’agent démarre lui-même, quand il en a besoin, les services de ce catalogue (sur <code>localhost</code> de sa sandbox, sans accès réseau, données éphémères). Choisissez des images de confiance, idéalement verrouillées par digest.</p>
    <div class="card divide-y divide-stone-100 text-sm dark:divide-stone-800" aria-label="Catalogue des services">
      @for (s of items(); track s.id) {
        <div class="flex flex-wrap items-center gap-2 px-4 py-2">
          <code class="font-medium">{{ s.key }}</code><span>{{ s.name }}</span>
          <span class="font-mono text-xs text-stone-500">{{ s.image }}@if (s.port) { · :{{ s.port }} } · {{ s.defaultMemoryMb }}/{{ s.maxMemoryMb }} Mo</span>
          <span class="badge" [class]="s.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'">{{ s.enabled ? 'proposé' : 'désactivé' }}</span>
          <span class="ml-auto flex gap-1">
            <button class="btn-ghost !py-0.5 text-xs" (click)="toggle(s)">{{ s.enabled ? 'Désactiver' : 'Activer' }}</button>
            <button class="btn-ghost !py-0.5 text-xs" (click)="edit(s)">Modifier</button>
            <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(s)">Supprimer</button>
          </span>
        </div>
      } @empty { <p class="px-4 py-3 text-stone-500">Catalogue vide : l’agent ne peut lancer aucun service.</p> }
    </div>
    <form class="card mt-2 grid gap-2 p-4 md:grid-cols-3" (ngSubmit)="save()" aria-label="Service du catalogue">
      <div class="font-medium md:col-span-3">{{ editing() ? 'Modifier le service' : 'Ajouter un service' }}</div>
      <input class="input font-mono" name="key" placeholder="clé (ex. mongodb)" [(ngModel)]="form.key" />
      <input class="input" name="name" placeholder="Nom (ex. MongoDB 8)" [(ngModel)]="form.name" />
      <input class="input font-mono" name="image" placeholder="image (ex. mongo:8.0.4)" [(ngModel)]="form.image" />
      <input class="input" type="number" name="port" placeholder="port" [(ngModel)]="form.port" />
      <input class="input font-mono md:col-span-2" name="health" placeholder="sonde de santé (ex. pg_isready -h 127.0.0.1)" [(ngModel)]="form.health" />
      <textarea class="input font-mono text-xs md:col-span-3" rows="3" name="env" placeholder="Variables par défaut, une par ligne : CLE=valeur" [(ngModel)]="form.env"></textarea>
      <label class="text-sm">Mémoire par défaut (Mo) <input class="input mt-1" type="number" name="defmem" [(ngModel)]="form.defaultMemoryMb" /></label>
      <label class="text-sm">Mémoire maximale (Mo) <input class="input mt-1" type="number" name="maxmem" [(ngModel)]="form.maxMemoryMb" /></label>
      <label class="flex items-center gap-2 self-end text-sm"><input type="checkbox" name="enabled" [(ngModel)]="form.enabled" /> Proposé à l’agent</label>
      <div class="flex gap-2 md:col-span-3"><button class="btn-primary">Enregistrer</button>@if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">Annuler</button> }</div>
    </form>
    <cap-admin-registry [images]="images()" />
  `,
})
export class AdminServices implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly items = signal<ServiceCatalogDto[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected readonly images = computed(() => this.items().map((i) => i.image));
  protected form = { ...EMPTY };

  async ngOnInit() {
    this.items.set(await this.api.get<ServiceCatalogDto[]>('/admin/service-catalog'));
  }
  protected edit(s: ServiceCatalogDto) {
    this.editing.set(s.id);
    this.form = {
      key: s.key,
      name: s.name,
      image: s.image,
      port: s.port ?? '',
      health: s.healthCommand.join(' '),
      env: Object.entries(s.defaultEnv).map(([k, v]) => `${k}=${v}`).join('\n'),
      defaultMemoryMb: s.defaultMemoryMb,
      maxMemoryMb: s.maxMemoryMb,
      enabled: s.enabled,
    };
  }
  protected reset() {
    this.editing.set(null);
    this.form = { ...EMPTY };
  }
  private body(f: typeof EMPTY) {
    const defaultEnv: Record<string, string> = {};
    for (const line of f.env.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) defaultEnv[line.slice(0, i).trim()] = line.slice(i + 1);
    }
    return {
      key: f.key.trim(),
      name: f.name.trim(),
      image: f.image.trim(),
      port: f.port === '' ? null : Number(f.port),
      healthCommand: f.health.trim() ? f.health.trim().split(/\s+/) : [],
      defaultEnv,
      defaultMemoryMb: Number(f.defaultMemoryMb),
      maxMemoryMb: Number(f.maxMemoryMb),
      enabled: f.enabled,
    };
  }
  private async act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) this.toast.show(ok, 'success');
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected save() {
    const id = this.editing();
    const body = this.body(this.form);
    return this.act(async () => {
      await (id ? this.api.put(`/admin/service-catalog/${id}`, body) : this.api.post('/admin/service-catalog', body));
      this.reset();
    }, 'Catalogue mis à jour');
  }
  protected toggle(s: ServiceCatalogDto) {
    const { id: _id, ...rest } = s;
    return this.act(() => this.api.put(`/admin/service-catalog/${s.id}`, { ...rest, enabled: !s.enabled }));
  }
  protected remove(s: ServiceCatalogDto) {
    if (!confirm(`Supprimer ${s.name} du catalogue ? Les instances déjà lancées continuent jusqu’à l’arrêt de leur sandbox.`)) return;
    return this.act(() => this.api.delete(`/admin/service-catalog/${s.id}`));
  }
}
