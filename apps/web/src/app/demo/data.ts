import type {
  AdminModelDto,
  AdminOverviewDto,
  AdminUserDto,
  ApprovalDto,
  AuditEventDto,
  GitConnectionDto,
  GitForgeAdminDto,
  McpServerDto,
  MeResponse,
  MessageDto,
  ModelDto,
  NotificationDto,
  NotificationPreferenceDto,
  RemoteRepositoryDto,
  RepositoryDto,
  RunDto,
  ServiceCatalogDto,
  SkillCategoryDto,
  SkillDto,
  ToolCallDto,
  UsageBreakdownDto,
  UsageRequestDto,
  WorkspaceDto,
} from '@cap/contracts';
import { lang } from '../core/i18n';

/** Données fictives de la démonstration, dans la langue de l'interface. */
export const L = (fr: string, en: string): string => (lang === 'fr' ? fr : en);

const now = Date.now();
/** Date ISO il y a `min` minutes. */
export const ago = (min: number): string => new Date(now - min * 60_000).toISOString();

export const ME: MeResponse = {
  id: 'u-camille',
  email: 'camille.martin@example.com',
  username: 'camille',
  displayName: 'Camille Martin',
  platformRole: 'platform_admin',
  emailVerified: true,
  mfaEnabled: true,
  createdAt: ago(60 * 24 * 90),
};

