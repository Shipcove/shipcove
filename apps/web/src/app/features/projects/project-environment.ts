import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { EnvVarDto, ProjectEnvironmentDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';

/** Édition de variables d'environnement (projet ou équipe) ; les secrets ne sont jamais relus. */
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
          @if (overridden().includes(v.name)) { <span class="badge bg-stone-100 text-stone-500" title="Une variable du projet porte le même nom">remplacée par le projet</span> }
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-stone-500">{{ v.secret ? '••••••••' : v.value }}</span>
          @if (canManage()) {
            <button class="btn-ghost !py-0.5 text-xs" (click)="edit(v)">Modifier</button>
            <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(v)">Supprimer</button>
          }
        </div>
      } @empty { <p class="px-4 py-3 text-stone-500">Aucune variable.</p> }
    </div>
    @if (canManage()) {
      <form class="mt-2 grid gap-2 md:grid-cols-[12rem_1fr_auto_auto]" (ngSubmit)="save()" [attr.aria-label]="'Ajouter : ' + label()">
        <input class="input font-mono" name="name" placeholder="NOM_VARIABLE" [(ngModel)]="form.name" [disabled]="!!editing()" autocomplete="off" />
        <input class="input font-mono" name="value" [type]="form.secret ? 'password' : 'text'" autocomplete="off" [(ngModel)]="form.value"
          [placeholder]="editing() && form.secret ? 'Laisser vide pour conserver la valeur' : 'Valeur'" />
        <label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="secret" [(ngModel)]="form.secret" /> Secret</label>
        <span class="flex gap-1"><button class="btn-primary">{{ editing() ? 'Mettre à jour' : 'Ajouter' }}</button>
          @if (editing()) { <button type="button" class="btn-secondary" (click)="reset()">Annuler</button> }</span>
      </form>
    }
  `,
})
export class EnvVarsEditor {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  readonly endpoint = input.required<string>();
  readonly variables = input<EnvVarDto[]>([]);
  readonly canManage = input(false);
  readonly label = input('Variables');
  /** Noms remplacés par une variable de portée plus fine (affichage). */
  readonly overridden = input<string[]>([]);
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

/** Environnement des sandboxes d'un projet : image, script de préparation, variables et secrets. */
@Component({
  selector: 'cap-project-environment',
  imports: [FormsModule, EnvVarsEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (env(); as e) {
      <section aria-label="Environnement du projet">
        <h2 class="mt-8 mb-1 text-sm font-semibold text-stone-500 uppercase">Environnement des sandboxes</h2>
        <p class="mb-3 text-sm text-stone-500">S’applique à tous les workspaces du projet, à partir du run suivant.</p>
        <form class="card space-y-3 p-4" (ngSubmit)="saveEnv()">
          <label class="block text-sm">Image de sandbox
            <select class="input mt-1" name="image" [(ngModel)]="imageId" [disabled]="!e.canManage">
              <option [ngValue]="null">Image par défaut de la plateforme</option>
              @for (i of e.images; track i.id) { <option [ngValue]="i.id">{{ i.name }} {{ i.version }}{{ i.isDefault ? ' (défaut)' : '' }}</option> }
            </select>
          </label>
          <label class="block text-sm">Script de préparation (bash, exécuté dans <code>/workspace</code>)
            <textarea class="input mt-1 font-mono text-xs" rows="7" name="setup" [(ngModel)]="setupScript" [disabled]="!e.canManage" spellcheck="false"
              placeholder="npm ci&#10;pip install -r requirements.txt"></textarea>
          </label>
          <p class="text-xs text-stone-500">Rejoué dans chaque nouvelle sandbox et à chaque modification : il doit être idempotent (comme une étape de CI). Ce qu’il produit dans <code>/workspace</code> est conservé ; sa sortie apparaît dans la conversation.</p>
          @if (e.canManage) { <button class="btn-primary">Enregistrer</button> }
        </form>

        <h3 class="mt-5 mb-1 text-sm font-medium">Variables et secrets du projet</h3>
        <p class="mb-2 text-xs text-stone-500">Injectés dans l’environnement de l’agent (pas dans les fichiers). Les secrets sont conservés dans Vault, jamais réaffichés, et masqués dans les sorties et dans ce qui est envoyé au modèle. Comme pour une CI, l’agent de chaque membre du projet peut les utiliser.</p>
        <cap-env-vars [endpoint]="'/projects/' + projectId() + '/environment/variables'" [variables]="e.variables" [canManage]="e.canManage" label="Variables du projet" (changed)="load()" />
        @if (e.teamVariables.length) {
          <h3 class="mt-5 mb-1 text-sm font-medium">Héritées de l’équipe</h3>
          <cap-env-vars [endpoint]="''" [variables]="e.teamVariables" [canManage]="false" label="Variables de l’équipe" [overridden]="projectNames()" />
        }
      </section>
    }
  `,
})
export class ProjectEnvironment implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  readonly projectId = input.required<string>();
  protected readonly env = signal<ProjectEnvironmentDto | null>(null);
  protected imageId: string | null = null;
  protected setupScript = '';

  ngOnInit() {
    void this.load();
  }
  async load() {
    const e = await this.api.get<ProjectEnvironmentDto>(`/projects/${this.projectId()}/environment`);
    this.env.set(e);
    this.imageId = e.sandboxImageId;
    this.setupScript = e.setupScript ?? '';
  }
  protected projectNames() {
    return this.env()?.variables.map((v) => v.name) ?? [];
  }
  protected async saveEnv() {
    try {
      this.env.set(await this.api.put<ProjectEnvironmentDto>(`/projects/${this.projectId()}/environment`, { sandboxImageId: this.imageId, setupScript: this.setupScript || null }));
      this.toast.show('Environnement enregistré : appliqué au prochain run', 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }
}
