import { ConfirmService } from '../../core/confirm.service';
import { AdminSkillCategories } from './admin-skill-categories';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AuditEventDto, SkillDto } from '@cap/contracts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AgoPipe, BytesPipe } from '../../shared/pipes';
import { SettingsSection } from './settings-section';
import { AdminServices } from './admin-services';
import { t, tr } from '../../core/i18n';

type Row = Record<string, never>;

@Component({
  selector: 'cap-admin-sandboxes',
  imports: [FormsModule, SettingsSection, AgoPipe, AdminServices],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Sandboxes & previews') }}</h1>
    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <cap-settings-section section="sandbox" [title]="t('Ressources, inactivité, réseau sortant')" [exclude]="startupKeys" />
      <div class="space-y-4">
        <cap-settings-section section="previews" [title]="t('Previews (proxy de ports)')" />
        <cap-settings-section section="editor" [title]="t('Éditeur')" />
        <cap-settings-section section="attachments" [title]="t('Pièces jointes')" />
      </div>
    </div>
    <h2 class="mt-6 mb-1 text-sm font-semibold text-stone-500 uppercase">{{ t('Script de démarrage') }}</h2>
    <p class="mb-2 max-w-3xl text-sm text-stone-500">
      {{ t('Exécuté en bash (set -e) dans /workspace, au démarrage de chaque sandbox (avec ou sans dépôt), avant le premier message traité par l’agent.') }}
      {{ t('Rejoué à chaque nouvelle sandbox et quand il change : il doit être idempotent. Sa sortie s’affiche dans la conversation ; en cas d’échec, l’agent est prévenu et le travail continue.') }}
      {{ t('Les hôtes contactés (registre privé…) doivent figurer dans le réseau sortant autorisé ci-dessus.') }}
    </p>
    <cap-settings-section section="sandbox" [title]="t('Registres, miroirs, outils')" [only]="startupKeys" />
    <cap-admin-services />
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Instances') }}</h2>
    <div class="card overflow-x-auto"><table class="table">
      <thead><tr><th>{{ t('Workspace') }}</th><th>{{ t('Propriétaire') }}</th><th>{{ t('Statut') }}</th><th>{{ t('Fournisseur') }}</th><th>{{ t('Activité') }}</th><th></th></tr></thead>
      <tbody>@for (r of instances(); track r['s']['id']) {
        <tr><td>{{ r['workspace'] }}</td><td>{{ r['owner'] }}</td><td>{{ r['s']['status'] }} @if (r['s']['destroyReason']) { <span class="text-xs text-stone-500">({{ r['s']['destroyReason'] }})</span> }</td><td>{{ r['s']['provider'] }}</td><td class="text-xs">{{ r['s']['lastActivityAt'] | ago }}</td>
        <td class="text-right">@if (r['s']['status'] === 'running') { <button class="btn-ghost !py-0.5 text-xs" (click)="stop(r['s']['workspaceId'], false)">{{ t('Arrêter') }}</button><button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="stop(r['s']['workspaceId'], true)">{{ t('Forcer') }}</button> }</td></tr>
      }</tbody>
    </table></div>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Images officielles') }}</h2>
    <div class="card overflow-x-auto"><table class="table">
      <thead><tr><th>{{ t('Image') }}</th><th>Digest</th><th>{{ t('Agent') }}</th><th>{{ t('Statut') }}</th><th></th></tr></thead>
      <tbody>@for (i of images(); track i['id']) {
        <tr><td>{{ i['name'] }}:{{ i['version'] }} <div class="font-mono text-xs text-stone-500">{{ i['reference'] }}</div></td><td class="font-mono text-xs">{{ i['digest'] ?? '—' }}</td><td>{{ i['piVersion'] }}</td><td>{{ i['status'] }} @if (i['isDefault']) { {{ t('(défaut)') }} }</td>
        <td class="text-right">@if (!i['isDefault']) { <button class="btn-ghost !py-0.5 text-xs" (click)="activate(i['id'])">{{ t('Activer') }}</button> }</td></tr>
      } @empty { <tr><td colspan="5" class="text-stone-500">{{ t('Aucune image enregistrée : l’image par défaut de la configuration est utilisée.') }}</td></tr> }</tbody>
    </table></div>
    <form class="card mt-3 grid gap-2 p-4 md:grid-cols-5" (ngSubmit)="addImage()">
      <input class="input" name="n" [placeholder]="t('nom')" [(ngModel)]="img.name" /><input class="input" name="v" [placeholder]="t('version')" [(ngModel)]="img.version" />
      <input class="input" name="r" [placeholder]="t('référence (registre/shipcove-sandbox:0.1.0)')" [(ngModel)]="img.reference" /><input class="input" name="d" placeholder="sha256:…" [(ngModel)]="img.digest" />
      <input class="input" name="p" [placeholder]="t('version de l’agent')" [(ngModel)]="img.piVersion" />
      <button class="btn-secondary md:w-fit">{{ t('Enregistrer l’image') }}</button>
    </form>
  `,
})
export class AdminSandboxes implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly instances = signal<Array<Record<string, Row>>>([]);
  protected readonly images = signal<Row[]>([]);
  protected img = { name: 'shipcove-sandbox', version: '', reference: '', digest: '', piVersion: '0.73.1' };
  /** Réglages du script de démarrage, présentés dans leur propre carte. */
  protected readonly startupKeys = ['startupScript', 'setupTimeoutMinutes'];
  async ngOnInit() {
    this.instances.set(await this.api.get('/admin/sandboxes'));
    this.images.set(await this.api.get('/admin/sandbox-images'));
  }
  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await this.ngOnInit();
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected stop(workspaceId: string, force: boolean) {
    if (force && !confirm(t('Forcer la destruction peut perdre des écritures non sauvegardées. Continuer ?'))) return;
    return this.act(() => this.api.post(`/admin/sandboxes/${workspaceId}/stop`, { force }));
  }
  protected activate(id: string) {
    return this.act(() => this.api.post(`/admin/sandbox-images/${id}/activate`));
  }
  protected addImage() {
    return this.act(() => this.api.post('/admin/sandbox-images', { ...this.img, digest: this.img.digest || undefined }));
  }
}

@Component({
  selector: 'cap-admin-extensions',
  imports: [RouterLink, SettingsSection, AdminSkillCategories],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Skills & MCP') }}</h1>
    <p class="text-sm text-stone-500">{{ t('Gestion du catalogue global et des serveurs MCP :') }} <a routerLink="/extensions" class="underline">{{ t('page Skills & MCP') }}</a> {{ t('(les actions de portée globale y sont disponibles pour les administrateurs).') }}</p>
    <cap-admin-skill-categories />
    <div class="mt-4 grid gap-4 lg:grid-cols-2"><cap-settings-section section="skills" [title]="t('Politique des skills')" /><cap-settings-section section="mcp" [title]="t('Politique MCP')" /></div>
    @if (pending().length) {
      <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Skills personnels en attente de validation') }}</h2>
      <div class="card divide-y divide-stone-100 dark:divide-stone-800">
        @for (s of pending(); track s.id) {
          <div class="flex flex-wrap items-start gap-2 px-4 py-3 text-sm">
            <div class="min-w-0 flex-1"><a [routerLink]="['/extensions/skills', s.id]" class="font-mono font-medium hover:underline">{{ s.name }}</a> <span class="text-xs text-stone-500">{{ t('{n} fichier(s)', { n: s.fileCount }) }}</span>
              <div class="text-xs text-stone-500">{{ s.description }}</div>
              @if (s.findings.length) { <ul class="list-disc pl-5 text-xs text-amber-700">@for (f of s.findings; track f) { <li>{{ tr(f) }}</li> }</ul> }</div>
            <button class="btn-primary !py-0.5 text-xs" (click)="approve(s)">{{ t('Valider') }}</button>
            <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(s)">{{ t('Supprimer') }}</button>
          </div>
        }
      </div>
    }
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Skills globaux') }}</h2>
    <p class="mb-2 text-xs text-stone-500">{{ t('« Activé par défaut » s’applique à tous les utilisateurs qui n’ont pas fait leur propre choix ; chacun garde la main sur son interrupteur.') }}</p>
    <div class="card divide-y divide-stone-100 dark:divide-stone-800">
      @for (s of globals(); track s.id) {
        <div class="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
          <div class="min-w-0 flex-1"><a [routerLink]="['/extensions/skills', s.id]" class="font-mono font-medium hover:underline">{{ s.name }}</a> <span class="text-xs text-stone-500">{{ t('{n} fichier(s)', { n: s.fileCount }) }}</span>
            @if (s.findings.length) { <span class="ml-1 text-xs text-amber-700" [title]="s.findings.join('\n')">⚠ {{ s.findings.length }}</span> }</div>
          <label class="flex cursor-pointer items-center gap-2 text-xs" [class]="s.enabledByDefault ? 'text-emerald-700 dark:text-emerald-400' : 'text-stone-500'">
            {{ t('Activé par défaut') }}
            <input type="checkbox" class="peer sr-only" [checked]="s.enabledByDefault" (change)="setDefault(s)" [attr.aria-label]="t('Activé par défaut : {name}', { name: s.name })" />
            <span class="relative h-5 w-9 rounded-full bg-stone-300 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4 dark:bg-stone-700"></span>
          </label>
          <button class="btn-ghost !py-0.5 text-xs text-red-600" (click)="remove(s)">{{ t('Supprimer') }}</button>
        </div>
      } @empty { <p class="px-4 py-3 text-sm text-stone-500">{{ t('Aucun skill global.') }}</p> }
    </div>
  `,
})
export class AdminExtensions implements OnInit {
  protected readonly t = t;
  protected readonly tr = tr;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly globals = signal<SkillDto[]>([]);
  protected readonly pending = signal<SkillDto[]>([]);
  async ngOnInit() {
    const [all, pending] = await Promise.all([this.api.get<SkillDto[]>('/skills'), this.api.get<SkillDto[]>('/skills/review/pending').catch(() => [] as SkillDto[])]);
    this.globals.set(all.filter((s) => s.scope === 'global'));
    this.pending.set(pending);
  }
  protected async setDefault(s: SkillDto) {
    await this.api.put(`/skills/${s.id}/installation`, { scope: 'global', enabled: !s.enabledByDefault }).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
  protected async approve(s: SkillDto) {
    await this.api.post(`/skills/${s.id}/approve`).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
  protected async remove(s: SkillDto) {
    const ok = await this.confirm.ask({ title: t('Supprimer le skill ?'), message: s.scope === 'global' ? t('{subject} sera supprimé pour tous les utilisateurs.') : t('{subject} sera supprimé.'), subject: s.name, confirmLabel: t('Supprimer'), danger: true });
    if (!ok) return;
    await this.api.delete(`/skills/${s.id}`).catch((e) => this.toast.error(e));
    await this.ngOnInit();
  }
}

@Component({
  selector: 'cap-admin-secrets',
  imports: [BytesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Secrets & stockage') }}</h1>
    <p class="text-sm text-stone-500">{{ t('Les valeurs des secrets ne sont jamais affichées : seules les références, versions et l’état de Vault le sont.') }}</p>
    @if (secrets(); as s) {
      <div class="card mt-4 p-4 text-sm">
        <div class="font-medium">HashiCorp Vault : <span [class]="s['health']['ok'] ? 'text-emerald-700' : 'text-red-600'">{{ s['health']['ok'] ? t('disponible') : t('indisponible') }}</span> <span class="text-xs text-stone-500">{{ s['health']['version'] }} {{ s['health']['detail'] }}</span></div>
        <table class="table mt-2"><thead><tr><th>{{ t('Référence') }}</th><th>{{ t('Configuré') }}</th><th>{{ t('Version') }}</th><th>{{ t('Mise à jour') }}</th></tr></thead>
          <tbody>@for (r of s['infrastructure']; track r['ref']) { <tr><td class="font-mono text-xs">{{ r['ref'] }}</td><td>{{ r['configured'] ? t('oui') : t('non') }}</td><td>{{ r['version'] ?? '—' }}</td><td class="text-xs">{{ r['updatedAt'] ?? '—' }}</td></tr> }</tbody></table>
      </div>
    }
    @if (storage(); as st) {
      <div class="card mt-4 p-4 text-sm">
        <div class="font-medium">{{ t('Stockage objet (S3) :') }} <span [class]="st['health']['ok'] ? 'text-emerald-700' : 'text-red-600'">{{ st['health']['ok'] ? t('disponible') : t('indisponible') }}</span></div>
        <div class="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div>{{ t('Workspaces : {n}', { n: st['stats']['workspaces'] }) }}</div><div>{{ t('Checkpoints : {n}', { n: st['stats']['snapshots'] }) }}</div>
          <div>{{ t('Volume courant : {size}', { size: (+st['stats']['current_bytes'] | bytes) }) }}</div><div>{{ t('Téléversé cumulé : {size}', { size: (+st['stats']['bytes_uploaded'] | bytes) }) }}</div>
        </div>
        @if (st['unsynced'].length) { <div class="mt-2 text-red-600">{{ t('Non synchronisés :') }} @for (u of st['unsynced']; track u['id']) { {{ u['name'] }} } </div> }
      </div>
    }
  `,
})
export class AdminSecrets implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  // Réponses d'administration non typées dans les contrats (structure libre côté API).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly secrets = signal<Record<string, any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly storage = signal<Record<string, any> | null>(null);
  async ngOnInit() {
    this.secrets.set(await this.api.get('/admin/secrets'));
    this.storage.set(await this.api.get('/admin/storage'));
  }
}

@Component({
  selector: 'cap-admin-notifications',
  imports: [FormsModule, SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Notifications & SMTP') }}</h1>
    <form class="card mt-4 grid gap-2 p-4 md:grid-cols-3" (ngSubmit)="saveSmtp()">
      <div class="font-medium md:col-span-3">{{ t('Serveur SMTP') }} @if (smtp()['configured']) { <span class="text-xs text-emerald-700">{{ t('configuré') }}</span> }</div>
      <input class="input" name="h" [placeholder]="t('hôte')" [(ngModel)]="s.host" /><input class="input" type="number" name="p" placeholder="port" [(ngModel)]="s.port" />
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="sec" [(ngModel)]="s.secure" /> {{ t('TLS implicite') }}</label>
      <input class="input" name="u" [placeholder]="t('utilisateur')" [(ngModel)]="s.username" /><input class="input" type="password" name="pw" [placeholder]="t('mot de passe (Vault)')" [(ngModel)]="s.password" />
      <input class="input" name="f" [placeholder]="t('expéditeur')" [(ngModel)]="s.fromAddress" />
      <div class="flex gap-2 md:col-span-3"><button class="btn-primary">{{ t('Enregistrer') }}</button><input class="input !w-64" name="to" [placeholder]="t('adresse de test')" [(ngModel)]="testTo" /><button type="button" class="btn-secondary" (click)="test()">{{ t('Envoyer un test') }}</button></div>
    </form>
    <div class="mt-4"><cap-settings-section section="notifications" [title]="t('Canaux et politiques')" /></div>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Templates d’emails') }}</h2>
    <form class="card space-y-2 p-4" (ngSubmit)="saveTemplate()">
      <select class="input" name="k" [(ngModel)]="tpl.key" (ngModelChange)="pick()">@for (k of keys; track k) { <option [value]="k">{{ k }}</option> }</select>
      <input class="input" name="sub" [placeholder]="t('Sujet (variables entre doubles accolades)')" [(ngModel)]="tpl.subject" />
      <textarea class="input font-mono text-xs" rows="6" name="body" [(ngModel)]="tpl.bodyText"></textarea>
      <button class="btn-primary">{{ t('Enregistrer le template') }}</button>
    </form>
  `,
})
export class AdminNotifications implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly smtp = signal<Record<string, unknown>>({});
  protected s = { host: '', port: 587, secure: false, username: '', password: '', fromAddress: '' };
  protected testTo = '';
  protected readonly keys = ['auth.verify_email', 'auth.password_reset', 'auth.invitation', 'notification.generic', 'admin.smtp_test'];
  protected tpl = { key: 'auth.verify_email', subject: '', bodyText: '' };
  private templates: Array<{ key: string; subject: string; bodyText: string }> = [];

  async ngOnInit() {
    const smtp = await this.api.get<Record<string, unknown>>('/admin/smtp');
    this.smtp.set(smtp);
    if (smtp['configured']) this.s = { host: String(smtp['host']), port: Number(smtp['port']), secure: smtp['secure'] === 'true', username: String(smtp['username'] ?? ''), password: '', fromAddress: String(smtp['fromAddress']) };
    this.templates = await this.api.get('/admin/email-templates');
    this.pick();
  }
  protected pick() {
    const found = this.templates.find((x) => x.key === this.tpl.key);
    this.tpl = { key: this.tpl.key, subject: found?.subject ?? '', bodyText: found?.bodyText ?? '' };
  }
  protected async saveSmtp() {
    try {
      await this.api.put('/admin/smtp', { ...this.s, port: Number(this.s.port), password: this.s.password || undefined, username: this.s.username || undefined });
      this.toast.show(t('SMTP enregistré (Vault)'), 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected async test() {
    const r = await this.api.post<{ ok: boolean; detail?: string }>('/admin/smtp/test', { to: this.testTo }).catch((e) => ({ ok: false, detail: e.message }));
    this.toast.show(r.ok ? t('Email de test envoyé') : t('Échec : {detail}', { detail: tr(r.detail) }), r.ok ? 'success' : 'error');
  }
  protected async saveTemplate() {
    try {
      await this.api.put(`/admin/email-templates/${this.tpl.key}`, { subject: this.tpl.subject, bodyText: this.tpl.bodyText });
      this.toast.show(t('Template enregistré'), 'success');
      this.templates = await this.api.get('/admin/email-templates');
    } catch (e) {
      this.toast.error(e);
    }
  }
}

@Component({
  selector: 'cap-admin-audit',
  imports: [FormsModule, AgoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-semibold">{{ t('Audit & rétention') }}</h1>
    <form class="mt-4 flex flex-wrap gap-2" (ngSubmit)="search()">
      <input class="input !w-56" name="a" [placeholder]="t('action (préfixe), ex. auth.')" [(ngModel)]="q.action" />
      <input class="input sm:!w-72" name="t" [placeholder]="t('identifiant de cible')" [(ngModel)]="q.targetId" />
      <button class="btn-secondary">{{ t('Rechercher') }}</button>
      <a class="btn-secondary" [href]="exportUrl()">{{ t('Exporter (CSV)') }}</a>
    </form>
    <div class="card mt-3 max-h-[28rem] overflow-auto"><table class="table">
      <thead><tr><th>{{ t('Date') }}</th><th>{{ t('Acteur') }}</th><th>{{ t('Action') }}</th><th>{{ t('Cible') }}</th><th>{{ t('Résultat') }}</th><th>IP</th></tr></thead>
      <tbody>@for (e of events(); track e.id) {
        <tr><td class="text-xs">{{ e.occurredAt | ago }}</td><td class="text-xs">{{ e.actorLabel ?? e.actorId ?? t('système') }}</td><td class="font-mono text-xs">{{ e.action }}</td><td class="text-xs">{{ e.targetType }} {{ e.targetId }}</td>
        <td [class.text-red-600]="e.outcome === 'failure'">{{ e.outcome }}</td><td class="text-xs">{{ e.ip }}</td></tr>
      }</tbody>
    </table></div>
    <h2 class="mt-6 mb-2 text-sm font-semibold text-stone-500 uppercase">{{ t('Durées de rétention (administrateur plateforme uniquement)') }}</h2>
    <div class="card overflow-x-auto"><table class="table">
      <thead><tr><th>{{ t('Données') }}</th><th>{{ t('Durée (jours, vide = illimitée)') }}</th><th>{{ t('Gel légal') }}</th><th></th></tr></thead>
      <tbody>@for (r of retention(); track r.dataType) {
        <tr><td>{{ r.dataType }}</td><td><input class="input !w-32 !py-0.5" type="number" [(ngModel)]="r.retentionDays" [name]="'d' + r.dataType" /></td><td><input type="checkbox" [(ngModel)]="r.legalHold" [name]="'h' + r.dataType" /></td>
        <td class="text-right"><button class="btn-ghost !py-0.5 text-xs" (click)="saveRetention(r)">{{ t('Enregistrer') }}</button></td></tr>
      }</tbody>
    </table></div>
    <div class="mt-6 mb-2 flex items-center"><h2 class="text-sm font-semibold text-stone-500 uppercase">{{ t('Dernières purges') }}</h2>
      <button class="btn-secondary ml-auto !py-1 text-xs" (click)="runRetention()" [title]="t('Exécutée aussi automatiquement toutes les heures')">{{ t('Lancer la purge maintenant') }}</button></div>
    <div class="card max-h-64 overflow-auto"><table class="table">
      <thead><tr><th>{{ t('Date') }}</th><th>{{ t('Type') }}</th><th>{{ t('Statut') }}</th><th>{{ t('Statistiques') }}</th></tr></thead>
      <tbody>@for (j of jobs(); track j['id']) { <tr><td class="text-xs">{{ j['createdAt'] | ago }}</td><td>{{ j['dataType'] ?? j['kind'] }}</td><td>{{ j['status'] }}</td><td class="text-xs">{{ stats(j['stats']) }}</td></tr> }</tbody>
    </table></div>
  `,
})
export class AdminAudit implements OnInit {
  protected readonly t = t;
  private readonly api = inject(Api);
  private readonly toast = inject(ToastService);
  protected readonly events = signal<AuditEventDto[]>([]);
  protected readonly retention = signal<Array<{ dataType: string; retentionDays: number | null; legalHold: boolean }>>([]);
  protected readonly jobs = signal<Row[]>([]);
  protected q = { action: '', targetId: '' };

  async ngOnInit() {
    await this.search();
    this.retention.set(await this.api.get('/admin/retention'));
    this.jobs.set(await this.api.get('/admin/deletion-jobs'));
  }
  async search() {
    this.events.set(await this.api.get<AuditEventDto[]>('/admin/audit', { action: this.q.action, targetId: this.q.targetId, limit: 200 }));
  }
  protected exportUrl() {
    const p = new URLSearchParams();
    if (this.q.action) p.set('action', this.q.action);
    if (this.q.targetId) p.set('targetId', this.q.targetId);
    return `/api/v1/admin/audit/export?${p}`;
  }
  protected stats(s: unknown) {
    return JSON.stringify(s);
  }
  protected async runRetention() {
    if (!confirm(t('Lancer maintenant la purge selon les durées de rétention ? Les données expirées seront supprimées définitivement (sauf gel légal).'))) return;
    try {
      await this.api.post('/admin/retention/run');
      this.toast.show(t('Purge lancée : les résultats apparaissent ci-dessous'), 'success');
      setTimeout(() => void this.api.get<Row[]>('/admin/deletion-jobs').then((j) => this.jobs.set(j)), 5000);
    } catch (e) {
      this.toast.error(e);
    }
  }
  protected async saveRetention(r: { dataType: string; retentionDays: number | null; legalHold: boolean }) {
    try {
      await this.api.put('/admin/retention', { dataType: r.dataType, retentionDays: r.retentionDays === null || (r.retentionDays as unknown) === '' ? null : Number(r.retentionDays), legalHold: r.legalHold });
      this.toast.show(t('Rétention enregistrée'), 'success');
    } catch (e) {
      this.toast.error(e);
    }
  }
}
