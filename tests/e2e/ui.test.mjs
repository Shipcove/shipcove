// Tests d'interface (Playwright) sur la pile Compose réelle.
// Navigateur : CHROMIUM_PATH (défaut /usr/bin/chromium) ou le Chromium de Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { BASE, adminClient, uid } from './client.mjs';

const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const OUT = new URL('./artifacts/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

/** Collecte les violations CSP et erreurs JavaScript d'une page. */
function watch(page) {
  const issues = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content[- ]Security[- ]Policy|CSP/i.test(m.text())) issues.push(m.text());
  });
  page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));
  return issues;
}

test('interface : CSP stricte respectée, connexion, conversation Pi et panneau Modifications', async () => {
  // Préparation via l'API : utilisateur, équipe, projet, workspace.
  const admin = await adminClient(state);
  const models = await admin.get('/admin/models');
  assert.ok(models.body.some((m) => m.isDefault), 'modèle par défaut requis (lancer stack.test.mjs d’abord)');
  const slug = `ui-${uid()}`;
  const team = await admin.post('/teams', { name: `UI ${slug}`, slug });
  const username = `ui${uid()}`;
  const password = 'Ui-Password-123456';
  const user = await admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `UI ${username}`, platformRole: 'user', password });
  await admin.post(`/teams/${team.body.id}/members`, { userId: user.body.id, role: 'member' });

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const issues = watch(page);

    await page.goto(`${BASE}/auth/login`, { waitUntil: 'networkidle' });
    await page.fill('#login', username);
    await page.fill('#password', password);
    await page.click('button:has-text("Se connecter")');
    await page.waitForURL(`${BASE}/`);

    // Projet vierge puis workspace, via l'interface.
    await page.goto(`${BASE}/projects`);
    await page.click('button:has-text("Nouveau projet")');
    await page.selectOption('#pt', team.body.id);
    await page.fill('#pn', `Projet UI ${slug}`);
    await page.click('form button:has-text("Créer")');
    await page.waitForURL(/\/projects\/[0-9a-f-]+$/);
    await page.fill('#wn', 'Workspace UI');
    await page.click('form button:has-text("Créer")');
    await page.waitForURL(/\/workspaces\/[0-9a-f-]+$/);

    // Message à Pi (fournisseur factice piloté par directives).
    await page.fill('textarea[aria-label="Message"]', 'Crée un fichier. [[tool:bash {"command":"mkdir -p app && printf \'console.log(1)\\n\' > app/main.js"}]]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=Terminé : 1 action(s) exécutée(s).', { timeout: 240_000 });
    await page.waitForSelector('cap-tool-card');

    // Panneau Modifications : le fichier apparaît, le diff s'ouvre dans Monaco.
    await page.waitForSelector('cap-changes-panel button:has-text("main.js")', { timeout: 30_000 });
    await page.click('cap-changes-panel button:has-text("main.js")');
    await page.waitForSelector('cap-diff-editor .monaco-diff-editor', { timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: new URL('workspace-diff.png', OUT).pathname });

    // Un très long mot sans espace ne doit pas faire déborder la conversation.
    const longWord = 'sfghfghd'.repeat(80);
    await page.fill('textarea[aria-label="Message"]', longWord);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`text=Réponse factice`, { timeout: 120_000 });
    const overflow = await page.evaluate(() => {
      const col = document.querySelector('cap-conversation > div');
      return { scroll: col.scrollWidth, client: col.clientWidth, wider: [...col.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > col.getBoundingClientRect().right + 1).length };
    });
    assert.ok(overflow.scroll <= overflow.client && overflow.wider === 0, `débordement horizontal : ${JSON.stringify(overflow)}`);
    await page.screenshot({ path: new URL('long-text.png', OUT).pathname });

    assert.deepEqual(issues, [], `erreurs/violations CSP :\n${issues.join('\n')}`);
  } finally {
    await browser.close();
  }
});
