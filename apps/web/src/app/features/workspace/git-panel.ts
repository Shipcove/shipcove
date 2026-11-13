import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { GitStatusDto } from '@cap/contracts';
import { Api, idempotencyKey } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { WorkspaceStore } from './workspace.store';

/** Statut Git et opérations (les publications passent par une approbation). */
@Component({
  selector: 'cap-git-panel',
  imports: [FormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full space-y-4 overflow-y-auto p-4 text-sm">
      <div class="flex items-center gap-2">
        <button class="btn-secondary !py-1" (click)="load()"><cap-icon name="refresh" [size]="13" /> Statut</button>
        <button class="btn-secondary !py-1" (click)="op({ action: 'fetch' })" [disabled]="busy()">Fetch</button>
        <button class="btn-secondary !py-1" (click)="op({ action: 'pull' })" [disabled]="busy()">Pull (ff-only)</button>
      </div>
      @if (status(); as s) {
        @if (!s.available) {
          <p class="text-stone-500">Statut indisponible : démarrez le workspace (ou le projet n’a pas de dépôt).</p>
        } @else {
          <div class="card p-3">
            <div class="flex items-center gap-2"><cap-icon name="git" [size]="14" /><span class="font-mono">{{ s.branch }}</span>
              @if (s.upstream) { <span class="text-xs text-stone-500">→ {{ s.upstream }} (↑{{ s.ahead }} ↓{{ s.behind }})</span> }</div>
            <div class="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>Indexés : {{ s.staged.length }}</div><div>Modifiés : {{ s.unstaged.length }}</div>
              <div>Non suivis : {{ s.untracked.length }}</div><div [class.text-red-600]="s.conflicted.length">Conflits : {{ s.conflicted.length }}</div>
            </div>
          </div>
        }
      }
      <form class="card space-y-2 p-3" (ngSubmit)="push()">
        <div class="font-medium">Publier une branche</div>
        <p class="text-xs text-stone-500">Le push est exécuté par la plateforme après votre approbation explicite (commits et diff affichés).</p>
        <div class="grid grid-cols-2 gap-2">
          <input class="input !py-1" name="local" placeholder="Branche locale" [(ngModel)]="local" required />
          <input class="input !py-1" name="remote" placeholder="Branche distante (idem)" [(ngModel)]="remote" />
        </div>
        <button class="btn-secondary !py-1" [disabled]="busy() || !local">Demander le push</button>
      </form>
      <form class="card space-y-2 p-3" (ngSubmit)="pr()">
        <div class="font-medium">Pull request / Merge request</div>
        <div class="grid grid-cols-2 gap-2">
          <input class="input !py-1" name="src" placeholder="Branche source" [(ngModel)]="source" required />
          <input class="input !py-1" name="tgt" placeholder="Branche cible" [(ngModel)]="target" required />
        </div>
        <input class="input !py-1" name="title" placeholder="Titre" [(ngModel)]="title" required />
        <textarea class="input" rows="3" name="body" placeholder="Description" [(ngModel)]="body"></textarea>
        <button class="btn-secondary !py-1" [disabled]="busy() || !source || !target || !title">Demander la création</button>
      </form>
    </div>
  `,
  host: { class: 'block h-full' },
})
export class GitPanel {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly store = inject(WorkspaceStore);
  protected readonly status = signal<GitStatusDto | null>(null);
  protected readonly busy = signal(false);
  protected local = '';
  protected remote = '';
  protected source = '';
  protected target = 'main';
  protected title = '';
  protected body = '';

  async load(): Promise<void> {
    try {
      this.status.set(await this.api.get<GitStatusDto>(`/workspaces/${this.store.workspace()!.id}/git/status`));
      const s = this.status();
      if (s?.branch && !this.local) {
        this.local = s.branch;
        this.source = s.branch;
      }
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected async op(body: Record<string, unknown>): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.post<{ ok?: boolean; output?: string; summary?: string }>(`/workspaces/${this.store.workspace()!.id}/git/operations`, body, { 'Idempotency-Key': idempotencyKey() });
      this.toast.show(r.summary ? `Approbation demandée : ${r.summary}` : r.output || 'Terminé', r.ok === false ? 'error' : 'success');
      await this.store.loadApprovals();
      await this.load();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected push() {
    return this.op({ action: 'push', localBranch: this.local, remoteBranch: this.remote || this.local, force: false });
  }
  protected pr() {
    return this.op({ action: 'create_pull_request', sourceBranch: this.source, targetBranch: this.target, title: this.title, body: this.body, draft: false });
  }
}
