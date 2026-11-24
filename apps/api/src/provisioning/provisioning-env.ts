import { z } from 'zod';
import {
  PlatformSettingsPatchSchema,
  SmtpConfigSchema,
  UpsertAuthProviderSchema,
  UpsertGitForgeSchema,
  type GitProviderKind,
  type UpsertGitForge,
} from '@cap/contracts';

/**
 * Configuration déclarative par variables d'environnement (toutes facultatives), appliquée par
 * l'API à chaque démarrage : connexion LiteLLM et modèles, fournisseurs d'identité, forges Git,
 * SMTP et paramètres plateforme. Ce qui n'est pas déclaré reste géré depuis l'administration.
 * Les secrets acceptent la variante `<NOM>_FILE` (fichier monté), comme toutes les variables.
 */

export type ProvisionedAuthProvider = z.infer<typeof UpsertAuthProviderSchema>;

export interface LiteLlmModelDeclaration {
  model_name: string;
  litellm_params: Record<string, unknown> & { model: string };
  model_info?: Record<string, unknown>;
}

export interface Provisioning {
  litellm: {
    /** URL et clé écrites dans Vault (si `LITELLM_MASTER_KEY` est fourni). */
    connection: { url: string; masterKey: string } | null;
    /** Modèles créés dans LiteLLM s'ils n'existent pas (`POST /model/new`). */
    models: LiteLlmModelDeclaration[];
    syncOnStart: boolean;
    syncIntervalMinutes: number;
    /** Modèles activés après découverte ; `'*'` : tous. */
    enable: string[] | '*';
    defaultModel: string | null;
    titleModel: string | null;
  };
  authProviders: ProvisionedAuthProvider[];
  gitForges: UpsertGitForge[];
  smtp: z.infer<typeof SmtpConfigSchema> | null;
  /** Correctifs de paramètres par section (fusionnés aux valeurs actuelles). */
  settings: Record<string, Record<string, unknown>>;
}

type Env = Record<string, string | undefined>;

export class ProvisioningError extends Error {}

const str = (env: Env, k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

/** Valeur brute (secret, certificat PEM) : seuls les blancs de début et de fin sont retirés. */
const raw = (env: Env, k: string): string | undefined => str(env, k);

function bool(env: Env, k: string): boolean | undefined {
  const v = str(env, k)?.toLowerCase();
  if (v === undefined) return undefined;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new ProvisioningError(`${k} : booléen attendu (true / false), reçu « ${env[k]} »`);
}

function int(env: Env, k: string): number | undefined {
  const v = str(env, k);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new ProvisioningError(`${k} : entier attendu, reçu « ${v} »`);
  return Number(v);
}

function list(env: Env, k: string): string[] | undefined {
  const v = str(env, k);
  if (v === undefined) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function json(env: Env, k: string): unknown {
  const v = str(env, k);
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new ProvisioningError(`${k} : JSON invalide (${(e as Error).message})`);
  }
}

function check<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
    throw new ProvisioningError(`${label} invalide : ${issues}`);
  }
  return r.data;
}

/** Retire les clés `undefined` (les valeurs par défaut du schéma s'appliquent alors). */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/* ------------------------------- LiteLLM ------------------------------- */

const LiteLlmModelsSchema = z.array(
  z.looseObject({
    model_name: z.string().min(1).max(200),
    litellm_params: z.looseObject({ model: z.string().min(1).max(300) }),
    model_info: z.record(z.string(), z.unknown()).optional(),
  }),
);

function litellm(env: Env, litellmUrl: string): Provisioning['litellm'] {
  const key = raw(env, 'LITELLM_MASTER_KEY');
  const enable = list(env, 'LITELLM_ENABLED_MODELS') ?? [];
  return {
    connection: key ? { url: litellmUrl.replace(/\/+$/, ''), masterKey: key } : null,
    models: check(LiteLlmModelsSchema, json(env, 'LITELLM_MODELS') ?? [], 'LITELLM_MODELS') as LiteLlmModelDeclaration[],
    syncOnStart: bool(env, 'LITELLM_SYNC_ON_START') ?? true,
    syncIntervalMinutes: int(env, 'LITELLM_SYNC_INTERVAL_MINUTES') ?? 0,
    enable: enable.includes('*') ? '*' : enable,
    defaultModel: str(env, 'LITELLM_DEFAULT_MODEL') ?? null,
    titleModel: str(env, 'LITELLM_TITLE_MODEL') ?? null,
  };
}

/* ------------------------- Fournisseurs d'identité ------------------------- */

type FieldKind = 'string' | 'raw' | 'bool' | 'int' | 'list';
interface ProviderSpec {
  type: ProvisionedAuthProvider['type'];
  prefix: string;
  defaultName: string;
  /** Variable dont la présence déclare le fournisseur. */
  trigger: string;
  /** Suffixe de variable → [clé de configuration, nature]. */
  fields: Record<string, [string, FieldKind]>;
}

