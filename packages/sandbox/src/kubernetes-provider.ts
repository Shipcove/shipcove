import { PassThrough, Readable } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import {
  SANDBOX_LABEL,
  SandboxError,
  type ExecOptions,
  type ExecProcess,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSpec,
} from './sandbox-provider.js';

export interface KubernetesProviderOptions {
  /** Namespace dédié aux sandboxes (NetworkPolicy deny-all + egress vers la gateway). */
  namespace: string;
  egressProxyUrl?: string;
  /** Hôtes internes joints directement (gateway LLM / Git) : exclus du proxy d'egress. */
  noProxyHosts?: string[];
  /** RuntimeClass optionnelle (gVisor, Kata) pour un isolement renforcé. */
  runtimeClassName?: string;
  imagePullSecrets?: string[];
  nodeSelector?: Record<string, string>;
  /** Charger la config depuis le cluster (ServiceAccount) ; sinon kubeconfig par défaut. */
  inCluster?: boolean;
}

/**
 * Sandboxes Kubernetes : un Pod éphémère par workspace actif, sans token de ServiceAccount
 * monté, contexte de sécurité `restricted`, volumes `emptyDir` bornés.
 * Le réseau est contraint par la NetworkPolicy du chart Helm (egress uniquement vers la gateway).
 */
export class KubernetesSandboxProvider implements SandboxProvider {
  readonly kind = 'kubernetes' as const;
  private readonly kc: k8s.KubeConfig;
  private readonly core: k8s.CoreV1Api;
  private readonly execApi: k8s.Exec;

  constructor(private readonly opts: KubernetesProviderOptions) {
    this.kc = new k8s.KubeConfig();
    if (opts.inCluster) this.kc.loadFromCluster();
    else this.kc.loadFromDefault();
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.execApi = new k8s.Exec(this.kc);
  }

