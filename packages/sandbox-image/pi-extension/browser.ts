/**
 * Plugin Pi « browser » — captures d'écran avec le Chromium de la sandbox (Playwright).
 *
 * Outil natif `browser_screenshot` : ouvre une page (en général le serveur de développement lancé
 * par l'agent), exécute éventuellement quelques actions (clic, saisie, touche, attente), puis
 * enregistre une capture dans /workspace/.cap/screenshots/. La plateforme affiche ces captures dans
 * la conversation (miniatures agrandissables) ; si le modèle accepte les images, la capture lui est
 * aussi renvoyée pour qu'il juge lui-même le rendu.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

const PLAYWRIGHT = '/usr/local/lib/node_modules/playwright/package.json';
const DIR = '/workspace/.cap/screenshots';
/** Au-delà, l'image n'est pas renvoyée au modèle (le fichier reste affiché dans la conversation). */
const MAX_MODEL_IMAGE_BYTES = 3_500_000;

const Action = Type.Object({
  type: Type.Union([Type.Literal('click'), Type.Literal('fill'), Type.Literal('press'), Type.Literal('hover'), Type.Literal('wait_for'), Type.Literal('wait'), Type.Literal('goto'), Type.Literal('scroll')], {
    description: 'click/hover/wait_for: selector ; fill: selector + text ; press: key (ex. Enter) ; wait: ms ; goto: url ; scroll: selector (ou bas de page si absent)',
  }),
  selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  ms: Type.Optional(Type.Number()),
  url: Type.Optional(Type.String()),
});

