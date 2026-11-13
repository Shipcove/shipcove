import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CoreModule } from '@cap/server-core';
import type { SecretProvider } from '@cap/secrets';
import type { ApiEnv } from './env.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthController, MeController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { MfaService } from './auth/mfa.service.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { ProvidersRegistry } from './auth/providers/providers.registry.js';
import { AccessService } from './access/access.service.js';
import { TeamsController, UsersDirectoryController } from './teams/teams.controller.js';
import { ProjectsController } from './projects/projects.controller.js';
import { HealthController } from './health/health.controller.js';

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv, opts: { secretProvider?: SecretProvider } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot({ env, serviceName: 'api', secretProvider: opts.secretProvider })],
      controllers: [HealthController, AuthController, MeController, TeamsController, UsersDirectoryController, ProjectsController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        SessionService,
        PasswordService,
        MfaService,
        AuthService,
        ProvidersRegistry,
        AccessService,
      ],
    };
  }
}
