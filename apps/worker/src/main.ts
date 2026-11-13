import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module.js';
import { loadWorkerEnv } from './env.js';

const env = loadWorkerEnv();
mkdirSync(env.GIT_BROKER_TMP, { recursive: true, mode: 0o700 });
const app = await NestFactory.create(WorkerModule.forRoot(env), { logger: new ConsoleLogger({ json: env.LOG_FORMAT === 'json' }) });
app.enableShutdownHooks();
await app.listen(env.PORT, '0.0.0.0');
console.log(JSON.stringify({ level: 'log', message: `Worker ${env.INSTANCE_ID} démarré (santé :${env.PORT})` }));
