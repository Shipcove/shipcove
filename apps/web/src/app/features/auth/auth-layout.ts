import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'cap-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex min-h-screen items-center justify-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex flex-col items-center gap-2 text-center">
          <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-600 font-mono text-lg font-bold text-white">π</div>
          <h1 class="text-xl font-semibold">{{ title() }}</h1>
          @if (subtitle()) { <p class="text-sm text-stone-500">{{ subtitle() }}</p> }
        </div>
        <div class="card p-6 shadow-sm"><ng-content /></div>
      </div>
    </div>
  `,
})
export class AuthLayout {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
}
