import 'reflect-metadata';
import { ConsoleLogger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { BaseEnvSchema, CoreModule, loadEnv, resolveFileVars } from '@cap/server-core';
import { PreviewProxyService } from './preview-proxy.service.js';

const env = loadEnv(BaseEnvSchema.extend({ PORT: z.coerce.number().int().default(8090) }), resolveFileVars(process.env));

@Module({ imports: [CoreModule.forRoot({ env, serviceName: 'preview' })], providers: [PreviewProxyService] })
class PreviewModule {}

const app = await NestFactory.createApplicationContext(PreviewModule, { logger: new ConsoleLogger({ json: env.LOG_FORMAT === 'json' }) });
app.enableShutdownHooks();
