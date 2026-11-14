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
// Pi garde ses connexions HTTP ouvertes entre deux appels au modèle : si le serveur ferme une
// connexion inactive (5 s par défaut) au moment où Pi la réutilise, l'appel échoue
// (« Connection error »). Le serveur garde donc les connexions plus longtemps que les clients.
const server = app.getHttpServer();
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
console.log(JSON.stringify({ level: 'log', message: `Gateway à l'écoute sur :${env.PORT}` }));
