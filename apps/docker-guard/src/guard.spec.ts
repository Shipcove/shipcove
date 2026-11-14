import http from 'node:http';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxProvider, execCollect, type SandboxHandle } from '@cap/sandbox';
import { route, validateCreate, Refused, type GuardConfig } from './policy.js';
import { createGuard } from './server.js';

const cfg: GuardConfig = { sandboxNetwork: 'cap-sandbox', sandboxUser: '10001:10001', allowedRuntimes: [], maxMemoryMb: 8192, maxCpus: 8, maxPids: 4096 };
const TOKEN = 't'.repeat(40);

const sandboxBody = () => ({
  Image: 'shipcove-sandbox:0.1.0',
  User: '10001:10001',
  Labels: { 'cap.sandbox': 'true' },
  HostConfig: {
    NetworkMode: 'cap-sandbox',
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Privileged: false,
    Memory: 512 * 1024 * 1024,
    MemorySwap: 512 * 1024 * 1024,
    NanoCpus: 1e9,
    PidsLimit: 256,
    Mounts: [{ Type: 'volume', Source: '', Target: '/workspace', VolumeOptions: { NoCopy: false, DriverConfig: { Name: 'local', Options: {} } } }],
  },
});

describe('politique du garde Docker', () => {
  const refused = (fn: () => unknown, msg: RegExp) => expect(fn).toThrow(msg);
  const withHost = (patch: Record<string, unknown>) => {
    const b = sandboxBody();
    Object.assign(b.HostConfig, patch);
    return b;
  };

  it('accepte une sandbox conforme et refuse toute variante dangereuse', () => {
    expect(validateCreate(sandboxBody(), cfg)).toEqual({ type: 'sandbox' });
    refused(() => validateCreate(withHost({ Privileged: true }), cfg), /privilégié/);
    refused(() => validateCreate(withHost({ Binds: ['/:/host'] }), cfg), /Binds non autorisé/);
    refused(() => validateCreate(withHost({ NetworkMode: 'host' }), cfg), /réseau/);
    refused(() => validateCreate(withHost({ PidMode: 'host' }), cfg), /PidMode/);
    refused(() => validateCreate(withHost({ CapAdd: ['SYS_ADMIN'] }), cfg), /CapAdd/);
    refused(() => validateCreate(withHost({ SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] }), cfg), /sécurité/);
    refused(() => validateCreate(withHost({ Devices: [{ PathOnHost: '/dev/sda' }] }), cfg), /Devices/);
    refused(() => validateCreate(withHost({ Mounts: [{ Type: 'bind', Source: '/', Target: '/workspace' }] }), cfg), /volumes anonymes/);
    refused(
      () => validateCreate(withHost({ Mounts: [{ Type: 'volume', Source: '', Target: '/workspace', VolumeOptions: { DriverConfig: { Name: 'local', Options: { type: 'none', o: 'bind', device: '/' } } } }] }), cfg),
      /options de pilote/,
    );
    refused(() => validateCreate(withHost({ Memory: 0 }), cfg), /mémoire/);
    refused(() => validateCreate(withHost({ Runtime: 'nvidia' }), cfg), /runtime/);
    refused(() => validateCreate({ ...sandboxBody(), User: 'root' }, cfg), /utilisateur/);
    refused(() => validateCreate({ ...sandboxBody(), Labels: {} }, cfg), /non géré/);
    refused(() => validateCreate({ ...sandboxBody(), Entrypoint: ['sh'] }, cfg), /Entrypoint/);
    expect(validateCreate({ ...sandboxBody(), name: 'cap-sbx-123' }, cfg)).toEqual({ type: 'sandbox' });
    refused(() => validateCreate({ ...sandboxBody(), name: 'cap-postgres-1' }, cfg), /nom de conteneur/);
  });

  it('services : réseau de la sandbox obligatoire, capacités limitées', () => {
    const id = 'a'.repeat(64);
    const svc = {
      Image: 'redis:8.6.8-alpine',
      Labels: { 'cap.service': 'true', 'cap.sandbox': id },
      HostConfig: { NetworkMode: `container:${id}`, CapDrop: ['ALL'], CapAdd: ['CHOWN', 'SETUID'], SecurityOpt: ['no-new-privileges:true'], Memory: 1 << 28, NanoCpus: 1e9, PidsLimit: 128 },
    };
    expect(validateCreate(svc, cfg)).toEqual({ type: 'service', sandbox: id });
    refused(() => validateCreate({ ...svc, HostConfig: { ...svc.HostConfig, CapAdd: ['NET_ADMIN'] } }, cfg), /capacité/);
    refused(() => validateCreate({ ...svc, HostConfig: { ...svc.HostConfig, NetworkMode: 'bridge' } }, cfg), /réseau de sa sandbox/);
  });

  it('liste blanche des routes', () => {
    expect(route('GET', '/v1.47/_ping')).toEqual({ kind: 'ping' });
    expect(route('GET', `/containers/json?all=1&filters=${encodeURIComponent('{"label":["cap.sandbox=true"]}')}`)).toEqual({ kind: 'list' });
    for (const [m, p] of [
      ['GET', '/containers/json?all=1'],
      ['POST', '/containers/abc/archive'],
      ['PUT', '/containers/abc/archive'],
      ['POST', '/build'],
      ['POST', '/volumes/create'],
      ['POST', '/networks/create'],
      ['POST', '/networks/cap-sandbox/connect'],
      ['POST', '/containers/abc/update'],
      ['POST', '/images/create?fromSrc=-'],
      ['GET', '/containers/abc/logs?follow=1'],
      ['POST', '/swarm/init'],
    ]) {
      expect(() => route(m, p), `${m} ${p}`).toThrow(Refused);
    }
  });
});

