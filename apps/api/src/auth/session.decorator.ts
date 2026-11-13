import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError } from '@cap/server-core';
import type { AppRequest } from '../common/request.js';

/** Session courante (y compris en attente de MFA). */
export const Session = createParamDecorator((opts: { optional?: boolean } | undefined, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.session && !opts?.optional) throw new AppError('unauthenticated', 'Session requise');
  return req.session;
});