export const MODELS: ModelDto[] = [
  { id: 'm-sonnet', litellmModel: 'claude-sonnet', displayName: 'Claude Sonnet', provider: 'anthropic', contextWindow: 200_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, enabled: true, isDefault: true, available: true, coefficients: { version: 2, input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75', effectiveFrom: ago(60 * 24 * 30) } },
  { id: 'm-opus', litellmModel: 'claude-opus', displayName: 'Claude Opus', provider: 'anthropic', contextWindow: 200_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, enabled: true, isDefault: false, available: true, coefficients: { version: 1, input: '15', output: '75', cacheRead: '1.5', cacheWrite: '18.75', effectiveFrom: ago(60 * 24 * 30) } },
  { id: 'm-qwen', litellmModel: 'qwen-coder', displayName: 'Qwen Coder (local)', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 16_000, supportsImages: false, supportsReasoning: false, enabled: true, isDefault: false, available: true, coefficients: { version: 1, input: '0.2', output: '0.6', cacheRead: '0', cacheWrite: '0', effectiveFrom: ago(60 * 24 * 30) } },
];

export const ADMIN_MODELS: AdminModelDto[] = [
  ...MODELS.map((m) => ({ ...m, allowedUsers: [], lastSyncAt: ago(7), lastSyncError: null })),
  { id: 'm-gpt', litellmModel: 'gpt-4.1', displayName: 'GPT-4.1', provider: 'openai', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: false, enabled: false, isDefault: false, available: true, coefficients: { version: 1, input: '2', output: '8', cacheRead: '0.5', cacheWrite: '0', effectiveFrom: ago(60 * 24 * 3) }, allowedUsers: [{ id: 'u-samir', displayName: 'Samir Haddad', username: 'samir' }], lastSyncAt: ago(7), lastSyncError: null },
];

const repo = (name: string): RepositoryDto => ({
  id: `r-${name}`,
  provider: 'github',
  host: 'github.com',
  fullName: `acme/${name}`,
  cloneUrl: `https://github.com/acme/${name}.git`,
  defaultBranch: 'main',
  webUrl: `https://github.com/acme/${name}`,
});

export const REMOTE_REPOS: RemoteRepositoryDto[] = ['landing', 'shop-api', 'design-system', 'mobile-app'].map((n) => ({
  fullName: `acme/${n}`,
  defaultBranch: 'main',
  private: n !== 'design-system',
  webUrl: `https://github.com/acme/${n}`,
  description: null,
}));

export function repository(fullName: string): RepositoryDto {
  return repo(fullName.replace(/^acme\//, ''));
}

const ws = (id: string, name: string, r: RepositoryDto | null, branch: string | null, minutes: number, extra: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id,
  ownerId: ME.id,
  name,
  titleSource: 'auto',
  repository: r,
  status: 'ready',
  syncState: 'synced',
  branch,
  modelId: 'm-sonnet',
  thinkingLevel: 'medium',
  agentMode: 'autonomous',
  conversationId: `c-${id}`,
  activeRunId: null,
  activeRunStatus: null,
  lastActivityAt: ago(minutes),
  lastCheckpointAt: ago(minutes),
  createdAt: ago(minutes + 30),
  archivedAt: null,
  access: 'owner',
  ...extra,
});

/* ------------------------------ Conversations ------------------------------ */

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

export function message(conversationId: string, role: MessageDto['role'], text: string, at: string, extra: Partial<MessageDto> = {}): MessageDto {
  return { id: id('msg'), conversationId, runId: null, role, authorId: role === 'user' ? ME.id : null, text, thinking: null, attachments: [], toolCalls: [], model: role === 'assistant' ? 'Claude Sonnet' : null, stopReason: role === 'assistant' ? 'stop' : null, meta: null, createdAt: at, completedAt: at, ...extra };
}

export function tool(runId: string, toolName: string, args: unknown, output: string, at: string, extra: Partial<ToolCallDto> = {}): ToolCallDto {
  return { id: id('tool'), runId, messageId: null, toolName, args, status: 'completed', output, outputTruncated: false, isError: false, filesTouched: [], images: [], files: [], details: null, startedAt: at, completedAt: at, durationMs: 1800, ...extra };
}

/** Appel `subagent` terminé (sous-agents d'exploration), avec ses détails pour l'interface. */
function subagents(runId: string, at: string, agents: Array<{ title: string; steps: Array<[string, string]>; output: string }>): ToolCallDto {
  const end = Date.parse(at);
  const details = {
    kind: 'subagents',
    agents: agents.map((a, i) => ({
      title: a.title,
      mode: 'explore',
      status: 'completed',
      steps: a.steps.map(([tool, summary]) => ({ tool, summary, status: 'completed' })),
      toolCount: a.steps.length,
      output: a.output,
      error: null,
      startedAt: end - 38_000 - i * 9_000,
      endedAt: end - i * 4_000,
      tokens: 14_000 + i * 3_000,
    })),
  };
  const tasks = agents.map((a) => ({ title: a.title, prompt: a.title, mode: 'explore' }));
  return tool(runId, 'subagent', { tasks }, agents.map((a, i) => `## Sous-agent ${i + 1} — ${a.title}\n\n${a.output}`).join('\n\n'), at, { details, durationMs: 38_000 });
}

export function run(workspaceId: string, runId: string, startedAt: string, endedAt: string): RunDto {
  return { id: runId, workspaceId, status: 'completed', modelId: 'm-sonnet', modelName: 'Claude Sonnet', agentMode: 'autonomous', startedAt, endedAt, error: null, pausedReason: null };
}

export const plan = (steps: Array<[string, 'pending' | 'in_progress' | 'completed']>) => ({ items: steps.map(([content, status]) => ({ content, status })) });

/* Fichiers de la landing page (dépôt acme/landing). */
const CSS_BEFORE = `:root {
  --bg: #ffffff;
  --text: #1c1917;
  --accent: #ea580c;
}

body {
  margin: 0;
  font-family: Inter, system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}

.hero {
  padding: 6rem 1.5rem;
  text-align: center;
}

.button {
  background: var(--accent);
  color: #fff;
  border-radius: 0.5rem;
  padding: 0.75rem 1.5rem;
}
`;

const CSS_AFTER = CSS_BEFORE.replace(
  '--accent: #ea580c;\n}',
  `--accent: #ea580c;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09;
    --text: #f5f5f4;
    --accent: #fb923c;
  }
}

:root[data-theme='dark'] {
  --bg: #0c0a09;
  --text: #f5f5f4;
  --accent: #fb923c;
}`,
);

const HTML_BEFORE = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <title>Acme</title>
  <link rel="stylesheet" href="src/styles.css" />
</head>
<body>
  <section class="hero">
    <h1>${L('Livrez plus vite avec Acme', 'Ship faster with Acme')}</h1>
    <a class="button" href="/signup">${L('Commencer', 'Get started')}</a>
  </section>
</body>
</html>
`;

const HTML_AFTER = HTML_BEFORE.replace(
  '</section>',
  `  <button class="theme-toggle" aria-label="${L('Changer de thème', 'Toggle theme')}">◐</button>
  </section>
  <script src="src/theme.js"></script>`,
);

const THEME_JS = `// ${L('Bascule clair / sombre, mémorisée', 'Light / dark toggle, remembered')}
const root = document.documentElement;
const saved = localStorage.getItem('theme');
if (saved) root.dataset.theme = saved;
document.querySelector('.theme-toggle')?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('theme', next);
});
`;

export interface DemoWorkspace {
  ws: WorkspaceDto;
  messages: MessageDto[];
  runs: RunDto[];
  approvals: ApprovalDto[];
  /** Fichiers au dernier commit (base du git diff). */
  base: Record<string, string>;
  /** Fichiers actuels de la sandbox. */
  files: Record<string, string>;
  branches: string[];
}

function landing(): DemoWorkspace {
  const w = ws('w-landing', L('Mode sombre de la landing page', 'Dark mode for the landing page'), repo('landing'), 'feat/dark-mode', 35, { status: 'running' });
  const c = w.conversationId;
  const r1 = 'run-landing-1';
  const t0 = 95;
  const user = message(c, 'user', L('Ajoute un mode sombre à la landing page, avec un bouton pour basculer. Respecte la préférence du système.', 'Add a dark mode to the landing page, with a toggle button. Respect the system preference.'), ago(t0), { runId: r1 });
  const setup = message(c, 'system', L('Environnement préparé (6 s)', 'Environment ready (6 s)'), ago(t0 - 0.2), { runId: r1, meta: { kind: 'setup', status: 'succeeded', durationMs: 6000, output: 'npm config set registry https://npm.example.com\n+ npm ci\nadded 312 packages in 5s' } });
  const branch = message(c, 'system', L('Branche de travail : main → feat/dark-mode', 'Working branch: main → feat/dark-mode'), ago(t0 - 0.5), { runId: r1, meta: { kind: 'branch_switched', from: 'main', to: 'feat/dark-mode' } });
  const steps = [L('Lire la feuille de style et la page', 'Read the stylesheet and the page'), L('Ajouter les couleurs du thème sombre', 'Add the dark theme colors'), L('Ajouter le bouton de bascule', 'Add the toggle button'), L('Vérifier le rendu dans le navigateur', 'Check the rendering in the browser')];
  const pushTool = tool(r1, 'platform_git_push', { local_branch: 'feat/dark-mode' }, L('Branche feat/dark-mode publiée sur origin.', 'Branch feat/dark-mode pushed to origin.'), ago(t0 - 6));
  const answer = message(c, 'assistant', L(
    `Le mode sombre est en place :

- **\`src/styles.css\`** : couleurs du thème sombre, appliquées selon la préférence du système (\`prefers-color-scheme\`) ou le choix de l'utilisateur ;
- **\`index.html\`** et **\`src/theme.js\`** : un bouton ◐ bascule le thème, et le choix est mémorisé.

J'ai vérifié le rendu dans le navigateur (capture ci-dessus) et publié la branche \`feat/dark-mode\`. Voulez-vous que j'ouvre la pull request ?`,
    `Dark mode is in place:

- **\`src/styles.css\`**: dark theme colors, applied from the system preference (\`prefers-color-scheme\`) or the user's choice;
- **\`index.html\`** and **\`src/theme.js\`**: a ◐ button toggles the theme, and the choice is remembered.

I checked the rendering in the browser (screenshot above) and pushed the \`feat/dark-mode\` branch. Shall I open the pull request?`,
  ), ago(t0 - 7), { runId: r1 });
  const work = message(c, 'assistant', '', ago(t0 - 1), {
    runId: r1,
    stopReason: 'tool_use',
    thinking: L("L'utilisateur veut un thème sombre qui suit le système, avec une bascule manuelle. Je commence par lire les styles existants : s'ils utilisent des variables CSS, il suffit de les redéfinir.", 'The user wants a dark theme that follows the system, with a manual toggle. I will start by reading the existing styles: if they use CSS variables, redefining them is enough.'),
    toolCalls: [
      tool(r1, 'update_plan', plan(steps.map((s, i) => [s, i === 0 ? 'in_progress' : 'pending'])), 'ok', ago(t0 - 1)),
      tool(r1, 'read', { path: 'src/styles.css' }, CSS_BEFORE, ago(t0 - 1.2)),
      tool(r1, 'edit', { path: 'src/styles.css' }, L('1 remplacement', '1 replacement'), ago(t0 - 2), { filesTouched: ['src/styles.css'] }),
      tool(r1, 'write', { path: 'src/theme.js' }, L('Fichier écrit (11 lignes)', 'File written (11 lines)'), ago(t0 - 2.5), { filesTouched: ['src/theme.js'] }),
      tool(r1, 'edit', { path: 'index.html' }, L('1 remplacement', '1 replacement'), ago(t0 - 3), { filesTouched: ['index.html'] }),
      tool(r1, 'bash', { command: 'npm test' }, '> landing@1.4.0 test\n> vitest run\n\n ✓ tests/theme.test.js (3 tests) 41ms\n ✓ tests/page.test.js (5 tests) 63ms\n\n Test Files  2 passed (2)\n      Tests  8 passed (8)', ago(t0 - 4)),
      tool(r1, 'browser_screenshot', { url: 'http://localhost:5173' }, L('Capture enregistrée', 'Screenshot saved'), ago(t0 - 5), { images: [{ attachmentId: L('landing-dark.png', 'landing-dark-en.png'), fileName: 'landing-dark.png', width: 1280, height: 800 }] }),
      tool(r1, 'update_plan', plan(steps.map((s) => [s, 'completed'])), 'ok', ago(t0 - 5.5)),
      pushTool,
    ],
  });
  const approvals: ApprovalDto[] = [
    {
      id: 'appr-1', workspaceId: w.id, action: 'push', status: 'consumed', requestedBy: 'agent', toolCallId: pushTool.id, repository: 'acme/landing', target: 'feat/dark-mode', commitSha: '4f2a9c1',
      commits: [{ sha: '4f2a9c1', subject: L('feat: mode sombre et bouton de bascule', 'feat: dark mode and theme toggle'), author: 'Shipcove' }],
      diffStat: ' index.html     |  3 ++-\n src/styles.css | 15 +++++++++++++++\n src/theme.js   | 11 +++++++++++\n 3 files changed, 28 insertions(+), 1 deletion(-)',
      patchPreview: null, title: null, body: null, expiresAt: ago(t0 - 66), decidedAt: ago(t0 - 6), decidedBy: ME.id, createdAt: ago(t0 - 6),
      operation: { id: 'op-1', status: 'succeeded', result: L('feat/dark-mode publiée (4f2a9c1)', 'feat/dark-mode pushed (4f2a9c1)') },
    },
  ];
  const files = { 'index.html': HTML_AFTER, 'src/styles.css': CSS_AFTER, 'src/theme.js': THEME_JS, 'package.json': '{\n  "name": "landing",\n  "version": "1.4.0",\n  "scripts": { "dev": "vite", "test": "vitest run" }\n}\n', 'README.md': L('# Landing page Acme\n\n`npm run dev` pour lancer le serveur de développement.\n', '# Acme landing page\n\n`npm run dev` starts the development server.\n') };
  // Le dernier commit précède le travail de Pi : le git diff montre ses changements.
  const base = { ...files, 'index.html': HTML_BEFORE, 'src/styles.css': CSS_BEFORE } as Record<string, string>;
  delete base['src/theme.js'];
  return { ws: w, messages: [user, setup, branch, work, answer], runs: [run(w.id, r1, ago(t0), ago(t0 - 7))], approvals, base, files, branches: ['main', 'feat/dark-mode'] };
}