const PROVIDER_SPECS: ProviderSpec[] = [
  {
    type: 'oidc',
    prefix: 'SSO_OIDC_',
    defaultName: 'SSO',
    trigger: 'ISSUER',
    fields: {
      ISSUER: ['issuer', 'string'],
      CLIENT_ID: ['clientId', 'string'],
      CLIENT_SECRET: ['clientSecret', 'raw'],
      SCOPES: ['scopes', 'list'],
      USERNAME_CLAIM: ['usernameClaim', 'string'],
      EMAIL_CLAIM: ['emailClaim', 'string'],
      NAME_CLAIM: ['nameClaim', 'string'],
      MFA: ['mfa', 'string'],
      ALLOW_INSECURE_HTTP: ['allowInsecureHttp', 'bool'],
    },
  },
  {
    type: 'saml',
    prefix: 'SSO_SAML_',
    defaultName: 'SAML',
    trigger: 'ENTRY_POINT',
    fields: {
      ENTRY_POINT: ['entryPoint', 'string'],
      ISSUER: ['issuer', 'string'],
      IDP_CERT: ['idpCert', 'raw'],
      IDP_ISSUER: ['idpIssuer', 'string'],
      PRIVATE_KEY: ['privateKey', 'raw'],
      EMAIL_ATTRIBUTE: ['emailAttribute', 'string'],
      NAME_ATTRIBUTE: ['nameAttribute', 'string'],
      USERNAME_ATTRIBUTE: ['usernameAttribute', 'string'],
      WANT_ASSERTIONS_SIGNED: ['wantAssertionsSigned', 'bool'],
      WANT_AUTHN_RESPONSE_SIGNED: ['wantAuthnResponseSigned', 'bool'],
      MFA: ['mfa', 'string'],
    },
  },
  {
    type: 'ldap',
    prefix: 'SSO_LDAP_',
    defaultName: 'LDAP',
    trigger: 'URL',
    fields: {
      URL: ['url', 'string'],
      BIND_DN: ['bindDn', 'string'],
      BIND_PASSWORD: ['bindPassword', 'raw'],
      SEARCH_BASE: ['searchBase', 'string'],
      SEARCH_FILTER: ['searchFilter', 'string'],
      USERNAME_ATTRIBUTE: ['usernameAttribute', 'string'],
      EMAIL_ATTRIBUTE: ['emailAttribute', 'string'],
      NAME_ATTRIBUTE: ['nameAttribute', 'string'],
      START_TLS: ['startTls', 'bool'],
      TLS_REJECT_UNAUTHORIZED: ['tlsRejectUnauthorized', 'bool'],
      TIMEOUT_MS: ['timeoutMs', 'int'],
    },
  },
  {
    type: 'github',
    prefix: 'SSO_GITHUB_',
    defaultName: 'GitHub',
    trigger: 'CLIENT_ID',
    fields: {
      HOST: ['host', 'string'],
      CLIENT_ID: ['clientId', 'string'],
      CLIENT_SECRET: ['clientSecret', 'raw'],
      ALLOW_LOGIN: ['allowLogin', 'bool'],
      ALLOWED_ORGANIZATIONS: ['allowedOrganizations', 'list'],
    },
  },
  {
    type: 'gitlab',
    prefix: 'SSO_GITLAB_',
    defaultName: 'GitLab',
    trigger: 'CLIENT_ID',
    fields: {
      HOST: ['host', 'string'],
      CLIENT_ID: ['clientId', 'string'],
      CLIENT_SECRET: ['clientSecret', 'raw'],
      ALLOW_LOGIN: ['allowLogin', 'bool'],
      ALLOWED_GROUPS: ['allowedGroups', 'list'],
    },
  },
];

function readField(env: Env, k: string, kind: FieldKind): unknown {
  switch (kind) {
    case 'bool':
      return bool(env, k);
    case 'int':
      return int(env, k);
    case 'list':
      return list(env, k);
    case 'raw':
      return raw(env, k);
    default:
      return str(env, k);
  }
}

function authProviders(env: Env): ProvisionedAuthProvider[] {
  const out: ProvisionedAuthProvider[] = [];
  const fromJson = json(env, 'SSO_PROVIDERS');
  if (fromJson !== undefined) out.push(...check(z.array(UpsertAuthProviderSchema), fromJson, 'SSO_PROVIDERS'));
  for (const spec of PROVIDER_SPECS) {
    if (!str(env, spec.prefix + spec.trigger)) continue;
    const config = defined(Object.fromEntries(Object.entries(spec.fields).map(([suffix, [key, kind]]) => [key, readField(env, spec.prefix + suffix, kind)])));
    out.push(
      check(
        UpsertAuthProviderSchema,
        {
          type: spec.type,
          name: str(env, `${spec.prefix}NAME`) ?? spec.defaultName,
          enabled: bool(env, `${spec.prefix}ENABLED`) ?? true,
          autoProvision: bool(env, `${spec.prefix}AUTO_PROVISION`) ?? true,
          config,
        },
        `${spec.prefix}*`,
      ),
    );
  }
  const names = new Set<string>();
  for (const p of out) {
    if (names.has(p.name)) throw new ProvisioningError(`Fournisseur d'identité déclaré deux fois : « ${p.name} » (changez SSO_<TYPE>_NAME)`);
    names.add(p.name);
  }
  return out;
}

