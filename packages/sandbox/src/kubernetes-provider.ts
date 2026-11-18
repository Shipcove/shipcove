import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import {
  SANDBOX_LABEL,
  SandboxError,
  execCollect,
  type ExecOptions,
  type ExecProcess,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSpec,
  type ExecResult,
  type ServiceSpec,
  type ServiceState,
} from './sandbox-provider.js';

export interface KubernetesProviderOptions {
  /** Namespace dédié aux sandboxes (NetworkPolicy deny-all + egress vers la gateway, cf. chart Helm). */
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
  /** Délai max de démarrage d'un Pod (sandbox ou service), en ms. */
  startTimeoutMs?: number;
}

const SANDBOX_CONTAINER = 'sandbox';
const SERVICE_CONTAINER = 'service';
const COMPONENT = 'app.kubernetes.io/component';
const RELAY_CONFIG = '/run/cap/relays.json';
const RELAY_BIN = '/opt/cap/bin/cap-port-relay';

/**
 * Sandboxes Kubernetes : un Pod éphémère par workspace actif, sans jeton de ServiceAccount monté,
 * contexte de sécurité compatible `restricted`, volumes `emptyDir` bornés. Le réseau est contraint
 * par les NetworkPolicies du chart Helm (sortie uniquement vers la gateway et le DNS).
 *
 * Services d'appui (PostgreSQL, Redis…) : un Pod par service (un Pod en cours ne peut pas recevoir
 * de nouveau conteneur), joignable depuis sa seule sandbox (NetworkPolicy par sandbox), sans
 * aucune sortie réseau. Dans la sandbox, un relais TCP les expose sur `localhost:<port>`, comme
 * le partage d'espace réseau du provider Docker.
 */
export class KubernetesSandboxProvider implements SandboxProvider {
  readonly kind = 'kubernetes' as const;
  private readonly kc: k8s.KubeConfig;
  private readonly core: k8s.CoreV1Api;
  private readonly net: k8s.NetworkingV1Api;
  private readonly execApi: k8s.Exec;

  constructor(private readonly opts: KubernetesProviderOptions) {
    this.kc = new k8s.KubeConfig();
    if (opts.inCluster) this.kc.loadFromCluster();
    else this.kc.loadFromDefault();
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.net = this.kc.makeApiClient(k8s.NetworkingV1Api);
    this.execApi = new k8s.Exec(this.kc);
  }

  private get ns(): string {
    return this.opts.namespace;
  }

  private podName(instanceId: string): string {
    return `cap-sbx-${instanceId}`;
  }

  /** Identifiant d'instance d'une sandbox, déduit du nom de son Pod. */
  private instanceOf(handle: SandboxHandle): string {
    return handle.externalId.replace(/^cap-sbx-/, '');
  }

