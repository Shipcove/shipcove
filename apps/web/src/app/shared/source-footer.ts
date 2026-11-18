import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LANGS, LANG_NAMES, lang, setLang, t, type Lang } from '../core/i18n';

/**
 * Code source de l'instance (section 13 de l'AGPL v3 : les utilisateurs qui accèdent au service
 * par le réseau doivent pouvoir obtenir le code source de la version qu'ils utilisent).
 * Une version modifiée doit pointer vers SON propre code source, et conserver la mention
 * « Basé sur Shipcove » (voir NOTICE).
 */
export const SOURCE_URL = 'https://github.com/Shipcove/shipcove';
export const LICENSE_URL = `${SOURCE_URL}/blob/develop/LICENSE`;

/** Mention discrète : nom, licence, lien vers le code source et choix de la langue. */
@Component({
  selector: 'cap-source-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="text-[11px] leading-5 text-stone-400 dark:text-stone-500">
      Shipcove ·
      <a class="hover:text-stone-600 hover:underline dark:hover:text-stone-300" [href]="licenseUrl" target="_blank" rel="noopener noreferrer">{{ t('Licence AGPL v3') }}</a> ·
      <a class="hover:text-stone-600 hover:underline dark:hover:text-stone-300" [href]="sourceUrl" target="_blank" rel="noopener noreferrer">{{ t('Code source') }}</a> ·
      <span role="group" [attr.aria-label]="t('Langue')">
        @for (l of langs; track l; let last = $last) {
          @if (l === current) {
            <span class="font-medium text-stone-600 dark:text-stone-300" aria-current="true" [title]="names[l]">{{ l.toUpperCase() }}</span>
          } @else {
            <button type="button" class="hover:text-stone-600 hover:underline dark:hover:text-stone-300" [attr.lang]="l" [title]="names[l]" [attr.aria-label]="names[l]" (click)="choose(l)">{{ l.toUpperCase() }}</button>
          }
          @if (!last) { <span aria-hidden="true">/</span> }
        }
      </span>
    </p>
  `,
})
export class SourceFooter {
  protected readonly t = t;
  protected readonly sourceUrl = SOURCE_URL;
  protected readonly licenseUrl = LICENSE_URL;
  protected readonly langs = LANGS;
  protected readonly names = LANG_NAMES;
  protected readonly current = lang;
  protected choose(l: Lang): void {
    setLang(l);
  }
}
