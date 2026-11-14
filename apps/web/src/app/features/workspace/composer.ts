import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AttachmentDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { BytesPipe } from '../../shared/pipes';
import { WorkspaceStore } from './workspace.store';

/** Saisie : envoi, guidage pendant un run, pièces jointes (bouton, glisser-déposer, collage). */
@Component({
  selector: 'cap-composer',
  imports: [FormsModule, Icon, BytesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto max-w-3xl px-6 pb-4">
      @if (store.quotaPaused(); as q) {
        <div class="mb-2 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" role="status">
          <cap-icon name="alert" /> Quota de crédits atteint ({{ q.window }}). L’agent est suspendu.
          <button class="btn-secondary ml-auto !py-1" (click)="resume()">Reprendre</button>
        </div>
      }
      <div class="card relative shadow-sm transition-colors" [class.ring-2]="dragging()" [class.ring-accent-500]="dragging()"
        (dragover)="$event.preventDefault(); dragging.set(true)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)">
        @if (attachments().length) {
          <div class="flex flex-wrap gap-2 border-b border-stone-200 p-2 dark:border-stone-800">
            @for (a of attachments(); track a.id) {
              <span class="badge max-w-60 bg-stone-100 py-1 text-stone-700 dark:bg-stone-800 dark:text-stone-300" [class.!bg-red-100]="a.status === 'rejected'" [title]="a.rejectionReason ?? ''">
                @if (previews()[a.id]) { <img [src]="previews()[a.id]" alt="" class="h-6 w-6 rounded object-cover" /> } @else { <cap-icon name="paperclip" [size]="12" /> }
                <span class="truncate">{{ a.fileName }}</span><span class="text-stone-400">{{ a.size | bytes }}</span>
                <button (click)="remove(a)" aria-label="Retirer"><cap-icon name="x" [size]="12" /></button>
              </span>
            }
          </div>
        }
        <textarea class="block max-h-60 min-h-[3.5rem] w-full resize-none bg-transparent px-4 py-3 text-[0.925rem] focus:outline-none" rows="2"
          [placeholder]="running() ? 'Guider Pi pendant son exécution…' : 'Décrivez la tâche pour Pi…'" [(ngModel)]="text" name="text"
          (keydown)="onKey($event)" (paste)="onPaste($event)" [disabled]="!store.isOwner()" aria-label="Message"></textarea>
        <div class="flex flex-wrap items-center gap-1 px-2 pb-2">
          <label class="btn-ghost !p-1.5 cursor-pointer" aria-label="Joindre des fichiers">
            <cap-icon name="paperclip" /><input type="file" multiple class="hidden" (change)="onFiles($event)" />
          </label>
          @if (running()) {
            <select class="input !w-auto max-w-44 min-w-0 !py-1 text-xs" [(ngModel)]="delivery" name="delivery" aria-label="Mode de livraison">
              <option value="steer">Avant le prochain appel</option>
              <option value="follow_up">Après la fin</option>
            </select>
          }
          <span class="ml-auto flex shrink-0 items-center gap-1">
          @if (running()) {
            <button class="btn-secondary !py-1" (click)="interrupt()" [disabled]="store.activeRun()?.status === 'interrupting'"><cap-icon name="stop" [size]="14" /> Interrompre</button>
          }
          <button class="btn-accent !py-1" (click)="submit()" [disabled]="!canSend()"><cap-icon name="send" [size]="14" /> Envoyer</button>
          </span>
        </div>
      </div>
    </div>
  `,
})
export class Composer {
  protected readonly store = inject(WorkspaceStore);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected text = '';
  protected delivery: 'steer' | 'follow_up' = 'steer';
  protected readonly attachments = signal<AttachmentDto[]>([]);
  protected readonly previews = signal<Record<string, string>>({});
  protected readonly dragging = signal(false);
  protected readonly sending = signal(false);
  protected readonly running = computed(() => ['running', 'queued'].includes(this.store.activeRun()?.status ?? ''));
  protected readonly canSend = computed(() => this.store.isOwner() && !this.sending());

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    const text = this.text.trim();
    if (!text || this.sending()) return;
    const ready = this.attachments().filter((a) => a.status === 'ready');
    this.sending.set(true);
    try {
      await this.store.send(text, ready.map((a) => a.id), this.running() ? this.delivery : 'new_run');
      this.text = '';
      this.attachments.set([]);
      this.previews.set({});
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.sending.set(false);
    }
  }

  protected async interrupt() {
    await this.store.interrupt().catch((e) => this.toast.error(e));
  }

  protected async resume() {
    await this.store.resume().catch((e) => this.toast.error(e));
  }

  protected onFiles(e: Event): void {
    const files = (e.target as HTMLInputElement).files;
    if (files) void this.upload([...files]);
    (e.target as HTMLInputElement).value = '';
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer?.files.length) void this.upload([...e.dataTransfer.files]);
  }

  protected onPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      void this.upload(files);
    }
  }

  private async upload(files: File[]): Promise<void> {
    const cfg = this.store.config()?.attachments;
    const form = new FormData();
    for (const f of files) {
      if (cfg && f.size > cfg.maxFileMb * 1024 * 1024) {
        this.toast.show(`${f.name} dépasse ${cfg.maxFileMb} Mo`, 'error');
        continue;
      }
      form.append('files', f, f.name);
    }
    if (!form.has('files')) return;
    try {
      const res = await this.api.upload<AttachmentDto[]>(`/workspaces/${this.store.workspace()!.id}/attachments`, form);
      this.attachments.update((l) => [...l, ...res]);
      for (const a of res) {
        if (a.status === 'rejected') this.toast.show(`${a.fileName} refusé : ${a.rejectionReason}`, 'error');
        const local = files.find((f) => f.name === a.fileName);
        if (a.kind === 'image' && local) this.previews.update((p) => ({ ...p, [a.id]: URL.createObjectURL(local) }));
      }
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected async remove(a: AttachmentDto): Promise<void> {
    await this.api.delete(`/workspaces/${this.store.workspace()!.id}/attachments/${a.id}`).catch(() => undefined);
    this.attachments.update((l) => l.filter((x) => x.id !== a.id));
  }
}
