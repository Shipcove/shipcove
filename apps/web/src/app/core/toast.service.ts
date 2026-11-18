import { Injectable, signal } from '@angular/core';
import { t, tr } from './i18n';
import { ApiError } from './api.service';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(text: string, kind: Toast['kind'] = 'info', ms = 5000): void {
    const t = { id: ++this.seq, kind, text };
    this.toasts.update((l) => [...l, t]);
    setTimeout(() => this.dismiss(t.id), ms);
  }

  error(err: unknown): void {
    // Messages du serveur : traduits s'ils sont connus du dictionnaire (sinon affichés tels quels).
    const msg = err instanceof ApiError ? tr(err.message) : err instanceof Error ? tr(err.message) : t('Erreur inattendue');
    this.show(msg, 'error', 8000);
  }

  dismiss(id: number): void {
    this.toasts.update((l) => l.filter((t) => t.id !== id));
  }
}