  private podName(instanceId: string): string {
    return `cap-sbx-${instanceId}`;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const env = { ...spec.env };
    if (this.opts.egressProxyUrl) {
      Object.assign(env, {
        HTTP_PROXY: this.opts.egressProxyUrl,
        HTTPS_PROXY: this.opts.egressProxyUrl,
        http_proxy: this.opts.egressProxyUrl,
        https_proxy: this.opts.egressProxyUrl,
        NO_PROXY: ['localhost', '127.0.0.1', '::1', ...(this.opts.noProxyHosts ?? [])].join(','),
        no_proxy: ['localhost', '127.0.0.1', '::1', ...(this.opts.noProxyHosts ?? [])].join(','),
      });
    }
    const name = this.podName(spec.instanceId);
    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.opts.namespace,
        labels: {
          [SANDBOX_LABEL]: 'true',
          'cap.instance': spec.instanceId,
          'cap.workspace': spec.workspaceId,
          'app.kubernetes.io/component': 'sandbox',
        },
        annotations: { 'cap.owner': spec.ownerId },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: 'Never',
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        ...(this.opts.runtimeClassName ? { runtimeClassName: this.opts.runtimeClassName } : {}),
        ...(this.opts.nodeSelector ? { nodeSelector: this.opts.nodeSelector } : {}),
        ...(this.opts.imagePullSecrets ? { imagePullSecrets: this.opts.imagePullSecrets.map((n) => ({ name: n })) } : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        terminationGracePeriodSeconds: 15,
        containers: [
          {
            name: 'sandbox',
            image: spec.image,
            imagePullPolicy: 'IfNotPresent',
            command: ['/opt/cap/bin/sandbox-init'],
            workingDir: '/workspace',
            env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              privileged: false,
              capabilities: { drop: ['ALL'] },
            },
            resources: {
              limits: {
                cpu: String(spec.resources.cpu),
                memory: `${spec.resources.memoryMb}Mi`,
                'ephemeral-storage': `${spec.resources.diskMb}Mi`,
              },
              requests: {
                cpu: String(Math.max(0.1, spec.resources.cpu / 4)),
                memory: `${Math.max(256, Math.floor(spec.resources.memoryMb / 2))}Mi`,
              },
            },
            volumeMounts: [
              { name: 'workspace', mountPath: '/workspace' },
              { name: 'state', mountPath: '/workspace-state' },
              { name: 'home', mountPath: '/home/agent' },
              { name: 'tmp', mountPath: '/tmp' },
              { name: 'run', mountPath: '/run/cap' },
            ],
          },
        ],
        volumes: [
          { name: 'workspace', emptyDir: { sizeLimit: `${spec.resources.diskMb}Mi` } },
          { name: 'state', emptyDir: { sizeLimit: '2Gi' } },
          { name: 'home', emptyDir: { sizeLimit: '4Gi' } },
          { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } },
          { name: 'run', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
        ],
      },
    };
    try {
      await this.core.createNamespacedPod({ namespace: this.opts.namespace, body: pod });
    } catch (err) {
      throw new SandboxError(`Création du Pod impossible : ${(err as Error).message}`, true);
    }
    return { provider: 'kubernetes', externalId: name, internalHost: null };
  }

  async start(handle: SandboxHandle): Promise<SandboxHandle> {
    // Le Pod démarre à sa création ; on attend l'état Running.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const info = await this.inspect(handle);
      if (info.state === 'running' && info.internalHost) return { ...handle, internalHost: info.internalHost };
      if (info.state === 'failed' || info.state === 'missing') throw new SandboxError(`Pod ${handle.externalId} en échec`, true);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new SandboxError('Délai de démarrage du Pod dépassé', true);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInfo> {
    try {
      const pod = await this.core.readNamespacedPod({ name: handle.externalId, namespace: this.opts.namespace });
      const phase = pod.status?.phase;
      const ready = pod.status?.containerStatuses?.[0]?.state?.running;
      return {
        ...handle,
        internalHost: pod.status?.podIP ?? null,
        state: phase === 'Running' && ready ? 'running' : phase === 'Pending' ? 'creating' : phase === 'Failed' ? 'failed' : phase === 'Running' ? 'creating' : 'stopped',
        startedAt: pod.status?.startTime ? new Date(pod.status.startTime).toISOString() : null,
        exitCode: pod.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? null,
      };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return { ...handle, state: 'missing', startedAt: null, exitCode: null };
      throw new SandboxError(`Inspection impossible : ${(err as Error).message}`, true);
    }
  }

  async exec(handle: SandboxHandle, argv: string[], opts: ExecOptions = {}): Promise<ExecProcess> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdinStream: PassThrough | null = null;
    let input: Readable | null = null;
    if (opts.interactive) {
      stdinStream = new PassThrough();
      input = stdinStream;
    } else if (opts.stdin) {
      input = typeof opts.stdin === 'string' || Buffer.isBuffer(opts.stdin) ? Readable.from([Buffer.from(opts.stdin)]) : opts.stdin;
    }
    // Kubernetes exec ne transmet ni env ni workdir : on les applique via `env` et `cd`.
    const envArgs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const cmd = ['/usr/bin/env', '-C', opts.workdir ?? '/workspace', ...envArgs, ...argv];
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((r) => (resolveExit = r));
    const ws = await this.execApi.exec(this.opts.namespace, handle.externalId, 'sandbox', cmd, stdout, stderr, input, false, (status) => {
      if (status.status === 'Success') resolveExit(0);
      else {
        const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
        resolveExit(cause?.message ? Number(cause.message) : 1);
      }
    });
    ws.on('close', () => {
      stdout.end();
      stderr.end();
      resolveExit(-1);
    });
    let timer: NodeJS.Timeout | undefined;
    const kill = async () => {
      ws.close();
    };
    if (opts.timeoutMs) timer = setTimeout(() => void kill(), opts.timeoutMs);
    return {
      stdout,
      stderr,
      stdin: stdinStream,
      wait: async () => {
        const code = await exit;
        if (timer) clearTimeout(timer);
        return code;
      },
      kill,
    };
  }

  async portTarget(handle: SandboxHandle, port: number) {
    const info = await this.inspect(handle);
    if (info.state !== 'running' || !info.internalHost) throw new SandboxError('Sandbox non démarrée');
    return { host: info.internalHost, port };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await this.destroy(handle);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ name: handle.externalId, namespace: this.opts.namespace, gracePeriodSeconds: 10 });
    } catch (err) {
      if ((err as { code?: number }).code !== 404) throw new SandboxError(`Suppression du Pod impossible : ${(err as Error).message}`, true);
    }
  }

  async list() {
    const res = await this.core.listNamespacedPod({ namespace: this.opts.namespace, labelSelector: `${SANDBOX_LABEL}=true` });
    return res.items.map((p) => ({
      externalId: p.metadata!.name!,
      instanceId: p.metadata?.labels?.['cap.instance'] ?? null,
      workspaceId: p.metadata?.labels?.['cap.workspace'] ?? null,
    }));
  }

  async health() {
    try {
      await this.core.listNamespacedPod({ namespace: this.opts.namespace, limit: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
