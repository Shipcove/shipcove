import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SKILL_LIMITS, isMarkdownPath, isSafeSkillPath, type SkillCategoryDto, type SkillDetailDto, type SkillDto } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { LayoutService } from '../../core/layout.service';
import { Icon } from '../../shared/icon';
import { CodeEditor } from '../../shared/monaco';
import { BytesPipe, CodeBlocksDirective, MarkdownPipe } from '../../shared/pipes';
import { downloadSkillZip, isTextFile, splitFrontmatter } from './skill-util';
import { SkillScopeService } from './skill-scope.service';
import { t, tr } from '../../core/i18n';

/** Fichier en cours d'édition. `sourcePath` : fichier repris tel quel de la version chargée. */
interface EditFile {
  path: string;
  content: string;
  size: number;
  sourcePath: string | null;
  dirty: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  depth: number;
  file?: EditFile;
}

const TEMPLATE = (name: string) => `---
name: ${name}
description: ${t('Ce que fait ce skill et quand l’utiliser (Pi s’appuie sur cette phrase pour le choisir).')}
---

# ${name}

## ${t('Instructions')}

1. …

## ${t('Ressources')}

${t('Les fichiers markdown annexes (dossier `references/` par exemple) sont lus par Pi à la demande.')}
`;

/**
 * Éditeur de skill : arborescence (dossiers et sous-dossiers) de fichiers markdown, édition avec
 * aperçu, téléversement de .md, import et export .zip, catégorie, suppression.
 * Lecture seule (mais activable pour soi) pour un skill que l'utilisateur ne gère pas.
 */
