import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { NotificationType } from '@cap/contracts';
import { notificationPreferences, notifications, users, type Database, type DbOrTx } from '@cap/database';
import { DB } from '../tokens.js';
import { JobsService } from '../jobs/jobs.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Valeurs par défaut des préférences (in-app toujours, email pour les événements importants). */
const DEFAULTS: Record<NotificationType, { inApp: boolean; email: boolean }> = {
  'run.completed': { inApp: true, email: false },
  'run.failed': { inApp: true, email: true },
  'approval.required': { inApp: true, email: true },
  'quota.reached': { inApp: true, email: true },
  'quota.available': { inApp: true, email: false },
  'checkpoint.failed': { inApp: true, email: true },
  invitation: { inApp: true, email: true },
  security: { inApp: true, email: true },
};

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
  /** Évite les doublons (ex. `approval:<id>`). */
  dedupeKey?: string;
  /** Variables du template email. */
  emailVars?: Record<string, string>;
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
  ) {}

  async preferencesFor(userId: string, type: NotificationType): Promise<{ inApp: boolean; email: boolean; locked: boolean }> {
    const policy = await this.settings.section('notifications');
    const mandatory = policy.mandatoryEmailTypes.includes(type) || type === 'security';
    const [pref] = await this.db
      .select()
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type)));
    const base = pref ?? DEFAULTS[type];
    return {
      // Les notifications de sécurité ne peuvent pas être désactivées individuellement.
      inApp: mandatory ? true : base.inApp,
      email: policy.emailEnabled && (mandatory ? true : base.email),
      locked: mandatory,
    };
  }

  async notify(input: NotifyInput, tx?: DbOrTx): Promise<void> {
    const exec = tx ?? this.db;
    const prefs = await this.preferencesFor(input.userId, input.type);
    let notificationId: string | null = null;
    if (prefs.inApp) {
      const rows = await exec
        .insert(notifications)
        .values({
          userId: input.userId,
          type: input.type,
          title: input.title.slice(0, 300),
          body: input.body.slice(0, 4000),
          link: input.link ?? null,
          dedupeKey: input.dedupeKey ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      notificationId = rows[0]?.id ?? null;
      if (!notificationId && input.dedupeKey) return; // déjà notifié
    }
    if (prefs.email) {
      const [u] = await exec.select({ email: users.email, name: users.displayName, status: users.status }).from(users).where(eq(users.id, input.userId));
      if (!u || u.status === 'deleted') return;
      const key = `notif:${input.type}:${input.dedupeKey ?? notificationId ?? Date.now()}:${input.userId}`;
      await this.jobs.enqueue(
        'email.send',
        {
          idempotencyKey: key,
          userId: input.userId,
          to: u.email,
          template: `notification.${input.type}`,
          vars: { name: u.name, title: input.title, body: input.body, link: input.link ?? '', ...(input.emailVars ?? {}) },
        },
        { dedupeKey: key },
        exec,
      );
    }
  }

  /** Email transactionnel direct (vérification, réinitialisation, invitation). */
  async sendEmail(input: { to: string; userId?: string | null; template: string; vars: Record<string, string>; idempotencyKey: string }, tx?: DbOrTx) {
    await this.jobs.enqueue('email.send', input, { dedupeKey: input.idempotencyKey }, tx);
  }
}