const DOCKER = existsSync('/var/run/docker.sock');

describe.skipIf(!DOCKER)('garde Docker contre le vrai moteur', () => {
  let guard: http.Server;
  let url: string;
  let provider: DockerSandboxProvider;
  let handle: SandboxHandle | null = null;
  const denied: unknown[] = [];

  beforeAll(async () => {
    guard = createGuard({ ...cfg, socketPath: '/var/run/docker.sock', token: TOKEN, log: (e) => void denied.push(e) });
    await new Promise<void>((r) => guard.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(guard.address() as AddressInfo).port}`;
    provider = new DockerSandboxProvider({ network: 'cap-sandbox', guard: { url, token: TOKEN } });
  });

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
    guard?.close();
  });

  const raw = (method: string, path: string, body?: unknown, token = TOKEN) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: u.hostname, port: u.port, method, path, headers: { 'X-Cap-Guard-Token': token, ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: b }));
      });
      r.on('error', reject);
      r.end(data);
    });

  it('cycle de vie complet d’une sandbox par le provider réel, à travers le garde', async () => {
    expect(await provider.health()).toMatchObject({ ok: true });
    handle = await provider.create({
      instanceId: `guard-test-${Date.now()}`,
      workspaceId: 'w',
      ownerId: 'o',
      image: 'shipcove-sandbox:0.1.0',
      resources: { cpu: 1, memoryMb: 512, diskMb: 1024, pidsLimit: 256 },
      env: {},
    } as never);
    await provider.start(handle);
    const r = await execCollect(provider, handle, ['sh', '-c', 'id -u; echo bonjour | cat'], { stdin: 'x' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toMatch(/10001\s+bonjour/);
    expect((await provider.list()).some((s) => s.externalId === handle!.externalId)).toBe(true);
  }, 120_000);

  it('refuse les tentatives d’évasion, même authentifiées', async () => {
    expect((await raw('GET', '/_ping', undefined, 'mauvais-jeton')).status).toBe(401);
    const priv = sandboxBody();
    Object.assign(priv.HostConfig, { Privileged: true });
    expect((await raw('POST', '/containers/create', priv)).status).toBe(403);
    const bind = sandboxBody();
    Object.assign(bind.HostConfig, { Binds: ['/:/host'] });
    expect((await raw('POST', '/containers/create', bind)).status).toBe(403);
    // Conteneur non géré par la plateforme (le garde lui-même n'en est pas un, ni postgres de la pile).
    const other = JSON.parse((await new Promise<string>((resolve) => {
      http.get({ socketPath: '/var/run/docker.sock', path: '/containers/json?limit=1', headers: { Host: 'docker' } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      });
    })) as string) as Array<{ Id: string; Labels: Record<string, string> }>;
    const foreign = other.find((c) => !c.Labels['cap.sandbox'] && !c.Labels['cap.service']);
    if (foreign) {
      expect((await raw('POST', `/containers/${foreign.Id}/exec`, { Cmd: ['id'], AttachStdout: true })).status).toBe(403);
      expect((await raw('POST', `/containers/${foreign.Id}/stop`)).status).toBe(403);
      expect((await raw('DELETE', `/containers/${foreign.Id}?force=true`)).status).toBe(403);
    }
    expect((await raw('GET', '/containers/json?all=1')).status).toBe(403);
    expect((await raw('POST', '/volumes/create', { Name: 'x' })).status).toBe(403);
    expect(denied.length).toBeGreaterThan(3);
  });

  it('services d’appui dans le réseau de la sandbox', async () => {
    await provider.startServices(handle!, [{ name: 'cache', key: 'redis', image: 'redis:8.6.8-alpine', env: {}, memoryMb: 128, cpu: 0.5, pidsLimit: 128, specHash: 'h' }]);
    const list = await provider.listServices(handle!);
    expect(list.map((s) => s.name)).toEqual(['cache']);
    await provider.removeServices(handle!);
  }, 120_000);
});