function shopApi(): DemoWorkspace {
  const w = ws('w-shop', L('Test de paiement instable', 'Flaky payment test'), repo('shop-api'), 'main', 60 * 26);
  const c = w.conversationId;
  const r1 = 'run-shop-1';
  const t0 = 60 * 26 + 20;
  const user = message(c, 'user', L('Le test `checkout.test.ts` échoue une fois sur dix en CI. Trouve pourquoi.', 'The `checkout.test.ts` test fails one time in ten in CI. Find out why.'), ago(t0), { runId: r1 });
  const assistant = message(c, 'assistant', L(
    "Le test dépendait de l'heure courante : la remise « happy hour » s'appliquait si le test tournait entre 18 h et 19 h. J'ai figé l'horloge avec `vi.setSystemTime` dans `checkout.test.ts`. Les 200 exécutions d'affilée passent.",
    'The test depended on the current time: the "happy hour" discount applied when the test ran between 6 and 7 pm. I froze the clock with `vi.setSystemTime` in `checkout.test.ts`. 200 runs in a row pass.',
  ), ago(t0 - 9), { runId: r1 });
  const work = message(c, 'assistant', '', ago(t0 - 1), {
    runId: r1,
    stopReason: 'tool_use',
    toolCalls: [
      subagents(r1, ago(t0 - 1.5), [
        {
          title: L('Repérer les dépendances au temps', 'Find time dependencies'),
          steps: [['grep', 'new Date\\(|Date.now'], ['read', 'src/pricing.ts'], ['grep', 'getHours']],
          output: L(
            "`src/pricing.ts` : `discount()` lit `new Date()` et applique 10 % de remise quand `getHours() === 18`. Aucun test ne fige l'horloge. Autres usages de la date : `src/orders.ts` (horodatage seulement, sans effet sur les totaux).",
            '`src/pricing.ts`: `discount()` reads `new Date()` and applies a 10% discount when `getHours() === 18`. No test freezes the clock. Other date uses: `src/orders.ts` (timestamps only, no effect on totals).',
          ),
        },
        {
          title: L('Lire le test et la config CI', 'Read the test and CI config'),
          steps: [['read', 'tests/checkout.test.ts'], ['find', '.github/workflows'], ['read', '.github/workflows/ci.yml']],
          output: L(
            "`checkout.test.ts` attend un total de 90 pour [50, 40], sans remise. La CI tourne sur des runners en UTC, sans `TZ` ni retry : un échec dans la tranche 18 h–19 h UTC fait échouer le job.",
            '`checkout.test.ts` expects a total of 90 for [50, 40], without discount. CI runs on UTC runners, without `TZ` or retries: a failure in the 6–7 pm UTC window fails the job.',
          ),
        },
      ]),
      tool(r1, 'bash', { command: 'npx vitest run checkout --repeat 50' }, ' ✓ checkout.test.ts (49)\n ✗ checkout.test.ts > applies the right total (1)\n   AssertionError: expected 81 to be 90', ago(t0 - 2), { isError: true, status: 'failed' }),
      tool(r1, 'read', { path: 'src/pricing.ts' }, 'export function discount(now = new Date()) {\n  return now.getHours() === 18 ? 0.1 : 0;\n}', ago(t0 - 3)),
      tool(r1, 'edit', { path: 'tests/checkout.test.ts' }, L('1 remplacement', '1 replacement'), ago(t0 - 5), { filesTouched: ['tests/checkout.test.ts'] }),
      tool(r1, 'bash', { command: 'npx vitest run checkout --repeat 200' }, ' ✓ checkout.test.ts (200)\n\n Test Files  1 passed (1)\n      Tests  200 passed (200)', ago(t0 - 8)),
    ],
  });
  const files = { 'src/pricing.ts': 'export function discount(now = new Date()) {\n  return now.getHours() === 18 ? 0.1 : 0;\n}\n', 'tests/checkout.test.ts': "import { vi, test, expect } from 'vitest';\n\nvi.setSystemTime(new Date('2026-01-15T10:00:00Z'));\n\ntest('applies the right total', () => {\n  expect(total([50, 40])).toBe(90);\n});\n", 'package.json': '{\n  "name": "shop-api",\n  "scripts": { "test": "vitest run" }\n}\n' };
  return { ws: w, messages: [user, work, assistant], runs: [run(w.id, r1, ago(t0), ago(t0 - 9))], approvals: [], base: { ...files }, files, branches: ['main', 'fix/flaky-checkout'] };
}

