import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import qrcode from 'qrcode-generator';

/**
 * QR code en SVG, généré dans le navigateur (le contenu, ex. un secret TOTP, ne quitte pas la page).
 * Fond blanc et marge de 4 modules imposés : les lecteurs en ont besoin, y compris en thème sombre.
 */
@Component({
  selector: 'cap-qr-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="'0 0 ' + qr().size + ' ' + qr().size" [attr.width]="size()" [attr.height]="size()" role="img" [attr.aria-label]="label()" shape-rendering="crispEdges" class="rounded-md">
      <rect width="100%" height="100%" fill="#fff" />
      <path [attr.d]="qr().path" fill="#000" />
    </svg>
  `,
})
export class QrCode {
  readonly value = input.required<string>();
  readonly size = input(200);
  readonly label = input('QR code');

  protected readonly qr = computed(() => {
    const q = qrcode(0, 'M');
    q.addData(this.value(), 'Byte');
    q.make();
    const n = q.getModuleCount();
    const margin = 4;
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    return { size: n + margin * 2, path };
  });
}
