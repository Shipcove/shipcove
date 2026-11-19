import { Injectable } from '@angular/core';
import type { EventEnvelope } from '@cap/contracts';
import type { SseHandle } from '../core/sse.service';
import { server } from './server';

/** Flux d'événements de la démonstration : abonnement direct au backend simulé. */
@Injectable()
export class DemoSse {
  connect(workspaceId: string, fromId: number, onEvent: (e: EventEnvelope) => void, onState?: (s: 'open' | 'reconnecting') => void): SseHandle {
    const unsubscribe = server.subscribe(workspaceId, (e) => {
      if (e.id > fromId) onEvent(JSON.parse(JSON.stringify(e)) as EventEnvelope);
    });
    queueMicrotask(() => onState?.('open'));
    return { close: unsubscribe };
  }
}
