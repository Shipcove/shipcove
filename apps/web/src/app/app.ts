import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme.service';
import { ToastService } from './core/toast.service';
import { Icon } from './shared/icon';

@Component({
  selector: 'cap-root',
  imports: [RouterOutlet, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    <div class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 max-w-[90vw] flex-col gap-2" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="card pointer-events-auto flex items-start gap-2 px-3 py-2 text-sm shadow-lg"
          [class.border-red-300]="t.kind === 'error'" [class.border-emerald-300]="t.kind === 'success'">
          <cap-icon [name]="t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'bell'" class="mt-0.5"
            [class.text-red-600]="t.kind === 'error'" [class.text-emerald-600]="t.kind === 'success'" />
          <span class="flex-1">{{ t.text }}</span>
          <button class="text-stone-400 hover:text-stone-700" (click)="toast.dismiss(t.id)" aria-label="Fermer"><cap-icon name="x" [size]="14" /></button>
        </div>
      }
    </div>
  `,
})
export class App {
  protected readonly toast = inject(ToastService);
  // Instancie le thème au démarrage.
  private readonly theme = inject(ThemeService);
}
