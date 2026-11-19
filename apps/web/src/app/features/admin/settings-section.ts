import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PlatformSettings } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { t } from '../../core/i18n';

type Section = keyof PlatformSettings;

const LABELS: Record<string, string> = {
  localLoginEnabled: t('Connexion locale (login / mot de passe)'),
  registrationEnabled: t('Inscription libre'),
  emailVerificationRequired: t('Vérification d’email obligatoire'),
  mfaPolicy: t('Politique MFA'),
  sessionIdleHours: t('Expiration de session après inactivité (h)'),
  sessionAbsoluteHours: t('Durée maximale de session (h)'),
  maxFailedLogins: t('Échecs avant verrouillage'),
  lockoutMinutes: t('Durée de verrouillage (min)'),
  manualEditingEnabled: t('Édition manuelle des fichiers dans l’interface'),
  idleTimeoutMinutes: t('Destruction après inactivité (min)'),
  maxRunMinutes: t('Durée maximale d’un run (min)'),
  cpu: t('CPU par sandbox'),
  memoryMb: t('Mémoire par sandbox (Mo)'),
  diskMb: t('Disque par sandbox (Mo)'),
  pidsLimit: t('Processus max'),
  maxActiveSandboxesPerUser: t('Sandboxes actives par utilisateur'),
  maxActiveSandboxesTotal: t('Sandboxes actives au total'),
  egressAllowlist: t('Domaines autorisés en sortie (un par ligne)'),
  excludeDependencyDirs: t('Ne pas sauvegarder les dépendances et caches (node_modules, .venv, __pycache__…)'),
  checkpointExcludes: t('Exclusions supplémentaires des checkpoints (motifs, un par ligne)'),
  maxPortsPerWorkspace: t('Ports de preview simultanés par workspace'),
  allowedPorts: t('Ports autorisés pour les previews (un port ou une plage par ligne, ex. 3000-9999)'),
  enabled: t('Activé'),
  defaultOutputReservation: t('Réservation de sortie par défaut (tokens)'),
  unknownUsagePolicy: t('Usage inconnu après réconciliation'),
  maxFileMb: t('Taille max par fichier (Mo)'),
  maxFilesPerMessage: t('Fichiers par message'),
  allowArchives: t('Autoriser les archives'),
  maxArchiveEntries: t('Entrées max d’archive'),
  maxArchiveExpandedMb: t('Taille décompressée max (Mo)'),
  personalSkillsAllowed: t('Skills personnels autorisés'),
  personalSkillsRequireReview: t('Revue obligatoire des skills personnels'),
  personalServersAllowed: t('Serveurs MCP personnels autorisés'),
  allowedRemoteHosts: t('Hôtes MCP distants autorisés (portée personnelle)'),
  insecureHttpHosts: t('Forges auto-hébergées joignables en HTTP (hôte[:port] ; vide = HTTPS obligatoire)'),
  maxServicesPerWorkspace: t('Services lancés par l’agent : nombre max. par sandbox'),
  setupTimeoutMinutes: t('Durée max. du script de démarrage (min)'),
  startupScript: t('Script bash exécuté au démarrage de chaque sandbox'),
  allowPersonalTokens: t('Autoriser les jetons d’accès personnels (sinon : OAuth uniquement)'),
  coAuthorEmail: t('Adresse du co-auteur « Shipcove » ajouté à chaque commit (vide : aucune mention)'),
  maxTasks: t('Sous-agents par appel (max.)'),
  maxParallel: t('Sous-agents d’exploration en même temps (max.)'),
  timeoutMinutes: t('Durée max. d’un sous-agent (min)'),
  emailEnabled: t('Envoi d’emails'),
  mandatoryEmailTypes: t('Emails imposés (types)'),
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
          } @else if (multiline.has(k)) {
            <textarea class="input font-mono text-xs md:col-span-2" rows="12" spellcheck="false" [id]="section() + k" [name]="k" [ngModel]="v" (ngModelChange)="set(k, $event)"></textarea>
          } @else if (isArray(v)) {
            <textarea class="input font-mono text-xs" rows="4" [id]="section() + k" [name]="k" [ngModel]="asLines(v)" (ngModelChange)="set(k, toLines($event))"></textarea>
          } @else {
            <input class="input" [id]="section() + k" [name]="k" [ngModel]="v" (ngModelChange)="set(k, $event)" />
          }
        </div>
      }
      <button class="btn-primary">{{ t('Enregistrer') }}</button>
    </form>
  `,
})
export class SettingsSection implements OnInit {
  protected readonly t = t;
  readonly section = input.required<Section>();
  readonly title = input('');
  /** Clés affichées (toutes par défaut) ; permet de répartir une section sur plusieurs cartes. */
  readonly only = input<string[] | null>(null);
  /** Clés masquées (affichées dans une autre carte). */
  readonly exclude = input<string[]>([]);
  /** Texte libre sur plusieurs lignes (scripts). */
  protected readonly multiline = new Set(['startupScript']);
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly values = signal<Record<string, unknown>>({});
  protected readonly keys = signal<string[]>([]);
  protected readonly enums = ENUMS;
  protected readonly isArray = Array.isArray;

  async ngOnInit() {
    const all = await this.api.get<PlatformSettings>('/admin/settings');
    const v = all[this.section()] as unknown as Record<string, unknown>;
    const only = this.only();
    const keys = Object.keys(v).filter((k) => (!only || only.includes(k)) && !this.exclude().includes(k));
    this.values.set(Object.fromEntries(keys.map((k) => [k, v[k]])));
    this.keys.set(keys);
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
      this.toast.show(t('Paramètres enregistrés'), 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }
}
