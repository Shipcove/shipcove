import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from './request.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Identifiant de corrélation propagé (`X-Correlation-Id`) et renvoyé dans chaque réponse. */
export function correlationMiddleware(req: AppRequest, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-correlation-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}
