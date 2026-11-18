import { ChangeDetectionStrategy, Component, ElementRef, Injectable, OnDestroy, effect, inject, input, output, viewChild } from '@angular/core';
import { ThemeService } from '../core/theme.service';

// Types minimaux de l'API Monaco utilisée (chargée dynamiquement via le loader AMD).
interface MonacoModel {
  dispose(): void;
  getValue(): string;
  setValue(v: string): void;
}
interface MonacoEditor {
  dispose(): void;
  createDecorationsCollection(d: Array<{ range: unknown; options: Record<string, unknown> }>): { clear(): void };
  getValue(): string;
  setValue(v: string): void;
  getModel(): MonacoModel | null;
  onDidChangeModelContent(cb: () => void): void;
  updateOptions(o: Record<string, unknown>): void;
  layout(): void;
  saveViewState(): unknown;
  restoreViewState(s: unknown): void;
}
interface MonacoDiffEditor {
  dispose(): void;
  setModel(m: { original: MonacoModel; modified: MonacoModel }): void;
  updateOptions(o: Record<string, unknown>): void;
  layout(): void;
  saveViewState(): unknown;
  restoreViewState(s: unknown): void;
}
interface MonacoApi {
  editor: {
    create(el: HTMLElement, o: Record<string, unknown>): MonacoEditor;
    createDiffEditor(el: HTMLElement, o: Record<string, unknown>): MonacoDiffEditor;
    createModel(value: string, language?: string): MonacoModel;
    setTheme(t: string): void;
  };
  Range: new (a: number, b: number, c: number, d: number) => unknown;
}

/** Chargement unique de Monaco (copié dans monaco/vs à la construction). */
@Injectable({ providedIn: 'root' })
export class MonacoLoader {
  private promise: Promise<MonacoApi> | null = null;
  load(): Promise<MonacoApi> {
    if (!this.promise) {
      this.promise = new Promise((resolve, reject) => {
        const w = window as unknown as { require: { config(o: unknown): void } & ((deps: string[], cb: () => void, err: (e: unknown) => void) => void); monaco: MonacoApi };
        // Relatif à <base href> : fonctionne aussi quand l'application est publiée dans un sous-dossier.
        const vs = new URL('monaco/vs', document.baseURI).href;
        const script = document.createElement('script');
        script.src = `${vs}/loader.js`;
        script.onload = () => {
          w.require.config({ paths: { vs } });
          w.require(['vs/editor/editor.main'], () => resolve(w.monaco), reject);
        };
        script.onerror = reject;
        document.body.appendChild(script);
      });
    }
    return this.promise;
  }
}

export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp', css: 'css', scss: 'scss', html: 'html', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell',
    sql: 'sql', xml: 'xml', toml: 'ini', dockerfile: 'dockerfile', vue: 'html', swift: 'swift',
  };
  if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return map[ext] ?? 'plaintext';
}

@Component({
  selector: 'cap-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="h-full w-full"></div>`,
  host: { class: 'block h-full w-full' },
})
export class CodeEditor implements OnDestroy {
  readonly value = input('');
  readonly path = input('');
  readonly readOnly = input(true);
  readonly changed = output<string>();
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly loader = inject(MonacoLoader);
  private readonly theme = inject(ThemeService);
  private editor: MonacoEditor | null = null;
  private ro: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const v = this.value();
      const p = this.path();
      const ro = this.readOnly();
      void this.render(v, p, ro);
    });
  }

  private async render(value: string, path: string, readOnly: boolean): Promise<void> {
    const monaco = await this.loader.load();
    monaco.editor.setTheme(this.theme.isDark() ? 'vs-dark' : 'vs');
    if (!this.editor) {
      this.editor = monaco.editor.create(this.host().nativeElement, {
        automaticLayout: false,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        readOnly,
      });
      this.editor.onDidChangeModelContent(() => this.changed.emit(this.editor!.getValue()));
      this.ro = new ResizeObserver(() => this.editor?.layout());
      this.ro.observe(this.host().nativeElement);
    }
    const old = this.editor.getModel();
    const model = monaco.editor.createModel(value, languageOf(path));
    (this.editor as unknown as { setModel(m: MonacoModel): void }).setModel(model);
    old?.dispose();
    this.editor.updateOptions({ readOnly });
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
  }
}