function sketch(): DemoWorkspace {
  const w = ws('w-sketch', L('Idées pour un script de sauvegarde', 'Ideas for a backup script'), null, null, 60 * 24 * 4, { status: 'ready' });
  const c = w.conversationId;
  const r1 = 'run-sketch-1';
  const t0 = 60 * 24 * 4 + 15;
  const user = message(c, 'user', L('Écris un petit script bash qui sauvegarde un dossier dans une archive datée, et garde les 7 dernières.', 'Write a small bash script that backs up a folder into a dated archive and keeps the last 7.'), ago(t0), { runId: r1 });
  const assistant = message(c, 'assistant', L('Voici `backup.sh`, téléchargeable ci-dessus. Usage : `./backup.sh ~/projets /mnt/sauvegardes`.', 'Here is `backup.sh`, ready to download above. Usage: `./backup.sh ~/projects /mnt/backups`.'), ago(t0 - 3), { runId: r1 });
  const work = message(c, 'assistant', '', ago(t0 - 1), {
    runId: r1,
    stopReason: 'tool_use',
    toolCalls: [
      tool(r1, 'write', { path: 'backup.sh' }, L('Fichier écrit (14 lignes)', 'File written (14 lines)'), ago(t0 - 1), { filesTouched: ['backup.sh'] }),
      tool(r1, 'bash', { command: 'bash -n backup.sh && shellcheck backup.sh' }, '', ago(t0 - 2)),
      tool(r1, 'share_files', { paths: ['backup.sh'] }, L('1 fichier proposé au téléchargement', '1 file offered for download'), ago(t0 - 2.5), { files: [{ attachmentId: 'backup.sh', fileName: 'backup.sh', path: 'backup.sh', size: 412, kind: 'text' }] }),
    ],
  });
  const files = { 'backup.sh': BACKUP_SH };
  return { ws: w, messages: [user, work, assistant], runs: [run(w.id, r1, ago(t0), ago(t0 - 3))], approvals: [], base: {}, files, branches: [] };
}

