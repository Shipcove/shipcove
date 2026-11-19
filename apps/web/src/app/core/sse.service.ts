import { Injectable, NgZone, inject } from '@angular/core';
import type { EventEnvelope } from '@cap/contracts';
import { API_BASE } from './mode';

export interface SseHandle {
  close(): void;
}

/**
 * Flux SSE des événements agentiques. `EventSource` renvoie automatiquement `Last-Event-ID`
 * à la reconnexion : le serveur rejoue les événements manqués sans relancer Pi.
 * En cas d'erreur durable, reconnexion manuelle avec le dernier id reçu.
 */
@Injectable({ providedIn: 'root' })
export class SseService {
  private readonly zone = inject(NgZone);

  connect(workspaceId: string, fromId: number, onEvent: (e: EventEnvelope) => void, onState?: (s: 'open' | 'reconnecting') => void): SseHandle {
    let lastId = fromId;
    let source: EventSource | null = null;
    let closed = false;
    let retry = 1000;
    const open = () => {
      if (closed) return;
      source = new EventSource(`${API_BASE}/workspaces/${workspaceId}/events?lastEventId=${lastId}`, { withCredentials: true });
      source.onopen = () => {
        retry = 1000;
        this.zone.run(() => onState?.('open'));
      };
      source.onmessage = (msg) => {
        if (!msg.data) return;
        const e = JSON.parse(msg.data) as EventEnvelope;
        if (e.id <= lastId && e.type !== 'stream.resync') return;
        lastId = e.id;
        this.zone.run(() => onEvent(e));
      };
      source.onerror = () => {
        if (closed) return;
        this.zone.run(() => onState?.('reconnecting'));
        // Fermeture explicite puis reconnexion avec le dernier id connu (y compris après 401/502).
        source?.close();
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 15_000);
      };
    };
    open();
    return {
      close: () => {
        closed = true;
        source?.close();
      },
    };
  }
}
