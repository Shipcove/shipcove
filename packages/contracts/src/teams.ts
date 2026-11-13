import { z } from 'zod';
import { EmailSchema } from './auth.js';
import { TeamRoleSchema } from './common.js';

export const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'minuscules, chiffres et tirets');

export const CreateTeamSchema = z.object({
  name: z.string().min(2).max(120),
  slug: SlugSchema,
  description: z.string().max(2000).optional(),
});
export type CreateTeam = z.infer<typeof CreateTeamSchema>;

export const UpdateTeamSchema = CreateTeamSchema.partial();

export interface TeamDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  myRole: 'team_admin' | 'member' | null;
  memberCount: number;
  projectCount: number;
  createdAt: string;
}

export interface TeamMemberDto {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  role: 'team_admin' | 'member';
  joinedAt: string;
}

export const AddTeamMemberSchema = z.object({
  userId: z.uuid(),
  role: TeamRoleSchema.default('member'),
});
export const UpdateTeamMemberSchema = z.object({ role: TeamRoleSchema });

export const CreateInvitationSchema = z.object({
  email: EmailSchema,
  teamId: z.uuid().optional(),
  role: TeamRoleSchema.default('member'),
});
export type CreateInvitation = z.infer<typeof CreateInvitationSchema>;

export interface InvitationDto {
  id: string;
  email: string;
  teamId: string | null;
  role: 'team_admin' | 'member';
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface UserSummaryDto {
  id: string;
  username: string;
  displayName: string;
}
