import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme.service';
import { ToastService } from './core/toast.service';
import { ConfirmDialog } from './shared/confirm-dialog';
import { Icon } from './shared/icon';
import { t } from './core/i18n';

@Component({
  selector: 'cap-root',
  imports: [RouterOutlet, Icon, ConfirmDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    <cap-confirm-dialog />
    <div class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 max-w-[90vw] flex-col gap-2" aria-live="polite">
      @for (ts of toast.toasts(); track ts.id) {
        <div class="card pointer-events-auto flex items-start gap-2 px-3 py-2 text-sm shadow-lg"
          [class.border-red-300]="ts.kind === 'error'" [class.border-emerald-300]="ts.kind === 'success'">
          <cap-icon [name]="ts.kind === 'error' ? 'alert' : ts.kind === 'success' ? 'check' : 'bell'" class="mt-0.5"
            [class.text-red-600]="ts.kind === 'error'" [class.text-emerald-600]="ts.kind === 'success'" />
          <span class="flex-1">{{ ts.text }}</span>
          <button class="text-stone-400 hover:text-stone-700" (click)="toast.dismiss(ts.id)" [attr.aria-label]="t('Fermer')"><cap-icon name="x" [size]="14" /></button>
        </div>
      }
    </div>
  `,
})
export class App {
  protected readonly t = t;
  protected readonly toast = inject(ToastService);
  // Instancie le thème au démarrage.
  private readonly theme = inject(ThemeService);
}
