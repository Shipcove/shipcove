/**
 * Configuration de Pi générée par la plateforme à chaque démarrage de sandbox.
 * Un seul provider, `platform`, pointant vers la gateway LLM : tous les appels passent par LiteLLM
 * via la gateway (réservation de crédits). La clé est le jeton de run (variable d'environnement).
 */
export interface PiModelConfig {
  /** Nom du modèle côté LiteLLM. */
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
}

export const PI_PROVIDER = 'platform';
export const PI_TOKEN_ENV = 'CAP_LLM_TOKEN';

export function buildModelsJson(gatewayBaseUrl: string, models: PiModelConfig[]): string {
  return JSON.stringify(
    {
      providers: {
        [PI_PROVIDER]: {
          baseUrl: gatewayBaseUrl,
          api: 'openai-completions',
          apiKey: PI_TOKEN_ENV,
          compat: { supportsDeveloperRole: false },
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            input: m.input,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            // Coûts gérés par la plateforme (crédits) : non calculés par Pi.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    },
    null,
    2,
  );
}

export function buildSettingsJson(defaultModel: string): string {
  return JSON.stringify(
    {
      defaultProvider: PI_PROVIDER,
      defaultModel,
      enableInstallTelemetry: false,
      // Les retries de transport sont limités : la gateway ne rejoue pas d'appel facturable.
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000, provider: { maxRetries: 0, timeoutMs: 600_000 } },
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      sessionDir: '/workspace-state/pi-sessions',
    },
    null,
    2,
  );
}

/** Outils autorisés en mode Plan : lecture seule (aucune écriture, aucun shell, aucun outil plateforme/MCP). */
export const PLAN_MODE_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

export const PLAN_MODE_PROMPT =
  'MODE PLAN : tu ne peux ni modifier de fichier ni exécuter de commande. Explore le code avec les outils de lecture, ' +
  'puis rédige un plan d’implémentation précis et ordonné (fichiers concernés, changements, tests, risques). ' +
  'L’utilisateur repassera en mode autonome pour exécuter le plan.';

/** Ligne de commande de Pi en mode RPC dans la sandbox. */
/** Plugins Pi livrés dans l'image de sandbox, chargés s'ils sont présents (images plus anciennes). */
export const PI_PLUGINS = ['/opt/cap/pi-extension/browser.ts'] as const;

export function piCommand(opts: { sessionFile: string | null; skillDirs: string[]; tools?: readonly string[]; appendSystemPrompt?: string; plugins?: readonly string[] }): string[] {
  return [
    'pi',
    '--mode',
    'rpc',
    '--session-dir',
    '/workspace-state/pi-sessions',
    ...(opts.sessionFile ? ['--session', opts.sessionFile] : []),
    '--extension',
    '/opt/cap/pi-extension/index.ts',
    ...(opts.plugins ?? []).flatMap((p) => ['--extension', p]),
    ...opts.skillDirs.flatMap((d) => ['--skill', d]),
    // Liste blanche appliquée par Pi à tous les outils (intégrés, extension, MCP).
    ...(opts.tools ? ['--tools', opts.tools.join(',')] : []),
    ...(opts.appendSystemPrompt ? ['--append-system-prompt', opts.appendSystemPrompt] : []),
  ];
}
