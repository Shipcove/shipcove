import { Injectable, computed, inject, signal } from '@angular/core';
import { tk } from './i18n';
import type { WorkspaceDto } from '@cap/contracts';
import { Api } from './api.service';

export interface RepoGroup {
  key: string;
  /** Nom court (dernier segment) et nom complet du dépôt. */
  name: string;
  fullName: string;
  host: string;
  items: WorkspaceDto[];
}

export interface DateGroup {
  label: string;
  items: WorkspaceDto[];
}

const lastActivity = (w: WorkspaceDto) => new Date(w.lastActivityAt ?? w.createdAt).getTime();

/**
 * Conversations de l'utilisateur (et celles partagées avec lui), pour la barre latérale :
 * regroupées par dépôt Git, puis celles sans dépôt classées par date.
 */
@Injectable({ providedIn: 'root' })
export class ConversationsService {
  private readonly api = inject(Api);
  readonly all = signal<WorkspaceDto[]>([]);

  private readonly active = computed(() => this.all().filter((w) => !w.archivedAt).sort((a, b) => lastActivity(b) - lastActivity(a)));

  /** Dépôts, les plus récemment actifs d'abord ; conversations de chaque dépôt par date. */
  readonly byRepository = computed<RepoGroup[]>(() => {
    const map = new Map<string, RepoGroup>();
    for (const w of this.active()) {
      if (!w.repository) continue;
      const key = `${w.repository.host}/${w.repository.fullName}`;
      const g = map.get(key) ?? { key, name: w.repository.fullName.split('/').pop() ?? w.repository.fullName, fullName: w.repository.fullName, host: w.repository.host, items: [] };
      g.items.push(w);
      map.set(key, g);
    }
    return [...map.values()];
  });

  /** Conversations sans dépôt, par tranche de date (de la plus récente à la plus ancienne). */
  readonly withoutRepository = computed<DateGroup[]>(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 86_400_000;
    const buckets: Array<{ label: string; from: number }> = [
      { label: tk('Aujourd’hui'), from: startOfDay },
      { label: tk('Hier'), from: startOfDay - day },
      { label: tk('7 derniers jours'), from: startOfDay - 7 * day },
      { label: tk('30 derniers jours'), from: startOfDay - 30 * day },
      { label: tk('Plus ancien'), from: -Infinity },
    ];
    const groups: DateGroup[] = buckets.map((b) => ({ label: b.label, items: [] }));
    for (const w of this.active()) {
      if (w.repository) continue;
      const t = lastActivity(w);
      const i = buckets.findIndex((b) => t >= b.from);
      groups[i].items.push(w);
    }
    return groups.filter((g) => g.items.length);
  });

  async refresh(): Promise<void> {
    this.all.set(await this.api.get<WorkspaceDto[]>('/workspaces').catch(() => this.all()));
  }

  /** Mise à jour locale immédiate (titre généré, renommage, activité). */
  patch(id: string, changes: Partial<WorkspaceDto>): void {
    this.all.update((l) => l.map((w) => (w.id === id ? { ...w, ...changes } : w)));
  }

  upsert(w: WorkspaceDto): void {
    this.all.update((l) => (l.some((x) => x.id === w.id) ? l.map((x) => (x.id === w.id ? w : x)) : [w, ...l]));
  }

  remove(id: string): void {
    this.all.update((l) => l.filter((w) => w.id !== id));
  }
}
