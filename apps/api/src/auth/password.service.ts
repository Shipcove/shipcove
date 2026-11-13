import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** Paramètres Argon2id recommandés par OWASP (m=19 MiB, t=2, p=1). */
const OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// Empreinte factice pour égaliser le temps de réponse quand le compte n'existe pas.
let dummyHash: Promise<string> | null = null;

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(hashValue: string | null, password: string): Promise<boolean> {
    if (!hashValue) {
      dummyHash ??= hash('cap-dummy-password-for-timing', OPTIONS);
      await verify(await dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await verify(hashValue, password);
    } catch {
      return false;
    }
  }

  /** Politique minimale : longueur ≥ 12, pas uniquement des caractères identiques, pas l'email. */
  validate(password: string, context: { email?: string; username?: string }): string | null {
    if (password.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères';
    if (/^(.)\1+$/.test(password)) return 'Mot de passe trop simple';
    const lower = password.toLowerCase();
    if (context.email && lower.includes(context.email.split('@')[0].toLowerCase()) && context.email.split('@')[0].length >= 4)
      return 'Le mot de passe ne doit pas contenir votre identifiant';
    if (context.username && context.username.length >= 4 && lower.includes(context.username.toLowerCase()))
      return 'Le mot de passe ne doit pas contenir votre identifiant';
    return null;
  }
}
