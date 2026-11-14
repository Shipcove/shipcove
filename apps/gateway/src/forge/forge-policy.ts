/**
 * Garde-fous appliqués aux requêtes de la sandbox vers les forges (ADR 0013).
 *
 * L'agent est autonome (git push, gh, glab) avec les droits OAuth de l'utilisateur, SAUF pour les
 * opérations irréversibles ou qui donneraient un accès durable : elles restent soumises à
 * l'approbation humaine via les outils de la plateforme.
 */

export type ForgeFamily = 'github' | 'gitlab';

export interface Decision {
  allowed: boolean;
  reason: string;
  /**
   * Écriture de contenu via l'API (commit direct) : la branche visée (champ `branch` du corps,
   * branche par défaut si absent) doit être vérifiée comme pour un push.
   */
  branchWrite?: { repo: string };
}

const ALLOW: Decision = { allowed: true, reason: '' };
const deny = (reason: string): Decision => ({ allowed: false, reason });

/* ------------------------------------------------------------------ */
/* Jeton de run présenté par gh / glab / git                           */
/* ------------------------------------------------------------------ */

const RUN_TOKEN = /cap_rt_[A-Za-z0-9_-]{20,}/;

/**
 * Extrait le jeton de run des en-têtes d'authentification usuels :
 * `Authorization: Bearer|token <t>`, `Authorization: Basic base64(user:<t>)`, `PRIVATE-TOKEN`, `JOB-TOKEN`.
 */
export function extractRunToken(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (h: string) => {
    const v = headers[h];
    return Array.isArray(v) ? v[0] : v;
  };
  const auth = one('authorization');
  if (auth) {
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth.trim());
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const m = RUN_TOKEN.exec(decoded);
      if (m) return m[0];
    } else {
      const m = RUN_TOKEN.exec(auth);
      if (m) return m[0];
    }
  }
  for (const h of ['private-token', 'job-token']) {
    const m = RUN_TOKEN.exec(one(h) ?? '');
    if (m) return m[0];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Git smart HTTP                                                      */
/* ------------------------------------------------------------------ */

export type GitRequestKind = 'refs' | 'upload-pack' | 'receive-pack';

/** Reconnaît une requête Git « smart HTTP » et en déduit le chemin du dépôt (`owner/repo`). */
export function gitRequest(pathWithQuery: string): { kind: GitRequestKind; repo: string; service?: string } | null {
  const [path, query = ''] = pathWithQuery.split('?');
  let m = /^\/(.+?)(?:\.git)?\/info\/refs$/.exec(path);
  if (m) {
    const service = new URLSearchParams(query).get('service') ?? undefined;
    return { kind: 'refs', repo: decodeURIComponent(m[1]), service };
  }
  m = /^\/(.+?)(?:\.git)?\/git-(upload|receive)-pack$/.exec(path);
  if (m) return { kind: m[2] === 'upload' ? 'upload-pack' : 'receive-pack', repo: decodeURIComponent(m[1]) };
  return null;
}

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

const ZERO = /^0{40}(0{24})?$/;

/**
 * Lit la section de commandes d'une requête `git-receive-pack` (pkt-lines jusqu'au flush `0000`).
 * Renvoie `null` tant que les données sont incomplètes.
 */
export function parseReceivePack(buf: Buffer): { updates: RefUpdate[]; capabilities: string[] } | null {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let off = 0;
  while (true) {
    if (buf.length < off + 4) return null;
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('pkt-line invalide');
    if (len === 0) return { updates, capabilities };
    if (len < 4) throw new Error('pkt-line invalide');
    if (buf.length < off + len) return null;
    let line = buf.subarray(off + 4, off + len).toString('utf8');
    off += len;
    if (line.startsWith('shallow ')) continue;
    if (line.startsWith('push-cert')) throw new Error('push signé non pris en charge');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).trim().split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const [oldSha, newSha, ref] = line.trim().split(' ');
    if (!oldSha || !newSha || !ref) throw new Error('commande de push invalide');
    updates.push({ oldSha, newSha, ref });
  }
}

