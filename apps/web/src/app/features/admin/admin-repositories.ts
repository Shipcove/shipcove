import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AdminRepositoryDto, EnvVarDto, RepositoryEnvironmentDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { AgoPipe } from '../../shared/pipes';

/** Édition des variables d'environnement d'un dépôt ; les secrets ne sont jamais relus. */
@Component({
  selector: 'cap-env-vars',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card divide-y divide-stone-100 text-sm dark:divide-stone-800" [attr.aria-label]="label()">
      @for (v of variables(); track v.id) {
        <div class="flex items-center gap-2 px-4 py-2">
          <code class="font-medium">{{ v.name }}</code>
          @if (v.secret) { <span class="badge bg-amber-100 text-amber-800"><cap-icon name="lock" [size]="11" /> secret</span> }
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-stone-500">{{ v.secret ? '••••••••' : v.value }}</span>
          <button class="btn-ghost !py-0.5 text-xs" (click)="edit(v)">Modifier</button>
          <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(v)">Supprimer</button>
        </div>
      } @empty { <p class="px-4 py-3 text-stone-500">Aucune variable.</p> }
    </div>
    <form class="mt-2 grid gap-2 md:grid-cols-[12rem_1fr_auto_auto]" (ngSubmit)="save()" [attr.aria-label]="'Ajouter : ' + label()">
      <input class="input font-mono" name="name" placeholder="NOM_VARIABLE" [(ngModel)]="form.name" [disabled]="!!editing()" autocomplete="off" />
      <input class="input font-mono" name="value" [type]="form.secret ? 'password' : 'text'" autocomplete="off" [(ngModel)]="form.value"
        [placeholder]="editing() && form.secret ? 'Laisser vide pour conserver la valeur' : 'Valeur'" />
      <label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="secret" [(ngModel)]="form.secret" /> Secret</label>
      <span class="flex gap-1"><button class="btn-primary">{{ editing() ? 'Mettre à jour' : 'Ajouter' }}</button>
        @if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">Annuler</button> }</span>
    </form>
  `,
})
export class EnvVarsEditor {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  readonly endpoint = input.required<string>();
  readonly variables = input<EnvVarDto[]>([]);
  readonly label = input('Variables');
  readonly changed = output<void>();
  protected readonly editing = signal<string | null>(null);
  protected form = { name: '', value: '', secret: false };

  protected edit(v: EnvVarDto) {
    this.editing.set(v.id);
    this.form = { name: v.name, value: v.secret ? '' : (v.value ?? ''), secret: v.secret };
  }
  protected reset() {
    this.editing.set(null);
    this.form = { name: '', value: '', secret: false };
  }
  protected async save() {
    try {
      const keep = this.editing() && this.form.secret && !this.form.value;
      await this.api.put(this.endpoint(), { name: this.form.name.trim(), secret: this.form.secret, ...(keep ? {} : { value: this.form.value }) });
      this.toast.show(this.form.secret ? 'Secret enregistré (stocké dans Vault)' : 'Variable enregistrée', 'success');
      this.reset();
      this.changed.emit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected async remove(v: EnvVarDto) {
    if (!confirm(`Supprimer ${v.name} ?`)) return;
    try {
      await this.api.delete(`${this.endpoint()}/${v.id}`);
      this.changed.emit();
    } catch (e) {
      this.toast.error(e);
    }
  }
}

/**
 * Dépôts utilisés par des conversations, et l'environnement de sandbox partagé par toutes les
 * conversations sur chacun : image, script de préparation, variables et secrets.
 */
@Component({
  selector: 'cap-admin-repositories',
  imports: [FormsModule, Icon, AgoPipe, EnvVarsEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">Dépôts</h1>
    <p class="text-sm text-stone-500">Un dépôt apparaît ici dès qu’une conversation l’utilise. Son environnement s’applique à toutes les conversations sur ce dépôt, à partir du run suivant.</p>
    <div class="card mt-3 overflow-x-auto"><table class="table">
      <thead><tr><th>Dépôt</th><th>Conversations</th><th>Dernière activité</th><th>Environnement</th><th></th></tr></thead>
      <tbody>@for (r of repos(); track r.id) {
        <tr [class.bg-stone-50]="selected()?.repository?.id === r.id" [class.dark:bg-stone-800]="selected()?.repository?.id === r.id">
          <td><div class="flex items-center gap-1.5 font-mono text-sm"><cap-icon name="git" [size]="13" class="text-stone-400" />{{ r.fullName }}</div><div class="text-xs text-stone-500">{{ r.host }}</div></td>
          <td>{{ r.conversationCount }}</td>
          <td class="text-xs">{{ r.lastUsedAt ? (r.lastUsedAt | ago) : '—' }}</td>
          <td class="text-xs">{{ r.setupConfigured ? 'script' : '' }}{{ r.setupConfigured && r.variableCount ? ' · ' : '' }}{{ r.variableCount ? r.variableCount + ' variable(s)' : '' }}@if (!r.setupConfigured && !r.variableCount) { <span class="text-stone-400">par défaut</span> }</td>
          <td class="text-right"><button class="btn-ghost !py-0.5 text-xs" (click)="open(r.id)">Configurer</button></td>
        </tr>
      } @empty { <tr><td colspan="5" class="text-sm text-stone-500">Aucun dépôt pour l’instant.</td></tr> }</tbody>
    </table></div>

    @if (selected(); as e) {
      <section class="mt-6" aria-label="Environnement du dépôt">
        <div class="flex items-center gap-2">
          <h2 class="font-semibold">Environnement de <span class="font-mono">{{ e.repository.fullName }}</span></h2>
          <button class="btn-ghost ml-auto !p-1" (click)="selected.set(null)" aria-label="Fermer"><cap-icon name="x" /></button>
        </div>
        <form class="card mt-3 space-y-3 p-4" (ngSubmit)="saveEnv()">
          <label class="block text-sm">Image de sandbox
            <select class="input mt-1" name="image" [(ngModel)]="imageId">
              <option [ngValue]="null">Image par défaut de la plateforme</option>
              @for (i of e.images; track i.id) { <option [ngValue]="i.id">{{ i.name }} {{ i.version }}{{ i.isDefault ? ' (défaut)' : '' }}</option> }
            </select>
          </label>
          <label class="block text-sm">Script de préparation (bash, exécuté dans <code>/workspace</code>)
            <textarea class="input mt-1 font-mono text-xs" rows="7" name="setup" [(ngModel)]="setupScript" spellcheck="false" placeholder="npm ci&#10;pip install -r requirements.txt"></textarea>
          </label>
          <p class="text-xs text-stone-500">Rejoué dans chaque nouvelle sandbox et à chaque modification : il doit être idempotent (comme une étape de CI). Ce qu’il produit dans <code>/workspace</code> est conservé ; sa sortie apparaît dans la conversation.</p>
          <button class="btn-primary">Enregistrer</button>
        </form>
        <h3 class="mt-5 mb-1 text-sm font-medium">Variables et secrets</h3>
        <p class="mb-2 text-xs text-stone-500">Injectés dans l’environnement de l’agent (pas dans les fichiers). Les secrets sont conservés dans Vault, jamais réaffichés, et masqués dans les sorties et dans ce qui est envoyé au modèle. Comme pour une CI, l’agent de toute conversation sur ce dépôt peut les utiliser.</p>
        <cap-env-vars [endpoint]="'/admin/repositories/' + e.repository.id + '/environment/variables'" [variables]="e.variables" label="Variables du dépôt" (changed)="open(e.repository.id)" />
      </section>
    }
  `,
})
export class AdminRepositories implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly repos = signal<AdminRepositoryDto[]>([]);
  protected readonly selected = signal<RepositoryEnvironmentDto | null>(null);
  protected imageId: string | null = null;
  protected setupScript = '';

  async ngOnInit() {
    this.repos.set(await this.api.get<AdminRepositoryDto[]>('/admin/repositories'));
  }

  protected async open(id: string) {
    const e = await this.api.get<RepositoryEnvironmentDto>(`/admin/repositories/${id}/environment`);
    this.selected.set(e);
    this.imageId = e.sandboxImageId;
    this.setupScript = e.setupScript ?? '';
    void this.ngOnInit();
  }

  protected async saveEnv() {
    const e = this.selected();
    if (!e) return;
    try {
      this.selected.set(await this.api.put<RepositoryEnvironmentDto>(`/admin/repositories/${e.repository.id}/environment`, { sandboxImageId: this.imageId, setupScript: this.setupScript || null }));
      this.toast.show('Environnement enregistré : appliqué au prochain run', 'success');
      void this.ngOnInit();
    } catch (err) {
      this.toast.error(err);
    }
  }
}
