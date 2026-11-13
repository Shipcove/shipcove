import type { Request } from 'express';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  platformRole: 'platform_admin' | 'user';
  sessionId: string;
  mfaVerified: boolean;
}

export interface AppRequest extends Request {
  correlationId: string;
  user?: AuthUser;
  session?: { id: string; state: string; csrfToken: string; userId: string };
}