export interface BranchFacts {
  defaultBranch: string | null;
  /** Branches protégées connues de la forge parmi celles visées. */
  protectedBranches: Set<string>;
}

export function decideRefUpdate(u: RefUpdate, facts: BranchFacts): Decision {
  if (ZERO.test(u.newSha)) return deny(`suppression de ${u.ref} soumise à approbation (outil platform_delete_remote_branch)`);
  if (u.ref.startsWith('refs/heads/')) {
    const branch = u.ref.slice('refs/heads/'.length);
    if (facts.defaultBranch && branch === facts.defaultBranch) {
      return deny(`la branche par défaut « ${branch} » ne reçoit de push qu'après approbation (outil platform_git_push) ; poussez une autre branche et ouvrez une PR/MR`);
    }
    if (facts.protectedBranches.has(branch)) return deny(`branche protégée « ${branch} » : push soumis à approbation (outil platform_git_push)`);
    return ALLOW;
  }
  if (u.ref.startsWith('refs/tags/')) return ALLOW;
  return deny(`référence ${u.ref} non autorisée`);
}

/** Réponse `report-status` lisible par git : « ! [remote rejected] main -> main (raison) ». */
export function receivePackRejection(updates: RefUpdate[], reasons: Map<string, string>, capabilities: string[]): Buffer {
  const pkt = (s: string | Buffer) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'ascii'), b]);
  };
  const lines = [pkt('unpack ok\n')];
  for (const u of updates) {
    const reason = (reasons.get(u.ref) ?? 'refusé : une autre référence du push est refusée').replace(/[\r\n]/g, ' ');
    lines.push(pkt(`ng ${u.ref} ${reason}\n`));
  }
  lines.push(Buffer.from('0000'));
  const report = Buffer.concat(lines);
  if (!capabilities.includes('side-band-64k') && !capabilities.includes('side-band')) return report;
  const max = capabilities.includes('side-band-64k') ? 65515 : 995;
  const out: Buffer[] = [pkt(Buffer.from('\x02Plateforme : push refusé par les garde-fous (voir ci-dessous).\n'))];
  for (let i = 0; i < report.length; i += max) out.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + max)])));
  out.push(Buffer.from('0000'));
  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ */
/* API REST / GraphQL                                                  */
/* ------------------------------------------------------------------ */

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Rule {
  methods: string[] | '*write';
  path: RegExp;
  reason: string;
}

const MERGE = 'fusion soumise à approbation (outil platform_merge_pull_request)';
const BRANCH_DELETE = 'suppression de branche soumise à approbation (outil platform_delete_remote_branch)';
const SETTINGS = 'réglages, accès et suppression du dépôt réservés à un humain';
const PERSISTENT = "création d'un accès durable (clé, jeton, runner) interdite depuis une sandbox";

