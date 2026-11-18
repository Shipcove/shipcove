import type { EnvironmentProviders, Provider } from '@angular/core';
import { withInterceptors, type HttpFeature, type HttpFeatureKind } from '@angular/common/http';
import { withHashLocation, type RouterFeatures } from '@angular/router';
import { SseService } from '../core/sse.service';
import { demoInterceptor } from '../demo/interceptor';
import { textUrl } from '../demo/pi';
import { blobUrls } from '../demo/server';
import { DemoSse } from '../demo/sse';

/**
 * Mode démonstration (remplace `core/mode.ts` avec `ng build --configuration demo`) :
 * API simulée dans le navigateur, routes en `#/…` (aucune réécriture côté hébergement),
 * chemins relatifs (publiable dans n'importe quel sous-dossier).
 */
export const DEMO = true;

/** Relatif à la page : la démo fonctionne dans n'importe quel sous-dossier. */
export const API_BASE = 'demo-api';

/** Fichiers de démonstration : envoyés pendant la visite (mémoire), sinon fichiers statiques fournis. */
export function fileUrl(_workspaceId: string | undefined, _kind: 'attachments' | 'screenshots' | 'agent-files', id: string): string {
  return blobUrls.get(id) ?? textUrl(id) ?? `demo-assets/${encodeURIComponent(id)}`;
}

export const httpFeatures: Array<HttpFeature<HttpFeatureKind>> = [withInterceptors([demoInterceptor])];
export const routerFeatures: RouterFeatures[] = [withHashLocation()];
export const modeProviders: Array<Provider | EnvironmentProviders> = [{ provide: SseService, useClass: DemoSse }];
