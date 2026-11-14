/**
 * Politique du garde Docker (ADR 0014) : liste blanche des appels de l'API Docker utilisés par le
 * worker, et validation stricte des conteneurs créés. Tout le reste est refusé.
 *
 * Objectif : un worker compromis ne peut pas obtenir root sur l'hôte (conteneur privilégié, montage
 * de l'hôte, espaces de noms de l'hôte, capacités, pilote de volume détourné…), ni agir sur un
 * conteneur qui n'appartient pas à la plateforme.
 */

export interface GuardConfig {
  /** Réseau Docker des sandboxes (ex. `cap-sandbox`). */
  sandboxNetwork: string;
  /** Utilisateur imposé aux sandboxes. */
  sandboxUser: string;
  /** Runtimes autorisés en plus du runtime par défaut (ex. `runsc`). */
  allowedRuntimes: string[];
  /** Plafonds de ressources par conteneur. */
  maxMemoryMb: number;
  maxCpus: number;
  maxPids: number;
}

export type Route =
  | { kind: 'ping' }
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'container'; id: string; action: string; method: string }
  | { kind: 'exec-create'; id: string }
  | { kind: 'exec'; id: string; action: string }
  | { kind: 'image-inspect' }
  | { kind: 'image-pull' };

export class Refused extends Error {}

const SANDBOX_MOUNTS = ['/workspace', '/workspace-state', '/home/agent'];
const SANDBOX_TMPFS = ['/tmp', '/run/cap'];
const SERVICE_CAPS = ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'];
const ID = '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}';

/** Reconnaît un appel autorisé (chemin sans préfixe de version) ; lève `Refused` sinon. */
export function route(method: string, rawPath: string): Route {
  const [pathWithVersion, query = ''] = rawPath.split('?');
  const path = pathWithVersion.replace(/^\/v\d+(\.\d+)?(?=\/)/, '');
  const m = method.toUpperCase();
  let r: RegExpExecArray | null;
  if ((m === 'GET' || m === 'HEAD') && (path === '/_ping' || path === '/version')) return { kind: 'ping' };
  if (m === 'GET' && path === '/containers/json') {
    const filters = parseFilters(query);
    const labels = filters['label'] ?? [];
    if (!labels.some((l) => l === 'cap.sandbox=true' || l === 'cap.service=true')) {
      throw new Refused('liste de conteneurs : filtre cap.sandbox=true ou cap.service=true obligatoire');
    }
    return { kind: 'list' };
  }
  if (m === 'POST' && path === '/containers/create') {
    // Docker lit le nom (et la plateforme) dans l'URL : même contrainte que dans le corps.
    const name = new URLSearchParams(query).get('name');
    if (name !== null && !/^cap-(sbx|svc)-[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Refused('nom de conteneur hors de l’espace cap-sbx-* / cap-svc-*');
    return { kind: 'create' };
  }
  if ((r = new RegExp(`^/containers/(${ID})/exec$`).exec(path)) && m === 'POST') return { kind: 'exec-create', id: r[1] };
  if ((r = new RegExp(`^/containers/(${ID})/(json|start|stop|kill|wait|logs)$`).exec(path))) {
    const allowed: Record<string, string> = { json: 'GET', start: 'POST', stop: 'POST', kill: 'POST', wait: 'POST', logs: 'GET' };
    if (allowed[r[2]] !== m) throw new Refused(`${m} ${r[2]} non autorisé`);
    if (r[2] === 'logs' && /(^|&)follow=(1|true)/.test(query)) throw new Refused('journaux en continu non autorisés');
    return { kind: 'container', id: r[1], action: r[2], method: m };
  }
  if ((r = new RegExp(`^/containers/(${ID})$`).exec(path)) && m === 'DELETE') return { kind: 'container', id: r[1], action: 'remove', method: m };
  if ((r = /^\/exec\/([a-f0-9]{64})\/(start|json|resize)$/.exec(path))) {
    const allowed: Record<string, string> = { start: 'POST', json: 'GET', resize: 'POST' };
    if (allowed[r[2]] !== m) throw new Refused(`${m} exec ${r[2]} non autorisé`);
    return { kind: 'exec', id: r[1], action: r[2] };
  }
  if (m === 'GET' && /^\/images\/.+\/json$/.test(path)) return { kind: 'image-inspect' };
  if (m === 'POST' && path === '/images/create') {
    const q = new URLSearchParams(query);
    if (!q.get('fromImage') || q.get('fromSrc')) throw new Refused('seul le téléchargement depuis un registre est autorisé');
    return { kind: 'image-pull' };
  }
  throw new Refused(`appel Docker non autorisé : ${m} ${path}`);
}

function parseFilters(query: string): Record<string, string[]> {
  const raw = new URLSearchParams(query).get('filters');
  if (!raw) return {};
  try {
    const f = JSON.parse(raw) as Record<string, string[] | Record<string, boolean>>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(f)) out[k] = Array.isArray(v) ? v : Object.keys(v).filter((x) => v[x]);
    return out;
  } catch {
    throw new Refused('filtres illisibles');
  }
}

/* ------------------------------------------------------------------ */
/* Création de conteneurs                                              */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!allowed.includes(k)) throw new Refused(`${where}.${k} non autorisé`);
  }
}

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Refused(msg);
}

