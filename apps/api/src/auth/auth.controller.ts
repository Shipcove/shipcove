import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  EmailVerifyRequestSchema,
  LoginRequestSchema,
  MfaDisableRequestSchema,
  MfaVerifyRequestSchema,
  PasswordChangeRequestSchema,
  PasswordForgotRequestSchema,
  PasswordResetRequestSchema,
  RegisterRequestSchema,
  TotpEnrollConfirmSchema,
  type AuthProvidersResponse,
  type LoginRequest,
  type LoginResult,
  type MeResponse,
} from '@cap/contracts';
import { AppError, SettingsService, AuditService } from '@cap/server-core';
import { AllowPendingMfa, CurrentUser, Public, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { Session } from './session.decorator.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';
import { ProvidersRegistry } from './providers/providers.registry.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly providers: ProvidersRegistry,
  ) {}

  @Public()
  @Get('providers')
  async listProviders(): Promise<AuthProvidersResponse> {
    const auth = await this.settings.section('auth');
    return {
      localEnabled: auth.localLoginEnabled,
      registrationEnabled: auth.registrationEnabled,
      providers: await this.providers.publicList(),
    };
  }

  /** État de session sans erreur 401 (sonde de l'interface au chargement). */
  @Public()
  @Get('session')
  async session(@Session({ optional: true }) session: { userId: string; state: string } | undefined): Promise<{ authenticated: boolean; state: string | null; user: MeResponse | null }> {
    if (!session) return { authenticated: false, state: null, user: null };
    if (session.state !== 'active') return { authenticated: false, state: session.state, user: null };
    return { authenticated: true, state: 'active', user: await this.auth.me(session.userId) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body({ schema: LoginRequestSchema }) body: LoginRequest, @ReqCtx() ctx: RequestContext, @Res({ passthrough: true }) res: Response): Promise<LoginResult> {
    const { result, tokens } = await this.auth.login(body.login, body.password, ctx);
    this.sessions.setCookies(res, tokens.token, tokens.csrfToken);
    return result;
  }

  @AllowPendingMfa()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Body({ schema: MfaVerifyRequestSchema }) body: { code: string },
    @Session() session: { id: string; state: string; userId: string },
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    if (session.state !== 'pending_mfa') throw new AppError('conflict', 'Aucune vérification MFA en attente');
    const { result, tokens } = await this.auth.verifyMfa(session.id, session.userId, body.code, ctx);
    this.sessions.setCookies(res, tokens.token, tokens.csrfToken);
    return result;
  }

  /** Enrôlement TOTP : pendant une session active, ou imposé par la politique (session en attente). */
  @AllowPendingMfa()
  @Post('mfa/totp/enroll')
  @HttpCode(200)
  async enrollTotp(@Session() session: { id: string; state: string; userId: string }) {
    if (session.state === 'pending_mfa') throw new AppError('mfa_required', 'Vérifiez d’abord votre second facteur');
    const me = await this.auth.me(session.userId);
    return this.mfa.startEnrollment(session.userId, me.email);
  }

  @AllowPendingMfa()
  @Post('mfa/totp/confirm')
  @HttpCode(200)
  async confirmTotp(
    @Body({ schema: TotpEnrollConfirmSchema }) body: { code: string },
    @Session() session: { id: string; state: string; userId: string },
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (session.state === 'pending_mfa') throw new AppError('mfa_required', 'Vérifiez d’abord votre second facteur');
    const { codes, tokens } = await this.auth.completeEnrollment(session.id, session.userId, body.code, ctx);
    this.sessions.setCookies(res, tokens.token, tokens.csrfToken);
    return { codes, user: await this.auth.me(session.userId) };
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  async regenerateCodes(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const codes = await this.mfa.regenerateRecoveryCodes(user.id);
    await this.audit.record({ actorId: user.id, action: 'auth.recovery_codes_regenerated', ip: ctx.ip });
    return { codes };
  }

  @Post('mfa/disable')
  @HttpCode(204)
  async disableMfa(@Body({ schema: MfaDisableRequestSchema }) body: { password: string }, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.auth.disableMfa(user.id, body.password, ctx);
  }

  @Public()
  @AllowPendingMfa()
  @Post('logout')
  @HttpCode(204)
  async logout(@Session({ optional: true }) session: { id: string } | undefined, @Res({ passthrough: true }) res: Response) {
    if (session) await this.sessions.revoke(session.id);
    this.sessions.clearCookies(res);
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body({ schema: RegisterRequestSchema }) body: z.infer<typeof RegisterRequestSchema>, @ReqCtx() ctx: RequestContext) {
    return this.auth.register(body, ctx);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body({ schema: EmailVerifyRequestSchema }) body: { token: string }) {
    await this.auth.verifyEmail(body.token);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body({ schema: PasswordForgotRequestSchema }) body: { email: string }, @ReqCtx() ctx: RequestContext) {
    await this.auth.forgotPassword(body.email, ctx);
    return { status: 'accepted' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async reset(@Body({ schema: PasswordResetRequestSchema }) body: { token: string; password: string }, @ReqCtx() ctx: RequestContext) {
    await this.auth.resetPassword(body.token, body.password, ctx);
  }

  @Post('password/change')
  @HttpCode(204)
  async change(
    @Body({ schema: PasswordChangeRequestSchema }) body: { currentPassword: string; newPassword: string },
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.auth.changePassword(user.id, user.sessionId, body.currentPassword, body.newPassword, ctx);
  }

  @Get('sessions')
  listSessions(@CurrentUser() user: AuthUser) {
    return this.sessions.list(user.id, user.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Param('id', { schema: z.uuid() }) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const ok = await this.sessions.revoke(id, user.id);
    if (!ok) throw new AppError('not_found', 'Session introuvable');
    await this.audit.record({ actorId: user.id, action: 'auth.session_revoked', targetType: 'session', targetId: id, ip: ctx.ip });
  }

  @Post('sessions/revoke-others')
  @HttpCode(204)
  async revokeOthers(@CurrentUser() user: AuthUser) {
    await this.sessions.revokeAll(user.id, user.sessionId);
  }
}

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user.id);
  }
}
