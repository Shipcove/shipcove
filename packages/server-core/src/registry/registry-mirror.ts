import { Inject, Injectable } from '@nestjs/common';
import type { SecretProvider } from '@cap/secrets';
import { SECRETS } from '../tokens.js';

/**
 * Miroir de registre d'images (Harbor, Nexus, Artifactory, registry:2 en cache…) : chaque
 * registre d'origine est servi sous un préfixe du miroir, par exemple
 * `docker.io` → `harbor.corp/dockerhub` donne `harbor.corp/dockerhub/library/redis:7.4-alpine`.
 */
export interface RegistryMirror {
  /** Registre d'origine : `docker.io`, `ghcr.io`, `quay.io`… */
  registry: string;
  /** Préfixe du miroir : `harbor.corp/dockerhub` (hôte[:port][/chemin]). */
  prefix: string;
  username?: string;
  password?: string;
}

export interface RegistryMirrorConfig {
  mirrors: RegistryMirror[];
  /** Si le miroir échoue, téléchargement direct depuis le registre d'origine. */
  fallbackToUpstream: boolean;
}

export interface ImagePullPlan {
  /** Référence à télécharger et à exécuter. */
  image: string;
  /** Identifiants pour le registre de `image`, le cas échéant. */
  auth?: { username: string; password: string; serveraddress: string };
  /** Référence d'origine, si un miroir s'applique et que le repli est autorisé. */
  fallback?: string;
}

export interface ParsedImage {
  registry: string;
  path: string;
  /** `:tag` et/ou `@sha256:…`, tels qu'écrits. */
  suffix: string;
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);

/** Décompose une référence d'image selon les règles de Docker (registre implicite `docker.io`, `library/`). */
export function parseImageReference(ref: string): ParsedImage {
  const at = ref.indexOf('@');
  const digest = at >= 0 ? ref.slice(at) : '';
  let name = at >= 0 ? ref.slice(0, at) : ref;
  let tag = '';
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    tag = name.slice(colon);
    name = name.slice(0, colon);
  }
  const parts = name.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift()!.toLowerCase();
  }
  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = 'docker.io';
    if (parts.length === 1) parts.unshift('library');
  }
  return { registry, path: parts.join('/'), suffix: tag + digest };
}

/** Hôte (avec port) d'un préfixe de miroir ou d'une référence. */
export function registryHost(prefix: string): string {
  return prefix.split('/')[0].toLowerCase();
}

/** Plan de téléchargement d'une image : miroir éventuel, identifiants, repli. */
export function planImagePull(ref: string, config: RegistryMirrorConfig | null): ImagePullPlan {
  if (!config?.mirrors.length) return { image: ref };
  const trimmed = (p: string) => p.replace(/\/+$/, '').toLowerCase();
  // Référence déjà sur un miroir : utilisée telle quelle (identifiants du miroir).
  const direct = config.mirrors.find((m) => ref.toLowerCase().startsWith(`${trimmed(m.prefix)}/`));
  if (direct) return { image: ref, auth: authFor(direct) };
  const parsed = parseImageReference(ref);
  const mirror = config.mirrors.find((m) => parseRegistry(m.registry) === parsed.registry);
  if (!mirror) return { image: ref };
  return {
    image: `${mirror.prefix.replace(/\/+$/, '')}/${parsed.path}${parsed.suffix}`,
    auth: authFor(mirror),
    ...(config.fallbackToUpstream ? { fallback: ref } : {}),
  };
}

function parseRegistry(r: string): string {
  const v = r.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return DOCKER_HUB_ALIASES.has(v) ? 'docker.io' : v;
}

function authFor(m: RegistryMirror): ImagePullPlan['auth'] {
  return m.username && m.password ? { username: m.username, password: m.password, serveraddress: registryHost(m.prefix) } : undefined;
}

const VAULT_PATH = 'infra/registry';

/**
 * Configuration des miroirs, dans Vault (les identifiants y sont) : réglée par l'API, relue par
 * le worker à chaque démarrage de service (opération rare) : un changement s'applique aussitôt.
 */
@Injectable()
export class RegistryMirrorService {
  constructor(@Inject(SECRETS) private readonly secrets: SecretProvider) {}

  async get(): Promise<RegistryMirrorConfig> {
    const data = await this.secrets.read(`vault:${VAULT_PATH}`).catch(() => null);
    let value: RegistryMirrorConfig = { mirrors: [], fallbackToUpstream: false };
    if (data?.['config']) {
      try {
        value = JSON.parse(data['config']) as RegistryMirrorConfig;
      } catch {
        /* configuration illisible : aucun miroir */
      }
    }
    return value;
  }

  async save(config: RegistryMirrorConfig): Promise<void> {
    await this.secrets.write(VAULT_PATH, { config: JSON.stringify(config) });
  }

  async plan(ref: string): Promise<ImagePullPlan> {
    return planImagePull(ref, await this.get());
  }
}
