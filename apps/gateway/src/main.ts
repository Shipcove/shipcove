import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GatewayModule } from './app.module.js';
import { loadGatewayEnv } from './env.js';

const env = loadGatewayEnv();
const app = await NestFactory.create<NestExpressApplication>(GatewayModule.forRoot(env), {
  logger: new ConsoleLogger({ json: env.LOG_FORMAT === 'json' }),
  bodyParser: false,
});
app.disable('x-powered-by');
// Corps JSON volumineux possibles (images) uniquement pour le proxy LLM.
app.useBodyParser('json', { limit: '25mb', type: ['application/json'] });
app.enableShutdownHooks();
await app.listen(env.PORT, '0.0.0.0');
console.log(JSON.stringify({ level: 'log', message: `Gateway à l'écoute sur :${env.PORT}` }));
