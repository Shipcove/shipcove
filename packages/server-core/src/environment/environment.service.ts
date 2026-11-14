import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { environmentVariables, projects, workspaces, type Database } from '@cap/database';
import { DB, SECRETS } from '../tokens.js';

export interface ResolvedEnvironment {
  /** Variables effectives (équipe puis projet, le projet l'emportant). */
  vars: Record<string, string>;
  /** Valeurs secrètes à masquer, des plus longues aux plus courtes. */
  secretValues: string[];
}

/** En dessous de cette longueur, une valeur n'est pas masquable sans faux positifs massifs. */
export const MIN_SECRET_LENGTH = 6;

/**
 * Environnement d'un workspace (SPEC : variables et secrets de projet). Résolu à chaque run ;
 * un court cache évite de relire Vault pour chaque requête LLM de la passerelle.
 */
@Injectable()
export class EnvironmentService {
  private readonly cache = new Map<string, { at: number; value: ResolvedEnvironment }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
  ) {}

  async forWorkspace(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<ResolvedEnvironment> {
    const hit = this.cache.get(workspaceId);
    if (!opts.fresh && hit && Date.now() - hit.at < 15_000) return hit.value;
    const [row] = await this.db
      .select({ projectId: workspaces.projectId, teamId: projects.teamId })
      .from(workspaces)
      .innerJoin(projects, eq(projects.id, workspaces.projectId))
      .where(eq(workspaces.id, workspaceId));
    const value: ResolvedEnvironment = { vars: {}, secretValues: [] };
    if (row) {
      const team = await this.db.select().from(environmentVariables).where(and(eq(environmentVariables.scope, 'team'), eq(environmentVariables.subjectId, row.teamId)));
      const project = await this.db.select().from(environmentVariables).where(and(eq(environmentVariables.scope, 'project'), eq(environmentVariables.subjectId, row.projectId)));
      const secrets = new Set<string>();
      for (const v of [...team, ...project]) {
        if (v.secret && v.secretRef) {
          const s = await this.secrets.readKey(v.secretRef, 'value');
          if (s === undefined) continue;
          value.vars[v.name] = s;
          if (s.length >= MIN_SECRET_LENGTH) secrets.add(s);
        } else if (v.value !== null) {
          value.vars[v.name] = v.value;
        }
      }
      value.secretValues = [...secrets].sort((a, b) => b.length - a.length);
    }
    this.cache.set(workspaceId, { at: Date.now(), value });
    return value;
  }
}

/** Remplace chaque occurrence d'une valeur secrète par `***` (texte brut et forme échappée JSON). */
export function scrubSecrets(text: string, secretValues: readonly string[]): string {
  if (!text || secretValues.length === 0) return text;
  let out = text;
  for (const s of secretValues) {
    out = out.split(s).join('***');
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out = out.split(escaped).join('***');
  }
  return out;
}

/** Masquage profond d'une valeur JSON (arguments d'outils). */
export function scrubDeep<T>(value: T, secretValues: readonly string[]): T {
  if (secretValues.length === 0 || value === null || value === undefined) return value;
  return JSON.parse(scrubSecrets(JSON.stringify(value), secretValues)) as T;
}

/**
 * Masquage d'un texte reçu en flux : un secret peut être coupé entre deux fragments. Le texte
 * cumulé est masqué, et la fin (plus courte que le plus long secret) est retenue tant qu'elle peut
 * encore commencer un secret ; `emit` renvoie uniquement la partie nouvelle et sûre.
 */
export class StreamScrubber {
  private full = '';
  private emitted = 0;
  private readonly hold: number;

  constructor(private readonly secretValues: readonly string[]) {
    this.hold = secretValues.reduce((m, s) => Math.max(m, s.length - 1), 0);
  }

  push(delta: string): string {
    this.full += delta;
    if (this.secretValues.length === 0) {
      const out = this.full.slice(this.emitted);
      this.emitted = this.full.length;
      return out;
    }
    const scrubbed = scrubSecrets(this.full, this.secretValues);
    const safeEnd = Math.max(this.emitted, scrubbed.length - this.hold);
    const out = scrubbed.slice(this.emitted, safeEnd);
    this.emitted = safeEnd;
    return out;
  }

  /** Fin du flux : texte final masqué et dernier fragment restant. */
  end(finalText?: string): { text: string; rest: string } {
    const text = scrubSecrets(finalText ?? this.full, this.secretValues);
    const rest = text.slice(this.emitted);
    this.emitted = text.length;
    return { text, rest };
  }

  /** Texte masqué accumulé jusqu'ici (persistance partielle). */
  current(): string {
    return scrubSecrets(this.full, this.secretValues).slice(0, this.emitted);
  }
}