export const BACKUP_SH = `#!/usr/bin/env bash
# ${L('Sauvegarde un dossier dans une archive datée et garde les 7 dernières.', 'Backs up a folder into a dated archive and keeps the last 7.')}
set -euo pipefail
src="\${1:?source}"
dest="\${2:?destination}"
mkdir -p "$dest"
archive="$dest/backup-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$archive" -C "$(dirname "$src")" "$(basename "$src")"
echo "$archive"
# ${L('Rotation : on garde les 7 plus récentes', 'Rotation: keep the 7 most recent')}
ls -1t "$dest"/backup-*.tar.gz | tail -n +8 | xargs -r rm --
`;

function shared(): DemoWorkspace {
  const w = ws('w-shared', L('Revue de la migration Postgres', 'Postgres migration review'), repo('shop-api'), 'main', 60 * 50, { ownerId: 'u-samir', access: 'shared_read' });
  const c = w.conversationId;
  const user = message(c, 'user', L('Relis la migration 0042 : y a-t-il un risque de verrou long ?', 'Review migration 0042: is there a risk of a long lock?'), ago(60 * 50 + 10), { authorId: 'u-samir' });
  const assistant = message(c, 'assistant', L(
    "Oui : `ALTER TABLE orders ADD COLUMN … DEFAULT now()` réécrit toute la table sous un verrou exclusif. Mieux vaut ajouter la colonne sans défaut, la remplir par lots, puis poser le défaut.",
    'Yes: `ALTER TABLE orders ADD COLUMN … DEFAULT now()` rewrites the whole table under an exclusive lock. It is better to add the column without a default, backfill it in batches, then set the default.',
  ), ago(60 * 50 + 5));
  return { ws: w, messages: [user, assistant], runs: [], approvals: [], base: {}, files: {}, branches: ['main'] };
}

