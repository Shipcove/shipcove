import { z } from 'zod';
import { EmailSchema } from './auth.js';

/** Invitation à rejoindre la plateforme (administrateur). */
export const CreateInvitationSchema = z.object({
  email: EmailSchema,
});
export type CreateInvitation = z.infer<typeof CreateInvitationSchema>;

export interface InvitationDto {
  id: string;
  email: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** Annuaire minimal (partage nominatif d'une conversation). */
export interface UserSummaryDto {
  id: string;
  username: string;
  displayName: string;
}