const GITHUB_RULES: Rule[] = [
  { methods: ['PUT'], path: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/, reason: MERGE },
  { methods: ['PUT', 'POST'], path: /^\/repos\/[^/]+\/[^/]+\/merges$/, reason: MERGE },
  { methods: ['POST'], path: /^\/repos\/[^/]+\/[^/]+\/merge-upstream$/, reason: MERGE },
  { methods: ['DELETE', 'PATCH'], path: /^\/repos\/[^/]+\/[^/]+\/git\/refs\/.+$/, reason: BRANCH_DELETE },
  { methods: ['POST'], path: /^\/repos\/[^/]+\/[^/]+\/branches\/[^/]+\/rename$/, reason: SETTINGS },
  { methods: ['DELETE', 'PATCH'], path: /^\/repos\/[^/]+\/[^/]+$/, reason: SETTINGS },
  { methods: '*write', path: /^\/repos\/[^/]+\/[^/]+\/(branches\/.+\/protection|rulesets|hooks|keys|collaborators|invitations|teams|transfer|topics|environments|pages|vulnerability-alerts|automated-security-fixes|private-vulnerability-reporting|properties|autolinks|interaction-limits)(\/.*)?$/, reason: SETTINGS },
  { methods: '*write', path: /^\/repos\/[^/]+\/[^/]+\/actions\/(secrets|variables|permissions|runners|oidc)(\/.*)?$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/repos\/[^/]+\/[^/]+\/(codespaces|dependabot\/secrets)(\/.*)?$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/user\/(keys|gpg_keys|ssh_signing_keys|codespaces|emails|blocks|installations|memberships|interaction-limits)(\/.*)?$/, reason: PERSISTENT },
  { methods: ['PATCH', 'DELETE'], path: /^\/user$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/orgs\/.+$/, reason: SETTINGS },
  { methods: '*write', path: /^\/(admin|enterprises|applications|authorizations|app)(\/.*)?$/, reason: PERSISTENT },
  { methods: ['DELETE'], path: /^\/repos\/[^/]+\/[^/]+\/(releases|actions\/runs|actions\/artifacts|actions\/caches)(\/.*)?$/, reason: SETTINGS },
];