export function seedWorkspaces(): DemoWorkspace[] {
  return [landing(), shopApi(), sketch(), shared()];
}

/* --------------------------- Paramètres et extensions --------------------------- */

export const CATEGORIES: SkillCategoryDto[] = [
  { id: 'cat-front', name: L('Front-end', 'Front-end'), description: L('Interfaces, accessibilité, design system', 'Interfaces, accessibility, design system'), position: 0, skillCount: 2 },
  { id: 'cat-qual', name: L('Qualité', 'Quality'), description: L('Tests, revue, sécurité', 'Tests, review, security'), position: 1, skillCount: 2 },
];

const skill = (sid: string, name: string, description: string, categoryId: string | null, enabled: boolean, extra: Partial<SkillDto> = {}): SkillDto => ({
  id: sid, name, description, scope: 'global', ownerId: null, status: 'published', digest: 'sha256:9f0c', source: null, findings: [], createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24 * 2), enabledForMe: enabled, enabledByDefault: true, fileCount: 2, categoryId, canManage: true, ...extra,
});

export const SKILLS: SkillDto[] = [
  skill('sk-a11y', 'accessibility-audit', L('Vérifie une page selon le RGAA / WCAG 2.2 et propose des corrections.', 'Checks a page against WCAG 2.2 and suggests fixes.'), 'cat-front', true),
  skill('sk-ds', 'design-system', L('Utilise les composants et jetons du design system Acme.', 'Uses the Acme design system components and tokens.'), 'cat-front', true, { fileCount: 4 }),
  skill('sk-review', 'code-review', L('Relit un diff : bugs, sécurité, lisibilité, tests manquants.', 'Reviews a diff: bugs, security, readability, missing tests.'), 'cat-qual', true),
  skill('sk-tests', 'test-strategy', L('Propose un plan de tests et écrit les tests manquants.', 'Proposes a test plan and writes the missing tests.'), 'cat-qual', false),
  skill('sk-release', 'release-notes', L('Rédige les notes de version à partir des commits.', 'Writes release notes from the commits.'), null, false, { scope: 'personal', ownerId: ME.id, enabledByDefault: false, fileCount: 1 }),
];

export function skillFiles(s: SkillDto): Array<{ path: string; size: number; content: string }> {
  const md = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\n## ${L('Instructions', 'Instructions')}\n\n1. ${L('Lire le contexte de la tâche.', 'Read the task context.')}\n2. ${L('Appliquer la checklist de `references/checklist.md`.', 'Apply the checklist in `references/checklist.md`.')}\n3. ${L('Rendre compte des points vérifiés.', 'Report the points checked.')}\n`;
  const ref = `# Checklist\n\n- [ ] ${L('Point 1', 'Item 1')}\n- [ ] ${L('Point 2', 'Item 2')}\n`;
  return [
    { path: 'SKILL.md', size: md.length, content: md },
    ...(s.fileCount > 1 ? [{ path: 'references/checklist.md', size: ref.length, content: ref }] : []),
  ];
}

