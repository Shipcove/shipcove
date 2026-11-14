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
import { FederationService } from './auth/providers/federation.service.js';
import { AdminAuthProvidersController, SsoController } from './auth/providers/sso.controller.js';
import { AccessService } from './access/access.service.js';
import { TeamsController, UsersDirectoryController } from './teams/teams.controller.js';
import { ProjectsController } from './projects/projects.controller.js';
import { HealthController } from './health/health.controller.js';
import { PlatformConfigController } from './health/platform-config.controller.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';
import { FilesController } from './workspaces/files.controller.js';
import { PreviewsController } from './workspaces/previews.controller.js';
import { AttachmentsController } from './workspaces/attachments.controller.js';
import { SandboxRpcClient } from './workspaces/sandbox-rpc.client.js';
import { ConversationController, SharesController } from './conversations/conversation.controller.js';
import { ApprovalsController, GitConnectionsController, WorkspaceGitController } from './git/git.controller.js';
import { ModelsController, NotificationsController, UsageController } from './usage/usage.controller.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminModelsController } from './admin/admin-models.controller.js';
import { LiteLlmAdminService } from './admin/litellm.service.js';
import { IdempotencyService } from './common/idempotency.service.js';
import { SkillsController } from './extensions/skills.controller.js';
import { McpController } from './extensions/mcp.controller.js';

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv, opts: { secretProvider?: SecretProvider } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot({ env, serviceName: 'api', secretProvider: opts.secretProvider })],
      controllers: [
        HealthController,
        PlatformConfigController,
        AuthController,
        MeController,
        TeamsController,
        UsersDirectoryController,
        ProjectsController,
        WorkspacesController,
        ConversationController,
        SharesController,
        FilesController,
        PreviewsController,
        AttachmentsController,
        WorkspaceGitController,
        ApprovalsController,
        GitConnectionsController,
        ModelsController,
        UsageController,
        NotificationsController,
        AdminController,
        AdminModelsController,
        SsoController,
        AdminAuthProvidersController,
        SkillsController,
        McpController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        SessionService,
        PasswordService,
        MfaService,
        AuthService,
        ProvidersRegistry,
        FederationService,
        AccessService,
        WorkspacesService,
        SandboxRpcClient,
        IdempotencyService,
        LiteLlmAdminService,
      ],
    };
  }
}
