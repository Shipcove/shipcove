import { ConsoleLogger, StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { SecretProvider } from '@cap/secrets';
import { AppModule } from './app.module.js';
import { correlationMiddleware } from './common/correlation.middleware.js';
import type { ApiEnv } from './env.js';

export async function createApp(env: ApiEnv, opts: { secretProvider?: SecretProvider; logger?: false } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env, opts), {
    logger: opts.logger === false ? false : new ConsoleLogger({ json: env.LOG_FORMAT === 'json', logLevels: levels(env.LOG_LEVEL) }),
    bodyParser: true,
    rawBody: false,
  });
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: true, directives: { 'frame-ancestors': ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.use(correlationMiddleware);
  app.useBodyParser('json', { limit: '6mb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();
  return app;
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Shipcove API')
    .setDescription(
      'API REST v1. Authentification par cookie de session `cap_session` + en-tête `X-CSRF-Token` ' +
        '(valeur du cookie `cap_csrf`) sur toute méthode non sûre. Erreurs : `{ error: { code, message, correlationId } }`. ' +
        'Événements agentiques : SSE `GET /workspaces/{id}/events` (voir docs/api/sse-events.md).',
    )
    .setVersion('1.0.0')
    .addCookieAuth('cap_session')
    .build();
  return SwaggerModule.createDocument(app, config);
}

function levels(level: ApiEnv['LOG_LEVEL']) {
  const all = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  return all.slice(0, all.indexOf(level) + 1) as unknown as Array<(typeof all)[number]>;
}
