import { PassThrough, Readable } from 'node:stream';
import Docker from 'dockerode';
import {
  SANDBOX_LABEL,
  SANDBOX_USER,
  SandboxError,
  type ExecOptions,
  type ExecProcess,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSpec,
} from './sandbox-provider.js';

export interface DockerProviderOptions {
  /** Socket Docker (worker uniquement ; jamais monté dans une sandbox). */
  socketPath?: string;
  /** Réseau interne des sandboxes (Compose : `cap-sandbox`, `internal: true`). */
  network: string;
  /** Proxy d'egress (gateway) injecté dans l'environnement. */
  egressProxyUrl?: string;
  /** Runtime OCI alternatif (ex. `runsc` pour gVisor) si disponible. */
  runtime?: string;
  /** Activer la limite disque (`--storage-opt size`) : nécessite overlay2 sur xfs+pquota. */
  enforceDiskQuota?: boolean;
}

/**
 * Sandboxes Docker durcies (ADR 0010) :
 * utilisateur non privilégié, `cap-drop ALL`, `no-new-privileges`, seccomp par défaut,
 * rootfs en lecture seule + tmpfs/volumes éphémères pour les zones inscriptibles,
 * limites CPU/RAM/PIDs, réseau interne sans route vers Internet ni vers le backend.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = 'docker' as const;
  private readonly docker: Docker;

  constructor(private readonly opts: DockerProviderOptions) {
    this.docker = new Docker({ socketPath: opts.socketPath ?? '/var/run/docker.sock' });
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const name = `cap-sbx-${spec.instanceId}`;
    const env = { ...spec.env };
    if (this.opts.egressProxyUrl) {
      Object.assign(env, {
        HTTP_PROXY: this.opts.egressProxyUrl,
        HTTPS_PROXY: this.opts.egressProxyUrl,
        http_proxy: this.opts.egressProxyUrl,
        https_proxy: this.opts.egressProxyUrl,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
      });
    }
    const memory = spec.resources.memoryMb * 1024 * 1024;
    // NoCopy=false : le volume est initialisé avec le contenu de l'image (ex. /home/agent).
    const volOpts = { NoCopy: false, Labels: { [SANDBOX_LABEL]: 'true', 'cap.instance': spec.instanceId }, DriverConfig: { Name: 'local', Options: {} } };
    try {
      const container = (await this.docker.createContainer({
        name,
        Image: spec.image,
        User: SANDBOX_USER,
        WorkingDir: '/workspace',
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: {
          [SANDBOX_LABEL]: 'true',
          'cap.instance': spec.instanceId,
          'cap.workspace': spec.workspaceId,
          'cap.owner': spec.ownerId,
          ...(spec.labels ?? {}),
        },
        Cmd: ['/opt/cap/bin/sandbox-init'],
        StopSignal: 'SIGTERM',
        HostConfig: {
          NetworkMode: this.opts.network,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Privileged: false,
          Init: true,
          Memory: memory,
          MemorySwap: memory,
          NanoCpus: Math.round(spec.resources.cpu * 1e9),
          PidsLimit: spec.resources.pidsLimit,
          ...(this.opts.runtime ? { Runtime: this.opts.runtime } : {}),
          ...(this.opts.enforceDiskQuota ? { StorageOpt: { size: `${spec.resources.diskMb}m` } } : {}),
          Tmpfs: {
            '/tmp': `rw,nosuid,nodev,size=${Math.min(2048, Math.floor(spec.resources.diskMb / 4))}m`,
            '/run/cap': 'rw,nosuid,nodev,noexec,size=64m,uid=10001,gid=10001,mode=0700',
          },
          // Zones inscriptibles : volumes anonymes détruits avec le conteneur (état durable = S3).
          Mounts: [
            { Type: 'volume', Source: '', Target: '/workspace', VolumeOptions: volOpts },
            { Type: 'volume', Source: '', Target: '/workspace-state', VolumeOptions: volOpts },
            { Type: 'volume', Source: '', Target: '/home/agent', VolumeOptions: volOpts },
          ],
          AutoRemove: false,
          RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
        },
      })) as unknown as Docker.Container;
      return { provider: 'docker', externalId: container.id, internalHost: null };
    } catch (err) {
      throw new SandboxError(`Création de la sandbox impossible : ${(err as Error).message}`, true);
    }
  }

  async start(handle: SandboxHandle): Promise<SandboxHandle> {
    const c = this.docker.getContainer(handle.externalId);
    try {
      await c.start();
    } catch (err) {
      if (!/already started/i.test((err as Error).message)) throw new SandboxError(`Démarrage impossible : ${(err as Error).message}`, true);
    }
    const info = await c.inspect();
    const ip = info.NetworkSettings.Networks?.[this.opts.network]?.IPAddress || null;
    return { ...handle, internalHost: ip };
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInfo> {
    try {
      const info = await this.docker.getContainer(handle.externalId).inspect();
      const s = info.State;
      return {
        ...handle,
        internalHost: info.NetworkSettings.Networks?.[this.opts.network]?.IPAddress || handle.internalHost,
        state: s.Running ? 'running' : s.Status === 'created' ? 'creating' : s.Status === 'dead' ? 'failed' : 'stopped',
        startedAt: s.StartedAt ?? null,
        exitCode: s.Running ? null : s.ExitCode,
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return { ...handle, state: 'missing', startedAt: null, exitCode: null };
      throw new SandboxError(`Inspection impossible : ${(err as Error).message}`, true);
    }
  }

  async exec(handle: SandboxHandle, argv: string[], opts: ExecOptions = {}): Promise<ExecProcess> {
    const c = this.docker.getContainer(handle.externalId);
    const wantStdin = !!opts.stdin || !!opts.interactive;
    const exec = await c.exec({
      Cmd: argv,
      AttachStdin: wantStdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.user ?? SANDBOX_USER,
      WorkingDir: opts.workdir ?? '/workspace',
      Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: wantStdin });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);
    let ended = false;
    const endStreams = () => {
      if (ended) return;
      ended = true;
      stdout.end();
      stderr.end();
    };
    stream.on('end', endStreams);
    stream.on('close', endStreams);
    stream.on('error', (err) => {
      stdout.destroy(err);
      stderr.destroy(err);
    });

    if (opts.stdin && !opts.interactive) {
      const src = typeof opts.stdin === 'string' || Buffer.isBuffer(opts.stdin) ? Readable.from([Buffer.from(opts.stdin)]) : opts.stdin;
      src.on('data', (chunk) => stream.write(chunk));
      src.on('end', () => (stream as unknown as { end: () => void }).end());
      src.on('error', () => (stream as unknown as { end: () => void }).end());
    }

    let timer: NodeJS.Timeout | undefined;
    const kill = async () => {
      // Docker n'offre pas de kill d'exec : on tue le processus par son PID dans le conteneur.
      try {
        const info = await exec.inspect();
        if (info.Running && info.Pid) {
          const k = await c.exec({ Cmd: ['kill', '-TERM', `-${info.Pid}`], User: 'root', AttachStdout: false, AttachStderr: false });
          await k.start({ Detach: true }).catch(() => undefined);
          const k2 = await c.exec({ Cmd: ['kill', '-TERM', String(info.Pid)], User: 'root', AttachStdout: false, AttachStderr: false });
          await k2.start({ Detach: true }).catch(() => undefined);
        }
      } catch {
        /* conteneur déjà parti */
      }
      (stream as unknown as { destroy: () => void }).destroy();
    };
    if (opts.timeoutMs) timer = setTimeout(() => void kill(), opts.timeoutMs);

    const wait = async (): Promise<number> => {
      await new Promise<void>((resolve) => {
        if (ended) resolve();
        else {
          stream.on('end', () => resolve());
          stream.on('close', () => resolve());
          stream.on('error', () => resolve());
        }
      });
      if (timer) clearTimeout(timer);
      for (let i = 0; i < 50; i++) {
        const info = await exec.inspect().catch(() => null);
        if (!info) return -1;
        if (!info.Running) return info.ExitCode ?? -1;
        await new Promise((r) => setTimeout(r, 50));
      }
      return -1;
    };

    return {
      stdout,
      stderr,
      stdin: opts.interactive ? (stream as unknown as NodeJS.WritableStream as never) : null,
      wait,
      kill,
    };
  }

  async portTarget(handle: SandboxHandle, port: number): Promise<{ host: string; port: number }> {
    const info = await this.inspect(handle);
    if (info.state !== 'running' || !info.internalHost) throw new SandboxError('Sandbox non démarrée');
    return { host: info.internalHost, port };
  }

  async stop(handle: SandboxHandle, graceMs = 10_000): Promise<void> {
    try {
      await this.docker.getContainer(handle.externalId).stop({ t: Math.ceil(graceMs / 1000) });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 304 && code !== 404) throw new SandboxError(`Arrêt impossible : ${(err as Error).message}`, true);
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    try {
      await this.docker.getContainer(handle.externalId).remove({ force: true, v: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw new SandboxError(`Destruction impossible : ${(err as Error).message}`, true);
    }
  }

  async list() {
    const rows = await this.docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=true`] } });
    return rows.map((r) => ({ externalId: r.Id, instanceId: r.Labels['cap.instance'] ?? null, workspaceId: r.Labels['cap.workspace'] ?? null }));
  }

  async health() {
    try {
      await this.docker.ping();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Vérifie la présence locale de l'image (et son digest). */
  async imageDigest(image: string): Promise<string | null> {
    try {
      const info = await this.docker.getImage(image).inspect();
      return info.RepoDigests?.[0]?.split('@')[1] ?? info.Id;
    } catch {
      return null;
    }
  }
}
