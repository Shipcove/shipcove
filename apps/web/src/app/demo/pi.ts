import type { AttachmentDto, ToolFileDto, ToolImageDto } from '@cap/contracts';
import * as D from './data';
import type { DemoServer } from './server';

interface Run {
  id: string;
  messageId: string | null;
  text: string;
  cancelled: boolean;
}

/**
 * Pi simulé : à chaque message, un run se déroule en direct (plan, commandes, fichier modifié,
 * capture ou fichier à télécharger, réponse en flux), avec les mêmes événements que le vrai Pi.
 */
export class PiSimulator {
  private readonly active = new Map<string, Run>();
  /** Pièces jointes envoyées pendant la visite. */
  readonly uploads = new Map<string, AttachmentDto>();

  constructor(private readonly server: DemoServer) {}

  message(w: D.DemoWorkspace, b: Record<string, unknown>): Record<string, never> {
    const text = String(b['text'] ?? '').trim();
    const wsId = w.ws.id;
    const attachments = ((b['attachmentIds'] as string[] | undefined) ?? []).map((id) => this.uploads.get(id)).filter((a): a is AttachmentDto => !!a);
    const running = this.active.get(wsId);
    this.server.emit(wsId, 'message.created', { messageId: this.server.newId('msg'), role: 'user', text, attachmentIds: attachments.map((a) => a.id), attachments }, running?.id ?? null);
    // Pendant un run, le message est pris en compte par le run en cours.
    if (running) return {};
    if (b['command'] === 'compact') void this.compact(wsId);
    else void this.run(w, text);
    return {};
  }

  interrupt(wsId: string): void {
    const r = this.active.get(wsId);
    if (!r) return;
    r.cancelled = true;
    this.active.delete(wsId);
    if (r.messageId) this.server.emit(wsId, 'message.completed', { messageId: r.messageId, text: r.text, stopReason: 'aborted' }, r.id);
    this.server.emit(wsId, 'run.interrupted', { runId: r.id, reason: 'user' }, r.id);
  }

  private async compact(wsId: string): Promise<void> {
    this.server.emit(wsId, 'compaction.started', { reason: 'manual' });
    await sleep(1500);
    this.server.emit(wsId, 'message.created', { messageId: this.server.newId('msg'), role: 'system', text: 'Contexte de la conversation compacté', attachmentIds: [], meta: { kind: 'compaction', status: 'succeeded', tokensBefore: 48_200, summary: D.L('Résumé : la conversation porte sur une démonstration de Shipcove.', 'Summary: the conversation is about a Shipcove demo.') } });
    this.server.emit(wsId, 'compaction.completed', { tokensBefore: 48_200 });
    this.server.emit(wsId, 'usage.updated', { contextPercent: 6 });
  }

