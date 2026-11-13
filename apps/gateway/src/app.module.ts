import { Controller, Get, Module, type DynamicModule } from '@nestjs/common';
import { CoreModule } from '@cap/server-core';
import type { SecretProvider } from '@cap/secrets';
import type { GatewayEnv } from './env.js';
import { RunTokenService } from './run-token.service.js';
import { LlmProxyController } from './llm/llm-proxy.controller.js';
import { EgressProxyService } from './egress/egress-proxy.service.js';
import { GitReadProxyController } from './git/git-read-proxy.controller.js';

@Controller('health')
class HealthController {
  @Get('live')
  live() {
    return { status: 'up' };
  }
}

@Module({})
export class GatewayModule {
  static forRoot(env: GatewayEnv, opts: { secretProvider?: SecretProvider } = {}): DynamicModule {
    return {
      module: GatewayModule,
      imports: [CoreModule.forRoot({ env, serviceName: 'gateway', secretProvider: opts.secretProvider })],
      controllers: [HealthController, LlmProxyController, GitReadProxyController],
      providers: [RunTokenService, EgressProxyService],
    };
  }
}
