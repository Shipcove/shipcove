import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SettingsService } from '@cap/server-core';

/** Paramètres non sensibles utiles à l'interface (aucune valeur secrète). */
@ApiTags('platform')
@Controller('platform/config')
export class PlatformConfigController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get() {
    const s = await this.settings.get();
    return {
      editor: { manualEditingEnabled: s.editor.manualEditingEnabled },
      previews: { enabled: s.previews.enabled, maxPortsPerWorkspace: s.previews.maxPortsPerWorkspace },
      attachments: { maxFileMb: s.attachments.maxFileMb, maxFilesPerMessage: s.attachments.maxFilesPerMessage, allowArchives: s.attachments.allowArchives },
      sandbox: { idleTimeoutMinutes: s.sandbox.idleTimeoutMinutes },
      skills: { personalSkillsAllowed: s.skills.personalSkillsAllowed },
      mcp: { personalServersAllowed: s.mcp.personalServersAllowed },
      quotas: { enabled: s.quotas.enabled },
    };
  }
}