@Component({
  selector: 'cap-diff-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="h-full w-full"></div>`,
  host: { class: 'block h-full w-full' },
})
export class DiffEditor implements OnDestroy {
  readonly original = input<string | null>('');
  readonly modified = input<string | null>('');
  readonly path = input('');
  readonly sideBySide = input(false);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly loader = inject(MonacoLoader);
  private readonly theme = inject(ThemeService);
  private editor: MonacoDiffEditor | null = null;
  /** Fichier ajouté ou supprimé : affiché en entier (comme GitHub), sans côté « avant » vide. */
  private single: MonacoEditor | null = null;
  private models: MonacoModel[] = [];
  private ro: ResizeObserver | null = null;
  /** Dernier rendu : un contenu identique n'est pas redessiné (pas de scintillement). */
  private last: { original: string; modified: string; path: string; sideBySide: boolean } | null = null;

  constructor() {
    effect(() => {
      const o = this.original() ?? '';
      const m = this.modified() ?? '';
      const p = this.path();
      const s = this.sideBySide();
      void this.render(o, m, p, s);
    });
  }

  private async render(original: string, modified: string, path: string, sideBySide: boolean) {
    const prev = this.last;
    if (prev && prev.original === original && prev.modified === modified && prev.path === path && prev.sideBySide === sideBySide) return;
    this.last = { original, modified, path, sideBySide };
    // Même fichier mis à jour (Pi l'écrit) : position de défilement et régions dépliées conservées.
    const samePath = prev?.path === path;
    const monaco = await this.loader.load();
    monaco.editor.setTheme(this.theme.isDark() ? 'vs-dark' : 'vs');
    const kind = original === '' && modified !== '' ? 'added' : modified === '' && original !== '' ? 'deleted' : 'diff';
    const el = this.host().nativeElement;
    if (!this.ro) {
      this.ro = new ResizeObserver(() => (this.editor ?? this.single)?.layout());
      this.ro.observe(el);
    }
    const lang = languageOf(path);
    const old = this.models;
    if (kind === 'diff') {
      this.disposeSingle();
      if (!this.editor) {
        this.editor = monaco.editor.createDiffEditor(el, {
          readOnly: true,
          renderSideBySide: sideBySide,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          hideUnchangedRegions: { enabled: true },
          renderOverviewRuler: false,
        });
      }
      const view = samePath ? this.editor.saveViewState() : null;
      const next = [monaco.editor.createModel(original, lang), monaco.editor.createModel(modified, lang)];
      this.editor.setModel({ original: next[0], modified: next[1] });
      this.editor.updateOptions({ renderSideBySide: sideBySide });
      if (view) this.editor.restoreViewState(view);
      this.models = next;
    } else {
      this.editor?.dispose();
      this.editor = null;
      if (!this.single) {
        this.single = monaco.editor.create(el, { readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, lineDecorationsWidth: 14 });
      }
      const text = kind === 'added' ? modified : original;
      const view = samePath ? this.single.saveViewState() : null;
      const model = monaco.editor.createModel(text, lang);
      (this.single as unknown as { setModel(m: MonacoModel): void }).setModel(model);
      if (view) this.single.restoreViewState(view);
      // La dernière ligne vide qui suit un saut de ligne final n'est pas une ligne du fichier.
      const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
      this.single.createDecorationsCollection([
        {
          range: new monaco.Range(1, 1, Math.max(1, lines), 1),
          options: { isWholeLine: true, className: kind === 'added' ? 'cap-line-added' : 'cap-line-deleted', linesDecorationsClassName: kind === 'added' ? 'cap-gutter-added' : 'cap-gutter-deleted' },
        },
      ]);
      this.models = [model];
    }
    for (const m of old) m.dispose();
  }

  private disposeSingle(): void {
    this.single?.dispose();
    this.single = null;
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.editor?.dispose();
    this.disposeSingle();
    for (const m of this.models) m.dispose();
  }
}
