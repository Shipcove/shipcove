import type { EnvironmentProviders, Provider } from '@angular/core';
import type { HttpFeature, HttpFeatureKind } from '@angular/common/http';
import type { RouterFeatures } from '@angular/router';

/**
 * Mode de construction de l'application. Ce fichier décrit l'application normale (API réelle) ;
 * `ng build --configuration demo` le remplace par `demo/mode.demo.ts` (démonstration sans
 * serveur : API simulée dans le navigateur). Rien de la démo n'entre dans la version normale.
 */
export const DEMO = false;

/** Préfixe de l'API. */
export const API_BASE = '/api/v1';

/** Fichiers servis par l'API pour un workspace (pièces jointes, captures, fichiers de Pi). */
export function fileUrl(workspaceId: string | undefined, kind: 'attachments' | 'screenshots' | 'agent-files', id: string): string {
  return `${API_BASE}/workspaces/${workspaceId}/${kind}/${id}`;
}

export const httpFeatures: Array<HttpFeature<HttpFeatureKind>> = [];
export const routerFeatures: RouterFeatures[] = [];
export const modeProviders: Array<Provider | EnvironmentProviders> = [];
