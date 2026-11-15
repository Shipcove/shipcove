import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SKILL_LIMITS, isSafeSkillPath, type SkillDetailDto, type SkillDto } from '@cap/contracts';
import { Api, ApiError } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { CodeEditor } from '../../shared/monaco';
import { BytesPipe } from '../../shared/pipes';
import { downloadSkillZip, isTextFile, toBase64 } from './skill-util';

/** Fichier en cours d'édition. `sourcePath` : fichier repris tel quel de la version chargée. */
interface EditFile {
  path: string;
  encoding: 'utf8' | 'base64';
  executable: boolean;
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
description: Ce que fait ce skill et quand l’utiliser (Pi s’appuie sur cette phrase pour le choisir).
---

# ${name}

## Instructions

1. …

## Ressources

Les fichiers annexes (dossiers \`references/\`, \`scripts/\`, \`assets/\`…) sont lus par Pi à la demande.
`;

/**
 * Éditeur de skill : arborescence (dossiers et sous-dossiers), édition des fichiers texte,
 * téléversement de fichiers (binaires compris), import et export .zip, historique des versions.
 * Lecture seule pour un skill que l'utilisateur ne gère pas ou pour une ancienne version.
 */
@Component({
  selector: 'cap-skill-editor',
  imports: [FormsModule, RouterLink, Icon, CodeEditor, BytesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full', '(window:beforeunload)': 'beforeUnload($event)' },
  template: `
    <div class="flex h-full flex-col">
      <!-- En-tête -->
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200 px-3 py-2 sm:px-4 dark:border-stone-800">
        <a routerLink="/extensions" class="btn-ghost !p-1.5" aria-label="Retour aux skills" title="Retour"><cap-icon name="chevronLeft" /></a>
        @if (isNew()) {
          <input class="input !w-56 font-mono" [(ngModel)]="newName" (ngModelChange)="renameTemplate()" placeholder="nom-du-skill" aria-label="Nom du skill" autocomplete="off" />
          <select class="input !w-auto" [(ngModel)]="newScope" aria-label="Portée">
            <option value="personal">Personnel</option>
            @if (auth.isAdmin()) { <option value="global">Global (tous les utilisateurs)</option> }
          </select>
        } @else if (detail(); as d) {
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="truncate font-mono font-semibold">{{ d.skill.name }}</h1>
              <span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{{ d.skill.scope === 'global' ? 'Global' : 'Personnel' }}</span>
              @if (d.skill.status !== 'published') { <span class="badge bg-amber-100 text-amber-800">{{ statusLabel(d.skill.status) }}</span> }
            </div>
            <div class="truncate text-xs text-stone-500">{{ d.skill.description }}</div>
          </div>
        }
        <div class="ml-auto flex flex-wrap items-center gap-2">
          @if (detail(); as d) {
            <select class="input !w-auto !py-1 text-sm" [ngModel]="d.version" (ngModelChange)="loadVersion($event)" aria-label="Version">
              @for (v of d.versions; track v.version) { <option [ngValue]="v.version">v{{ v.version }}{{ v.version === d.skill.latestVersion ? ' (actuelle)' : '' }}</option> }
            </select>
            @if (d.skill.status === 'published') {
              <label class="flex cursor-pointer items-center gap-2 text-sm" [title]="d.skill.enabledForMe ? 'Pi peut utiliser ce skill' : 'Pi n’utilise pas ce skill'">
                <input type="checkbox" class="peer sr-only" [checked]="d.skill.enabledForMe" (change)="toggleEnabled()" />
                <span class="relative h-5 w-9 rounded-full bg-stone-300 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4 dark:bg-stone-700"></span>
                {{ d.skill.enabledForMe ? 'Activé' : 'Désactivé' }}
              </label>
            }
            <button class="btn-ghost !py-1 text-sm" (click)="exportZip()" title="Télécharger le skill (.zip)"><cap-icon name="archive" [size]="14" /> <span class="hidden sm:inline">Exporter</span></button>
          }
          @if (editable()) {
            <button class="btn-ghost !py-1 text-sm" (click)="zipInput.click()" [title]="isNew() ? 'Créer le skill depuis une archive .zip' : 'Remplacer le contenu par une archive .zip (nouvelle version)'">
              <cap-icon name="paperclip" [size]="14" /> <span class="hidden sm:inline">Importer .zip</span></button>
            <button class="btn-primary !py-1 text-sm" (click)="save()" [disabled]="busy() || (!isNew() && !dirty())">
              {{ isNew() ? 'Créer le skill' : dirty() ? 'Enregistrer (v' + ((detail()?.skill?.latestVersion ?? 0) + 1) + ')' : 'Enregistré' }}</button>
          } @else if (detail() && !viewingLatest() && detail()!.skill.canManage) {
            <button class="btn-secondary !py-1 text-sm" (click)="restore()" [disabled]="busy()">Restaurer cette version</button>
          }
          <input #zipInput type="file" accept=".zip,application/zip" class="hidden" (change)="importZip($event)" />
        </div>
      </header>

      @if (findings().length) {
        <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" role="status">
          <div class="font-medium">Points à vérifier :</div>
          <ul class="list-disc pl-5">@for (f of findings(); track f) { <li>{{ f }}</li> }</ul>
        </div>
      }
      @if (!editable() && detail()) {
        <div class="border-b border-stone-200 bg-stone-50 px-4 py-1.5 text-xs text-stone-500 dark:border-stone-800 dark:bg-stone-900/60">
          <cap-icon name="lock" [size]="12" /> {{ detail()!.skill.canManage ? 'Ancienne version : lecture seule.' : 'Lecture seule : ce skill est géré par ' + (detail()!.skill.scope === 'global' ? 'l’administrateur' : 'son propriétaire') + '.' }}
        </div>
      }

      <!-- Onglets sur mobile -->
      <div class="flex border-b border-stone-200 md:hidden dark:border-stone-800" role="tablist">
        <button role="tab" class="flex-1 py-2 text-sm" [class]="mobileTab() === 'tree' ? 'border-b-2 border-accent-600 font-medium' : 'text-stone-500'" (click)="mobileTab.set('tree')">Fichiers ({{ files().length }})</button>
        <button role="tab" class="flex-1 py-2 text-sm" [class]="mobileTab() === 'file' ? 'border-b-2 border-accent-600 font-medium' : 'text-stone-500'" (click)="mobileTab.set('file')">{{ selectedName() }}</button>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- Arborescence -->
        <aside class="flex w-full shrink-0 flex-col border-stone-200 md:w-72 md:border-r dark:border-stone-800" [class.max-md:hidden]="mobileTab() !== 'tree'" aria-label="Fichiers du skill">
          @if (editable()) {
            <div class="flex items-center gap-1 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
              <button class="btn-ghost !p-1.5" (click)="startCreate('file')" title="Nouveau fichier" aria-label="Nouveau fichier"><cap-icon name="file" [size]="15" /><cap-icon name="plus" [size]="10" class="-ml-1.5" /></button>
              <button class="btn-ghost !p-1.5" (click)="startCreate('dir')" title="Nouveau dossier" aria-label="Nouveau dossier"><cap-icon name="folder" [size]="15" /><cap-icon name="plus" [size]="10" class="-ml-1.5" /></button>
              <button class="btn-ghost !p-1.5" (click)="uploadInput.click()" title="Téléverser des fichiers dans le dossier sélectionné" aria-label="Téléverser des fichiers"><cap-icon name="paperclip" [size]="15" /></button>
              <input #uploadInput type="file" multiple class="hidden" (change)="uploadFiles($event)" />
              <span class="ml-auto truncate text-[11px] text-stone-400" [title]="'Dossier cible : ' + (targetDir() || 'racine')">{{ targetDir() ? targetDir() + '/' : 'racine' }}</span>
            </div>
          }
          @if (creating(); as c) {
            <form class="flex items-center gap-1 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800" (ngSubmit)="confirmCreate()">
              <cap-icon [name]="c === 'dir' ? 'folder' : 'file'" [size]="14" class="shrink-0 text-stone-400" />
              <input #createInput class="input !py-1 font-mono text-xs" name="newPath" [(ngModel)]="newPath" [placeholder]="c === 'dir' ? 'dossier/sous-dossier' : 'dossier/fichier.md'" (keydown.escape)="creating.set(null)" aria-label="Chemin" />
              <button class="btn-primary !px-2 !py-1 text-xs">OK</button>
            </form>
          }
          <ul class="min-h-0 flex-1 overflow-y-auto py-1 text-sm" role="tree">
            @for (n of tree(); track n.path) {
              <li role="treeitem" [attr.aria-expanded]="n.kind === 'dir' ? !collapsedDirs().has(n.path) : null" [attr.aria-selected]="n.kind === 'file' ? n.path === selected() : null">
                <div class="group flex items-center gap-1 py-1 pr-1 hover:bg-stone-100 dark:hover:bg-stone-800/60"
                  [style.padding-left.px]="8 + n.depth * 14" [class.bg-stone-200]="n.path === selected() || (n.kind === 'dir' && n.path === selectedDir())" [class.dark:bg-stone-800]="n.path === selected() || (n.kind === 'dir' && n.path === selectedDir())">
                  @if (renaming() === n.path) {
                    <input #renameInput class="input !py-0.5 font-mono text-xs" [value]="n.path" (keydown.enter)="confirmRename(n, renameInput.value)" (keydown.escape)="renaming.set(null)" (blur)="confirmRename(n, renameInput.value)" aria-label="Nouveau chemin" />
                  } @else {
                    <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" (click)="n.kind === 'dir' ? toggleDir(n.path) : select(n.path)" [title]="n.path">
                      @if (n.kind === 'dir') {
                        <cap-icon [name]="collapsedDirs().has(n.path) ? 'chevronRight' : 'chevronDown'" [size]="12" class="shrink-0 text-stone-400" />
                        <cap-icon name="folder" [size]="14" class="shrink-0 text-sky-600" />
                      } @else {
                        <span class="w-3 shrink-0"></span>
                        <cap-icon [name]="n.file!.encoding === 'base64' ? 'image' : 'file'" [size]="14" class="shrink-0 text-stone-400" />
                      }
                      <span class="truncate" [class.font-semibold]="n.path === 'SKILL.md'" [class.italic]="n.file?.dirty">{{ n.name }}</span>
                      @if (n.file?.executable) { <span class="shrink-0 rounded bg-stone-200 px-1 font-mono text-[10px] text-stone-600 dark:bg-stone-700 dark:text-stone-300" title="Exécutable">x</span> }
                      @if (n.file?.dirty) { <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" title="Modifié"></span> }
                    </button>
                    @if (editable() && n.path !== 'SKILL.md') {
                      <span class="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                        <button class="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-700" (click)="startRename(n.path)" [attr.aria-label]="'Renommer ' + n.path" title="Renommer / déplacer"><cap-icon name="edit" [size]="12" /></button>
                        <button class="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-red-600 dark:hover:bg-stone-700" (click)="remove(n)" [attr.aria-label]="'Supprimer ' + n.path" title="Supprimer"><cap-icon name="trash" [size]="12" /></button>
                      </span>
                    }
                  }
                </div>
              </li>
            }
          </ul>
          <div class="border-t border-stone-200 px-3 py-1.5 text-[11px] text-stone-400 dark:border-stone-800">
            {{ files().length }} fichier(s) · {{ totalSize() | bytes }} / {{ maxTotal | bytes }}
          </div>
        </aside>

        <!-- Fichier sélectionné -->
        <section class="flex min-w-0 flex-1 flex-col" [class.max-md:hidden]="mobileTab() !== 'file'" aria-label="Contenu du fichier">
          @if (current(); as f) {
            <div class="flex items-center gap-2 border-b border-stone-200 px-3 py-1.5 text-xs text-stone-500 dark:border-stone-800">
              <span class="truncate font-mono text-stone-700 dark:text-stone-300">{{ f.path }}</span>
              <span>{{ f.size | bytes }}</span>
              @if (editable() && f.path !== 'SKILL.md') {
                <label class="ml-auto flex items-center gap-1" title="Droit d’exécution (scripts)"><input type="checkbox" [checked]="f.executable" (change)="toggleExecutable(f)" /> exécutable</label>
              }
            </div>
            @if (f.encoding === 'utf8') {
              <div class="min-h-0 flex-1"><cap-code-editor [value]="editorValue()" [path]="f.path" [readOnly]="!editable()" (changed)="edit($event)" /></div>
            } @else {
              <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-stone-500">
                @if (imageUrl(); as url) { <img [src]="url" [alt]="f.path" class="max-h-80 max-w-full rounded-lg border border-stone-200 object-contain dark:border-stone-700" /> }
                @else { <cap-icon name="file" [size]="36" class="text-stone-300" /> }
                <div>Fichier binaire ({{ f.size | bytes }}) : non modifiable ici. Remplacez-le en téléversant un fichier du même nom.</div>
              </div>
            }
          } @else {
            <div class="flex flex-1 items-center justify-center p-6 text-sm text-stone-500">Sélectionnez un fichier.</div>
          }
        </section>
      </div>
    </div>
  `,
})
export class SkillEditor implements OnDestroy {
  /** `new` ou identifiant du skill. */
  readonly skillId = input.required<string>();
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');

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
  protected readonly imageUrl = signal<string | null>(null);
  protected readonly maxTotal = SKILL_LIMITS.maxTotalBytes;
  protected newName = '';
  protected newScope: 'personal' | 'global' = 'personal';
  protected newPath = '';

  protected readonly isNew = computed(() => this.skillId() === 'new');
  protected readonly viewingLatest = computed(() => !this.detail() || this.detail()!.version === this.detail()!.skill.latestVersion);
  protected readonly editable = computed(() => this.isNew() || (!!this.detail()?.skill.canManage && this.viewingLatest() && this.detail()!.skill.status !== 'revoked'));
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
    // Aperçu d'une image binaire.
    effect(() => {
      const f = this.current();
      untracked(() => {
        if (this.imageUrl()) URL.revokeObjectURL(this.imageUrl()!);
        this.imageUrl.set(null);
        const ext = f?.path.split('.').pop()?.toLowerCase() ?? '';
        if (f?.encoding === 'base64' && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
          const bytes = Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0));
          this.imageUrl.set(URL.createObjectURL(new Blob([bytes], { type: ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}` })));
        }
      });
    });
  }

  ngOnDestroy(): void {
    if (this.imageUrl()) URL.revokeObjectURL(this.imageUrl()!);
  }

  protected beforeUnload(e: BeforeUnloadEvent): void {
    if (this.editable() && this.dirty()) e.preventDefault();
  }

  private async load(id: string, version?: number): Promise<void> {
    this.removedOrRenamedSig.set(false);
    this.emptyDirs.set(new Set());
    if (id === 'new') {
      this.detail.set(null);
      this.findings.set([]);
      this.newName = '';
      this.files.set([{ path: 'SKILL.md', encoding: 'utf8', executable: false, content: TEMPLATE('nom-du-skill'), size: 0, sourcePath: null, dirty: true }]);
      this.files.update((l) => l.map((f) => ({ ...f, size: new Blob([f.content]).size })));
      this.select('SKILL.md', false);
      return;
    }
    try {
      const d = await this.api.get<SkillDetailDto>(`/skills/${id}`, version ? { version: String(version) } : undefined);
      this.detail.set(d);
      this.findings.set(d.versions.find((v) => v.version === d.version)?.findings ?? []);
      this.files.set(d.files.map((f) => ({ path: f.path, encoding: f.encoding, executable: f.executable, content: f.content, size: f.size, sourcePath: f.path, dirty: false })));
      this.select(this.files().some((f) => f.path === this.selected()) ? this.selected()! : 'SKILL.md', false);
    } catch (e) {
      this.toast.error(e);
      await this.router.navigateByUrl('/extensions');
    }
  }

  protected async loadVersion(version: number): Promise<void> {
    if (this.dirty() && !(await this.confirm.ask({ title: 'Abandonner les modifications ?', message: 'Les modifications non enregistrées seront perdues.', confirmLabel: 'Abandonner', danger: true }))) return;
    await this.load(this.skillId(), version);
  }

  protected statusLabel(s: SkillDto['status']): string {
    return { draft: 'Brouillon', pending_review: 'En attente de revue', published: 'Publié', disabled: 'Suspendu', revoked: 'Révoqué' }[s];
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
    this.editorValue.set(f.encoding === 'utf8' ? f.content : '');
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
    this.files.update((l) => l.map((f) => (f.path === path && f.content !== content ? { ...f, content, size: new Blob([content]).size, dirty: true } : f)));
  }

  protected toggleExecutable(f: EditFile): void {
    this.files.update((l) => l.map((x) => (x.path === f.path ? { ...x, executable: !x.executable, dirty: true } : x)));
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
    if (!isSafeSkillPath(path)) return this.toast.show('Chemin invalide (relatif, sans « .. »)', 'error');
    if (this.exists(path)) return this.toast.show(`« ${path} » existe déjà`, 'error');
    if (kind === 'dir') {
      this.emptyDirs.update((s) => new Set([...s, path]));
      this.reveal(`${path}/x`);
      this.selectedDir.set(path);
    } else {
      this.files.update((l) => [...l, { path, encoding: 'utf8', executable: /\.(sh|bash|py)$/.test(path), content: '', size: 0, sourcePath: null, dirty: true }]);
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
    if (!isSafeSkillPath(to)) return this.toast.show('Chemin invalide (relatif, sans « .. »)', 'error');
    const moved = (p: string) => (n.kind === 'dir' ? (p.startsWith(`${n.path}/`) ? to + p.slice(n.path.length) : p) : p === n.path ? to : p);
    const others = this.files().filter((f) => moved(f.path) === f.path);
    if (others.some((f) => f.path.toLowerCase() === to.toLowerCase() || f.path.toLowerCase().startsWith(`${to.toLowerCase()}/`))) return this.toast.show(`« ${to} » existe déjà`, 'error');
    this.files.update((l) => l.map((f) => ({ ...f, path: moved(f.path) })));
    this.emptyDirs.update((s) => new Set([...s].map((d) => (n.kind === 'dir' && (d === n.path || d.startsWith(`${n.path}/`)) ? to + d.slice(n.path.length) : d))));
    if (this.selected()) this.selected.set(moved(this.selected()!));
    this.removedOrRenamedSig.set(true);
  }

  protected async remove(n: TreeNode): Promise<void> {
    const inside = n.kind === 'dir' ? this.files().filter((f) => f.path.startsWith(`${n.path}/`)) : [];
    const ok = await this.confirm.ask({
      title: n.kind === 'dir' ? 'Supprimer le dossier ?' : 'Supprimer le fichier ?',
      message: n.kind === 'dir' ? `{subject} et ses ${inside.length} fichier(s) seront retirés du skill à l’enregistrement.` : '{subject} sera retiré du skill à l’enregistrement.',
      subject: n.path,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    this.files.update((l) => l.filter((f) => (n.kind === 'dir' ? !f.path.startsWith(`${n.path}/`) : f.path !== n.path)));
    this.emptyDirs.update((s) => new Set([...s].filter((d) => d !== n.path && !d.startsWith(`${n.path}/`))));
    if (this.selected() && !this.files().some((f) => f.path === this.selected())) this.select('SKILL.md', false);
    this.removedOrRenamedSig.set(true);
  }

  /** Téléversement dans le dossier cible ; un fichier du même nom est remplacé. */
  protected async uploadFiles(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const list = [...(input.files ?? [])];
    input.value = '';
    for (const file of list) {
      if (file.size > SKILL_LIMITS.maxFileBytes) {
        this.toast.show(`${file.name} dépasse ${SKILL_LIMITS.maxFileBytes / 1024 / 1024} Mo`, 'error');
        continue;
      }
      const path = this.targetDir() ? `${this.targetDir()}/${file.name}` : file.name;
      if (!isSafeSkillPath(path)) {
        this.toast.show(`Nom de fichier invalide : ${file.name}`, 'error');
        continue;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      const text = isTextFile(buf);
      const entry: EditFile = {
        path,
        encoding: text ? 'utf8' : 'base64',
        executable: /\.(sh|bash|py)$/.test(path),
        content: text ? new TextDecoder().decode(buf) : toBase64(buf),
        size: buf.length,
        sourcePath: null,
        dirty: true,
      };
      this.files.update((l) => [...l.filter((f) => f.path !== path), entry]);
      this.reveal(path);
      this.emptyDirs.update((s) => new Set([...s].filter((d) => !path.startsWith(`${d}/`))));
    }
    if (list.length) this.toast.show(`${list.length} fichier(s) ajouté(s) dans ${this.targetDir() || 'la racine'}`, 'success');
  }

  /* ------------------------------ Enregistrement ------------------------------ */

  private payload(sourceRefs: boolean) {
    return this.files().map((f) =>
      sourceRefs && !f.dirty && f.sourcePath
        ? { path: f.path, sourcePath: f.sourcePath, executable: f.executable }
        : { path: f.path, content: f.content, encoding: f.encoding, executable: f.executable },
    );
  }

  protected async save(): Promise<void> {
    if (this.totalSize() > SKILL_LIMITS.maxTotalBytes) return this.toast.show(`Le skill dépasse ${SKILL_LIMITS.maxTotalBytes / 1024 / 1024} Mo`, 'error');
    this.busy.set(true);
    try {
      if (this.isNew()) {
        const name = this.newName.trim();
        const r = await this.api.post<{ id: string; findings: string[] }>('/skills', { name, scope: this.newScope, files: this.payload(false) });
        this.toast.show('Skill créé', 'success');
        await this.router.navigate(['/extensions/skills', r.id], { replaceUrl: true });
      } else {
        const r = await this.api.post<{ version: number; findings: string[] }>(`/skills/${this.skillId()}/versions`, { files: this.payload(true) });
        this.toast.show(`Version ${r.version} enregistrée`, 'success');
        await this.load(this.skillId());
      }
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  /** Ancienne version republiée comme nouvelle version. */
  protected async restore(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    this.busy.set(true);
    try {
      const r = await this.api.post<{ version: number }>(`/skills/${d.skill.id}/versions`, { files: this.payload(false) });
      this.toast.show(`Version ${d.version} restaurée (v${r.version})`, 'success');
      await this.load(d.skill.id);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async importZip(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!this.isNew()) {
      const ok = await this.confirm.ask({ title: 'Remplacer le contenu ?', message: 'Le contenu de {subject} sera remplacé par l’archive, dans une nouvelle version (les précédentes restent consultables).', subject: this.detail()?.skill.name, confirmLabel: 'Importer' });
      if (!ok) return;
    }
    const form = new FormData();
    form.append('file', file, file.name);
    if (this.isNew()) {
      form.append('scope', this.newScope);
      if (this.newName.trim()) form.append('name', this.newName.trim());
    } else form.append('skillId', this.skillId());
    this.busy.set(true);
    try {
      const r = await this.api.upload<{ id: string; findings: string[] }>('/skills/import', form);
      this.toast.show('Archive importée', 'success');
      if (this.isNew()) await this.router.navigate(['/extensions/skills', r.id], { replaceUrl: true });
      else await this.load(this.skillId());
    } catch (err) {
      this.toast.show(err instanceof ApiError ? err.message : 'Import impossible', 'error', 10_000);
    } finally {
      this.busy.set(false);
    }
  }

  protected async exportZip(): Promise<void> {
    const d = this.detail();
    if (d) await downloadSkillZip(this.api.base, d.skill.id, d.skill.name, d.version).catch(() => this.toast.show('Export impossible', 'error'));
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