export const MCP: McpServerDto[] = [
  {
    id: 'mcp-linear', name: 'linear', description: L('Tickets Linear de l’équipe', 'Team Linear tickets'), scope: 'global', ownerId: null, transport: 'streamable_http', url: 'https://mcp.linear.app/mcp', command: null, args: [], secretKeys: ['Authorization'], version: '1.2.0', enabled: true, health: 'healthy', lastHealthAt: ago(3),
    tools: [
      { id: 'mt-1', name: 'list_issues', description: '', effective: 'allowed' },
      { id: 'mt-2', name: 'create_issue', description: '', effective: 'allowed' },
      { id: 'mt-3', name: 'delete_issue', description: '', effective: 'denied' },
    ],
  },
  { id: 'mcp-pw', name: 'playwright', description: L('Navigateur dans la sandbox', 'Browser in the sandbox'), scope: 'personal', ownerId: ME.id, transport: 'stdio', url: null, command: 'npx', args: ['@playwright/mcp'], secretKeys: [], version: null, enabled: true, health: 'unknown', lastHealthAt: null, tools: [{ id: 'mt-4', name: 'browser_navigate', description: '', effective: 'allowed' }] },
];

export const NOTIFICATIONS: NotificationDto[] = [
  { id: 'n1', type: 'run.completed', title: L('Tâche terminée dans « Mode sombre de la landing page »', 'Task finished in “Dark mode for the landing page”'), body: L('L’agent a terminé son exécution.', 'The agent has finished running.'), link: '/workspaces/w-landing', readAt: null, createdAt: ago(88) },
  { id: 'n2', type: 'approval.required', title: L('Approbation Git requise', 'Git approval required'), body: L('Push de feat/dark-mode vers acme/landing', 'Push feat/dark-mode to acme/landing'), link: '/workspaces/w-landing', readAt: ago(87), createdAt: ago(89) },
  { id: 'n3', type: 'security', title: L('Double authentification activée', 'Two-factor authentication enabled'), body: L('Le TOTP a été configuré sur votre compte.', 'TOTP has been set up on your account.'), link: null, readAt: ago(60 * 24 * 30), createdAt: ago(60 * 24 * 30) },
];

export const NOTIF_PREFS: NotificationPreferenceDto[] = (['run.completed', 'run.failed', 'approval.required', 'quota.reached', 'quota.available', 'checkpoint.failed', 'security'] as const).map((type) => ({ type, inApp: true, email: type === 'approval.required' || type === 'security', locked: type === 'security' }));

export const GIT_CONNECTIONS: GitConnectionDto[] = [
  { id: 'gc-1', provider: 'github', host: 'github.com', accountLogin: 'camille-acme', accountName: 'Camille Martin', scopes: ['repo'], status: 'active', createdAt: ago(60 * 24 * 60), lastUsedAt: ago(40) },
];

export const USAGE_BREAKDOWN: UsageBreakdownDto = {
  days: 7,
  byModel: [{ model: 'Claude Sonnet', requests: 412, percent: 81 }, { model: 'Qwen Coder (local)', requests: 96, percent: 12 }, { model: 'Claude Opus', requests: 9, percent: 7 }],
  byWorkspace: [{ workspaceId: 'w-landing', name: L('Mode sombre de la landing page', 'Dark mode for the landing page'), requests: 190, percent: 46 }, { workspaceId: 'w-shop', name: L('Test de paiement instable', 'Flaky payment test'), requests: 141, percent: 34 }, { workspaceId: 'w-sketch', name: L('Idées pour un script de sauvegarde', 'Ideas for a backup script'), requests: 22, percent: 20 }],
};

export const USAGE_REQUESTS: UsageRequestDto[] = Array.from({ length: 12 }, (_, i) => ({ id: `req-${i}`, workspaceId: 'w-landing', runId: 'run-landing-1', model: i % 4 === 3 ? 'qwen-coder' : 'claude-sonnet', status: i === 5 ? 'failed' : 'completed', latencyMs: 900 + ((i * 397) % 2400), createdAt: ago(88 + i * 3) }));

/* ---------------------------------- Admin ---------------------------------- */

