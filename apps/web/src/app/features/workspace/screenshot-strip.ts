import { ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { ToolImageDto } from '@cap/contracts';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';
import { fileUrl } from '../../core/mode';
import { t } from '../../core/i18n';

/**
 * Captures d'écran de Pi : miniatures (toujours visibles), agrandies au clic dans une visionneuse
 * (Échap pour fermer, flèches pour passer de l'une à l'autre).
 */
@Component({
  selector: 'cap-screenshot-strip',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex gap-2 overflow-x-auto py-1" role="list" [attr.aria-label]="t('Captures d’écran')">
      @for (img of images(); track img.attachmentId; let i = $index) {
        <button
          role="listitem"
          class="group relative shrink-0 overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm transition hover:border-accent-400 hover:shadow focus-visible:outline-2 focus-visible:outline-accent-500 dark:border-stone-700 dark:bg-stone-950"
          (click)="viewer.set(i)"
          [attr.aria-label]="t('Agrandir la capture {name}', { name: img.fileName })"
        >
          <img [src]="src(img.attachmentId)" [alt]="img.fileName" loading="lazy" class="h-28 w-auto max-w-56 object-cover object-top" [attr.width]="thumbWidth(img)" height="112" />
          <span class="absolute right-1 bottom-1 rounded bg-black/55 p-0.5 text-white opacity-0 transition group-hover:opacity-100 touch:opacity-100"><cap-icon name="maximize" [size]="12" /></span>
        </button>
      }
    </div>
    @if (viewer() !== null && images()[viewer()!]; as img) {
      <div
        #overlay
        class="fixed inset-0 z-50 flex flex-col bg-black/85 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="t('Capture {name}', { name: img.fileName })"
        tabindex="-1"
        (click)="viewer.set(null)"
        (keydown)="onKey($event)"
      >
        <div class="mb-3 flex items-center gap-3 text-sm text-stone-200" (click)="$event.stopPropagation()">
          <span class="truncate font-mono">{{ img.fileName }}</span>
          @if (img.width && img.height) { <span class="text-stone-400">{{ img.width }} × {{ img.height }}</span> }
          @if (images().length > 1) { <span class="text-stone-400">{{ viewer()! + 1 }} / {{ images().length }}</span> }
          <a class="ml-auto rounded px-2 py-1 hover:bg-white/10" [href]="src(img.attachmentId)" target="_blank" rel="noopener">{{ t('Taille réelle') }}</a>
          <button class="rounded p-1 hover:bg-white/10" (click)="viewer.set(null)" [attr.aria-label]="t('Fermer')"><cap-icon name="x" [size]="18" /></button>
        </div>
        <div class="relative flex min-h-0 flex-1 items-center justify-center">
          @if (images().length > 1) {
            <button class="absolute left-0 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" (click)="step(-1, $event)" [attr.aria-label]="t('Capture précédente')"><cap-icon name="chevronLeft" [size]="20" /></button>
          }
          <img [src]="src(img.attachmentId)" [alt]="img.fileName" class="max-h-full max-w-full rounded object-contain shadow-2xl" (click)="$event.stopPropagation()" />
          @if (images().length > 1) {
            <button class="absolute right-0 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" (click)="step(1, $event)" [attr.aria-label]="t('Capture suivante')"><cap-icon name="chevronRight" [size]="20" /></button>
          }
        </div>
      </div>
    }
  `,
})
export class ScreenshotStrip {
  protected readonly t = t;
  readonly images = input.required<ToolImageDto[]>();
  private readonly store = inject(WorkspaceStore);
  private readonly overlay = viewChild<ElementRef<HTMLElement>>('overlay');
  protected readonly viewer = signal<number | null>(null);

  constructor() {
    // Focus sur la visionneuse à l'ouverture (clavier : Échap, flèches).
    effect(() => this.overlay()?.nativeElement.focus());
  }

  protected src(attachmentId: string): string {
    return fileUrl(this.store.workspace()?.id, 'screenshots', attachmentId);
  }

  protected thumbWidth(img: { width: number | null; height: number | null }): number | null {
    return img.width && img.height ? Math.min(224, Math.round((112 * img.width) / img.height)) : null;
  }

  protected step(delta: number, ev?: Event) {
    ev?.stopPropagation();
    const n = this.images().length;
    this.viewer.update((i) => (i === null ? null : (i + delta + n) % n));
  }

  protected onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      // Échap ferme la visionneuse sans compter pour l'arrêt de Pi (double Échap).
      ev.stopPropagation();
      this.viewer.set(null);
    } else if (ev.key === 'ArrowRight') this.step(1);
    else if (ev.key === 'ArrowLeft') this.step(-1);
  }
}
