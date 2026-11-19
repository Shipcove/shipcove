import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Logo Shipcove (deux voiles sur une vague), dessiné en SVG pour rester net à toutes les tailles. */
@Component({
  selector: 'cap-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block shrink-0 leading-none', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `
    <svg viewBox="0 0 64 64" [attr.width]="size()" [attr.height]="size()" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="15" fill="#cb5a1a" />
      <path d="M30 11 30 41H15z" fill="#fff" />
      <path d="M34 19 34 41H47z" fill="#fff" fill-opacity=".72" />
      <path d="M12 47.5c6.5 4.5 13.5 4.5 20 0s13.5-4.5 20 0" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" />
    </svg>
  `,
})
export class Logo {
  readonly size = input(28);
}