  private async run(w: D.DemoWorkspace, request: string): Promise<void> {
    const wsId = w.ws.id;
    const r: Run = { id: this.server.newId('run'), messageId: null, text: '', cancelled: false };
    this.active.set(wsId, r);
    const emit: DemoServer['emit'] = (wid, type, data) => {
      if (!r.cancelled) this.server.emit(wid, type, data, r.id);
    };
    const step = async (ms: number) => {
      await sleep(ms);
      return !r.cancelled;
    };
    const hasRepo = !!w.ws.repository;
    const isLanding = wsId === 'w-landing';

    emit(wsId, 'run.queued', { runId: r.id });
    if (w.ws.status !== 'running') {
      emit(wsId, 'workspace.status', { status: 'starting', syncState: 'synced', detail: null });
      if (!(await step(700))) return;
      emit(wsId, 'workspace.status', { status: 'running', syncState: 'synced', detail: null });
    }
    if (!(await step(400))) return;
    emit(wsId, 'run.started', { runId: r.id, model: 'Claude Sonnet' });
    if (w.ws.titleSource === 'auto' && !w.messages.some((m) => m.role === 'assistant')) {
      emit(wsId, 'workspace.renamed', { name: title(request), titleSource: 'auto' });
    }

    r.messageId = this.server.newId('msg');
    emit(wsId, 'message.created', { messageId: r.messageId, role: 'assistant', text: '', attachmentIds: [] });
    const thinking = D.L(
      `La demande : « ${clip(request, 120)} ». Je commence par regarder le projet, puis je fais la modification et je vérifie le résultat.`,
      `The request: “${clip(request, 120)}”. I will look at the project first, then make the change and check the result.`,
    );
    for (const chunk of words(thinking)) {
      emit(wsId, 'thinking.delta', { messageId: r.messageId, delta: chunk });
      if (!(await step(35))) return;
    }

    const steps = [D.L('Explorer le projet', 'Explore the project'), D.L('Appliquer la modification', 'Make the change'), D.L('Vérifier le résultat', 'Check the result')];
    const planTool = async (current: number) => {
      const items = steps.map((content, i) => ({ content, status: i < current ? 'completed' : i === current ? 'in_progress' : 'pending' }));
      await this.tool(r, wsId, 'update_plan', { items }, 'ok', 200);
    };

    await planTool(0);
    if (!(await step(500))) return;
    const listing = Object.keys(w.files).sort().join('\n') || D.L('(dossier vide)', '(empty folder)');
    await this.tool(r, wsId, 'bash', { command: hasRepo ? 'git ls-files' : 'ls -A' }, listing, 900);
    if (!(await step(400))) return;

    await planTool(1);
    const notes = D.L(
      `# Notes de l’agent\n\n## Demande\n\n> ${request.replace(/\n/g, '\n> ')}\n\n## Dans la vraie application\n\nL’agent modifierait ici le code du dépôt, lancerait les tests et vous montrerait le résultat.\nDans cette démonstration, son travail est simulé : ce fichier en garde la trace.\n`,
      `# The agent's notes\n\n## Request\n\n> ${request.replace(/\n/g, '\n> ')}\n\n## In the real application\n\nThe agent would change the repository's code here, run the tests and show you the result.\nIn this demo, its work is simulated: this file keeps a record of it.\n`,
    );
    w.files['NOTES.md'] = notes;
    await this.tool(r, wsId, 'write', { path: 'NOTES.md', content: notes }, D.L(`Fichier écrit (${notes.split('\n').length} lignes)`, `File written (${notes.split('\n').length} lines)`), 700, { filesTouched: ['NOTES.md'] });
    emit(wsId, 'file.changed', { paths: ['NOTES.md'], generation: 0 });
    if (!(await step(400))) return;

    await planTool(2);
    if (hasRepo) {
      await this.tool(r, wsId, 'bash', { command: 'npm test' }, ' ✓ tests/app.test.ts (6 tests) 52ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)', 1500);
    }
    await planTool(3);
    if (!(await step(300))) return;
    if (isLanding) {
      const images: ToolImageDto[] = [{ attachmentId: D.L('landing-dark.png', 'landing-dark-en.png'), fileName: 'landing-dark.png', width: 1280, height: 800 }];
      await this.tool(r, wsId, 'browser_screenshot', { url: 'http://localhost:5173' }, D.L('Capture enregistrée', 'Screenshot saved'), 1200, { images });
    } else {
      const id = this.server.newId('file');
      registerText(id, notes);
      const files: ToolFileDto[] = [{ attachmentId: id, fileName: 'NOTES.md', path: 'NOTES.md', size: notes.length, kind: 'text' }];
      await this.tool(r, wsId, 'share_files', { paths: ['NOTES.md'] }, D.L('1 fichier proposé au téléchargement', '1 file offered for download'), 500, { files });
    }
    if (!(await step(300))) return;

    // Comme le vrai Pi : la réponse finale est un nouveau message, après les actions.
    emit(wsId, 'message.completed', { messageId: r.messageId, text: '', stopReason: 'tool_use' });
    r.messageId = this.server.newId('msg');
    emit(wsId, 'message.created', { messageId: r.messageId, role: 'assistant', text: '', attachmentIds: [] });
    const answer = D.L(
      `C'est fait. Comme il s'agit d'une **démonstration**, mon travail est simulé :\n\n- j'ai établi un **plan** (bouton *Plan* en haut à droite) et l'ai suivi étape par étape ;\n- j'ai écrit \`NOTES.md\` : il apparaît dans l'onglet **Git** (git diff) et dans l'**explorateur de fichiers** ;\n- ${isLanding ? "j'ai pris une **capture d'écran** du rendu, affichée ci-dessus" : 'je vous propose le fichier en **téléchargement**, juste au-dessus'}.\n\nDans la vraie application, je travaille sur votre dépôt dans une sandbox isolée, et toute publication Git attend votre approbation.`,
      `Done. Since this is a **demo**, my work is simulated:\n\n- I made a **plan** (*Plan* button at the top right) and followed it step by step;\n- I wrote \`NOTES.md\`: it shows up in the **Git** tab (git diff) and in the **file explorer**;\n- ${isLanding ? 'I took a **screenshot** of the rendering, shown above' : 'I am offering the file for **download**, just above'}.\n\nIn the real application, I work on your repository in an isolated sandbox, and every Git publication waits for your approval.`,
    );
    for (const chunk of words(answer)) {
      r.text += chunk;
      emit(wsId, 'message.delta', { messageId: r.messageId, delta: chunk });
      if (!(await step(28))) return;
    }
    emit(wsId, 'message.completed', { messageId: r.messageId, text: r.text, stopReason: 'stop' });
    emit(wsId, 'checkpoint.completed', { generation: 0, changedFiles: 1, bytesUploaded: notes.length });
    emit(wsId, 'usage.updated', { contextPercent: Math.min(90, 12 + w.messages.length * 3) });
    emit(wsId, 'run.completed', { runId: r.id });
    this.active.delete(wsId);
  }

  private async tool(r: Run, wsId: string, toolName: string, args: unknown, output: string, ms: number, extra: { filesTouched?: string[]; images?: ToolImageDto[]; files?: ToolFileDto[] } = {}): Promise<void> {
    if (r.cancelled) return;
    const toolCallId = this.server.newId('tool');
    this.server.emit(wsId, 'tool.started', { toolCallId, messageId: r.messageId, toolName, args }, r.id);
    await sleep(ms);
    if (r.cancelled) return;
    this.server.emit(wsId, 'tool.completed', { toolCallId, isError: false, output, truncated: false, durationMs: ms, filesTouched: extra.filesTouched ?? [], images: extra.images ?? [], files: extra.files ?? [] }, r.id);
  }
}

/** Texte servi en téléchargement depuis la mémoire du navigateur. */
const textUrls = new Map<string, string>();
export function registerText(id: string, content: string): void {
  textUrls.set(id, URL.createObjectURL(new Blob([content], { type: 'text/markdown' })));
}
export function textUrl(id: string): string | undefined {
  return textUrls.get(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Découpe un texte en morceaux d'un mot (espaces compris), comme un flux de tokens. */
function words(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Titre automatique : les premiers mots de la demande. */
function title(request: string): string {
  const s = clip(request, 60).replace(/[.!?…]+$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1) || D.L('Nouvelle conversation', 'New conversation');
}