/** Mutations GraphQL GitHub interdites (les noms de champ ne peuvent pas venir des variables). */
const GITHUB_MUTATIONS =
  /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch|deleteRef|updateRef|updateRefs|deleteRepository|updateRepository|archiveRepository|transferRepository|createBranchProtectionRule|updateBranchProtectionRule|deleteBranchProtectionRule|createRepositoryRuleset|updateRepositoryRuleset|deleteRepositoryRuleset|addDeployKey|createDeployKey|updateRepositoryWebCommitSignoffSetting|addPublicKey|updateEnterprise\w*|createEnvironment|deleteEnvironment)\s*[(@{]/;

const GITLAB_RULES: Rule[] = [
  { methods: ['PUT', 'POST'], path: /^\/projects\/[^/]+\/merge_requests\/\d+\/(merge|merge_when_pipeline_succeeds|rebase)$/, reason: MERGE },
  { methods: ['DELETE'], path: /^\/projects\/[^/]+\/repository\/(branches\/.+|merged_branches|tags\/.+)$/, reason: BRANCH_DELETE },
  { methods: ['DELETE', 'PUT'], path: /^\/projects\/[^/]+$/, reason: SETTINGS },
  { methods: ['POST'], path: /^\/projects\/[^/]+\/(archive|unarchive|transfer|fork\/.+|share|restore)$/, reason: SETTINGS },
  { methods: '*write', path: /^\/projects\/[^/]+\/(protected_branches|protected_tags|protected_environments|push_rule|hooks|members|invitations|share|approval_rules|approvals|environments|integrations|services|mirror|remote_mirrors|import|export|badges)(\/.*)?$/, reason: SETTINGS },
  { methods: '*write', path: /^\/projects\/[^/]+\/(deploy_keys|deploy_tokens|access_tokens|variables|runners|triggers|secure_files|pipeline_schedules\/\d+\/take_ownership)(\/.*)?$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/user\/(keys|gpg_keys|personal_access_tokens|runners|emails)(\/.*)?$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/users\/.+$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/personal_access_tokens(\/.*)?$/, reason: PERSISTENT },
  { methods: '*write', path: /^\/groups\/.+$/, reason: SETTINGS },
  { methods: '*write', path: /^\/(runners|admin|application|applications|hooks|deploy_keys|deploy_tokens|keys|namespaces|feature_flags)(\/.*)?$/, reason: PERSISTENT },
  { methods: ['DELETE'], path: /^\/projects\/[^/]+\/(pipelines|jobs|releases|packages|registry|artifacts)(\/.*)?$/, reason: SETTINGS },
];

const GITLAB_MUTATIONS =
  /\b(mergeRequestAccept|mergeRequestSetAutoMerge|mergeRequestRebase|projectDelete|projectUpdate|projectSettingsUpdate|branchRuleCreate|branchRuleUpdate|branchRuleDelete|branchRuleSquashOptionUpdate|branchRuleApprovalProjectRuleCreate|personalAccessTokenCreate|projectAccessTokenCreate|deployKeyCreate|ciVariable\w*|projectCiCdSettingsUpdate|runnerCreate|runnerUpdate|userPreferencesUpdate|groupUpdate|groupDelete|namespace\w*|projectMemberBulkUpdate|projectInitializeProductAnalytics|repositoryDelete|branchDelete)\s*[(@{]/;

/**
 * `apiPath` : chemin sans préfixe d'API ni requête (`/repos/o/r/pulls/1/merge`, `/projects/12/…`).
 * `graphqlQuery` : document GraphQL quand la requête vise l'API GraphQL.
 */
export function decideApi(family: ForgeFamily, method: string, apiPath: string, graphqlQuery?: string): Decision {
  const m = method.toUpperCase();
  if (graphqlQuery !== undefined) {
    const forbidden = (family === 'github' ? GITHUB_MUTATIONS : GITLAB_MUTATIONS).exec(graphqlQuery);
    if (forbidden && /\bmutation\b/.test(graphqlQuery)) return deny(`mutation GraphQL ${forbidden[1]} : opération soumise à approbation ou réservée à un humain`);
    if (/\bmutation\b/.test(graphqlQuery) && /\b(createCommitOnBranch|commitCreate)\s*[(@{]/.test(graphqlQuery)) {
      return deny('commit direct par GraphQL non pris en charge : utilisez git push');
    }
    return ALLOW;
  }
  if (!WRITE.has(m)) return ALLOW;
  const contents =
    family === 'github'
      ? /^\/repos\/([^/]+\/[^/]+)\/contents\/.+$/.exec(apiPath)
      : /^\/projects\/([^/]+)\/repository\/(?:files\/.+|commits|commits\/[0-9a-f]+\/(?:cherry_pick|revert))$/.exec(apiPath);
  if (contents && (family === 'gitlab' ? m !== 'GET' : m === 'PUT' || m === 'DELETE')) {
    return { allowed: true, reason: '', branchWrite: { repo: decodeURIComponent(contents[1]) } };
  }
  for (const r of family === 'github' ? GITHUB_RULES : GITLAB_RULES) {
    const methodOk = r.methods === '*write' ? true : r.methods.includes(m);
    if (methodOk && r.path.test(apiPath)) return deny(r.reason);
  }
  return ALLOW;
}

/**
 * Localise l'API dans une requête vers une forge :
 * - GitHub.com : hôte `api.github.com` (chemin direct) ; GitHub Enterprise : `/api/v3/…`, GraphQL `/api/graphql`.
 * - GitLab : `/api/v4/…`, GraphQL `/api/graphql`.
 */
export function apiTarget(family: ForgeFamily, host: string, path: string): { kind: 'rest'; path: string } | { kind: 'graphql' } | null {
  const p = path.split('?')[0];
  if (family === 'github') {
    if (host === 'api.github.com') return p === '/graphql' ? { kind: 'graphql' } : { kind: 'rest', path: p };
    if (p === '/api/graphql') return { kind: 'graphql' };
    if (p.startsWith('/api/v3/')) return { kind: 'rest', path: p.slice('/api/v3'.length) };
    return null;
  }
  if (p === '/api/graphql') return { kind: 'graphql' };
  if (p.startsWith('/api/v4/')) return { kind: 'rest', path: p.slice('/api/v4'.length) };
  return null;
}

/** Les pages web d'une forge (hors API et Git) : lecture seule depuis la sandbox. */
export function decideWeb(method: string): Decision {
  return WRITE.has(method.toUpperCase()) ? deny('interface web de la forge en lecture seule depuis la sandbox (utilisez gh, glab ou l’API)') : ALLOW;
}
