import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PlatformSettings } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

type Section = keyof PlatformSettings;

const LABELS: Record<string, string> = {
  localLoginEnabled: 'Connexion locale (login / mot de passe)',
  registrationEnabled: 'Inscription libre',
  emailVerificationRequired: 'Vérification d’email obligatoire',
  mfaPolicy: 'Politique MFA',
  sessionIdleHours: 'Expiration de session après inactivité (h)',
  sessionAbsoluteHours: 'Durée maximale de session (h)',
  maxFailedLogins: 'Échecs avant verrouillage',
  lockoutMinutes: 'Durée de verrouillage (min)',
  manualEditingEnabled: 'Édition manuelle des fichiers dans l’interface',
  idleTimeoutMinutes: 'Destruction après inactivité (min)',
  maxRunMinutes: 'Durée maximale d’un run (min)',
  cpu: 'CPU par sandbox',
  memoryMb: 'Mémoire par sandbox (Mo)',
  diskMb: 'Disque par sandbox (Mo)',
  pidsLimit: 'Processus max',
  maxActiveSandboxesPerUser: 'Sandboxes actives par utilisateur',
  maxActiveSandboxesTotal: 'Sandboxes actives au total',
  egressAllowlist: 'Domaines autorisés en sortie (un par ligne)',
  checkpointExcludes: 'Exclusions des checkpoints (motifs, un par ligne)',
  maxPortsPerWorkspace: 'Ports de preview simultanés par workspace',
  enabled: 'Activé',
  defaultOutputReservation: 'Réservation de sortie par défaut (tokens)',
  unknownUsagePolicy: 'Usage inconnu après réconciliation',
  maxFileMb: 'Taille max par fichier (Mo)',
  maxFilesPerMessage: 'Fichiers par message',
  allowArchives: 'Autoriser les archives',
  maxArchiveEntries: 'Entrées max d’archive',
  maxArchiveExpandedMb: 'Taille décompressée max (Mo)',
  personalSkillsAllowed: 'Skills personnels autorisés',
  personalSkillsRequireReview: 'Revue obligatoire des skills personnels',
  personalServersAllowed: 'Serveurs MCP personnels autorisés',
  teamServersAllowed: 'Serveurs MCP d’équipe autorisés',
  allowedRemoteHosts: 'Hôtes MCP distants autorisés (portées équipe/personnelle)',
  insecureHttpHosts: 'Forges auto-hébergées joignables en HTTP (hôte[:port] ; vide = HTTPS obligatoire)',
  emailEnabled: 'Envoi d’emails',
  mandatoryEmailTypes: 'Emails imposés (types)',
};

const ENUMS: Record<string, string[]> = {
  mfaPolicy: ['optional', 'required_admins', 'required_all'],
  unknownUsagePolicy: ['charge_estimate_input', 'charge_nothing_flag'],
};

/** Éditeur générique d'une section de paramètres plateforme (validation côté serveur). */
@Component({
  selector: 'cap-settings-section',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card space-y-3 p-4" (ngSubmit)="save()">
      <div class="font-medium">{{ title() }}</div>
      @for (k of keys(); track k) {
        @let v = values()[k];
        <div class="grid items-center gap-2 text-sm md:grid-cols-2">
          <label class="text-stone-700 dark:text-stone-300" [for]="section() + k">{{ label(k) }}</label>
          @if (enums[k]) {
            <select class="input" [id]="section() + k" [name]="k" [ngModel]="v" (ngModelChange)="set(k, $event)">@for (o of enums[k]; track o) { <option [value]="o">{{ o }}</option> }</select>
          } @else if (typeof v === 'boolean') {
            <input type="checkbox" [id]="section() + k" [name]="k" [ngModel]="v" (ngModelChange)="set(k, $event)" class="h-4 w-4 justify-self-start" />
          } @else if (typeof v === 'number') {
            <input class="input" type="number" [id]="section() + k" [name]="k" [ngModel]="v" (ngModelChange)="set(k, +$event)" />
          } @else if (isArray(v)) {
            <textarea class="input font-mono text-xs" rows="4" [id]="section() + k" [name]="k" [ngModel]="asLines(v)" (ngModelChange)="set(k, toLines($event))"></textarea>
          } @else {
            <input class="input" [id]="section() + k" [name]="k" [ngModel]="v" (ngModelChange)="set(k, $event)" />
          }
        </div>
      }
      <button class="btn-primary">Enregistrer</button>
    </form>
  `,
})
export class SettingsSection implements OnInit {
  readonly section = input.required<Section>();
  readonly title = input('');
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly values = signal<Record<string, unknown>>({});
  protected readonly keys = signal<string[]>([]);
  protected readonly enums = ENUMS;
  protected readonly isArray = Array.isArray;

  async ngOnInit() {
    const all = await this.api.get<PlatformSettings>('/admin/settings');
    const v = all[this.section()] as unknown as Record<string, unknown>;
    this.values.set({ ...v });
    this.keys.set(Object.keys(v));
  }
  protected label(k: string) {
    return LABELS[k] ?? k;
  }
  protected set(k: string, v: unknown) {
    this.values.update((x) => ({ ...x, [k]: v }));
  }
  protected asLines(v: unknown) {
    return (v as string[]).join('\n');
  }
  protected toLines(s: string) {
    return s.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  protected async save() {
    try {
      await this.api.patch('/admin/settings', { section: this.section(), values: this.values() });
      this.toast.show('Paramètres enregistrés', 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }
}
