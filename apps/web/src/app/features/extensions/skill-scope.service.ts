import { Injectable, inject } from '@angular/core';
import type { SkillDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';

/**
 * Seule façon de rendre un skill global (ou de le retirer du global) : un skill est toujours créé
 * ou importé en personnel, puis un administrateur change sa portée, depuis sa carte ou l'éditeur.
 */
@Injectable({ providedIn: 'root' })
export class SkillScopeService {
  private readonly api = inject(Api);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  /** Demande confirmation puis bascule la portée ; renvoie la nouvelle portée, ou null si rien n'a changé. */
  async toggle(s: Pick<SkillDto, 'id' | 'name' | 'scope'>): Promise<'global' | 'personal' | null> {
    const scope = s.scope === 'global' ? 'personal' : 'global';
    const ok = await this.confirm.ask(
      scope === 'global'
        ? {
            title: 'Rendre le skill global ?',
            message: '{subject} sera disponible pour tous les utilisateurs de l’instance.',
            subject: s.name,
            details: ['Chacun pourra l’activer ; seuls les administrateurs pourront le modifier', 'Vous pourrez retirer ce caractère global à tout moment'],
            confirmLabel: 'Rendre global',
          }
        : {
            title: 'Retirer le caractère global ?',
            message: '{subject} redeviendra un skill personnel, à vous.',
            subject: s.name,
            details: ['Les autres utilisateurs n’y auront plus accès', 'Leurs activations de ce skill sont retirées'],
            confirmLabel: 'Retirer',
            danger: true,
          },
    );
    if (!ok) return null;
    try {
      await this.api.put(`/skills/${s.id}/scope`, { scope });
      this.toast.show(scope === 'global' ? 'Skill rendu global' : 'Skill redevenu personnel', 'success');
      return scope;
    } catch (e) {
      this.toast.error(e);
      return null;
    }
  }
}
