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
    const r = await admin.patch(`/admin/models/${mock.id}`, { supportsReasoning: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const slug = `ui-${uid()}`;
  const username = `ui${uid()}`;
  const password = 'Ui-Password-123456';
  const user = await admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `UI ${username}`, platformRole: 'user', password });

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const issues = watch(page);

    await page.goto(`${BASE}/auth/login`, { waitUntil: 'networkidle' });
    await page.fill('#login', username);
    await page.fill('#password', password);
    await page.click('button:has-text("Se connecter")');
    await page.waitForURL(`${BASE}/`);

    // Accueil = nouvelle conversation : sans dépôt par défaut, le premier message la crée.
    await page.waitForSelector('cap-repo-picker >> text=Aucun dépôt');
    assert.equal(await page.locator('a[href="/projects"], a[href="/teams"]').count(), 0, 'plus de sections Projets / Équipes');
    await page.screenshot({ path: new URL('home.png', OUT).pathname });
    await page.click('cap-repo-picker button');
    await page.waitForSelector('text=Aucune connexion Git.');
    await page.keyboard.press('Escape');
    await page.waitForSelector('text=Aucune connexion Git.', { state: 'detached' });
    // Message à Pi (fournisseur factice piloté par directives).
    await page.fill('textarea[aria-label="Message"]', 'Crée un fichier. [[tool:bash {"command":"mkdir -p app && printf \'console.log(1)\\n\' > app/main.js"}]]');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/workspaces\/[0-9a-f-]+$/);
    await page.waitForSelector('text=Terminé : 1 action(s) exécutée(s).', { timeout: 240_000 });
    // Titre automatique, affiché dans l'en-tête et dans la barre latérale (section sans dépôt, « Aujourd’hui »).
    await page.waitForSelector('header h1:has-text("Crée un fichier.")', { timeout: 30_000 });
    const sidebar = page.locator('nav[aria-label="Conversations"]');
    await sidebar.locator('text=Aujourd’hui').waitFor();
    await sidebar.locator('a:has-text("Crée un fichier.")').waitFor();
    // Renommage dans l'en-tête.
    await page.click('button[aria-label="Renommer la conversation"]');
    await page.fill('input[aria-label="Titre de la conversation"]', 'Conversation UI');
    await page.keyboard.press('Enter');
    await sidebar.locator('a:has-text("Conversation UI")').waitFor();
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
    // Arborescence : aucun rechargement en boucle, dossiers repliables et dépliables.
    await page.fill('input[aria-label="Rechercher des fichiers"]', '');
    let fileRequests = 0;
    const onFileRequest = (r) => {
      if (/\/files(\/all)?(\?|$)/.test(r.url())) fileRequests++;
    };
    page.on('request', onFileRequest);
    await page.waitForTimeout(4000);
    page.off('request', onFileRequest);
    assert.ok(fileRequests <= 2, `rechargements de l'arborescence en boucle : ${fileRequests} requêtes en 4 s`);
    const appDir = page.locator('cap-explorer [role="treeitem"][title="app"]');
    if ((await appDir.getAttribute('aria-expanded')) === 'true') {
      await appDir.click();
      await page.waitForSelector('cap-explorer [role="treeitem"][title="app/main.js"]', { state: 'detached', timeout: 5_000 });
    }
    await appDir.click();
    await page.waitForSelector('cap-explorer [role="treeitem"][title="app/main.js"]', { timeout: 5_000 });
    // Bascule : le bouton du panneau latéral ferme l'explorateur.
    await page.click('button[aria-label="Panneau latéral"]');
    await page.waitForSelector('aside[aria-label="Explorateur de fichiers"]', { state: 'detached', timeout: 5_000 }).catch(() => assert.fail('explorateur fermé'));
    // État vide de l'explorateur après fermeture de l'onglet.
    await page.click('button[aria-label="Explorateur de fichiers"]');
    await page.click('button[aria-label="Fermer main.js"]');
    await page.waitForSelector('text=Les fichiers ouverts apparaissent ici');
    await page.screenshot({ path: new URL('files-pane-empty.png', OUT).pathname });
    await page.click('button[aria-label="Panneau latéral"]');

    // Retour en arrière proposé sous les messages ayant lancé un run.
    assert.ok((await page.locator('button[aria-label="Revenir avant ce message"]').count()) >= 1, 'bouton de retour en arrière');

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

    // Suppression depuis la barre latérale : corbeille visible au survol seulement, confirmation, retour à l'accueil.
    const item = page.locator('nav[aria-label="Conversations"] div.group\\/item', { hasText: 'Conversation UI' });
    const trash = item.locator('button[aria-label^="Supprimer"]');
    assert.equal(await trash.isVisible(), false, 'corbeille masquée hors survol');
    await item.hover();
    await trash.waitFor({ state: 'visible' });
    await page.screenshot({ path: new URL('sidebar-delete.png', OUT).pathname, clip: { x: 0, y: 0, width: 300, height: 260 } });
    page.once('dialog', (d) => d.accept());
    await trash.click();
    await page.waitForURL(`${BASE}/`);
    await page.waitForSelector('text=Conversation supprimée');
    assert.equal(await page.locator('nav[aria-label="Conversations"] a:has-text("Conversation UI")').count(), 0);
    await page.waitForTimeout(1500); // aucune requête résiduelle vers la conversation supprimée (404 relevé sinon)

    assert.deepEqual(issues, [], `erreurs/violations CSP :\n${issues.join('\n')}`);
  } finally {
    await browser.close();
  }
});
