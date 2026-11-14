import { Module, type DynamicModule } from '@nestjs/common';
import { CoreModule } from '@cap/server-core';
import type { SecretProvider } from '@cap/secrets';
import type { WorkerEnv } from './env.js';
import { JobRunner } from './jobs/job-runner.service.js';
import { CheckpointService } from './sandbox/checkpoint.service.js';
import { SandboxManager } from './sandbox/sandbox-manager.service.js';
import { RunOrchestrator } from './runs/run-orchestrator.service.js';
import { BridgeRpcService } from './runs/bridge-rpc.service.js';
import { GitBrokerService } from './git/git-broker.service.js';
import { McpBridgeService } from './mcp/mcp-bridge.service.js';
import { SkillsMaterializer } from './mcp/skills-materializer.service.js';
import { SetupService } from './sandbox/setup.service.js';
import { ServicesService } from './sandbox/services.service.js';
import { SandboxRpcService } from './rpc/sandbox-rpc.service.js';
import { EmailService } from './email/email.service.js';
import { MaintenanceService } from './maintenance/maintenance.service.js';
import { RetentionService } from './maintenance/retention.service.js';
import { HealthController } from './health.controller.js';

@Module({})
export class WorkerModule {
  static forRoot(env: WorkerEnv, opts: { secretProvider?: SecretProvider; maintenance?: boolean } = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot({ env, serviceName: 'worker', secretProvider: opts.secretProvider })],
      controllers: [HealthController],
      providers: [
        JobRunner,
        CheckpointService,
        SkillsMaterializer,
        SetupService,
        ServicesService,
        SandboxManager,
        GitBrokerService,
        McpBridgeService,
        BridgeRpcService,
        RunOrchestrator,
        SandboxRpcService,
        EmailService,
        RetentionService,
        ...(opts.maintenance === false ? [] : [MaintenanceService]),
      ],
      exports: [SandboxManager, RunOrchestrator, CheckpointService, GitBrokerService, EmailService],
    };
  }
}
