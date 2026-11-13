import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SandboxManager } from './sandbox/sandbox-manager.service.js';
import { RunOrchestrator } from './runs/run-orchestrator.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly sandboxes: SandboxManager,
    private readonly runs: RunOrchestrator,
  ) {}

  @Get('live')
  live() {
    return { status: 'up', activeRuns: this.runs.activeRuns().length };
  }

  @Get('ready')
  async ready() {
    const engine = await this.sandboxes.provider.health();
    if (!engine.ok) throw new ServiceUnavailableException({ status: 'down', checks: { sandboxEngine: 'down' } });
    return { status: 'up', checks: { sandboxEngine: 'up' } };
  }
}
