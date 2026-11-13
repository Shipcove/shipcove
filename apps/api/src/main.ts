import 'reflect-metadata';
import { SwaggerModule } from '@nestjs/swagger';
import { loadApiEnv } from './env.js';
import { buildOpenApi, createApp } from './setup-app.js';

const env = loadApiEnv();
const app = await createApp(env);
SwaggerModule.setup('api/docs', app, () => buildOpenApi(app), { jsonDocumentUrl: 'api/v1/openapi.json' });
await app.listen(env.PORT, '0.0.0.0');
console.log(JSON.stringify({ level: 'log', message: `API à l'écoute sur :${env.PORT}`, instance: env.INSTANCE_ID }));