@Component({
  selector: 'cap-skill-editor',
  imports: [FormsModule, RouterLink, Icon, CodeEditor, BytesPipe, MarkdownPipe, CodeBlocksDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full', '(window:beforeunload)': 'beforeUnload($event)' },
  template: `
    <div class="flex h-full flex-col">
      <!-- En-tête -->
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200 px-3 py-2 sm:px-4 dark:border-stone-800">
        <a routerLink="/extensions" class="btn-ghost !p-1.5" [attr.aria-label]="t('Retour aux skills')" [title]="t('Retour')"><cap-icon name="chevronLeft" /></a>
        @if (isNew()) {
          <input class="input !w-56 font-mono" [(ngModel)]="newName" (ngModelChange)="renameTemplate()" [placeholder]="t('nom-du-skill')" [attr.aria-label]="t('Nom du skill')" autocomplete="off" />
          <select class="input !w-auto" [ngModel]="categoryId()" (ngModelChange)="categoryId.set($event)" [attr.aria-label]="t('Catégorie')">
            <option [ngValue]="null">{{ t('Sans catégorie') }}</option>
            @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
          </select>
        } @else if (detail(); as d) {
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="truncate font-mono font-semibold">{{ d.skill.name }}</h1>
              <span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ d.skill.scope === 'global' ? 'Global' : 'Personnel' }}</span>
              @if (d.skill.status !== 'published') { <span class="badge bg-amber-100 text-amber-800">{{ statusLabel(d.skill.status) }}</span> }
              @if (d.skill.canManage && categories().length) {
                <select class="input !w-auto !py-0.5 text-xs" [ngModel]="d.skill.categoryId" (ngModelChange)="setCategory($event)" [attr.aria-label]="t('Catégorie')">
                  <option [ngValue]="null">{{ t('Sans catégorie') }}</option>
                  @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
                </select>
              } @else if (categoryName(d.skill.categoryId); as cn) { <span class="badge bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">{{ cn }}</span> }
            </div>
            <div class="truncate text-xs text-stone-500">{{ d.skill.description }}</div>
          </div>
        }
        <div class="ml-auto flex flex-wrap items-center gap-2">
          @if (detail(); as d) {
            @if (d.skill.status === 'published') {
              <label class="flex cursor-pointer items-center gap-2 text-sm" [title]="d.skill.enabledForMe ? t('Pi peut utiliser ce skill') : t('Pi n’utilise pas ce skill')">
                <input type="checkbox" class="peer sr-only" [checked]="d.skill.enabledForMe" (change)="toggleEnabled()" />
                <span class="relative h-5 w-9 rounded-full bg-stone-300 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4 dark:bg-stone-700"></span>
                {{ d.skill.enabledForMe ? t('Activé') : t('Désactivé') }}
              </label>
            }
            @if (auth.isAdmin()) {
              <button class="btn-ghost !py-1 text-sm" (click)="toggleScope()" [disabled]="busy()"
                [title]="d.skill.scope === 'global' ? t('Le skill redevient personnel (à vous) et n’est plus disponible pour les autres') : t('Rendre ce skill disponible pour tous les utilisateurs')">
                <cap-icon name="globe" [size]="14" /> <span class="hidden sm:inline">{{ d.skill.scope === 'global' ? t('Retirer du global') : t('Rendre global') }}</span></button>
            }
            <button class="btn-ghost !py-1 text-sm" (click)="exportZip()" [title]="t('Télécharger le skill (.zip)')"><cap-icon name="archive" [size]="14" /> <span class="hidden sm:inline">{{ t('Exporter') }}</span></button>
          }
          @if (detail()?.skill?.canManage) {
            <button class="btn-ghost !py-1 text-sm text-stone-500 hover:text-red-600" (click)="deleteSkill()" [title]="t('Supprimer le skill')" [attr.aria-label]="t('Supprimer le skill')"><cap-icon name="trash" [size]="14" /></button>
          }
          @if (editable()) {
            <button class="btn-ghost !py-1 text-sm" (click)="zipInput.click()" [title]="isNew() ? t('Créer le skill depuis une archive .zip') : t('Remplacer le contenu par une archive .zip')">
              <cap-icon name="paperclip" [size]="14" /> <span class="hidden sm:inline">{{ t('Importer .zip') }}</span></button>
            <button class="btn-primary !py-1 text-sm" (click)="save()" [disabled]="busy() || (!isNew() && !dirty())">
              {{ isNew() ? t('Créer le skill') : dirty() ? t('Enregistrer') : t('Enregistré') }}</button>
          }
          <input #zipInput type="file" accept=".zip,application/zip" class="hidden" (change)="importZip($event)" />
        </div>
      </header>

      @if (findings().length) {
        <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" role="status">
          <div class="font-medium">{{ t('Points à vérifier :') }}</div>
          <ul class="list-disc pl-5">@for (f of findings(); track f) { <li>{{ tr(f) }}</li> }</ul>
        </div>
      }
      @if (!editable() && detail()) {
        <div class="border-b border-stone-200 bg-stone-50 px-4 py-1.5 text-xs text-stone-500 dark:border-stone-800 dark:bg-stone-900/60">
          <cap-icon name="lock" [size]="12" /> {{ detail()!.skill.scope === 'global' ? t('Lecture seule : ce skill est géré par l’administrateur. Vous pouvez l’activer ou le désactiver pour vous.') : t('Lecture seule : ce skill est géré par son propriétaire. Vous pouvez l’activer ou le désactiver pour vous.') }}
        </div>
      }

      <!-- Onglets sur mobile -->
      <div class="flex border-b border-stone-200 md:hidden dark:border-stone-800" role="tablist">
        <button role="tab" class="flex-1 py-2 text-sm" [class]="mobileTab() === 'tree' ? 'border-b-2 border-accent-600 font-medium' : 'text-stone-500'" (click)="mobileTab.set('tree')">{{ t('Fichiers ({n})', { n: files().length }) }}</button>
        <button role="tab" class="flex-1 py-2 text-sm" [class]="mobileTab() === 'file' ? 'border-b-2 border-accent-600 font-medium' : 'text-stone-500'" (click)="mobileTab.set('file')">{{ selectedName() }}</button>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- Arborescence -->
        <aside class="flex w-full shrink-0 flex-col border-stone-200 md:w-72 md:border-r dark:border-stone-800" [class.max-md:hidden]="mobileTab() !== 'tree'" [attr.aria-label]="t('Fichiers du skill')">
          @if (editable()) {
            <div class="flex items-center gap-1 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
              <button class="btn-ghost !p-1.5" (click)="startCreate('file')" [title]="t('Nouveau fichier')" [attr.aria-label]="t('Nouveau fichier')"><cap-icon name="file" [size]="15" /><cap-icon name="plus" [size]="10" class="-ml-1.5" /></button>
              <button class="btn-ghost !p-1.5" (click)="startCreate('dir')" [title]="t('Nouveau dossier')" [attr.aria-label]="t('Nouveau dossier')"><cap-icon name="folder" [size]="15" /><cap-icon name="plus" [size]="10" class="-ml-1.5" /></button>
              <button class="btn-ghost !p-1.5" (click)="uploadInput.click()" [title]="t('Téléverser des fichiers markdown (.md) dans le dossier sélectionné')" [attr.aria-label]="t('Téléverser des fichiers markdown')"><cap-icon name="paperclip" [size]="15" /></button>
              <input #uploadInput type="file" multiple accept=".md,.markdown,text/markdown" class="hidden" (change)="uploadFiles($event)" />
              <span class="ml-auto truncate text-[11px] text-stone-400" [title]="t('Dossier cible : {dir}', { dir: targetDir() || t('racine') })">{{ targetDir() ? targetDir() + '/' : t('racine') }}</span>
            </div>
          }
          @if (creating(); as c) {
            <form class="flex items-center gap-1 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800" (ngSubmit)="confirmCreate()">
              <cap-icon [name]="c === 'dir' ? 'folder' : 'file'" [size]="14" class="shrink-0 text-stone-400" />
              <input #createInput class="input !py-1 font-mono text-xs" name="newPath" [(ngModel)]="newPath" [placeholder]="c === 'dir' ? t('dossier/sous-dossier') : t('dossier/fichier.md (markdown)')" (keydown.escape)="creating.set(null)" [attr.aria-label]="t('Chemin')" />
              <button class="btn-primary !px-2 !py-1 text-xs">OK</button>
            </form>
          }
          <ul class="min-h-0 flex-1 overflow-y-auto py-1 text-sm" role="tree">
            @for (n of tree(); track n.path) {
              <li role="treeitem" [attr.aria-expanded]="n.kind === 'dir' ? !collapsedDirs().has(n.path) : null" [attr.aria-selected]="n.kind === 'file' ? n.path === selected() : null">
                <div class="group flex items-center gap-1 py-1 pr-1 hover:bg-stone-100 dark:hover:bg-stone-800/60"
                  [style.padding-left.px]="8 + n.depth * 14" [class.bg-stone-200]="n.path === selected() || (n.kind === 'dir' && n.path === selectedDir())" [class.dark:bg-stone-800]="n.path === selected() || (n.kind === 'dir' && n.path === selectedDir())">
                  @if (renaming() === n.path) {
                    <input #renameInput class="input !py-0.5 font-mono text-xs" [value]="n.path" (keydown.enter)="confirmRename(n, renameInput.value)" (keydown.escape)="renaming.set(null)" (blur)="confirmRename(n, renameInput.value)" [attr.aria-label]="t('Nouveau chemin')" />
                  } @else {
                    <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" (click)="n.kind === 'dir' ? toggleDir(n.path) : select(n.path)" [title]="n.path">
                      @if (n.kind === 'dir') {
                        <cap-icon [name]="collapsedDirs().has(n.path) ? 'chevronRight' : 'chevronDown'" [size]="12" class="shrink-0 text-stone-400" />
                        <cap-icon name="folder" [size]="14" class="shrink-0 text-sky-600" />
                      } @else {
                        <span class="w-3 shrink-0"></span>
                        <cap-icon name="file" [size]="14" class="shrink-0 text-stone-400" />
                      }
                      <span class="truncate" [class.font-semibold]="n.path === 'SKILL.md'" [class.italic]="n.file?.dirty">{{ n.name }}</span>
                      @if (n.file?.dirty) { <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" [title]="t('Modifié')"></span> }
                    </button>
                    @if (editable() && n.path !== 'SKILL.md') {
                      <span class="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                        <button class="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-700" (click)="startRename(n.path)" [attr.aria-label]="t('Renommer {name}', { name: n.path })" [title]="t('Renommer / déplacer')"><cap-icon name="edit" [size]="12" /></button>
                        <button class="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-red-600 dark:hover:bg-stone-700" (click)="remove(n)" [attr.aria-label]="t('Supprimer {name}', { name: n.path })" [title]="t('Supprimer')"><cap-icon name="trash" [size]="12" /></button>
                      </span>
                    }
                  }
                </div>
              </li>
            }
          </ul>
          <div class="border-t border-stone-200 px-3 py-1.5 text-[11px] text-stone-400 dark:border-stone-800">
            {{ t('{n} fichier(s)', { n: files().length }) }} · {{ totalSize() | bytes }} / {{ maxTotal | bytes }}
          </div>
        </aside>

        <!-- Fichier sélectionné -->
        <section class="flex min-w-0 flex-1 flex-col" [class.max-md:hidden]="mobileTab() !== 'file'" [attr.aria-label]="t('Contenu du fichier')">
          @if (current(); as f) {
            <div class="flex items-center gap-2 border-b border-stone-200 px-3 py-1.5 text-xs text-stone-500 dark:border-stone-800">
              <span class="min-w-0 truncate font-mono text-stone-700 dark:text-stone-300">{{ f.path }}</span>
              <span class="shrink-0">{{ f.size | bytes }}</span>
              <div class="ml-auto flex shrink-0 gap-0.5 rounded-md bg-stone-100 p-0.5 dark:bg-stone-800" role="tablist" [attr.aria-label]="t('Affichage')">
                @for (m of modes(); track m.id) {
                  <button role="tab" class="rounded px-2 py-0.5" [attr.aria-selected]="view() === m.id"
                    [class]="view() === m.id ? 'bg-white font-medium text-stone-800 shadow-sm dark:bg-stone-900 dark:text-stone-100' : 'hover:text-stone-800 dark:hover:text-stone-200'" (click)="view.set(m.id)">{{ m.label }}</button>
                }
              </div>
            </div>
            <div class="flex min-h-0 flex-1">
              @if (view() !== 'preview') {
                <div class="min-h-0 min-w-0 flex-1" [class.border-r]="view() === 'split'" [class.border-stone-200]="view() === 'split'" [class.dark:border-stone-800]="view() === 'split'">
                  <cap-code-editor [value]="editorValue()" [path]="f.path" [readOnly]="!editable()" (changed)="edit($event)" />
                </div>
              }
              @if (view() !== 'code') {
                <!-- Aperçu : rendu identique aux réponses de Pi (HTML assaini). Liens vers d'autres .md du skill : ouverts ici. -->
                <div class="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4" (click)="onPreviewClick($event)" [attr.aria-label]="t('Aperçu markdown')" data-skill-preview>
                  @if (preview(); as p) {
                    @if (p.meta.length) {
                      <dl class="mb-4 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm dark:border-stone-800 dark:bg-stone-900/60">
                        @for (m of p.meta; track m.key) {
                          <div class="flex gap-2 py-0.5"><dt class="w-24 shrink-0 font-mono text-xs text-stone-500">{{ m.key }}</dt><dd class="min-w-0 [overflow-wrap:anywhere]">{{ m.value }}</dd></div>
                        }
                      </dl>
                    }
                    <div class="prose-chat" capCodeBlocks [innerHTML]="p.body | markdown"></div>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="flex flex-1 items-center justify-center p-6 text-sm text-stone-500">{{ t('Sélectionnez un fichier.') }}</div>
          }
        </section>
      </div>
    </div>
  `,
})
export class SkillEditor implements OnDestroy {
  protected readonly t = t;
  protected readonly tr = tr;
  /** `new` ou identifiant du skill. */
  readonly skillId = input.required<string>();
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly scopes = inject(SkillScopeService);
  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');
  private readonly layout = inject(LayoutService);

  protected readonly detail = signal<SkillDetailDto | null>(null);
  protected readonly files = signal<EditFile[]>([]);
  protected readonly selected = signal<string | null>(null);
  protected readonly selectedDir = signal<string>('');
  /** Valeur donnée à l'éditeur (à la sélection seulement, pour ne pas perdre le curseur). */
  protected readonly editorValue = signal('');
  protected readonly collapsedDirs = signal<Set<string>>(new Set());
  protected readonly emptyDirs = signal<Set<string>>(new Set());
  protected readonly creating = signal<'file' | 'dir' | null>(null);
  protected readonly renaming = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly findings = signal<string[]>([]);
  protected readonly mobileTab = signal<'tree' | 'file'>('tree');
  protected readonly categories = signal<SkillCategoryDto[]>([]);
  /** Catégorie d'un nouveau skill. */
  protected readonly categoryId = signal<string | null>(null);
  protected readonly view = signal<'code' | 'preview' | 'split'>('split');
  /** Contenu courant du fichier ouvert, pour l'aperçu (mis à jour à la frappe). */
  private readonly liveContent = signal('');
  protected readonly preview = computed(() => (this.current() ? splitFrontmatter(this.liveContent()) : null));
  protected readonly modes = computed(() => [
    { id: 'code' as const, label: t('Code') },
    { id: 'preview' as const, label: t('Aperçu') },
    ...(this.layout.wide() ? [{ id: 'split' as const, label: t('Les deux') }] : []),
  ]);
  protected readonly maxTotal = SKILL_LIMITS.maxTotalBytes;
  protected newName = '';
  protected newPath = '';

  protected readonly isNew = computed(() => this.skillId() === 'new');
  protected readonly editable = computed(() => this.isNew() || !!this.detail()?.skill.canManage);
  protected readonly dirty = computed(() => this.removedOrRenamedSig() || this.files().some((f) => f.dirty || f.sourcePath !== f.path));
  private readonly removedOrRenamedSig = signal(false);
  protected readonly current = computed(() => this.files().find((f) => f.path === this.selected()) ?? null);
  protected readonly selectedName = computed(() => this.selected()?.split('/').pop() ?? 'Fichier');
  protected readonly totalSize = computed(() => this.files().reduce((n, f) => n + f.size, 0));
  /** Dossier où créer / téléverser : dossier sélectionné, ou celui du fichier sélectionné. */
  protected readonly targetDir = computed(() => this.selectedDir() || (this.selected()?.includes('/') ? this.selected()!.split('/').slice(0, -1).join('/') : ''));

  /** Arborescence : dossiers d'abord, SKILL.md en tête de la racine. */
  protected readonly tree = computed<TreeNode[]>(() => {
    interface Dir { dirs: Map<string, Dir>; files: EditFile[] }
    const root: Dir = { dirs: new Map(), files: [] };
    const ensure = (parts: string[]) => parts.reduce((d, p) => d.dirs.get(p) ?? (d.dirs.set(p, { dirs: new Map(), files: [] }), d.dirs.get(p)!), root);
    for (const f of this.files()) ensure(f.path.split('/').slice(0, -1)).files.push(f);
    for (const d of this.emptyDirs()) ensure(d.split('/'));
    const out: TreeNode[] = [];
    const walk = (d: Dir, prefix: string, depth: number) => {
      const files = [...d.files].sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
      if (depth === 0) for (const f of files.filter((x) => x.path === 'SKILL.md')) out.push({ name: 'SKILL.md', path: f.path, kind: 'file', depth, file: f });
      for (const [name, sub] of [...d.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const path = prefix ? `${prefix}/${name}` : name;
        out.push({ name, path, kind: 'dir', depth });
        if (!this.collapsedDirs().has(path)) walk(sub, path, depth + 1);
      }
      for (const f of files.filter((x) => x.path !== 'SKILL.md' || depth > 0)) out.push({ name: f.path.split('/').pop()!, path: f.path, kind: 'file', depth, file: f });
    };
    walk(root, '', 0);
    return out;
  });

  constructor() {
    effect(() => {
      const id = this.skillId();
      untracked(() => void this.load(id));
    });
    // « Les deux » n'existe que sur grand écran : aperçu seul sinon.
    effect(() => {
      if (!this.layout.wide() && untracked(() => this.view()) === 'split') this.view.set('preview');
    });
    void this.api.get<SkillCategoryDto[]>('/skill-categories').then((c) => this.categories.set(c)).catch(() => undefined);
  }

  ngOnDestroy(): void {
    /* rien à libérer */
  }

  protected beforeUnload(e: BeforeUnloadEvent): void {
    if (this.editable() && this.dirty()) e.preventDefault();
  }

  private async load(id: string): Promise<void> {
    this.removedOrRenamedSig.set(false);
    this.emptyDirs.set(new Set());
    if (id === 'new') {
      this.detail.set(null);
      this.findings.set([]);
      this.newName = '';
      this.categoryId.set(null);
      this.files.set([{ path: 'SKILL.md', content: TEMPLATE(t('nom-du-skill')), size: 0, sourcePath: null, dirty: true }]);
      this.files.update((l) => l.map((f) => ({ ...f, size: new Blob([f.content]).size })));
      this.select('SKILL.md', false);
      return;
    }
    try {
      const d = await this.api.get<SkillDetailDto>(`/skills/${id}`);
      this.detail.set(d);
      this.findings.set(d.skill.findings);
      this.files.set(d.files.map((f) => ({ path: f.path, content: f.content, size: f.size, sourcePath: f.path, dirty: false })));
      this.select(this.files().some((f) => f.path === this.selected()) ? this.selected()! : 'SKILL.md', false);
    } catch (e) {
      this.toast.error(e);
      await this.router.navigateByUrl('/extensions');
    }
  }



  protected statusLabel(s: SkillDto['status']): string {
    return s === 'pending_review' ? t('En attente de validation') : t('Disponible');
  }


  /* ------------------------------ Navigation ------------------------------ */

  /** Déplie les dossiers parents d'un chemin (fichier créé, sélectionné ou téléversé). */
  private reveal(path: string): void {
    const parts = path.split('/').slice(0, -1);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    if (ancestors.some((a) => this.collapsedDirs().has(a))) this.collapsedDirs.set(new Set([...this.collapsedDirs()].filter((d) => !ancestors.includes(d))));
  }

  /** `fromUser` : choix explicite (sur mobile, bascule alors sur l'onglet du fichier). */
  protected select(path: string, fromUser = true): void {
    const f = this.files().find((x) => x.path === path);
    if (!f) return;
    this.reveal(path);
    this.selected.set(path);
    this.selectedDir.set('');
    this.editorValue.set(f.content);
    this.liveContent.set(f.content);
    if (fromUser) this.mobileTab.set('file');
  }

  protected toggleDir(path: string): void {
    this.selectedDir.set(path);
    const next = new Set(this.collapsedDirs());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.collapsedDirs.set(next);
  }

  /* ------------------------------ Édition ------------------------------ */

  protected edit(content: string): void {
    const path = this.selected();
    this.liveContent.set(content);
    this.files.update((l) => l.map((f) => (f.path === path && f.content !== content ? { ...f, content, size: new Blob([content]).size, dirty: true } : f)));
  }

  protected categoryName(id: string | null): string | null {
    return this.categories().find((c) => c.id === id)?.name ?? null;
  }

  protected async setCategory(categoryId: string | null): Promise<void> {
    const d = this.detail();
    if (!d) return;
    try {
      await this.api.patch(`/skills/${d.skill.id}`, { categoryId });
      this.detail.set({ ...d, skill: { ...d.skill, categoryId } });
      this.toast.show(categoryId ? t('Classé dans « {name} »', { name: this.categoryName(categoryId) }) : t('Sans catégorie'), 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }

  /** Lien de l'aperçu vers un autre fichier markdown du skill : ouvert dans l'éditeur. */
  protected onPreviewClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href || /^([a-z]+:|#|\/\/)/i.test(href)) return;
    const base = this.selected()?.split('/').slice(0, -1) ?? [];
    const parts = [...base];
    for (const seg of decodeURIComponent(href.split('#')[0]).split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    const target = parts.join('/');
    e.preventDefault();
    if (this.files().some((f) => f.path === target)) this.select(target);
    else this.toast.show(t('Fichier introuvable dans le skill : {path}', { path: target }), 'error');
  }

  /** Nouveau skill : le nom du frontmatter suit le nom saisi. */
  protected renameTemplate(): void {
    const name = this.newName.trim() || 'nom-du-skill';
    this.files.update((l) => l.map((f) => (f.path === 'SKILL.md' ? { ...f, content: f.content.replace(/^(---\r?\n[\s\S]*?^name:\s*).*$/m, `$1${name}`) } : f)));
    if (this.selected() === 'SKILL.md') this.editorValue.set(this.files().find((f) => f.path === 'SKILL.md')!.content);
  }

  protected startCreate(kind: 'file' | 'dir'): void {
    this.creating.set(kind);
    this.newPath = this.targetDir() ? `${this.targetDir()}/` : '';
    setTimeout(() => this.createInput()?.nativeElement.focus());
  }

  protected confirmCreate(): void {
    const kind = this.creating();
    const path = this.newPath.trim().replace(/^\/+|\/+$/g, '');
    if (!kind || !path) return this.creating.set(null);
    if (!isSafeSkillPath(path)) return this.toast.show(t('Chemin invalide (relatif, sans « .. »)'), 'error');
    if (kind === 'file' && !isMarkdownPath(path)) return this.toast.show(t('Seuls les fichiers markdown (.md) sont acceptés'), 'error');
    if (this.exists(path)) return this.toast.show(t('« {path} » existe déjà', { path }), 'error');
    if (kind === 'dir') {
      this.emptyDirs.update((s) => new Set([...s, path]));
      this.reveal(`${path}/x`);
      this.selectedDir.set(path);
    } else {
      this.files.update((l) => [...l, { path, content: '', size: 0, sourcePath: null, dirty: true }]);
      this.select(path);
    }
    this.creating.set(null);
  }

  /** Fichier ou dossier existant (un fichier ne peut pas porter le nom d'un dossier). */
  private exists(path: string): boolean {
    const lower = path.toLowerCase();
    return this.files().some((f) => f.path.toLowerCase() === lower || f.path.toLowerCase().startsWith(`${lower}/`) || lower.startsWith(`${f.path.toLowerCase()}/`));
  }

  protected startRename(path: string): void {
    this.renaming.set(path);
  }

  /** Renommer ou déplacer un fichier ou un dossier entier (chemin complet modifiable). */
  protected confirmRename(n: TreeNode, value: string): void {
    if (this.renaming() !== n.path) return;
    this.renaming.set(null);
    const to = value.trim().replace(/^\/+|\/+$/g, '');
    if (!to || to === n.path) return;
    if (!isSafeSkillPath(to)) return this.toast.show(t('Chemin invalide (relatif, sans « .. »)'), 'error');
    if (n.kind === 'file' && !isMarkdownPath(to)) return this.toast.show(t('Seuls les fichiers markdown (.md) sont acceptés'), 'error');
    const moved = (p: string) => (n.kind === 'dir' ? (p.startsWith(`${n.path}/`) ? to + p.slice(n.path.length) : p) : p === n.path ? to : p);
    const others = this.files().filter((f) => moved(f.path) === f.path);
    if (others.some((f) => f.path.toLowerCase() === to.toLowerCase() || f.path.toLowerCase().startsWith(`${to.toLowerCase()}/`))) return this.toast.show(t('« {path} » existe déjà', { path: to }), 'error');
    this.files.update((l) => l.map((f) => ({ ...f, path: moved(f.path) })));
    this.emptyDirs.update((s) => new Set([...s].map((d) => (n.kind === 'dir' && (d === n.path || d.startsWith(`${n.path}/`)) ? to + d.slice(n.path.length) : d))));
    if (this.selected()) this.selected.set(moved(this.selected()!));
    this.removedOrRenamedSig.set(true);
  }

  protected async remove(n: TreeNode): Promise<void> {
    const inside = n.kind === 'dir' ? this.files().filter((f) => f.path.startsWith(`${n.path}/`)) : [];
    const ok = await this.confirm.ask({
      title: n.kind === 'dir' ? t('Supprimer le dossier ?') : t('Supprimer le fichier ?'),
      message: n.kind === 'dir' ? t('{subject} et ses {n} fichier(s) seront retirés du skill à l’enregistrement.', { n: inside.length }) : t('{subject} sera retiré du skill à l’enregistrement.'),
      subject: n.path,
      confirmLabel: t('Supprimer'),
      danger: true,
    });
    if (!ok) return;
    this.files.update((l) => l.filter((f) => (n.kind === 'dir' ? !f.path.startsWith(`${n.path}/`) : f.path !== n.path)));
    this.emptyDirs.update((s) => new Set([...s].filter((d) => d !== n.path && !d.startsWith(`${n.path}/`))));
    if (this.selected() && !this.files().some((f) => f.path === this.selected())) this.select('SKILL.md', false);
    this.removedOrRenamedSig.set(true);
  }

  /** Téléversement de fichiers markdown dans le dossier cible ; un fichier du même nom est remplacé. */
  protected async uploadFiles(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const list = [...(input.files ?? [])];
    input.value = '';
    let added = 0;
    for (const file of list) {
      const path = this.targetDir() ? `${this.targetDir()}/${file.name}` : file.name;
      if (!isMarkdownPath(path)) {
        this.toast.show(t('{name} ignoré : seuls les fichiers markdown (.md) sont acceptés', { name: file.name }), 'error');
        continue;
      }
      if (file.size > SKILL_LIMITS.maxFileBytes || !isSafeSkillPath(path)) {
        this.toast.show(t('{name} refusé (taille ou nom invalide)', { name: file.name }), 'error');
        continue;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      if (!isTextFile(buf)) {
        this.toast.show(t('{name} n’est pas un fichier texte', { name: file.name }), 'error');
        continue;
      }
      const entry: EditFile = { path, content: new TextDecoder().decode(buf), size: buf.length, sourcePath: null, dirty: true };
      this.files.update((l) => [...l.filter((f) => f.path !== path), entry]);
      this.reveal(path);
      added++;
    }
    if (added) this.toast.show(t('{n} fichier(s) ajouté(s) dans {dir}', { n: added, dir: this.targetDir() || t('la racine') }), 'success');
  }

  /* ------------------------------ Enregistrement ------------------------------ */

  private payload(sourceRefs: boolean) {
    return this.files().map((f) =>
      sourceRefs && !f.dirty && f.sourcePath
        ? { path: f.path, sourcePath: f.sourcePath }
        : { path: f.path, content: f.content },
    );
  }

  protected async save(): Promise<void> {
    if (this.totalSize() > SKILL_LIMITS.maxTotalBytes) return this.toast.show(t('Le skill dépasse {size} Mo', { size: SKILL_LIMITS.maxTotalBytes / 1024 / 1024 }), 'error');
    this.busy.set(true);
    try {
      if (this.isNew()) {
        const name = this.newName.trim();
        const r = await this.api.post<{ id: string; findings: string[] }>('/skills', { name, categoryId: this.categoryId(), files: this.payload(false) });
        this.toast.show(t('Skill créé'), 'success');
        await this.router.navigate(['/extensions/skills', r.id], { replaceUrl: true });
      } else {
        await this.api.put<{ findings: string[] }>(`/skills/${this.skillId()}/files`, { files: this.payload(true) });
        this.toast.show(t('Skill enregistré'), 'success');
        await this.load(this.skillId());
      }
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async deleteSkill(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    const ok = await this.confirm.ask({
      title: t('Supprimer le skill ?'),
      message: d.skill.scope === 'global' ? t('{subject} sera supprimé pour tous les utilisateurs.') : t('{subject} sera supprimé définitivement.'),
      subject: d.skill.name,
      confirmLabel: t('Supprimer'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.delete(`/skills/${d.skill.id}`);
      this.toast.show(t('Skill supprimé'), 'success');
      await this.router.navigateByUrl('/extensions');
    } catch (e) {
      this.toast.error(e);
    }
  }

  /** Administrateur : rendre global / retirer du global (même action que sur la carte). */
  protected async toggleScope(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    if (await this.scopes.toggle(d.skill)) await this.load(this.skillId());
  }

  protected async importZip(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!this.isNew()) {
      const ok = await this.confirm.ask({ title: t('Remplacer le contenu ?'), message: t('Le contenu de {subject} sera remplacé par celui de l’archive.'), subject: this.detail()?.skill.name, confirmLabel: t('Remplacer') });
      if (!ok) return;
    }
    const form = new FormData();
    form.append('file', file, file.name);
    if (this.isNew()) {
      if (this.categoryId()) form.append('categoryId', this.categoryId()!);
      if (this.newName.trim()) form.append('name', this.newName.trim());
    } else form.append('skillId', this.skillId());
    this.busy.set(true);
    try {
      const r = await this.api.upload<{ id: string; findings: string[]; ignored: string[] }>('/skills/import', form);
      this.toast.show(r.ignored.length ? t('Archive importée — {n} fichier(s) non markdown ignoré(s) : {files}', { n: r.ignored.length, files: r.ignored.slice(0, 5).join(', ') + (r.ignored.length > 5 ? '…' : '') }) : t('Archive importée'), 'success', r.ignored.length ? 12_000 : 5000);
      if (this.isNew()) await this.router.navigate(['/extensions/skills', r.id], { replaceUrl: true });
      else await this.load(this.skillId());
    } catch (err) {
      this.toast.show(err instanceof ApiError ? tr(err.message) : t('Import impossible'), 'error', 10_000);
    } finally {
      this.busy.set(false);
    }
  }

  protected async exportZip(): Promise<void> {
    const d = this.detail();
    if (d) await downloadSkillZip(this.api.base, d.skill.id, d.skill.name).catch(() => this.toast.show(t('Export impossible'), 'error'));
  }

  protected async toggleEnabled(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    try {
      await this.api.put(`/skills/${d.skill.id}/installation`, { scope: 'personal', enabled: !d.skill.enabledForMe });
      this.detail.set({ ...d, skill: { ...d.skill, enabledForMe: !d.skill.enabledForMe } });
    } catch (e) {
      this.toast.error(e);
    }
  }
}
