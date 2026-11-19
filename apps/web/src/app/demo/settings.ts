import type { PlatformSettings } from '@cap/contracts';

/** Réglages de plateforme affichés dans l'administration de la démonstration. */
export const SETTINGS: PlatformSettings = {
  "auth": {
    "localLoginEnabled": true,
    "registrationEnabled": false,
    "emailVerificationRequired": true,
    "mfaPolicy": "required_admins",
    "sessionIdleHours": 24,
    "sessionAbsoluteHours": 336,
    "maxFailedLogins": 8,
    "lockoutMinutes": 15
  },
  "editor": {
    "manualEditingEnabled": false
  },
  "sandbox": {
    "idleTimeoutMinutes": 15,
    "maxRunMinutes": 240,
    "cpu": 2,
    "memoryMb": 4096,
    "diskMb": 10240,
    "pidsLimit": 1024,
    "maxActiveSandboxesPerUser": 3,
    "maxActiveSandboxesTotal": 50,
    "egressAllowlist": [
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "registry.yarnpkg.com",
      "deb.debian.org",
      "proxy.golang.org",
      "crates.io",
      "static.crates.io",
      "index.crates.io",
      "repo.maven.apache.org",
      "objects.githubusercontent.com"
    ],
    "excludeDependencyDirs": true,
    "checkpointExcludes": [],
    "maxServicesPerWorkspace": 4,
    "setupTimeoutMinutes": 20,
    "startupScript": "# Registres internes de l'entreprise\nnpm config set registry https://npm.example.com\npip config set global.index-url https://pypi.example.com/simple\n"
  },
  "previews": {
    "maxPortsPerWorkspace": 3,
    "enabled": true,
    "allowedPorts": [
      "3000-9999"
    ]
  },
  "quotas": {
    "enabled": true,
    "defaultOutputReservation": 8192,
    "unknownUsagePolicy": "charge_estimate_input"
  },
  "attachments": {
    "maxFileMb": 20,
    "maxFilesPerMessage": 10,
    "allowArchives": true,
    "maxArchiveEntries": 2000,
    "maxArchiveExpandedMb": 200
  },
  "skills": {
    "personalSkillsAllowed": true,
    "personalSkillsRequireReview": false
  },
  "mcp": {
    "personalServersAllowed": true,
    "allowedRemoteHosts": []
  },
  "git": {
    "insecureHttpHosts": [],
    "allowPersonalTokens": false,
    "coAuthorEmail": "shipcove@example.com"
  },
  "subagents": {
    "enabled": true,
    "maxTasks": 4,
    "maxParallel": 4,
    "timeoutMinutes": 20
  },
  "conversations": {
    "titleModelId": "m-qwen"
  },
  "notifications": {
    "emailEnabled": true,
    "mandatoryEmailTypes": [
      "security"
    ]
  }
};
