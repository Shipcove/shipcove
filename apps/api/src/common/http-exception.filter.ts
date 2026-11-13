import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorBody, ErrorCode } from '@cap/contracts';
import { QuotaExceededError, StorageUnavailableError, redactString } from '@cap/server-core';
import { SecretBackendError } from '@cap/secrets';
import type { AppRequest } from './request.js';

const DEFAULT_CODES: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  412: 'edit_conflict',
  428: 'precondition_required',
  429: 'rate_limited',
};

/** Format d'erreur homogène `{ error: { code, message, correlationId } }`, sans fuite interne. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();
    if (res.headersSent) return;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiErrorBody = { error: { code: 'internal_error', message: 'Erreur interne' } };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as unknown;
      if (r && typeof r === 'object' && 'error' in r && typeof (r as ApiErrorBody).error === 'object') {
        body = r as ApiErrorBody;
      } else {
        const message =
          typeof r === 'string' ? r : ((r as { message?: string | string[] })?.message ?? exception.message);
        const issues = (r as { issues?: unknown; errors?: unknown })?.issues ?? (r as { errors?: unknown })?.errors;
        body = {
          error: {
            code: DEFAULT_CODES[status] ?? (status >= 500 ? 'internal_error' : 'validation_failed'),
            message: Array.isArray(message) ? message.join('; ') : String(message),
            ...(issues ? { details: issues } : {}),
          },
        };
      }
    } else if (exception instanceof QuotaExceededError) {
      status = HttpStatus.PAYMENT_REQUIRED;
      body = { error: { code: 'quota_exceeded', message: exception.message, details: { window: exception.window, resetsAt: exception.resetsAt } } };
    } else if (exception instanceof SecretBackendError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      body = { error: { code: 'secret_backend_unavailable', message: 'Gestionnaire de secrets indisponible' } };
      this.logger.error(redactString(exception.message));
    } else if (exception instanceof StorageUnavailableError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      body = { error: { code: 'storage_unavailable', message: 'Stockage objet indisponible' } };
      this.logger.error(redactString(exception.message));
    } else {
      const err = exception as Error;
      this.logger.error(`${req.method} ${req.path} [${req.correlationId}] ${redactString(err?.stack ?? String(err))}`);
    }
    body.error.correlationId = req.correlationId;
    res.status(status).json(body);
  }
}
