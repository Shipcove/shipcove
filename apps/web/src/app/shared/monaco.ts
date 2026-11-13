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
  getValue(): string;
  setValue(v: string): void;
  getModel(): MonacoModel | null;
  onDidChangeModelContent(cb: () => void): void;
  updateOptions(o: Record<string, unknown>): void;
  layout(): void;
}
interface MonacoDiffEditor {
  dispose(): void;
  setModel(m: { original: MonacoModel; modified: MonacoModel }): void;
  updateOptions(o: Record<string, unknown>): void;
  layout(): void;
}
interface MonacoApi {
  editor: {
    create(el: HTMLElement, o: Record<string, unknown>): MonacoEditor;
    createDiffEditor(el: HTMLElement, o: Record<string, unknown>): MonacoDiffEditor;
    createModel(value: string, language?: string): MonacoModel;
    setTheme(t: string): void;
  };
}

/** Chargement unique de Monaco (copié dans /monaco/vs à la construction). */
@Injectable({ providedIn: 'root' })
export class MonacoLoader {
  private promise: Promise<MonacoApi> | null = null;
  load(): Promise<MonacoApi> {
    if (!this.promise) {
      this.promise = new Promise((resolve, reject) => {
        const w = window as unknown as { require: { config(o: unknown): void } & ((deps: string[], cb: () => void, err: (e: unknown) => void) => void); monaco: MonacoApi };
        const script = document.createElement('script');
        script.src = '/monaco/vs/loader.js';
        script.onload = () => {
          w.require.config({ paths: { vs: '/monaco/vs' } });
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
  private models: MonacoModel[] = [];
  private ro: ResizeObserver | null = null;

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
    const monaco = await this.loader.load();
    monaco.editor.setTheme(this.theme.isDark() ? 'vs-dark' : 'vs');
    if (!this.editor) {
      this.editor = monaco.editor.createDiffEditor(this.host().nativeElement, {
        readOnly: true,
        renderSideBySide: sideBySide,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        hideUnchangedRegions: { enabled: true },
        renderOverviewRuler: false,
      });
      this.ro = new ResizeObserver(() => this.editor?.layout());
      this.ro.observe(this.host().nativeElement);
    }
    const lang = languageOf(path);
    const next = [monaco.editor.createModel(original, lang), monaco.editor.createModel(modified, lang)];
    this.editor.setModel({ original: next[0], modified: next[1] });
    this.editor.updateOptions({ renderSideBySide: sideBySide });
    for (const m of this.models) m.dispose();
    this.models = next;
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.editor?.dispose();
    for (const m of this.models) m.dispose();
  }
}
