import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SkillCategoryDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { t } from '../../core/i18n';

/** Catégories de skills : définies et ordonnées par les administrateurs, choisies par les auteurs. */
@Component({
  selector: 'cap-admin-skill-categories',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card mt-4 p-4" [attr.aria-label]="t('Catégories de skills')">
      <div class="font-medium">{{ t('Catégories de skills') }}</div>
      <p class="mt-0.5 text-sm text-stone-500">{{ t('Elles organisent la page Skills de tous les utilisateurs, dans cet ordre. Chaque auteur range ses skills dans l’une d’elles.') }}</p>
      <ul class="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
        @for (c of categories(); track c.id; let i = $index; let last = $last) {
          <li class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            @if (editing() === c.id) {
              <input class="input !w-48 !py-1" [(ngModel)]="form.name" [attr.aria-label]="t('Nom')" maxlength="60" />
              <input class="input min-w-0 flex-1 !py-1" [(ngModel)]="form.description" [attr.aria-label]="t('Description')" maxlength="300" [placeholder]="t('Description (facultative)')" />
              <button class="btn-primary !py-1 text-xs" (click)="save(c)">{{ t('Enregistrer') }}</button>
              <button class="btn-ghost !py-1 text-xs" (click)="editing.set(null)">{{ t('Annuler') }}</button>
            } @else {
              <span class="flex flex-col">
                <button class="rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 disabled:opacity-30 dark:hover:bg-stone-800" (click)="move(i, -1)" [disabled]="i === 0" [attr.aria-label]="t('Monter {name}', { name: c.name })"><cap-icon name="chevronDown" [size]="12" class="rotate-180" /></button>
                <button class="rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 disabled:opacity-30 dark:hover:bg-stone-800" (click)="move(i, 1)" [disabled]="last" [attr.aria-label]="t('Descendre {name}', { name: c.name })"><cap-icon name="chevronDown" [size]="12" /></button>
              </span>
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ c.name }} <span class="text-xs font-normal text-stone-400">· {{ t('{n} skill(s)', { n: c.skillCount }) }}</span></div>
                @if (c.description) { <div class="truncate text-xs text-stone-500">{{ c.description }}</div> }
              </div>
              <button class="btn-ghost !py-1 text-xs" (click)="edit(c)">{{ t('Modifier') }}</button>
              <button class="btn-ghost !py-1 text-xs text-red-600" (click)="remove(c)">{{ t('Supprimer') }}</button>
            }
          </li>
        } @empty { <li class="px-3 py-2 text-sm text-stone-500">{{ t('Aucune catégorie : les skills sont tous « sans catégorie ».') }}</li> }
      </ul>
      <form class="mt-3 flex flex-wrap gap-2" (ngSubmit)="create()">
        <input class="input !w-48" name="name" [(ngModel)]="draft.name" [placeholder]="t('Nouvelle catégorie')" maxlength="60" required [attr.aria-label]="t('Nom de la nouvelle catégorie')" />
        <input class="input min-w-0 flex-1" name="desc" [(ngModel)]="draft.description" [placeholder]="t('Description (facultative)')" maxlength="300" [attr.aria-label]="t('Description de la nouvelle catégorie')" />
        <button class="btn-primary" [disabled]="!draft.name.trim()"><cap-icon name="plus" [size]="14" /> {{ t('Ajouter') }}</button>
      </form>
    </section>
  `,
})
export class AdminSkillCategories implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly categories = signal<SkillCategoryDto[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected form = { name: '', description: '' };
  protected draft = { name: '', description: '' };

  async ngOnInit() {
    this.categories.set(await this.api.get<SkillCategoryDto[]>('/admin/skill-categories'));
  }

  protected async create() {
    try {
      await this.api.post('/admin/skill-categories', { name: this.draft.name.trim(), description: this.draft.description.trim() });
      this.draft = { name: '', description: '' };
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected edit(c: SkillCategoryDto) {
    this.form = { name: c.name, description: c.description };
    this.editing.set(c.id);
  }

  protected async save(c: SkillCategoryDto) {
    try {
      await this.api.put(`/admin/skill-categories/${c.id}`, { name: this.form.name.trim(), description: this.form.description.trim() });
      this.editing.set(null);
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async move(i: number, delta: number) {
    const list = [...this.categories()];
    const [c] = list.splice(i, 1);
    list.splice(i + delta, 0, c);
    this.categories.set(list.map((x, pos) => ({ ...x, position: pos })));
    await this.api.put('/admin/skill-categories', { ids: list.map((x) => x.id) }).catch((e) => this.toast.error(e));
  }

  protected async remove(c: SkillCategoryDto) {
    const ok = await this.confirm.ask({
      title: t('Supprimer la catégorie ?'),
      message: c.skillCount ? t('Les {subject} skill(s) de cette catégorie passeront « sans catégorie ».') : t('La catégorie {subject} sera supprimée.'),
      subject: c.skillCount ? String(c.skillCount) : c.name,
      confirmLabel: t('Supprimer'),
      danger: true,
    });
    if (!ok) return;
    await this.api.delete(`/admin/skill-categories/${c.id}`).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
}
