import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { generateSecret, generateURI, verify } from 'otplib';
import type { SecretProvider } from '@cap/secrets';
import { mfaFactors, type Database, type DbOrTx } from '@cap/database';
import { AppError, DB, SECRETS, randomToken, safeEqual, sha256Hex } from '@cap/server-core';

const RECOVERY_CODES = 10;

/**
 * MFA : TOTP (RFC 6238) + codes de récupération à usage unique.
 * - Secret TOTP stocké dans Vault (`mfa/<userId>/totp`), jamais en base.
 * - Protection anti-rejeu : un pas de temps déjà utilisé est refusé.
 * - Architecture extensible (`mfa_factors.type = 'webauthn'` réservé aux passkeys).
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
  ) {}

  async hasConfirmedTotp(userId: string, tx?: DbOrTx): Promise<boolean> {
    const rows = await (tx ?? this.db)
      .select({ id: mfaFactors.id })
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'totp'), isNotNull(mfaFactors.confirmedAt)));
    return rows.length > 0;
  }

  async startEnrollment(userId: string, label: string): Promise<{ secret: string; otpauthUrl: string }> {
    if (await this.hasConfirmedTotp(userId)) throw new AppError('conflict', 'TOTP déjà configuré');
    const secret = generateSecret();
    const ref = await this.secrets.write(`mfa/${userId}/totp-pending`, { secret });
    await this.db.delete(mfaFactors).where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'totp')));
    await this.db.insert(mfaFactors).values({ userId, type: 'totp', secretEnc: ref });
    return { secret, otpauthUrl: generateURI({ issuer: 'Shipcove', label, secret }) };
  }

  /** Confirme l'enrôlement et renvoie les codes de récupération (affichés une seule fois). */
  async confirmEnrollment(userId: string, code: string): Promise<string[]> {
    const [factor] = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'totp')));
    if (!factor?.secretEnc || factor.confirmedAt) throw new AppError('conflict', 'Aucun enrôlement TOTP en cours');
    const secret = await this.secrets.readKey(factor.secretEnc, 'secret');
    if (!secret) throw new AppError('conflict', 'Enrôlement expiré');
    const result = await verify({ secret, token: code, epochTolerance: 30 });
    if (!result.valid) throw new AppError('mfa_invalid', 'Code invalide');
    const finalRef = await this.secrets.write(`mfa/${userId}/totp`, { secret });
    await this.secrets.revoke(factor.secretEnc).catch(() => undefined);
    const codes = Array.from({ length: RECOVERY_CODES }, () => this.formatRecoveryCode(randomToken(10)));
    await this.db.transaction(async (tx) => {
      await tx
        .update(mfaFactors)
        .set({ secretEnc: finalRef, confirmedAt: new Date(), lastUsedStep: 'timeStep' in result ? result.timeStep : null })
        .where(eq(mfaFactors.id, factor.id));
      await tx.delete(mfaFactors).where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'recovery_codes')));
      await tx.insert(mfaFactors).values({
        userId,
        type: 'recovery_codes',
        recoveryCodes: codes.map((c) => ({ hash: sha256Hex(this.normalize(c)), usedAt: null })),
        confirmedAt: new Date(),
      });
    });
    return codes;
  }

  /** Vérifie un code TOTP (anti-rejeu) ou un code de récupération (usage unique). */
  async verifyCode(userId: string, code: string): Promise<'totp' | 'recovery_code' | null> {
    const trimmed = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(trimmed)) {
      const [factor] = await this.db
        .select()
        .from(mfaFactors)
        .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'totp'), isNotNull(mfaFactors.confirmedAt)));
      if (!factor?.secretEnc) return null;
      const secret = await this.secrets.readKey(factor.secretEnc, 'secret');
      if (!secret) return null;
      const result = await verify({
        secret,
        token: trimmed,
        epochTolerance: 30,
        ...(factor.lastUsedStep !== null ? { afterTimeStep: factor.lastUsedStep } : {}),
      });
      if (!result.valid) return null;
      // Mise à jour conditionnelle : deux vérifications concurrentes du même code → une seule gagne.
      const step = 'timeStep' in result ? result.timeStep : null;
      if (step !== null) {
        const updated = await this.db
          .update(mfaFactors)
          .set({ lastUsedStep: step })
          .where(and(eq(mfaFactors.id, factor.id), ...(factor.lastUsedStep === null ? [] : [eq(mfaFactors.lastUsedStep, factor.lastUsedStep)])))
          .returning({ id: mfaFactors.id });
        if (updated.length === 0) return null;
      }
      return 'totp';
    }
    const normalized = this.normalize(trimmed);
    return this.db.transaction(async (tx) => {
      const [factor] = await tx
        .select()
        .from(mfaFactors)
        .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'recovery_codes')))
        .for('update');
      if (!factor?.recoveryCodes) return null;
      const h = sha256Hex(normalized);
      const idx = factor.recoveryCodes.findIndex((c) => !c.usedAt && safeEqual(c.hash, h));
      if (idx === -1) return null;
      const codes = [...factor.recoveryCodes];
      codes[idx] = { ...codes[idx], usedAt: new Date().toISOString() };
      await tx.update(mfaFactors).set({ recoveryCodes: codes }).where(eq(mfaFactors.id, factor.id));
      return 'recovery_code' as const;
    });
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    if (!(await this.hasConfirmedTotp(userId))) throw new AppError('conflict', 'TOTP non configuré');
    const codes = Array.from({ length: RECOVERY_CODES }, () => this.formatRecoveryCode(randomToken(10)));
    await this.db.transaction(async (tx) => {
      await tx.delete(mfaFactors).where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'recovery_codes')));
      await tx.insert(mfaFactors).values({
        userId,
        type: 'recovery_codes',
        recoveryCodes: codes.map((c) => ({ hash: sha256Hex(this.normalize(c)), usedAt: null })),
        confirmedAt: new Date(),
      });
    });
    return codes;
  }

  async disable(userId: string, tx?: DbOrTx): Promise<void> {
    const exec = tx ?? this.db;
    const factors = await exec.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
    for (const f of factors) if (f.secretEnc) await this.secrets.revoke(f.secretEnc).catch(() => undefined);
    await exec.delete(mfaFactors).where(eq(mfaFactors.userId, userId));
  }

  private formatRecoveryCode(raw: string): string {
    const s = raw.replace(/[^A-Za-z0-9]/g, '').toLowerCase().padEnd(12, 'x').slice(0, 12);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  }

  private normalize(code: string): string {
    return code.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
}