export default function browserPlugin(pi: ExtensionAPI) {
  if (!existsSync(PLAYWRIGHT)) return; // image sans navigateur : plugin inactif

  pi.registerTool({
    name: 'browser_screenshot',
    label: 'Capture d’écran',
    description:
      'Opens a web page in the sandbox Chromium and takes a screenshot, shown to the user in the conversation. ' +
      'Typically used on the project dev server you started in the background (e.g. http://127.0.0.1:5173). ' +
      'Optional actions (click, fill, press, hover, wait_for, wait, goto, scroll) run before the capture. ' +
      'Reports the HTTP status and the JavaScript errors of the page.',
    promptSnippet: 'Capture d’écran d’une page web avec le Chromium de la sandbox (affichée à l’utilisateur)',
    promptGuidelines: [
      'When you create or change a web UI, start the dev server in the background (e.g. `nohup npm run dev -- --host 127.0.0.1 > /tmp/dev.log 2>&1 &`), wait until it responds, then use browser_screenshot to check the result and show it to the user — without being asked.',
      'Check desktop and, when relevant, mobile (mobile: true) and dark mode; fix visual problems and JavaScript errors you see before concluding. Give each screenshot a short descriptive name.',
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'Adresse de la page (ex. http://127.0.0.1:5173/)' }),
      name: Type.Optional(Type.String({ description: 'Nom court de la capture (ex. accueil-mobile)' })),
      width: Type.Optional(Type.Number({ description: 'Largeur de la fenêtre (défaut 1280)' })),
      height: Type.Optional(Type.Number({ description: 'Hauteur de la fenêtre (défaut 800)' })),
      full_page: Type.Optional(Type.Boolean({ description: 'Page entière, défilement compris' })),
      mobile: Type.Optional(Type.Boolean({ description: 'Téléphone (390×844, tactile)' })),
      dark: Type.Optional(Type.Boolean({ description: 'Thème sombre (prefers-color-scheme)' })),
      selector: Type.Optional(Type.String({ description: 'Capturer seulement cet élément' })),
      actions: Type.Optional(Type.Array(Action, { description: 'Actions avant la capture, dans l’ordre' })),
      timeout_ms: Type.Optional(Type.Number({ description: 'Délai maximal de chargement (défaut 30000)' })),
    }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      const req = createRequire(PLAYWRIGHT);
      const { chromium } = req('playwright') as typeof import('playwright');
      const timeout = p.timeout_ms ?? 30_000;
      const url = /^[a-z]+:\/\//i.test(p.url) ? p.url : `http://${p.url}`;
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      const browser = await chromium.launch({
        // La sandbox est elle-même le bac à sable (pas d'espaces de noms utilisateur disponibles).
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1,::1' } } : {}),
      });
      const abort = () => void browser.close().catch(() => undefined);
      signal?.addEventListener('abort', abort);
      try {
        const context = await browser.newContext({
          viewport: p.mobile ? { width: 390, height: 844 } : { width: p.width ?? 1280, height: p.height ?? 800 },
          deviceScaleFactor: p.mobile ? 2 : 1,
          isMobile: !!p.mobile,
          hasTouch: !!p.mobile,
          colorScheme: p.dark ? 'dark' : 'light',
          ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        const open = async (target: string) => {
          try {
            return await page.goto(target, { waitUntil: 'networkidle', timeout });
          } catch (err) {
            const msg = (err as Error).message;
            if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(msg)) {
              throw new Error(
                `Aucun serveur ne répond sur ${target}. Lancez d'abord le projet en arrière-plan (ex. \`nohup npm run dev -- --host 127.0.0.1 > /tmp/dev.log 2>&1 &\`), attendez qu'il soit prêt, puis réessayez.`,
              );
            }
            if (/Timeout/i.test(msg)) return null; // connexion persistante (HMR) : page tout de même affichée
            throw err;
          }
        };
        let response = await open(url);
        for (const a of p.actions ?? []) {
          const sel = a.selector ?? '';
          if (a.type === 'click') await page.locator(sel).first().click({ timeout });
          else if (a.type === 'hover') await page.locator(sel).first().hover({ timeout });
          else if (a.type === 'fill') await page.locator(sel).first().fill(a.text ?? '', { timeout });
          else if (a.type === 'press') await page.keyboard.press(a.key ?? 'Enter');
          else if (a.type === 'wait_for') await page.locator(sel).first().waitFor({ state: 'visible', timeout });
          else if (a.type === 'wait') await page.waitForTimeout(Math.min(a.ms ?? 500, 30_000));
          else if (a.type === 'goto') response = await open(a.url ?? url);
          else if (a.type === 'scroll') {
            if (sel) await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout });
            else await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          }
        }
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

        mkdirSync(DIR, { recursive: true });
        const slug = (p.name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
        const file = join(DIR, `${stamp}${slug ? `-${slug}` : ''}.png`);
        if (p.selector) await page.locator(p.selector).first().screenshot({ path: file, animations: 'disabled', timeout });
        else await page.screenshot({ path: file, fullPage: !!p.full_page, animations: 'disabled', timeout });

        const title = await page.title().catch(() => '');
        const lines = [
          `Capture enregistrée et affichée à l’utilisateur : ${file}`,
          `Page : ${page.url()}${title ? ` — « ${title} »` : ''}${response ? ` (HTTP ${response.status()})` : ''}`,
        ];
        if (errors.length) lines.push(`Erreurs JavaScript (${errors.length}) :`, ...errors.slice(0, 10).map((e) => `  - ${e.slice(0, 300)}`));
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        const size = statSync(file).size;
        if (ctx.model?.input?.includes('image') && size <= MAX_MODEL_IMAGE_BYTES) {
          content.push({ type: 'image', data: readFileSync(file).toString('base64'), mimeType: 'image/png' });
        } else if (ctx.model && !ctx.model.input?.includes('image')) {
          lines.push('(Le modèle actuel ne lit pas les images : la capture n’est visible que par l’utilisateur.)');
        }
        content.unshift({ type: 'text', text: lines.join('\n') });
        return { content, details: { file: basename(file), size } };
      } finally {
        signal?.removeEventListener('abort', abort);
        await browser.close().catch(() => undefined);
      }
    },
  });
}
