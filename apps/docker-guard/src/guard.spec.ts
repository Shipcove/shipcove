import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxProvider, execCollect, type SandboxHandle } from '@cap/sandbox';
import { route, subnetWithin, validateCreate, validateExec, validateNetworkCreate, validatePull, Refused, type GuardConfig } from './policy.js';
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
      ['POST', '/networks/cap-sandbox/connect'],
      ['POST', '/containers/abc/update'],
      ['POST', '/images/create?fromSrc=-'],
      ['GET', '/containers/abc/logs?follow=1'],
      ['GET', '/containers/abc/logs?stdout=1&follow=TRUE'],
      ['POST', '/networks/abc/disconnect'],
      ['POST', '/swarm/init'],
    ]) {
      expect(() => route(m, p), `${m} ${p}`).toThrow(Refused);
    }
  });
});

describe('isolation des sandboxes et durcissements', () => {
  const pooled: GuardConfig = { ...cfg, sandboxSubnetPool: '10.231.0.0/16' };
  const net = (over: Record<string, unknown> = {}) => ({
    Name: 'cap-sbx-net-0f3c2a91-7d4e-4b8a-9c1d-2e5f6a7b8c9d',
    Driver: 'bridge',
    Internal: true,
    Labels: { 'cap.sandbox-net': 'true', 'cap.instance': 'x' },
    IPAM: { Driver: 'default', Config: [{ Subnet: '10.231.4.16/28' }] },
    CheckDuplicate: true,
    ...over,
  });
  const refused = (fn: () => unknown, re: RegExp) => expect(fn).toThrow(re);

  it('réseau privé de sandbox : interne, étiqueté, /28 dans la plage', () => {
    expect(validateNetworkCreate(net(), pooled).name).toMatch(/^cap-sbx-net-/);
    refused(() => validateNetworkCreate(net(), cfg), /non activés/);
    refused(() => validateNetworkCreate(net({ Internal: false }), pooled), /interne/);
    refused(() => validateNetworkCreate(net({ Name: 'backend' }), pooled), /cap-sbx-net/);
    refused(() => validateNetworkCreate(net({ Driver: 'host' }), pooled), /pilote/);
    refused(() => validateNetworkCreate(net({ IPAM: { Config: [{ Subnet: '172.18.0.0/28' }] } }), pooled), /hors de la plage/);
    refused(() => validateNetworkCreate(net({ IPAM: { Config: [{ Subnet: '10.231.0.0/24' }] } }), pooled), /hors de la plage/);
    refused(() => validateNetworkCreate(net({ IPAM: { Config: [{ Subnet: '10.231.4.16/28', Gateway: '10.0.0.1' }] } }), pooled), /Gateway/);
    refused(() => validateNetworkCreate(net({ Options: { 'com.docker.network.bridge.name': 'docker0' } }), pooled), /Options/);
  });

  it('sous-réseaux : alignement et appartenance à la plage', () => {
    expect(subnetWithin('10.231.255.240/28', '10.231.0.0/16', 28)).toBe(true);
    expect(subnetWithin('10.231.4.17/28', '10.231.0.0/16', 28)).toBe(false); // non aligné
    expect(subnetWithin('10.232.0.0/28', '10.231.0.0/16', 28)).toBe(false);
  });

  it('sandbox : réseau partagé ou réseau privé (si activé), rien d’autre', () => {
    const body = (nm: string) => ({ ...sandboxBody(), HostConfig: { ...sandboxBody().HostConfig, NetworkMode: nm } });
    expect(validateCreate(body('cap-sbx-net-0f3c2a91-7d4e-4b8a-9c1d-2e5f6a7b8c9d'), pooled)).toEqual({ type: 'sandbox' });
    refused(() => validateCreate(body('cap-sbx-net-0f3c2a91-7d4e-4b8a-9c1d-2e5f6a7b8c9d'), cfg), /réseau/);
    refused(() => validateCreate(body('backend'), pooled), /réseau/);
  });

  it('exec : jamais en root', () => {
    expect(() => validateExec({ Cmd: ['id'] }, 'sandbox', cfg)).not.toThrow();
    expect(() => validateExec({ Cmd: ['id'], User: '10001:10001' }, 'sandbox', cfg)).not.toThrow();
    expect(() => validateExec({ Cmd: ['id'], User: '' }, 'service', cfg)).not.toThrow();
    refused(() => validateExec({ Cmd: ['id'], User: 'root' }, 'sandbox', cfg), /utilisateur/);
    refused(() => validateExec({ Cmd: ['id'], User: '0' }, 'sandbox', cfg), /utilisateur/);
    refused(() => validateExec({ Cmd: ['id'], User: 'root' }, 'service', cfg), /utilisateur/);
  });

  it('téléchargement d’images : liste de préfixes facultative', () => {
    expect(() => validatePull('anything/at-all', 'latest', cfg)).not.toThrow();
    const strict = { pullAllowlist: ['ghcr.io/shipcove/', 'harbor.example.com/dockerhub/'] };
    expect(() => validatePull('ghcr.io/shipcove/shipcove-sandbox', '0.2.2', strict)).not.toThrow();
    refused(() => validatePull('docker.io/evil/miner', 'latest', strict), /hors de la liste/);
  });
});

/**
 * Intégration contre le vrai moteur : socket Docker ET image de sandbox présents (construite
 * localement par tools/build-images.sh). Sinon (ex. CI des tests unitaires), le groupe est ignoré.
 */
const SANDBOX_IMAGE = 'shipcove-sandbox:0.1.0';
const DOCKER = existsSync('/var/run/docker.sock') && spawnSync('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: 'ignore' }).status === 0;

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
