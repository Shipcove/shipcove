import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SourceFooter } from '../../shared/source-footer';
import { Logo } from '../../shared/logo';

@Component({
  selector: 'cap-auth-layout',
  imports: [Logo, SourceFooter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex min-h-screen items-center justify-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex flex-col items-center gap-2 text-center">
          <cap-logo [size]="40" />
          <h1 class="text-xl font-semibold">{{ title() }}</h1>
          @if (subtitle()) { <p class="text-sm text-stone-500">{{ subtitle() }}</p> }
        </div>
        <div class="card p-6 shadow-sm"><ng-content /></div>
        <div class="mt-6 text-center"><cap-source-footer /></div>
      </div>
    </div>
  `,
})
export class AuthLayout {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
}
