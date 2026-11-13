import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ApprovalDto } from '@cap/contracts';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { AgoPipe } from '../../shared/pipes';
import { WorkspaceStore } from './workspace.store';

/** Approbations Git : action exacte, commits et diff avant décision ; usage unique. */
@Component({
  selector: 'cap-approvals-panel',
  imports: [Icon, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h-full space-y-3 overflow-y-auto p-4 text-sm">
      @for (a of store.approvals(); track a.id) {
        <div class="card p-3" [class.border-accent-500]="a.status === 'pending'">
          <div class="flex items-center gap-2">
            <cap-icon name="git" [size]="14" />
            <span class="font-medium">{{ label(a.action) }}</span>
            <span class="truncate font-mono text-xs text-stone-500">{{ a.target }}</span>
            <span class="badge ml-auto" [class]="badge(a.status)">{{ a.status }}</span>
          </div>
          <div class="mt-1 text-xs text-stone-500">
            Demandé par {{ a.requestedBy === 'agent' ? 'Pi' : 'vous' }} {{ a.createdAt | ago }}
            @if (a.commitSha) { · <span class="font-mono">{{ a.commitSha.slice(0, 10) }}</span> }
            @if (a.status === 'pending') { · expire {{ a.expiresAt | ago }} }
          </div>
          @if (a.title) { <div class="mt-2 font-medium">{{ a.title }}</div> }
          @if (a.commits.length) {
            <ul class="mt-2 space-y-0.5 text-xs">
              @for (c of a.commits.slice(0, 20); track c.sha) { <li class="truncate"><span class="font-mono text-stone-400">{{ c.sha.slice(0, 8) }}</span> {{ c.subject }} <span class="text-stone-400">— {{ c.author }}</span></li> }
            </ul>
          }
          @if (a.diffStat) { <pre class="mt-2 max-h-40 overflow-auto rounded bg-stone-100 p-2 font-mono text-[11px] dark:bg-stone-800">{{ a.diffStat }}</pre> }
          @if (a.patchPreview) {
            <button class="mt-1 text-xs text-accent-700 hover:underline" (click)="expanded.set(expanded() === a.id ? null : a.id)">{{ expanded() === a.id ? 'Masquer le diff' : 'Afficher le diff' }}</button>
            @if (expanded() === a.id) { <pre class="mt-1 max-h-96 overflow-auto rounded bg-stone-900 p-2 font-mono text-[11px] text-stone-100">{{ a.patchPreview }}</pre> }
          }
          @if (a.operation; as op) { <div class="mt-2 text-xs">Exécution : <strong>{{ op.status }}</strong> @if (op.result) { — {{ op.result }} }</div> }
          @if (a.status === 'pending') {
            <div class="mt-3 flex gap-2">
              <button class="btn-accent !py-1" (click)="decide(a, 'approve')" [disabled]="busy()"><cap-icon name="check" [size]="13" /> Approuver</button>
              <button class="btn-secondary !py-1" (click)="decide(a, 'reject')" [disabled]="busy()"><cap-icon name="x" [size]="13" /> Refuser</button>
            </div>
          }
        </div>
      } @empty {
        <p class="py-6 text-center text-stone-500">Aucune demande d’approbation.</p>
      }
    </div>
  `,
  host: { class: 'block h-full' },
})
export class ApprovalsPanel {
  protected readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly expanded = signal<string | null>(null);

  protected label(a: string) {
    return ({ push: 'Push', create_pull_request: 'Pull request', create_merge_request: 'Merge request', merge: 'Fusion', delete_remote_branch: 'Suppression de branche' } as Record<string, string>)[a] ?? a;
  }
  protected badge(s: ApprovalDto['status']) {
    return { pending: 'bg-amber-100 text-amber-800', approved: 'bg-sky-100 text-sky-800', consumed: 'bg-emerald-100 text-emerald-800', rejected: 'bg-stone-200 text-stone-700', expired: 'bg-stone-200 text-stone-500' }[s];
  }
  protected async decide(a: ApprovalDto, d: 'approve' | 'reject') {
    this.busy.set(true);
    try {
      await this.store.decide(a.id, d);
      this.toast.show(d === 'approve' ? 'Approuvé : exécution en cours' : 'Refusé', d === 'approve' ? 'success' : 'info');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
