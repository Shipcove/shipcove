import { z } from 'zod';
import { PlatformRoleSchema } from './common.js';

export const PasswordSchema = z.string().min(12, 'Au moins 12 caractères').max(256);
export const EmailSchema = z.email().max(254).transform((v) => v.trim().toLowerCase());
export const UsernameSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Lettres, chiffres, point, tiret, souligné');

export const LoginRequestSchema = z.object({
  /** Email ou identifiant. */
  login: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const MfaVerifyRequestSchema = z.object({
  /** Code TOTP (6 chiffres) ou code de récupération. */
  code: z.string().min(6).max(32),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  username: UsernameSchema,
  displayName: z.string().min(1).max(120),
  password: PasswordSchema,
  invitationToken: z.string().max(200).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const PasswordForgotRequestSchema = z.object({ email: EmailSchema });
export const PasswordResetRequestSchema = z.object({
  token: z.string().min(20).max(200),
  password: PasswordSchema,
});
export const PasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: PasswordSchema,
});
export const EmailVerifyRequestSchema = z.object({ token: z.string().min(20).max(200) });

export const TotpEnrollConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const MfaDisableRequestSchema = z.object({ password: z.string().min(1).max(256) });

export type LoginResult =
  | { status: 'authenticated'; user: MeResponse }
  | { status: 'mfa_required'; methods: Array<'totp' | 'recovery_code'> }
  | { status: 'mfa_enrollment_required' };

export interface AuthProviderPublic {
  id: string;
  type: AuthProviderType;
  name: string;
  /** URL de démarrage pour les fournisseurs à redirection. */
  startUrl?: string;
}

export const AuthProviderTypeSchema = z.enum(['local', 'oidc', 'saml', 'ldap', 'github', 'gitlab']);
export type AuthProviderType = z.infer<typeof AuthProviderTypeSchema>;

export interface AuthProvidersResponse {
  localEnabled: boolean;
  registrationEnabled: boolean;
  providers: AuthProviderPublic[];
}

export const LdapLoginRequestSchema = z.object({
  providerId: z.uuid(),
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
});

export interface MeResponse {
  id: string;
  email: string;
  username: string;
  displayName: string;
  platformRole: z.infer<typeof PlatformRoleSchema>;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
  teams: Array<{ id: string; name: string; slug: string; role: 'team_admin' | 'member' }>;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  authMethod: string;
}

export interface TotpEnrollResponse {
  secret: string;
  otpauthUrl: string;
}

export interface RecoveryCodesResponse {
  codes: string[];
}
