import { describe, expect, it } from 'vitest';
import { parseImageReference, planImagePull, type RegistryMirrorConfig } from './registry-mirror.js';

describe('parseImageReference', () => {
  it('applique les règles implicites de Docker Hub', () => {
    expect(parseImageReference('redis:7.4-alpine')).toEqual({ registry: 'docker.io', path: 'library/redis', suffix: ':7.4-alpine' });
    expect(parseImageReference('bitnami/redis')).toEqual({ registry: 'docker.io', path: 'bitnami/redis', suffix: '' });
    expect(parseImageReference('docker.io/redis')).toEqual({ registry: 'docker.io', path: 'library/redis', suffix: '' });
    expect(parseImageReference('index.docker.io/library/redis:7')).toEqual({ registry: 'docker.io', path: 'library/redis', suffix: ':7' });
  });

  it('reconnaît un registre explicite, un port et un digest', () => {
    expect(parseImageReference('ghcr.io/org/app:1.0@sha256:abc')).toEqual({ registry: 'ghcr.io', path: 'org/app', suffix: ':1.0@sha256:abc' });
    expect(parseImageReference('registry.corp:5000/team/img')).toEqual({ registry: 'registry.corp:5000', path: 'team/img', suffix: '' });
    expect(parseImageReference('localhost/img:1')).toEqual({ registry: 'localhost', path: 'img', suffix: ':1' });
    expect(parseImageReference('rabbitmq@sha256:def')).toEqual({ registry: 'docker.io', path: 'library/rabbitmq', suffix: '@sha256:def' });
  });
});

describe('planImagePull', () => {
  const config: RegistryMirrorConfig = {
    mirrors: [
      { registry: 'docker.io', prefix: 'harbor.corp/dockerhub/', username: 'robot', password: 's3cret' },
      { registry: 'https://ghcr.io', prefix: 'harbor.corp/ghcr' },
    ],
    fallbackToUpstream: false,
  };

  it('sans miroir : référence inchangée', () => {
    expect(planImagePull('redis:7', null)).toEqual({ image: 'redis:7' });
    expect(planImagePull('redis:7', { mirrors: [], fallbackToUpstream: true })).toEqual({ image: 'redis:7' });
  });

  it('réécrit vers le préfixe du miroir, avec ses identifiants', () => {
    expect(planImagePull('redis:7.4-alpine', config)).toEqual({
      image: 'harbor.corp/dockerhub/library/redis:7.4-alpine',
      auth: { username: 'robot', password: 's3cret', serveraddress: 'harbor.corp' },
    });
    expect(planImagePull('ghcr.io/org/app@sha256:abc', config)).toEqual({ image: 'harbor.corp/ghcr/org/app@sha256:abc', auth: undefined });
  });

  it('registre sans miroir déclaré : téléchargement direct', () => {
    expect(planImagePull('quay.io/org/x:1', config)).toEqual({ image: 'quay.io/org/x:1' });
  });

  it('référence déjà sur le miroir : inchangée, identifiants fournis', () => {
    expect(planImagePull('harbor.corp/dockerhub/library/redis:7', config)).toEqual({
      image: 'harbor.corp/dockerhub/library/redis:7',
      auth: { username: 'robot', password: 's3cret', serveraddress: 'harbor.corp' },
    });
  });

  it('repli sur le registre d’origine si autorisé', () => {
    expect(planImagePull('postgres:17', { ...config, fallbackToUpstream: true }).fallback).toBe('postgres:17');
  });
});