/* ------------------------------ Forges Git ------------------------------ */

const FORGE_SPECS: Array<{ prefix: string; saas: GitProviderKind; selfHosted: GitProviderKind; saasHost: string; defaultName: string }> = [
  { prefix: 'GIT_GITHUB_', saas: 'github', selfHosted: 'github_enterprise', saasHost: 'github.com', defaultName: 'GitHub' },
  { prefix: 'GIT_GITLAB_', saas: 'gitlab', selfHosted: 'gitlab_self_managed', saasHost: 'gitlab.com', defaultName: 'GitLab' },
];

function gitForges(env: Env): UpsertGitForge[] {
  const out: UpsertGitForge[] = [];
  const fromJson = json(env, 'GIT_FORGES');
  if (fromJson !== undefined) out.push(...check(z.array(UpsertGitForgeSchema), fromJson, 'GIT_FORGES'));
  for (const f of FORGE_SPECS) {
    const clientId = str(env, `${f.prefix}CLIENT_ID`);
    if (!clientId) continue;
    const host = (str(env, `${f.prefix}HOST`) ?? f.saasHost).replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
    const saas = host === f.saasHost;
    out.push(
      check(
        UpsertGitForgeSchema,
        defined({
          provider: saas ? f.saas : f.selfHosted,
          name: str(env, `${f.prefix}NAME`) ?? (saas ? f.defaultName : `${f.defaultName} (${host})`),
          host,
          clientId,
          clientSecret: raw(env, `${f.prefix}CLIENT_SECRET`),
          enabled: bool(env, `${f.prefix}ENABLED`) ?? true,
        }),
        `${f.prefix}*`,
      ),
    );
  }
  const hosts = new Set<string>();
  for (const f of out) {
    const h = f.host.toLowerCase();
    if (hosts.has(h)) throw new ProvisioningError(`Forge Git déclarée deux fois : ${h}`);
    hosts.add(h);
  }
  return out;
}

/* --------------------------------- SMTP --------------------------------- */

function smtp(env: Env): Provisioning['smtp'] {
  const host = str(env, 'SMTP_HOST');
  if (!host) return null;
  return check(
    SmtpConfigSchema,
    defined({
      host,
      port: int(env, 'SMTP_PORT') ?? 587,
      secure: bool(env, 'SMTP_SECURE'),
      username: str(env, 'SMTP_USERNAME'),
      password: raw(env, 'SMTP_PASSWORD'),
      fromAddress: str(env, 'SMTP_FROM_ADDRESS'),
      fromName: str(env, 'SMTP_FROM_NAME'),
    }),
    'SMTP_*',
  );
}

/* --------------------------- Paramètres plateforme --------------------------- */

const SECTIONS = PlatformSettingsPatchSchema.shape.section.options;

function settings(env: Env): Provisioning['settings'] {
  const out: Provisioning['settings'] = {};
  const fromJson = json(env, 'PLATFORM_SETTINGS');
  if (fromJson !== undefined) {
    const obj = check(z.partialRecord(z.enum(SECTIONS), z.record(z.string(), z.unknown())), fromJson, 'PLATFORM_SETTINGS');
    for (const [s, v] of Object.entries(obj)) if (v) out[s] = { ...v };
  }
  const put = (section: string, values: Record<string, unknown>) => {
    const d = defined(values);
    if (Object.keys(d).length) out[section] = { ...out[section], ...d };
  };
  put('auth', {
    localLoginEnabled: bool(env, 'AUTH_LOCAL_LOGIN_ENABLED'),
    registrationEnabled: bool(env, 'AUTH_REGISTRATION_ENABLED'),
    mfaPolicy: str(env, 'AUTH_MFA_POLICY'),
  });
  put('git', {
    allowPersonalTokens: bool(env, 'GIT_ALLOW_PERSONAL_TOKENS'),
    insecureHttpHosts: list(env, 'GIT_INSECURE_HTTP_HOSTS'),
    coAuthorEmail: env['GIT_CO_AUTHOR_EMAIL'] !== undefined ? env['GIT_CO_AUTHOR_EMAIL'].trim() : undefined,
  });
  return out;
}

/** Lit la configuration déclarée ; lève `ProvisioningError` (message sans secret) si elle est invalide. */
export function parseProvisioning(env: Env, litellmUrl: string): Provisioning {
  return {
    litellm: litellm(env, litellmUrl),
    authProviders: authProviders(env),
    gitForges: gitForges(env),
    smtp: smtp(env),
    settings: settings(env),
  };
}

/** Rien n'est déclaré (hors découverte des modèles, active par défaut). */
export function isEmpty(p: Provisioning): boolean {
  return (
    !p.litellm.connection &&
    !p.litellm.models.length &&
    !p.litellm.defaultModel &&
    !p.litellm.titleModel &&
    p.litellm.enable !== '*' &&
    !p.litellm.enable.length &&
    !p.authProviders.length &&
    !p.gitForges.length &&
    !p.smtp &&
    !Object.keys(p.settings).length
  );
}
