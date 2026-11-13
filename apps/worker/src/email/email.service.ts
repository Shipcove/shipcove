import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { SecretProvider } from '@cap/secrets';
import { emailDeliveries, emailTemplates, type Database } from '@cap/database';
import { DB, ENV, SECRETS, redactString, type BaseEnv } from '@cap/server-core';
import { JobRunner, PermanentJobError } from '../jobs/job-runner.service.js';
import { DEFAULT_TEMPLATES, render } from './templates.js';

interface EmailJob {
  idempotencyKey: string;
  userId?: string | null;
  to: string;
  template: string;
  vars: Record<string, string>;
}

export const SMTP_SECRET_REF = 'vault:infra/smtp';

/** Envoi asynchrone, idempotent (`email_deliveries.idempotency_key`), avec retries du moteur de jobs. */
@Injectable()
export class EmailService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Email');

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    @Inject(ENV) private readonly env: BaseEnv,
    private readonly runner: JobRunner,
  ) {}

  onApplicationBootstrap(): void {
    this.runner.register('email.send', (p, job) => this.send(p as EmailJob, job.attempts, job.maxAttempts), { concurrency: 4 });
  }

  async smtpConfig(): Promise<Record<string, string> | null> {
    try {
      return await this.secrets.read(SMTP_SECRET_REF);
    } catch {
      return null;
    }
  }

  async send(job: EmailJob, attempt: number, maxAttempts: number): Promise<{ status: string }> {
    const [existing] = await this.db.select().from(emailDeliveries).where(eq(emailDeliveries.idempotencyKey, job.idempotencyKey));
    if (existing?.status === 'sent') return { status: 'already_sent' };
    const tpl = await this.template(job.template);
    if (job.vars.link?.startsWith('/')) job.vars = { ...job.vars, link: `${this.env.PUBLIC_URL.replace(/\/$/, '')}${job.vars.link}` };
    const subject = render(tpl.subject, job.vars);
    if (!existing) {
      await this.db
        .insert(emailDeliveries)
        .values({ idempotencyKey: job.idempotencyKey, userId: job.userId ?? null, toAddress: job.to, template: job.template, subject })
        .onConflictDoNothing();
    }
    const smtp = await this.smtpConfig();
    if (!smtp?.host) {
      await this.mark(job.idempotencyKey, 'failed', 'SMTP non configuré', attempt);
      throw new Error('SMTP non configuré (administration > notifications)');
    }
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port ?? 587),
      secure: smtp.secure === 'true',
      auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
      connectionTimeout: 15_000,
    });
    try {
      const info = await transport.sendMail({
        from: smtp.fromName ? `"${smtp.fromName}" <${smtp.fromAddress}>` : smtp.fromAddress,
        to: job.to,
        subject,
        text: render(tpl.bodyText, job.vars),
        ...(tpl.bodyHtml ? { html: render(tpl.bodyHtml, job.vars, true) } : {}),
        headers: { 'X-Cap-Idempotency-Key': job.idempotencyKey },
      });
      await this.db
        .update(emailDeliveries)
        .set({ status: 'sent', sentAt: new Date(), providerMessageId: info.messageId, attempts: attempt, lastError: null })
        .where(eq(emailDeliveries.idempotencyKey, job.idempotencyKey));
      return { status: 'sent' };
    } catch (err) {
      const msg = redactString((err as Error).message);
      const permanent = /^5\d\d/.test(String((err as { responseCode?: number }).responseCode ?? ''));
      await this.mark(job.idempotencyKey, permanent || attempt >= maxAttempts ? 'dead' : 'failed', msg, attempt);
      if (permanent) throw new PermanentJobError(msg);
      throw err;
    }
  }

  /** Envoi de test depuis l'administration. */
  async test(to: string): Promise<void> {
    await this.send({ idempotencyKey: `test:${Date.now()}`, to, template: 'admin.smtp_test', vars: {} }, 1, 1);
  }

  private async mark(key: string, status: 'failed' | 'dead', error: string, attempts: number) {
    await this.db.update(emailDeliveries).set({ status, lastError: error, attempts }).where(eq(emailDeliveries.idempotencyKey, key));
  }

  private async template(key: string) {
    const [row] = await this.db.select().from(emailTemplates).where(and(eq(emailTemplates.key, key), eq(emailTemplates.locale, 'fr')));
    if (row) return row;
    const generic = key.startsWith('notification.') ? DEFAULT_TEMPLATES['notification.generic'] : undefined;
    const tpl = DEFAULT_TEMPLATES[key] ?? generic;
    if (!tpl) throw new PermanentJobError(`Template inconnu : ${key}`);
    return { ...tpl, bodyHtml: tpl.bodyHtml ?? null };
  }
}