  private podBase(): Partial<k8s.V1PodSpec> {
    return {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      ...(this.opts.runtimeClassName ? { runtimeClassName: this.opts.runtimeClassName } : {}),
      ...(this.opts.nodeSelector ? { nodeSelector: this.opts.nodeSelector } : {}),
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const env = { ...spec.env };
    if (this.opts.egressProxyUrl) {
      const noProxy = ['localhost', '127.0.0.1', '::1', ...(this.opts.noProxyHosts ?? [])].join(',');
      Object.assign(env, {
        HTTP_PROXY: this.opts.egressProxyUrl,
        HTTPS_PROXY: this.opts.egressProxyUrl,
        http_proxy: this.opts.egressProxyUrl,
        https_proxy: this.opts.egressProxyUrl,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      });
    }
    const name = this.podName(spec.instanceId);
    const securityContext: k8s.V1SecurityContext = {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      privileged: false,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
    };
    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.ns,
        labels: {
          [SANDBOX_LABEL]: 'true',
          'cap.instance': spec.instanceId,
          'cap.workspace': spec.workspaceId,
          [COMPONENT]: 'sandbox',
          ...(spec.labels ?? {}),
        },
        annotations: { 'cap.owner': spec.ownerId },
      },
      spec: {
        ...this.podBase(),
        ...(this.opts.imagePullSecrets ? { imagePullSecrets: this.opts.imagePullSecrets.map((n) => ({ name: n })) } : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        terminationGracePeriodSeconds: 15,
        // /home/agent est un volume vide : on y recopie celui de l'image (configuration de Pi, shell…),
        // comme le fait Docker à la création d'un volume.
        initContainers: [
          {
            name: 'home',
            image: spec.image,
            imagePullPolicy: 'IfNotPresent',
            // Entrée par entrée : la racine du volume appartient à root (ses dates et droits ne
            // peuvent pas être recopiés par l'utilisateur non privilégié).
            command: ['sh', '-c', 'for f in /home/agent/* /home/agent/.[!.]*; do if [ -e "$f" ]; then cp -a "$f" /mnt/home/ || exit 1; fi; done'],
            securityContext,
            resources: { limits: { cpu: '500m', memory: '256Mi' }, requests: { cpu: '50m', memory: '64Mi' } },
            volumeMounts: [{ name: 'home', mountPath: '/mnt/home' }],
          },
        ],
        containers: [
          {
            name: SANDBOX_CONTAINER,
            image: spec.image,
            imagePullPolicy: 'IfNotPresent',
            command: ['/opt/cap/bin/sandbox-init'],
            workingDir: '/workspace',
            env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
            securityContext,
            resources: {
              limits: {
                cpu: String(spec.resources.cpu),
                memory: `${spec.resources.memoryMb}Mi`,
                'ephemeral-storage': `${spec.resources.diskMb + 8192}Mi`,
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
          { name: 'tmp', emptyDir: { sizeLimit: `${Math.min(2048, Math.floor(spec.resources.diskMb / 4))}Mi` } },
          { name: 'run', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
        ],
      },
    };
    try {
      await this.core.createNamespacedPod({ namespace: this.ns, body: pod });
    } catch (err) {
      throw new SandboxError(`Création du Pod impossible : ${message(err)}`, true);
    }
    return { provider: 'kubernetes', externalId: name, internalHost: null };
  }

  async start(handle: SandboxHandle): Promise<SandboxHandle> {
    // Le Pod démarre à sa création ; on attend l'état Running.
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      const info = await this.inspect(handle);
      if (info.state === 'running' && info.internalHost) return { ...handle, internalHost: info.internalHost };
      if (info.state === 'failed' || info.state === 'missing') throw new SandboxError(`Pod ${handle.externalId} en échec`, true);
      const reason = await this.waitingReason(handle.externalId, SANDBOX_CONTAINER);
      if (reason && FATAL_WAITING.has(reason)) throw new SandboxError(`Pod ${handle.externalId} : ${reason}`, true);
      await sleep(1000);
    }
    throw new SandboxError('Délai de démarrage du Pod dépassé', true);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInfo> {
    try {
      const pod = await this.core.readNamespacedPod({ name: handle.externalId, namespace: this.ns });
      const phase = pod.status?.phase;
      const cs = pod.status?.containerStatuses?.find((c) => c.name === SANDBOX_CONTAINER);
      const running = !!cs?.state?.running;
      return {
        ...handle,
        internalHost: pod.status?.podIP ?? null,
        state: phase === 'Running' && running ? 'running' : phase === 'Pending' || phase === 'Running' ? 'creating' : phase === 'Failed' ? 'failed' : 'stopped',
        startedAt: pod.status?.startTime ? new Date(pod.status.startTime).toISOString() : null,
        exitCode: cs?.state?.terminated?.exitCode ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return { ...handle, state: 'missing', startedAt: null, exitCode: null };
      throw new SandboxError(`Inspection impossible : ${message(err)}`, true);
    }
  }

  async exec(handle: SandboxHandle, argv: string[], opts: ExecOptions = {}): Promise<ExecProcess> {
    // Kubernetes exec ne transmet ni env ni workdir : on les applique via `env -C` (coreutils).
    const envArgs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    return this.execIn(handle.externalId, SANDBOX_CONTAINER, ['/usr/bin/env', '-C', opts.workdir ?? '/workspace', ...envArgs, ...argv], opts);
  }

  private async execIn(pod: string, container: string, cmd: string[], opts: ExecOptions = {}): Promise<ExecProcess> {
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
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((r) => (resolveExit = r));
    let ws: Awaited<ReturnType<k8s.Exec['exec']>>;
    try {
      ws = await this.execApi.exec(this.ns, pod, container, cmd, stdout, stderr, input, false, (status) => {
        if (status.status === 'Success') resolveExit(0);
        else {
          const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
          resolveExit(cause?.message ? Number(cause.message) : 1);
        }
      });
    } catch (err) {
      throw new SandboxError(`Exécution impossible dans ${pod} : ${message(err)}`, true);
    }
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
    await this.removeServices(handle);
    try {
      await this.core.deleteNamespacedPod({ name: handle.externalId, namespace: this.ns, gracePeriodSeconds: 10 });
    } catch (err) {
      if (!isNotFound(err)) throw new SandboxError(`Suppression du Pod impossible : ${message(err)}`, true);
    }
  }

  async list() {
    const res = await this.core.listNamespacedPod({ namespace: this.ns, labelSelector: `${SANDBOX_LABEL}=true` });
    return res.items.map((p) => ({
      externalId: p.metadata!.name!,
      instanceId: p.metadata?.labels?.['cap.instance'] ?? null,
      workspaceId: p.metadata?.labels?.['cap.workspace'] ?? null,
    }));
  }

  async health() {
    try {
      await this.core.listNamespacedPod({ namespace: this.ns, limit: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: message(err) };
    }
  }

  /* ------------------------------ Services d'appui ------------------------------ */

  private servicePodName(instanceId: string, name: string): string {
    return `cap-svc-${createHash('sha256').update(`${instanceId}/${name}`).digest('hex').slice(0, 20)}`;
  }

  private serviceSelector(instanceId: string, name?: string): string {
    return [`${COMPONENT}=service`, `cap.instance=${instanceId}`, ...(name ? [`cap.service=${name}`] : [])].join(',');
  }

  private async servicePods(instanceId: string, name?: string): Promise<k8s.V1Pod[]> {
    const res = await this.core.listNamespacedPod({ namespace: this.ns, labelSelector: this.serviceSelector(instanceId, name) });
    return res.items.filter((p) => !p.metadata?.deletionTimestamp);
  }

  async startServices(handle: SandboxHandle, services: ServiceSpec[]): Promise<void> {
    if (!services.length) return;
    const instanceId = this.instanceOf(handle);
    await this.ensureServicePolicy(instanceId);
    for (const svc of services) {
      try {
        await this.startOne(instanceId, svc, svc.image, svc.pullAuth);
      } catch (err) {
        if (!(err instanceof ImagePullError) || !svc.fallbackImage) throw err;
        // Miroir indisponible et repli autorisé : registre d'origine.
        await this.removeService(handle, svc.name);
        await this.startOne(instanceId, svc, svc.fallbackImage);
      }
    }
    await this.syncRelays(handle);
  }

  private async startOne(instanceId: string, svc: ServiceSpec, image: string, auth?: ServiceSpec['pullAuth']): Promise<void> {
    const name = this.servicePodName(instanceId, svc.name);
    const pullSecret = auth ? `${name}-pull` : null;
    if (pullSecret && auth) await this.writePullSecret(pullSecret, image, auth, instanceId, svc.name);
    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.ns,
        labels: { [COMPONENT]: 'service', 'cap.instance': instanceId, 'cap.service': svc.name, 'cap.service-key': svc.key },
        annotations: { 'cap.service-hash': svc.specHash, 'cap.service-ports': JSON.stringify(svc.ports ?? []) },
      },
      spec: {
        ...this.podBase(),
        ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        terminationGracePeriodSeconds: 5,
        containers: [
          {
            name: SERVICE_CONTAINER,
            image,
            imagePullPolicy: 'IfNotPresent',
            env: Object.entries(svc.env).map(([n, value]) => ({ name: n, value })),
            // Capacités minimales pour les images officielles qui abandonnent root au démarrage.
            securityContext: {
              allowPrivilegeEscalation: false,
              privileged: false,
              capabilities: { drop: ['ALL'], add: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'] },
            },
            resources: {
              limits: { cpu: String(svc.cpu), memory: `${svc.memoryMb}Mi`, 'ephemeral-storage': '4Gi' },
              requests: { cpu: String(Math.max(0.05, svc.cpu / 4)), memory: `${Math.max(32, Math.floor(svc.memoryMb / 4))}Mi` },
            },
          },
        ],
      },
    };
    try {
      await this.core.createNamespacedPod({ namespace: this.ns, body: pod });
    } catch (err) {
      throw new SandboxError(`Service ${svc.name} : création du Pod impossible (${message(err)})`, true);
    }
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      const p = await this.core.readNamespacedPod({ name, namespace: this.ns }).catch(() => null);
      const cs = p?.status?.containerStatuses?.[0];
      if (p?.status?.phase === 'Running' && cs?.state?.running && p.status.podIP) return;
      if (p?.status?.phase === 'Failed' || p?.status?.phase === 'Succeeded') throw new SandboxError(`Service ${svc.name} : le conteneur s’est arrêté (${cs?.state?.terminated?.reason ?? p.status.phase})`, true);
      const reason = cs?.state?.waiting?.reason;
      if (reason === 'ErrImagePull' || reason === 'ImagePullBackOff' || reason === 'InvalidImageName') throw new ImagePullError(`Service ${svc.name} : image ${image} introuvable (${cs?.state?.waiting?.message ?? reason})`);
      if (reason && FATAL_WAITING.has(reason)) throw new SandboxError(`Service ${svc.name} : ${reason}`, true);
      await sleep(1000);
    }
    throw new SandboxError(`Service ${svc.name} : délai de démarrage dépassé`, true);
  }

  /** Identifiants du registre (miroir authentifié) : Secret propre au service, supprimé avec lui. */
  private async writePullSecret(name: string, image: string, auth: NonNullable<ServiceSpec['pullAuth']>, instanceId: string, service: string): Promise<void> {
    const registry = auth.serveraddress || image.split('/')[0];
    const config = { auths: { [registry]: { username: auth.username, password: auth.password, auth: Buffer.from(`${auth.username}:${auth.password}`).toString('base64') } } };
    const body: k8s.V1Secret = {
      metadata: { name, namespace: this.ns, labels: { [COMPONENT]: 'service-pull', 'cap.instance': instanceId, 'cap.service': service } },
      type: 'kubernetes.io/dockerconfigjson',
      data: { '.dockerconfigjson': Buffer.from(JSON.stringify(config)).toString('base64') },
    };
    try {
      await this.core.createNamespacedSecret({ namespace: this.ns, body });
    } catch (err) {
      if (!isConflict(err)) throw new SandboxError(`Secret de registre impossible : ${message(err)}`, true);
      await this.core.replaceNamespacedSecret({ name, namespace: this.ns, body });
    }
  }

  /**
   * Isolement des services d'une sandbox : entrées acceptées depuis cette sandbox seulement. La
   * politique par défaut du namespace (chart Helm) interdit tout le reste, sorties comprises.
   */
  private async ensureServicePolicy(instanceId: string): Promise<void> {
    const body: k8s.V1NetworkPolicy = {
      metadata: { name: `cap-svc-${instanceId}`, namespace: this.ns, labels: { [COMPONENT]: 'service-policy', 'cap.instance': instanceId } },
      spec: {
        podSelector: { matchLabels: { [COMPONENT]: 'service', 'cap.instance': instanceId } },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{ _from: [{ podSelector: { matchLabels: { [COMPONENT]: 'sandbox', 'cap.instance': instanceId } } }] }],
        egress: [],
      },
    };
    try {
      await this.net.createNamespacedNetworkPolicy({ namespace: this.ns, body });
    } catch (err) {
      if (!isConflict(err)) throw new SandboxError(`NetworkPolicy des services impossible : ${message(err)}`, true);
    }
  }

  /** Relais localhost → Pods des services, dans la sandbox (démarré au besoin, configuration relue en continu). */
  private async syncRelays(handle: SandboxHandle): Promise<void> {
    const relays: Array<{ port: number; host: string }> = [];
    for (const p of await this.servicePods(this.instanceOf(handle))) {
      const ip = p.status?.podIP;
      if (!ip) continue;
      const ports = JSON.parse(p.metadata?.annotations?.['cap.service-ports'] ?? '[]') as number[];
      for (const port of ports) relays.push({ port, host: ip });
    }
    const write = await execCollect(this, handle, ['sh', '-c', `cat > ${RELAY_CONFIG}.tmp && mv ${RELAY_CONFIG}.tmp ${RELAY_CONFIG}`], { stdin: JSON.stringify(relays), timeoutMs: 15_000, workdir: '/' });
    if (write.exitCode !== 0) throw new SandboxError(`Configuration du relais impossible : ${write.stderr.toString('utf8').slice(0, 200)}`, true);
    // Démarrage unique (fichier de verrou) ; le relais survit à la fin de cet exec.
    const start = await execCollect(
      this,
      handle,
      ['sh', '-c', `if ! [ -f /run/cap/relay.pid ] || ! kill -0 "$(cat /run/cap/relay.pid)" 2>/dev/null; then nohup ${RELAY_BIN} >/dev/null 2>&1 & echo $! > /run/cap/relay.pid; fi`],
      { timeoutMs: 15_000, workdir: '/' },
    );
    if (start.exitCode !== 0) throw new SandboxError('Relais des services impossible à démarrer', true);
    // Le relais relit sa configuration chaque seconde.
    await sleep(1500);
  }

  async removeService(handle: SandboxHandle, name: string): Promise<void> {
    const instanceId = this.instanceOf(handle);
    await this.deleteServiceObjects(instanceId, this.serviceSelector(instanceId, name), `${COMPONENT}=service-pull,cap.instance=${instanceId},cap.service=${name}`);
    await this.waitGone(this.serviceSelector(instanceId, name));
    if ((await this.inspect(handle)).state === 'running') await this.syncRelays(handle).catch(() => undefined);
  }

  async removeServices(handle: SandboxHandle): Promise<void> {
    const instanceId = this.instanceOf(handle);
    await this.deleteServiceObjects(instanceId, this.serviceSelector(instanceId), `${COMPONENT}=service-pull,cap.instance=${instanceId}`);
    try {
      await this.net.deleteNamespacedNetworkPolicy({ name: `cap-svc-${instanceId}`, namespace: this.ns });
    } catch (err) {
      if (!isNotFound(err)) throw new SandboxError(`Suppression de la NetworkPolicy : ${message(err)}`, true);
    }
  }

  private async deleteServiceObjects(_instanceId: string, podSelector: string, secretSelector: string): Promise<void> {
    try {
      await this.core.deleteCollectionNamespacedPod({ namespace: this.ns, labelSelector: podSelector, gracePeriodSeconds: 5 });
      await this.core.deleteCollectionNamespacedSecret({ namespace: this.ns, labelSelector: secretSelector });
    } catch (err) {
      if (!isNotFound(err)) throw new SandboxError(`Suppression du service : ${message(err)}`, true);
    }
  }

  /** Attend la disparition des Pods (un nom de Pod ne peut pas être réutilisé avant). */
  private async waitGone(selector: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const res = await this.core.listNamespacedPod({ namespace: this.ns, labelSelector: selector });
      if (res.items.length === 0) return;
      await sleep(1000);
    }
  }

  async listServices(handle: SandboxHandle): Promise<ServiceState[]> {
    return (await this.servicePods(this.instanceOf(handle))).map((p) => ({
      name: p.metadata?.labels?.['cap.service'] ?? '',
      key: p.metadata?.labels?.['cap.service-key'] ?? p.metadata?.labels?.['cap.service'] ?? '',
      specHash: p.metadata?.annotations?.['cap.service-hash'] ?? '',
      running: p.status?.phase === 'Running' && !!p.status.containerStatuses?.[0]?.state?.running,
    }));
  }

  private async servicePod(handle: SandboxHandle, name: string): Promise<string> {
    const [p] = await this.servicePods(this.instanceOf(handle), name);
    if (!p?.metadata?.name) throw new SandboxError(`Service ${name} introuvable`);
    return p.metadata.name;
  }

  async serviceExec(handle: SandboxHandle, name: string, argv: string[], timeoutMs = 10_000): Promise<ExecResult> {
    const pod = await this.servicePod(handle, name);
    // Commande directe (pas d'`env -C` : les images de services n'ont pas toutes coreutils).
    const proc = await this.execIn(pod, SERVICE_CONTAINER, argv, { timeoutMs });
    const collect = (s: Readable) =>
      new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        s.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 256 * 1024) chunks.push(c);
        });
        s.on('end', () => resolve(Buffer.concat(chunks)));
        s.on('error', () => resolve(Buffer.concat(chunks)));
      });
    const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()]);
    return { exitCode, stdout, stderr };
  }

  async serviceLogs(handle: SandboxHandle, name: string, tail: number): Promise<string> {
    const pod = await this.servicePod(handle, name);
    try {
      return await this.core.readNamespacedPodLog({ name: pod, namespace: this.ns, container: SERVICE_CONTAINER, tailLines: tail });
    } catch (err) {
      throw new SandboxError(`Journal du service ${name} indisponible : ${message(err)}`);
    }
  }

  private async waitingReason(pod: string, container: string): Promise<string | null> {
    const p = await this.core.readNamespacedPod({ name: pod, namespace: this.ns }).catch(() => null);
    const all = [...(p?.status?.initContainerStatuses ?? []), ...(p?.status?.containerStatuses ?? [])];
    return all.find((c) => c.name === container || c.state?.waiting)?.state?.waiting?.reason ?? null;
  }
}

/** Raisons d'attente qui ne se résolvent pas seules. */
const FATAL_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError', 'CrashLoopBackOff']);

class ImagePullError extends SandboxError {
  constructor(msg: string) {
    super(msg, false);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statusCode(err: unknown): number | undefined {
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e.code ?? e.statusCode ?? e.response?.statusCode;
}
const isNotFound = (err: unknown) => statusCode(err) === 404;
const isConflict = (err: unknown) => statusCode(err) === 409;
function message(err: unknown): string {
  const e = err as { body?: unknown; message?: string };
  if (typeof e.body === 'string') {
    try {
      return (JSON.parse(e.body) as { message?: string }).message ?? e.body;
    } catch {
      return e.body;
    }
  }
  return e.message ?? String(err);
}
