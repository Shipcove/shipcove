import 'reflect-metadata';
import { SwaggerModule } from '@nestjs/swagger';
import { loadApiEnv } from './env.js';
import { buildOpenApi, createApp } from './setup-app.js';

const env = loadApiEnv();
const app = await createApp(env);
// Documentation de l'API : publique par nature, elle détaille toute la surface d'attaque ; désactivée
// en production sauf demande explicite (API_DOCS=true).
if ((env.API_DOCS ?? (env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true') {
  SwaggerModule.setup('api/docs', app, () => buildOpenApi(app), { jsonDocumentUrl: 'api/v1/openapi.json' });
}
if (!process.env.CLAMAV_HOST) console.warn(JSON.stringify({ level: 'warn', message: 'Antivirus désactivé : CLAMAV_HOST non défini, les pièces jointes ne sont pas analysées' }));
await app.listen(env.PORT, '0.0.0.0');
console.log(JSON.stringify({ level: 'log', message: `API à l'écoute sur :${env.PORT}`, instance: env.INSTANCE_ID }));