export const ADMIN_USERS: AdminUserDto[] = [
  { id: ME.id, email: ME.email, username: ME.username, displayName: ME.displayName, platformRole: 'platform_admin', status: 'active', mfaEnabled: true, lastLoginAt: ago(5), createdAt: ME.createdAt, identities: [{ provider: 'Keycloak', subject: 'b81c' }] },
  { id: 'u-samir', email: 'samir.haddad@example.com', username: 'samir', displayName: 'Samir Haddad', platformRole: 'user', status: 'active', mfaEnabled: true, lastLoginAt: ago(60 * 3), createdAt: ago(60 * 24 * 80), identities: [{ provider: 'Keycloak', subject: 'c02f' }] },
  { id: 'u-lea', email: 'lea.dubois@example.com', username: 'lea', displayName: 'Léa Dubois', platformRole: 'user', status: 'active', mfaEnabled: false, lastLoginAt: ago(60 * 24), createdAt: ago(60 * 24 * 40), identities: [] },
  { id: 'u-tom', email: 'tom.nguyen@example.com', username: 'tom', displayName: 'Tom Nguyen', platformRole: 'user', status: 'suspended', mfaEnabled: false, lastLoginAt: ago(60 * 24 * 20), createdAt: ago(60 * 24 * 70), identities: [] },
];

export const OVERVIEW: AdminOverviewDto = {
  users: { total: 4, active: 3, suspended: 1 },
  repositories: 6,
  workspaces: { total: 23, running: 2 },
  sandboxes: { active: 2 },
  llm: { requests24h: 1284, errors24h: 7, credits24h: '18452.5', costUsd24h: '18.45', p95LatencyMs: 4200 },
  checkpoints: { failed24h: 0, unsyncedWorkspaces: 0 },
  jobs: { pending: 1, failed: 0 },
  health: { database: { status: 'up', detail: 'PostgreSQL 17' }, vault: { status: 'up', detail: 'v1.20' }, storage: { status: 'up', detail: 'Garage S3' }, litellm: { status: 'up', detail: L('4 modèles', '4 models') }, smtp: { status: 'up' } },
};

export const FORGES: GitForgeAdminDto[] = [
  { id: 'gf-1', provider: 'github', name: 'GitHub', host: 'github.com', clientId: 'Iv1.8a61f9b3a7aba766', enabled: true, secretConfigured: true, callbackUrl: 'https://shipcove.example.com/api/v1/me/git-connections/oauth/gf-1/callback', scopes: ['repo', 'read:user'], connections: 3, lastTestAt: ago(60 * 24), lastTestResult: L('OK : application OAuth joignable', 'OK: OAuth application reachable') },
  { id: 'gf-2', provider: 'gitlab_self_managed', name: L('GitLab interne', 'Internal GitLab'), host: 'gitlab.example.com', clientId: '6f1d…', enabled: true, secretConfigured: true, callbackUrl: 'https://shipcove.example.com/api/v1/me/git-connections/oauth/gf-2/callback', scopes: ['api', 'read_user'], connections: 1, lastTestAt: null, lastTestResult: null },
];

export const SERVICES: ServiceCatalogDto[] = [
  { id: 'svc-pg', key: 'postgres', name: 'PostgreSQL 17', image: 'postgres:17-alpine', port: 5432, healthCommand: ['pg_isready', '-h', '127.0.0.1'], defaultEnv: { POSTGRES_PASSWORD: 'postgres' }, defaultMemoryMb: 512, maxMemoryMb: 2048, enabled: true },
  { id: 'svc-redis', key: 'redis', name: 'Redis 7', image: 'redis:7.4-alpine', port: 6379, healthCommand: ['redis-cli', 'ping'], defaultEnv: {}, defaultMemoryMb: 256, maxMemoryMb: 1024, enabled: true },
  { id: 'svc-mongo', key: 'mongodb', name: 'MongoDB 8', image: 'mongo:8.0.4', port: 27017, healthCommand: [], defaultEnv: {}, defaultMemoryMb: 512, maxMemoryMb: 2048, enabled: false },
];

export const AUDIT: AuditEventDto[] = [
  ['git.push', 'workspace', 'w-landing', 'success', 6],
  ['git.approval.approve', 'approval', 'appr-1', 'success', 7],
  ['workspace.create', 'workspace', 'w-landing', 'success', 96],
  ['auth.login', 'user', ME.id, 'success', 100],
  ['auth.login', 'user', 'u-tom', 'failure', 60 * 24],
  ['admin.settings.update', 'settings', 'sandbox', 'success', 60 * 30],
].map(([action, targetType, targetId, outcome, min], i) => ({ id: `ae-${i}`, occurredAt: ago(min as number), actorId: ME.id, actorLabel: ME.displayName, action: action as string, targetType: targetType as string, targetId: targetId as string, outcome: outcome as 'success' | 'failure', ip: '10.0.4.21', metadata: {} }));
