import { Injectable, signal } from '@angular/core';
import { t } from './i18n';

export interface ConfirmOptions {
  title: string;
  /** Texte principal (le nom de l'élément concerné peut être mis en évidence via `subject`). */
  message: string;
  /** Élément concerné, affiché en gras dans le message à la place de `{subject}`. */
  subject?: string;
  /** Liste de conséquences, affichée sous le message. */
  details?: string[];
  /** Avertissement complémentaire (ex. « Pi est en train de travailler »). */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Action destructive : bouton rouge, focus initial sur « Annuler ». */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

/** Confirmation dans une modale de l'application (remplace `window.confirm`). */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<ConfirmRequest | null>(null);
  private seq = 0;

  ask(options: ConfirmOptions): Promise<boolean> {
    this.current()?.resolve(false);
    return new Promise((resolve) => {
      this.current.set({ ...options, id: ++this.seq, resolve });
    });
  }

  answer(ok: boolean): void {
    const c = this.current();
    if (!c) return;
    this.current.set(null);
    c.resolve(ok);
  }
}

/** Confirmation de suppression d'une conversation (barre latérale et en-tête). */
export function leaveShareDialog(name: string): ConfirmOptions {
  return {
    title: t('Retirer le partage ?'),
    message: t('{subject} disparaîtra de votre liste et vous n’y aurez plus accès.'),
    subject: name,
    details: [t('La conversation n’est ni supprimée ni modifiée pour son propriétaire'), t('Les autres personnes avec qui elle est partagée gardent leur accès'), t('Le propriétaire pourra la partager de nouveau avec vous')],
    confirmLabel: t('Retirer'),
    danger: true,
  };
}

export function deleteConversationDialog(name: string, running: boolean): ConfirmOptions {
  return {
    title: t('Supprimer la conversation ?'),
    message: t('{subject} sera supprimée définitivement. Cette action est irréversible.'),
    subject: name,
    details: [t('La sandbox et ses services sont détruits'), t('Les sauvegardes, fichiers, pièces jointes et captures sont effacés'), t('Tout l’historique de la conversation est perdu')],
    warning: running ? t('Pi est en train de travailler : sa tâche sera interrompue.') : undefined,
    confirmLabel: t('Supprimer'),
    danger: true,
  };
}
