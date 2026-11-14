import { z } from 'zod';
import type { GitActionKind } from './events.js';
import { GitProviderKindSchema, type GitProviderKind } from './projects.js';

export interface GitConnectionDto {
  id: string;
  provider: GitProviderKind;
  host: string;
  accountLogin: string;
  accountName: string | null;
  scopes: string[];
  status: 'active' | 'expired' | 'revoked' | 'error';
  createdAt: string;
  lastUsedAt: string | null;
}

export const CreatePatConnectionSchema = z.object({
  provider: GitProviderKindSchema,
  host: z.string().min(3).max(255).regex(/^[a-z0-9.-]+(:\d+)?$/i),
  token: z.string().min(10).max(4000),
});

export interface RemoteRepositoryDto {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  webUrl: string;
  description: string | null;
}

export interface GitStatusDto {
  available: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  source: 'sandbox' | 'unavailable';
}

export const GitOperationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fetch') }),
  z.object({ action: z.literal('pull'), branch: z.string().max(255).optional() }),
  z.object({
    action: z.literal('push'),
    localBranch: z.string().min(1).max(255),
    remoteBranch: z.string().min(1).max(255),
    force: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('create_pull_request'),
    sourceBranch: z.string().min(1).max(255),
    targetBranch: z.string().min(1).max(255),
    title: z.string().min(1).max(250),
    body: z.string().max(60000).default(''),
    draft: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('merge'),
    number: z.number().int().positive(),
    method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  }),
  z.object({ action: z.literal('delete_remote_branch'), branch: z.string().min(1).max(255) }),
]);
export type GitOperationRequest = z.infer<typeof GitOperationRequestSchema>;

export interface ApprovalDto {
  id: string;
  workspaceId: string;
  action: GitActionKind;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  requestedBy: 'agent' | 'user';
  repository: string;
  target: string;
  /** SHA local exact couvert par l'approbation. */
  commitSha: string | null;
  commits: Array<{ sha: string; subject: string; author: string }>;
  diffStat: string | null;
  patchPreview: string | null;
  title: string | null;
  body: string | null;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
  operation: { id: string; status: GitOperationStatus; result: string | null } | null;
}

export type GitOperationStatus = 'pending' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'rejected';

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).optional(),
});

/* ---------- Forges Git (applications OAuth configurées par l'administrateur) ---------- */

export const UpsertGitForgeSchema = z.object({
  provider: GitProviderKindSchema,
  name: z.string().min(1).max(120),
  /** Hôte[:port] ; imposé à `github.com` / `gitlab.com` pour les offres SaaS. */
  host: z.string().min(3).max(255).regex(/^[a-z0-9.-]+(:\d+)?$/i),
  clientId: z.string().min(1).max(500),
  /** Écrit dans Vault, jamais renvoyé ; vide = secret existant conservé. */
  clientSecret: z.string().min(1).max(4000).optional(),
  enabled: z.boolean().default(false),
});
export type UpsertGitForge = z.infer<typeof UpsertGitForgeSchema>;

export interface GitForgeAdminDto {
  id: string;
  provider: GitProviderKind;
  name: string;
  host: string;
  clientId: string;
  enabled: boolean;
  secretConfigured: boolean;
  /** URL de rappel à déclarer dans l'application OAuth de la forge. */
  callbackUrl: string;
  /** Portées demandées à la forge. */
  scopes: string[];
  connections: number;
  lastTestAt: string | null;
  lastTestResult: string | null;
}

/** Forges proposées à l'utilisateur pour rattacher un compte. */
export interface GitForgesPublicDto {
  forges: Array<{ id: string; provider: GitProviderKind; name: string; host: string }>;
  /** Rattachement par jeton d'accès personnel autorisé par l'administrateur. */
  allowPersonalTokens: boolean;
}
