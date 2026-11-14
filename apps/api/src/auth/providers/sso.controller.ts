import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { LdapLoginRequestSchema, UpsertAuthProviderSchema, type AuthProviderAdminDto, type LinkedIdentityDto, type LoginResult } from '@cap/contracts';
import { AppError, ENV } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, Public, ReqCtx, SkipCsrf, type RequestContext } from '../../common/decorators.js';
import type { AppRequest, AuthUser } from '../../common/request.js';
import type { ApiEnv } from '../../env.js';
import { SessionService } from '../session.service.js';
import { FederationError } from './federation.types.js';
import { FederationService, safeReturnTo, type SsoCallbackInput } from './federation.service.js';

const uuid = { schema: z.uuid() };

/** Parcours SSO à redirection (OIDC, SAML, OAuth) et connexion annuaire (LDAP). */
@ApiTags('auth')
@Controller('auth')
export class SsoController {
  constructor(
    private readonly federation: FederationService,
    private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** Redirige vers le fournisseur. `link=1` rattache l'identité au compte connecté. */
  @Public()
  @Get('sso/:id/start')
  async start(
    @Param('id', uuid) id: string,
    @Req() req: AppRequest,
    @Res() res: Response,
    @Query('returnTo') returnTo?: string,
    @Query('link') link?: string,
  ): Promise<void> {
    const linking = link === '1';
    try {
      if (linking && !req.user) throw new FederationError('sso_denied', 'Session requise pour rattacher une identité');
      const url = await this.federation.start(id, { returnTo: safeReturnTo(returnTo ?? (linking ? '/settings' : '/')), linkUserId: linking ? req.user!.id : undefined });
      res.redirect(302, url);
    } catch (e) {
      this.fail(res, e, linking ? '/settings' : null);
    }
  }

  @Public()
  @Get('sso/:id/callback')
  async callbackGet(@Param('id', uuid) id: string, @Req() req: Request, @Res() res: Response, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.handle(id, { url: this.currentUrl(req), body: {} }, res, ctx);
  }

  /** ACS SAML (HTTP-POST) : requête intersite émise par le fournisseur, sans jeton CSRF. */
  @Public()
  @SkipCsrf()
  @Post('sso/:id/callback')
  async callbackPost(@Param('id', uuid) id: string, @Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.handle(id, { url: this.currentUrl(req), body: body ?? {} }, res, ctx);
  }

  @Public()
  @Get('sso/:id/metadata')
  @Header('content-type', 'application/samlmetadata+xml; charset=utf-8')
  async metadata(@Param('id', uuid) id: string): Promise<string> {
    return this.federation.samlMetadata(id);
  }

  @Public()
  @Post('ldap/login')
  @HttpCode(200)
  async ldapLogin(@Body({ schema: LdapLoginRequestSchema }) body: z.infer<typeof LdapLoginRequestSchema>, @ReqCtx() ctx: RequestContext, @Res({ passthrough: true }) res: Response): Promise<LoginResult> {
    const { result, tokens } = await this.federation.ldapLogin(body.providerId, body.username, body.password, ctx);
    this.sessions.setCookies(res, tokens.token, tokens.csrfToken);
    return result;
  }

  @Get('identities')
  async identities(@CurrentUser() user: AuthUser): Promise<LinkedIdentityDto[]> {
    return this.federation.identities(user.id);
  }

  @Delete('identities/:identityId')
  @HttpCode(204)
  async unlink(@Param('identityId', uuid) identityId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.federation.unlink(user.id, identityId, ctx);
  }

  private async handle(id: string, input: SsoCallbackInput, res: Response, ctx: RequestContext): Promise<void> {
    try {
      const out = await this.federation.callback(id, input, ctx);
      if (out.kind === 'linked') {
        res.redirect(303, appendQuery(out.returnTo, 'linked', '1'));
        return;
      }
      this.sessions.setCookies(res, out.tokens.token, out.tokens.csrfToken);
      const next = encodeURIComponent(out.returnTo);
      // 303 : après un POST SAML, le navigateur suit la redirection en GET.
      if (out.result.status === 'mfa_required') res.redirect(303, `/auth/mfa?next=${next}`);
      else if (out.result.status === 'mfa_enrollment_required') res.redirect(303, `/auth/mfa-enroll?next=${next}`);
      else res.redirect(303, out.returnTo);
    } catch (e) {
      this.fail(res, e, null);
    }
  }

  /** Échec : retour vers l'interface avec un code stable (jamais de détail technique dans l'URL). */
  private fail(res: Response, e: unknown, linkReturn: string | null): void {
    const code = e instanceof FederationError ? e.code : e instanceof AppError && e.code === 'provider_disabled' ? 'provider_disabled' : 'sso_failed';
    this.federation.toAppError(e); // journalise la cause
    res.redirect(303, linkReturn ? appendQuery(linkReturn, 'sso_error', code) : `/auth/login?sso_error=${code}`);
  }

  /** URL publique reçue (doit correspondre à la redirect URI déclarée). */
  private currentUrl(req: Request): URL {
    return new URL(req.originalUrl, this.env.PUBLIC_URL);
  }
}

@ApiTags('admin')
@Controller('admin/auth-providers')
@PlatformAdmin()
export class AdminAuthProvidersController {
  constructor(private readonly federation: FederationService) {}

  @Get()
  async list(): Promise<AuthProviderAdminDto[]> {
    return this.federation.adminList();
  }

  @Post()
  async create(@Body({ schema: UpsertAuthProviderSchema }) body: z.infer<typeof UpsertAuthProviderSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.federation.upsert(null, body, user.id, ctx);
  }

  @Put(':id')
  async update(@Param('id', uuid) id: string, @Body({ schema: UpsertAuthProviderSchema }) body: z.infer<typeof UpsertAuthProviderSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.federation.upsert(id, body, user.id, ctx);
  }

  @Post(':id/enable')
  @HttpCode(204)
  async enable(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.federation.setEnabled(id, true, user.id, ctx);
  }

  @Post(':id/disable')
  @HttpCode(204)
  async disable(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.federation.setEnabled(id, false, user.id, ctx);
  }

  @Post(':id/test')
  @HttpCode(200)
  async test(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    return this.federation.test(id, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.federation.remove(id, user.id, ctx);
  }
}

function appendQuery(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}