function commonHost(h: Obj, cfg: GuardConfig): void {
  req(h['Privileged'] === false || h['Privileged'] === undefined, 'conteneur privilégié interdit');
  req(Array.isArray(h['CapDrop']) && (h['CapDrop'] as string[]).includes('ALL'), 'CapDrop ALL obligatoire');
  const sec = (h['SecurityOpt'] as unknown[] | undefined) ?? [];
  req(Array.isArray(sec) && sec.includes('no-new-privileges:true'), 'no-new-privileges obligatoire');
  req(sec.every((s) => s === 'no-new-privileges:true'), 'options de sécurité supplémentaires interdites (seccomp, apparmor…)');
  const mem = Number(h['Memory']);
  req(mem > 0 && mem <= cfg.maxMemoryMb * 1024 * 1024, 'limite mémoire obligatoire et plafonnée');
  req(h['MemorySwap'] === undefined || Number(h['MemorySwap']) === mem, 'swap supplémentaire interdit');
  const cpu = Number(h['NanoCpus']);
  req(cpu > 0 && cpu <= cfg.maxCpus * 1e9, 'limite CPU obligatoire et plafonnée');
  const pids = Number(h['PidsLimit']);
  req(pids > 0 && pids <= cfg.maxPids, 'limite de processus obligatoire et plafonnée');
  if (h['Runtime'] !== undefined) req(cfg.allowedRuntimes.includes(String(h['Runtime'])), `runtime ${String(h['Runtime'])} non autorisé`);
  if (h['Init'] !== undefined) req(typeof h['Init'] === 'boolean', 'Init invalide');
  if (h['RestartPolicy'] !== undefined) req(isObj(h['RestartPolicy']) && h['RestartPolicy']['Name'] === 'no', 'redémarrage automatique interdit');
  if (h['LogConfig'] !== undefined) req(isObj(h['LogConfig']) && h['LogConfig']['Type'] === 'json-file', 'pilote de journaux non autorisé');
  if (h['AutoRemove'] !== undefined) req(typeof h['AutoRemove'] === 'boolean', 'AutoRemove invalide');
}

