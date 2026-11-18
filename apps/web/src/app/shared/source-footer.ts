import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Code source de l'instance (section 13 de l'AGPL v3 : les utilisateurs qui accèdent au service
 * par le réseau doivent pouvoir obtenir le code source de la version qu'ils utilisent).
 * Une version modifiée doit pointer vers SON propre code source, et conserver la mention
 * « Basé sur Shipcove » (voir NOTICE).
 */
export const SOURCE_URL = 'https://github.com/Shipcove/shipcove';
export const LICENSE_URL = `${SOURCE_URL}/blob/develop/LICENSE`;

/** Mention discrète : nom, licence et lien vers le code source. */
@Component({
  selector: 'cap-source-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="text-[11px] leading-5 text-stone-400 dark:text-stone-500">
      Shipcove ·
      <a class="hover:text-stone-600 hover:underline dark:hover:text-stone-300" [href]="licenseUrl" target="_blank" rel="noopener noreferrer">Licence AGPL v3</a> ·
      <a class="hover:text-stone-600 hover:underline dark:hover:text-stone-300" [href]="sourceUrl" target="_blank" rel="noopener noreferrer">Code source</a>
    </p>
  `,
})
export class SourceFooter {
  protected readonly sourceUrl = SOURCE_URL;
  protected readonly licenseUrl = LICENSE_URL;
}
