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
  const mock = models.body.find((m) => m.isDefault);
  assert.ok(mock, 'modèle par défaut requis (lancer stack.test.mjs d’abord)');
  // Le modèle factice est déclaré « avec raisonnement » pour exercer le réglage d'effort.
  if (!mock.supportsReasoning) {
    const r = await admin.put(`/admin/models/${mock.id}`, {
      litellmModel: mock.litellmModel,
      displayName: mock.displayName,
      litellmParams: mock.litellmParams,
      contextWindow: mock.contextWindow,
      maxOutputTokens: mock.maxOutputTokens,
      supportsImages: mock.supportsImages,
      supportsReasoning: true,
      enabled: true,
      isDefault: true,
      allowedTeamIds: mock.allowedTeamIds,
      coefficients: { input: mock.coefficients.input, output: mock.coefficients.output, cacheRead: mock.coefficients.cacheRead, cacheWrite: mock.coefficients.cacheWrite },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
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

    // Alignement vertical du « + », de l'input et du bouton d'envoi ; pas de dictée vocale.
    await page.waitForSelector('button[aria-label="Envoyer"]', { timeout: 30_000 });
    const centers = await page.evaluate(() => {
      const c = (el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      return [c(document.querySelector('button[aria-label="Ajouter"]')), c(document.querySelector('textarea[aria-label="Message"]')), c(document.querySelector('button[aria-label="Envoyer"]'))];
    });
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, `alignement : ${centers.join(', ')}`);
    assert.equal(await page.locator('button[aria-label="Dicter"]').count(), 0, 'dictée vocale supprimée');

    // Message envoyé pendant une génération : mis en file d'attente, traité ensuite.
    await page.fill('textarea[aria-label="Message"]', 'Tâche longue. [[sleep:6000]]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=Pi travaille…');
    await page.fill('textarea[aria-label="Message"]', 'Message en attente');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[aria-label="Messages en file d\'attente"] >> text=Message en attente', { timeout: 30_000 });
    await page.screenshot({ path: new URL('composer-queue.png', OUT).pathname });
    await page.waitForSelector('text=Réponse factice : Message en attente', { timeout: 120_000 });
    await page.waitForSelector('[aria-label="Messages en file d\'attente"]', { state: 'detached', timeout: 30_000 });

    // Composer : menu « + », modèle / effort, mode, consommation.
    await page.click('button[aria-label="Ajouter"]');
    await page.waitForSelector('text=Ajouter des fichiers ou des photos');
    await page.screenshot({ path: new URL('composer-plus.png', OUT).pathname });
    await page.keyboard.press('Escape');
    await page.click('button[aria-haspopup="menu"]:has-text("Mock")');
    await page.click('button:has-text("Effort")');
    await page.waitForSelector('[role="menuitemradio"]:has-text("Élevé")');
    await page.screenshot({ path: new URL('composer-model.png', OUT).pathname });
    await page.keyboard.press('Escape');
    // Quotas : pourcentages uniquement, orange à l'approche de la limite, rouge au-delà de 90 %.
    const used = (await admin.get(`/admin/quotas/usage/${user.body.id}`)).body.windows.map((w) => Number(w.used) + Number(w.reserved));
    assert.ok(used[0] > 0, 'consommation mesurée');
    await admin.put('/admin/quotas/policies', { scope: 'user', subjectId: user.body.id, limit5h: (used[0] / 0.8).toFixed(4), limit7d: (used[1] / 0.95).toFixed(4), exempt: false });
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('button[aria-label="Utilisation des quotas"]');
    await page.waitForSelector('text=Limite de 5 heures');
    const popover = page.locator('div:has(> div > span:text("Utilisation des quotas"))');
    const popText = await popover.innerText();
    assert.doesNotMatch(popText, /crédit/i, 'aucun crédit affiché');
    assert.match(popText, /80\s%/);
    assert.match(popText, /95\s%/);
    assert.equal(await popover.locator('.bg-orange-500').count(), 1, 'jauge orange');
    assert.equal(await popover.locator('.bg-red-600').count(), 1, 'jauge rouge');
    await page.screenshot({ path: new URL('composer-usage.png', OUT).pathname });
    await page.keyboard.press('Escape');
    await admin.put('/admin/quotas/policies', { scope: 'user', subjectId: user.body.id, limit5h: null, limit7d: null, exempt: true });
    // Pas de tokens (entrée / sortie) sous les réponses.
    assert.equal(await page.locator('cap-conversation :text("entrée")').count(), 0, 'pas de tokens sous les réponses');

    // Mode Plan : outils en lecture seule imposés par Pi → aucune écriture possible.
    await page.click('button[aria-haspopup="menu"]:has-text("Autonome")');
    await page.screenshot({ path: new URL('composer-mode.png', OUT).pathname });
    await page.click('[role="menuitemradio"]:has-text("Plan")');
    await page.waitForSelector('text=Mode plan');
    await page.fill('textarea[aria-label="Message"]', 'Plan. [[tool:bash {"command":"touch /workspace/interdit.txt"}]]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=Terminé : 1 action(s) exécutée(s). >> nth=1', { timeout: 240_000 });
    const wsId = new URL(page.url()).pathname.split('/').pop();
    const files = await page.evaluate(async (id) => (await fetch(`/api/v1/workspaces/${id}/files/all`, { credentials: 'include' })).json(), wsId);
    assert.ok(!files.includes('interdit.txt'), 'le mode plan ne doit rien écrire');
    assert.ok(await page.locator('cap-tool-card').nth(1).locator('svg').last().evaluate((el) => el.closest('span')?.innerHTML.includes('M18 6')), 'outil refusé en mode plan');
    await page.click('button[aria-haspopup="menu"]:has-text("Plan")');
    await page.click('[role="menuitemradio"]:has-text("Autonome")');

    // Panneau Modifications : le fichier apparaît, le diff s'ouvre dans Monaco.
    await page.waitForSelector('cap-changes-panel button:has-text("main.js")', { timeout: 30_000 });
    await page.click('cap-changes-panel button:has-text("main.js")');
    // Fichier ajouté : affiché en entier en vert, sans ligne « supprimée » vide.
    await page.waitForSelector('cap-diff-editor .monaco-editor .cap-line-added', { timeout: 30_000 });
    assert.equal(await page.locator('cap-diff-editor .cap-line-deleted, cap-diff-editor .line-delete').count(), 0, 'pas de ligne supprimée pour un ajout');
    assert.equal(await page.locator('cap-diff-editor .cap-gutter-added').count(), 1, 'une seule ligne ajoutée (console.log)');
    await page.waitForTimeout(800);
    await page.screenshot({ path: new URL('workspace-diff.png', OUT).pathname });

    // L'onglet « Fichier » n'existe plus dans le panneau latéral.
    assert.equal(await page.locator('[role="tab"]:has-text("Fichier")').count(), 0);
    // « Voir le fichier » bascule vers l'explorateur (exclusif avec le panneau latéral).
    await page.click('button:has-text("Voir le fichier")');
    await page.waitForSelector('aside[aria-label="Explorateur de fichiers"] cap-code-editor .monaco-editor', { timeout: 30_000 });
    assert.equal(await page.locator('aside[aria-label="Panneau latéral"]').count(), 0, 'panneau latéral fermé');
    assert.equal(await page.locator('[role="tablist"][aria-label="Fichiers ouverts"] [role="tab"]').count(), 1);
    // Recherche dans la colonne de navigation.
    await page.fill('input[aria-label="Rechercher des fichiers"]', 'main');
    await page.waitForSelector('cap-explorer button[title="app/main.js"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: new URL('files-pane.png', OUT).pathname });
    // Bascule : le bouton du panneau latéral ferme l'explorateur.
    await page.click('button[aria-label="Panneau latéral"]');
    await page.waitForSelector('aside[aria-label="Explorateur de fichiers"]', { state: 'detached', timeout: 5_000 }).catch(() => assert.fail('explorateur fermé'));
    // État vide de l'explorateur après fermeture de l'onglet.
    await page.click('button[aria-label="Explorateur de fichiers"]');
    await page.click('button[aria-label="Fermer main.js"]');
    await page.waitForSelector('text=Les fichiers ouverts apparaissent ici');
    await page.screenshot({ path: new URL('files-pane-empty.png', OUT).pathname });
    await page.click('button[aria-label="Panneau latéral"]');

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