/** Valide le corps de `POST /containers/create`. Renvoie le type de conteneur et la sandbox parente (service). */
export function validateCreate(body: unknown, cfg: GuardConfig): { type: 'sandbox' } | { type: 'service'; sandbox: string } {
  req(isObj(body), 'corps invalide');
  onlyKeys(body, ['name', 'Image', 'User', 'WorkingDir', 'Env', 'Labels', 'Cmd', 'StopSignal', 'HostConfig'], 'Config');
  req(body['name'] === undefined || /^cap-(sbx|svc)-[A-Za-z0-9_.-]{1,100}$/.test(String(body['name'])), 'nom de conteneur hors de l’espace cap-sbx-* / cap-svc-*');
  req(typeof body['Image'] === 'string' && body['Image'].length > 0, 'image obligatoire');
  req(body['Env'] === undefined || (Array.isArray(body['Env']) && body['Env'].every((e) => typeof e === 'string')), 'Env invalide');
  req(body['Cmd'] === undefined || (Array.isArray(body['Cmd']) && body['Cmd'].every((e) => typeof e === 'string')), 'Cmd invalide');
  req(isObj(body['Labels']), 'étiquettes obligatoires');
  req(isObj(body['HostConfig']), 'HostConfig obligatoire');
  const labels = body['Labels'] as Record<string, unknown>;
  const h = body['HostConfig'];

  if (labels['cap.sandbox'] === 'true' && labels['cap.service'] === undefined) {
    onlyKeys(
      h,
      ['NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Privileged', 'Init', 'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'Runtime', 'StorageOpt', 'Tmpfs', 'Mounts', 'AutoRemove', 'RestartPolicy', 'LogConfig'],
      'HostConfig',
    );
    req(body['User'] === cfg.sandboxUser, `utilisateur ${cfg.sandboxUser} obligatoire`);
    req(h['NetworkMode'] === cfg.sandboxNetwork, `réseau ${cfg.sandboxNetwork} obligatoire`);
    req(h['ReadonlyRootfs'] === true, 'système de fichiers racine en lecture seule obligatoire');
    req(h['CapDrop'] && !('CapAdd' in h), 'aucune capacité ajoutée');
    commonHost(h, cfg);
    if (h['StorageOpt'] !== undefined) {
      req(isObj(h['StorageOpt']) && Object.keys(h['StorageOpt']).every((k) => k === 'size'), 'StorageOpt limité à size');
    }
    if (h['Tmpfs'] !== undefined) {
      req(isObj(h['Tmpfs']), 'Tmpfs invalide');
      for (const [k, v] of Object.entries(h['Tmpfs'])) {
        req(SANDBOX_TMPFS.includes(k), `tmpfs ${k} non autorisé`);
        req(typeof v === 'string' && /\bnosuid\b/.test(v) && /\bnodev\b/.test(v), `tmpfs ${k} : nosuid,nodev obligatoires`);
      }
    }
    const mounts = (h['Mounts'] as unknown[] | undefined) ?? [];
    req(Array.isArray(mounts), 'Mounts invalide');
    for (const mt of mounts) {
      req(isObj(mt), 'montage invalide');
      onlyKeys(mt, ['Type', 'Source', 'Target', 'VolumeOptions', 'ReadOnly'], 'Mount');
      req(mt['Type'] === 'volume', 'seuls les volumes anonymes sont autorisés (aucun montage de l’hôte)');
      req(mt['Source'] === '' || mt['Source'] === undefined, 'volume nommé interdit');
      req(SANDBOX_MOUNTS.includes(String(mt['Target'])), `point de montage ${String(mt['Target'])} non autorisé`);
      const vo = mt['VolumeOptions'];
      if (vo !== undefined) {
        req(isObj(vo), 'VolumeOptions invalide');
        onlyKeys(vo, ['NoCopy', 'Labels', 'DriverConfig'], 'VolumeOptions');
        const dc = vo['DriverConfig'];
        if (dc !== undefined) {
          // Le pilote « local » avec options (type=none,o=bind,device=/) monterait l'hôte.
          req(isObj(dc) && (dc['Name'] === 'local' || dc['Name'] === undefined), 'pilote de volume non autorisé');
          req(dc['Options'] === undefined || (isObj(dc['Options']) && Object.keys(dc['Options']).length === 0), 'options de pilote de volume interdites');
        }
      }
    }
    return { type: 'sandbox' };
  }

  if (labels['cap.service'] === 'true') {
    onlyKeys(h, ['NetworkMode', 'CapDrop', 'CapAdd', 'SecurityOpt', 'Privileged', 'Init', 'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'Runtime', 'RestartPolicy', 'LogConfig'], 'HostConfig');
    req(body['User'] === undefined, 'utilisateur imposé par l’image du service');
    const nm = /^container:([a-f0-9]{64})$/.exec(String(h['NetworkMode']));
    req(nm, 'un service partage obligatoirement le réseau de sa sandbox');
    req(labels['cap.sandbox'] === nm[1], 'étiquette cap.sandbox incohérente');
    const add = (h['CapAdd'] as unknown[] | undefined) ?? [];
    req(Array.isArray(add) && add.every((c) => SERVICE_CAPS.includes(String(c).toUpperCase().replace(/^CAP_/, ''))), 'capacité non autorisée');
    commonHost(h, cfg);
    return { type: 'service', sandbox: nm[1] };
  }

  throw new Refused('conteneur non géré par la plateforme (étiquette cap.sandbox ou cap.service attendue)');
}

/** Valide le corps de `POST /containers/{id}/exec`. */
export function validateExec(body: unknown): void {
  req(isObj(body), 'corps invalide');
  onlyKeys(body, ['Cmd', 'User', 'WorkingDir', 'Env', 'AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty'], 'Exec');
  req(Array.isArray(body['Cmd']) && body['Cmd'].length > 0, 'commande obligatoire');
}

/** Un conteneur est géré par la plateforme si ses étiquettes le disent. */
export function isManaged(labels: Record<string, string> | null | undefined): 'sandbox' | 'service' | null {
  if (!labels) return null;
  if (labels['cap.service'] === 'true') return 'service';
  if (labels['cap.sandbox'] === 'true') return 'sandbox';
  return null;
}
