import { Injectable, signal } from '@angular/core';

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
export function deleteConversationDialog(name: string, running: boolean): ConfirmOptions {
  return {
    title: 'Supprimer la conversation ?',
    message: '{subject} sera supprimée définitivement. Cette action est irréversible.',
    subject: name,
    details: ['La sandbox et ses services sont détruits', 'Les sauvegardes, fichiers, pièces jointes et captures sont effacés', 'Tout l’historique de la conversation est perdu'],
    warning: running ? 'Pi est en train de travailler : sa tâche sera interrompue.' : undefined,
    confirmLabel: 'Supprimer',
    danger: true,
  };
}
