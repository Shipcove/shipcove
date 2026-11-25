# Configuration par variables d'environnement

Toute la plateforme se règle depuis l'administration. Pour un déploiement reproductible (GitOps,
recette, instance jetable), l'API peut aussi **appliquer au démarrage** une configuration déclarée
par variables d'environnement : connexion LiteLLM et modèles, fournisseurs d'identité (SSO), forges
Git, SMTP et paramètres plateforme. Avec ces variables, aucun passage par la console n'est
nécessaire pour obtenir une instance utilisable.

**Toutes ces variables sont facultatives.** Sans elles, rien ne change : la plateforme démarre comme
avant et tout se règle dans l'administration.

## Principes

- **Déclaratif.** Ce qui est déclaré est réappliqué à chaque démarrage de l'API. Un élément déclaré
  (un fournisseur, une forge, un paramètre) que l'on modifie ensuite dans la console reprend la
  valeur des variables au redémarrage suivant. Ce qui n'est pas déclaré n'est jamais touché :
  on peut mélanger les deux (SSO par variables, quotas dans la console, par exemple).
- **Idempotent.** Rien n'est réécrit si la valeur est déjà en place : pas de nouvelle version des
  paramètres ni d'entrée d'audit à chaque redémarrage. Un changement réellement appliqué est
  journalisé et audité (`platform.env_provisioning`).
- **Sûr avec plusieurs instances.** Les répliques de l'API s'attendent (verrou PostgreSQL) : un
  modèle n'est jamais créé deux fois dans LiteLLM.
- **Échec explicite.** Une valeur invalide (JSON mal formé, booléen inconnu, champ obligatoire
  manquant, URL refusée par le schéma) **empêche l'API de démarrer** ; le journal dit quelle
  variable est en cause, sans afficher de secret. Un LiteLLM injoignable, lui, ne bloque pas le
  démarrage : la découverte des modèles est retentée en arrière-plan pendant une quinzaine de minutes.
- **Secrets.** Les secrets (clés, secrets client, mots de passe, clés privées) sont écrits dans
  **Vault**, jamais en base, comme depuis la console. Chaque variable accepte la variante
  `<NOM>_FILE` : chemin d'un fichier dont le contenu est la valeur (secret Docker ou Kubernetes
  monté). Elle est pratique pour les certificats PEM sur plusieurs lignes.
- Booléens : `true`/`false` (ou `1`/`0`, `yes`/`no`, `on`/`off`). Listes : valeurs séparées par des
  virgules. Une variable vide équivaut à une variable absente.

## Où les définir

| Déploiement | Où |
|---|---|
| Docker Compose | `infrastructure/docker/.env` : le service `api` lit ce fichier (`env_file`). Modèle commenté dans `.env.example`. |
| Helm | `api.extraEnv` (liste de variables) ou `api.envFrom` (Secret ou ConfigMap entier, ex. `- secretRef: { name: shipcove-provisioning }`). |
| Développement | `apps/api/.env.local` (lu par `pnpm dev`). |

Avec Docker Compose, le fichier `.env` peut alors contenir des secrets : limitez ses droits
(`chmod 600 .env`) ou utilisez les variantes `_FILE` avec des fichiers de `.secrets/`.

Seules les variables d'environnement de l'API sont concernées : le worker, la gateway et la preview
lisent la configuration appliquée (base et Vault).

## LiteLLM et modèles

| Variable | Défaut | Effet |
|---|---|---|
| `CAP_LITELLM_URL` (Compose) / `litellm.url` (Helm) | `http://litellm:4000` | URL du proxy LiteLLM utilisée par tous les services (`LITELLM_URL`). |
| `LITELLM_MASTER_KEY` | — | Clé d'administration de LiteLLM. Si elle est fournie, l'URL ci-dessus et cette clé sont écrites dans Vault (`infra/litellm`), comme **Administration → Modèles → Connexion à LiteLLM**, et remplacent ce qui y a été saisi. Inutile avec le LiteLLM fourni par Compose (sa clé est déjà dans Vault). |
| `LITELLM_MODELS` | — | Tableau JSON de modèles **créés dans LiteLLM** s'il n'en existe aucun du même nom (`POST /model/new`, même format que `model_list` de LiteLLM). Un modèle existant n'est pas modifié. Ces modèles sont activés dans la plateforme. Nécessite `STORE_MODEL_IN_DB` côté LiteLLM (c'est le cas du LiteLLM fourni). |
| `LITELLM_SYNC_ON_START` | `true` | Découverte des modèles au démarrage, comme le bouton **Recharger les modèles** : les nouveaux modèles sont ajoutés **désactivés** (coefficients préremplis depuis les prix LiteLLM), les disparus marqués indisponibles. |
| `LITELLM_SYNC_INTERVAL_MINUTES` | `0` | Découverte périodique (minutes) ; `0` : seulement au démarrage. |
| `LITELLM_ENABLED_MODELS` | — | Modèles activés après la découverte (noms LiteLLM, séparés par des virgules), ou `*` pour tous les modèles disponibles. Un modèle n'est jamais désactivé par cette variable. |
| `LITELLM_DEFAULT_MODEL` | — | Modèle par défaut (activé au besoin). |
| `LITELLM_TITLE_MODEL` | — | Modèle qui génère les titres des conversations (activé au besoin). |

Un nom de modèle introuvable dans LiteLLM est signalé dans le journal, sans bloquer le démarrage.

Exemple avec le LiteLLM fourni et une clé Anthropic :

```dotenv
LITELLM_MODELS='[
  {"model_name":"claude-sonnet","litellm_params":{"model":"anthropic/claude-sonnet-5-5","api_key":"sk-ant-…"}},
  {"model_name":"claude-haiku","litellm_params":{"model":"anthropic/claude-haiku-5-5","api_key":"sk-ant-…"}}
]'
LITELLM_DEFAULT_MODEL=claude-sonnet
LITELLM_TITLE_MODEL=claude-haiku
```

Le JSON peut aussi être placé dans un fichier : `LITELLM_MODELS_FILE=/run/secrets/litellm-models.json`.
Les clés des fournisseurs passées dans `litellm_params` sont conservées par LiteLLM (dans sa base,
chiffrées avec sa `LITELLM_SALT_KEY`).

Exemple avec un LiteLLM existant :

```dotenv
CAP_LITELLM_URL=https://litellm.example.com
LITELLM_MASTER_KEY=sk-…
LITELLM_ENABLED_MODELS=*
LITELLM_DEFAULT_MODEL=gpt-5
```

## Fournisseurs d'identité (SSO)

Un fournisseur par type se déclare par des variables à plat `SSO_<TYPE>_…`. Il est identifié par son
**nom** (`SSO_<TYPE>_NAME`) : changer le nom crée un nouveau fournisseur, l'ancien reste en place
(à supprimer dans la console). Pour chaque type :

| Variable commune | Défaut | Effet |
|---|---|---|
| `SSO_<TYPE>_NAME` | voir ci-dessous | Nom affiché sur la page de connexion. |
| `SSO_<TYPE>_ENABLED` | `true` | Fournisseur activé. |
| `SSO_<TYPE>_AUTO_PROVISION` | `true` | Création automatique du compte à la première connexion. |

L'URL de retour à déclarer chez le fournisseur est affichée dans **Administration → IAM & connexion**
(`<PUBLIC_URL>/api/v1/auth/sso/<id>/callback`). Le sens de chaque champ est détaillé dans
[`sso.md`](sso.md).

### OIDC (Keycloak, Entra ID, Okta…) — déclaré par `SSO_OIDC_ISSUER`

| Variable | Défaut |
|---|---|
| `SSO_OIDC_ISSUER` | — (obligatoire) |
| `SSO_OIDC_CLIENT_ID` | — (obligatoire) |
| `SSO_OIDC_CLIENT_SECRET` | — (Vault) |
| `SSO_OIDC_NAME` | `SSO` |
| `SSO_OIDC_SCOPES` | `openid,profile,email` |
| `SSO_OIDC_USERNAME_CLAIM`, `SSO_OIDC_EMAIL_CLAIM`, `SSO_OIDC_NAME_CLAIM` | `preferred_username`, `email`, `name` |
| `SSO_OIDC_MFA` | `auto` (`require_idp`, `trust_idp`, `local`) |
| `SSO_OIDC_REQUIRE_VERIFIED_EMAIL` | `false` (`true` : compte créé seulement si `email_verified` est attesté) |
| `SSO_OIDC_ALLOW_INSECURE_HTTP` | `false` (émetteur en HTTP : tests uniquement) |

### SAML 2.0 — déclaré par `SSO_SAML_ENTRY_POINT`

| Variable | Défaut |
|---|---|
| `SSO_SAML_ENTRY_POINT` | — (obligatoire) |
| `SSO_SAML_ISSUER` | — (obligatoire, entityID de la plateforme) |
| `SSO_SAML_IDP_CERT` (ou `_FILE`) | — (obligatoire, PEM ou base64) |
| `SSO_SAML_PRIVATE_KEY` (ou `_FILE`) | — (Vault, signature des requêtes) |
| `SSO_SAML_NAME` | `SAML` |
| `SSO_SAML_IDP_ISSUER` | — |
| `SSO_SAML_EMAIL_ATTRIBUTE`, `SSO_SAML_NAME_ATTRIBUTE`, `SSO_SAML_USERNAME_ATTRIBUTE` | `email`, `displayName`, `username` |
| `SSO_SAML_WANT_ASSERTIONS_SIGNED`, `SSO_SAML_WANT_AUTHN_RESPONSE_SIGNED` | `true`, `false` |
| `SSO_SAML_MFA` | `auto` |

### LDAP / Active Directory — déclaré par `SSO_LDAP_URL`

| Variable | Défaut |
|---|---|
| `SSO_LDAP_URL` | — (obligatoire, `ldap://` ou `ldaps://`) |
| `SSO_LDAP_BIND_DN` | — (obligatoire) |
| `SSO_LDAP_BIND_PASSWORD` | — (Vault) |
| `SSO_LDAP_SEARCH_BASE` | — (obligatoire) |
| `SSO_LDAP_SEARCH_FILTER` | `(\|(uid={{username}})(sAMAccountName={{username}}))` |
| `SSO_LDAP_NAME` | `LDAP` |
| `SSO_LDAP_USERNAME_ATTRIBUTE`, `SSO_LDAP_EMAIL_ATTRIBUTE`, `SSO_LDAP_NAME_ATTRIBUTE` | `uid`, `mail`, `cn` |
| `SSO_LDAP_START_TLS`, `SSO_LDAP_TLS_REJECT_UNAUTHORIZED` | `false`, `true` |
| `SSO_LDAP_TIMEOUT_MS` | `8000` |

### Connexion GitHub / GitLab — déclarée par `SSO_GITHUB_CLIENT_ID` / `SSO_GITLAB_CLIENT_ID`

| Variable | Défaut |
|---|---|
| `SSO_GITHUB_CLIENT_ID`, `SSO_GITHUB_CLIENT_SECRET` | — |
| `SSO_GITHUB_HOST` | `github.com` (ou hôte GitHub Enterprise) |
| `SSO_GITHUB_NAME` | `GitHub` |
| `SSO_GITHUB_ALLOW_LOGIN` | `true` |
| `SSO_GITHUB_ALLOWED_ORGANIZATIONS` | — (tous) |
| `SSO_GITLAB_CLIENT_ID`, `SSO_GITLAB_CLIENT_SECRET` | — |
| `SSO_GITLAB_HOST` | `gitlab.com` (ou instance auto-hébergée) |
| `SSO_GITLAB_NAME` | `GitLab` |
| `SSO_GITLAB_ALLOW_LOGIN` | `true` |
| `SSO_GITLAB_ALLOWED_GROUPS` | — (tous) |
| `SSO_GITLAB_REQUIRE_VERIFIED_EMAIL` | `false` |

Ces fournisseurs servent à **se connecter** à la plateforme. Le rattachement des dépôts passe par les
forges Git ci-dessous, avec leur propre application OAuth (ou la même, si la forge accepte plusieurs
URL de retour, comme GitLab).

### Plusieurs fournisseurs du même type

`SSO_PROVIDERS` : tableau JSON au format de l'API d'administration (`POST /api/v1/admin/auth-providers`),
secrets compris dans `config`. Il se combine avec les variables à plat ; deux fournisseurs ne peuvent
pas porter le même nom.

```dotenv
SSO_PROVIDERS_FILE=/run/secrets/sso-providers.json
```

```json
[
  { "type": "oidc", "name": "Entra ID", "enabled": true, "config": { "issuer": "https://login.microsoftonline.com/<tenant>/v2.0", "clientId": "…", "clientSecret": "…" } },
  { "type": "ldap", "name": "Annuaire", "enabled": true, "config": { "url": "ldaps://ad.example.com", "bindDn": "…", "bindPassword": "…", "searchBase": "dc=example,dc=com" } }
]
```

## Forges Git

Une forge GitHub et une forge GitLab se déclarent par des variables à plat. Une forge est
identifiée par son **hôte**. Le type est déduit de l'hôte : `github.com` → GitHub,
autre hôte → GitHub Enterprise ; `gitlab.com` → GitLab, autre hôte → GitLab auto-hébergé.

| Variable | Défaut | Effet |
|---|---|---|
| `GIT_GITLAB_CLIENT_ID` | — | Déclare la forge GitLab (application OAuth **confidentielle**). |
| `GIT_GITLAB_CLIENT_SECRET` | — | Secret client (Vault). Obligatoire à la première déclaration d'une forge activée. |
| `GIT_GITLAB_HOST` | `gitlab.com` | Hôte[:port] de l'instance (le schéma `https://` éventuel est retiré). |
| `GIT_GITLAB_NAME` | `GitLab` (`GitLab (<hôte>)` hors gitlab.com) | Nom affiché. |
| `GIT_GITLAB_ENABLED` | `true` | Forge proposée aux utilisateurs. |
| `GIT_GITHUB_CLIENT_ID`, `GIT_GITHUB_CLIENT_SECRET`, `GIT_GITHUB_HOST`, `GIT_GITHUB_NAME`, `GIT_GITHUB_ENABLED` | idem (`github.com`) | Forge GitHub. |
| `GIT_FORGES` | — | Tableau JSON pour plusieurs forges, format de `POST /api/v1/admin/git-forges` (`provider`, `name`, `host`, `clientId`, `clientSecret`, `enabled`). |
| `GIT_ALLOW_PERSONAL_TOKENS` | — | Paramètre `git.allowPersonalTokens`. |
| `GIT_AGENT_WRITE_SCOPE` | — | Paramètre `git.agentWriteScope` : `workspace_repository` (défaut de la plateforme : écritures de l'agent limitées au dépôt de la conversation) ou `any`. |
| `GIT_INSECURE_HTTP_HOSTS` | — | Paramètre `git.insecureHttpHosts` (forges joignables en HTTP). |
| `GIT_CO_AUTHOR_EMAIL` | — | Paramètre `git.coAuthorEmail` ; vide (`GIT_CO_AUTHOR_EMAIL=`) : aucune mention de co-auteur. |

L'URL de retour à déclarer dans l'application OAuth est affichée dans **Administration → Forges Git**
(`<PUBLIC_URL>/api/v1/me/git-connections/oauth/<id>/callback`) ; l'identifiant de la forge n'est
connu qu'après sa création. Les portées sont décrites dans [`git-forges.md`](git-forges.md).

Exemple, GitLab auto-hébergé :

```dotenv
GIT_GITLAB_HOST=gitlab.example.com
GIT_GITLAB_CLIENT_ID=…
GIT_GITLAB_CLIENT_SECRET=…
```

## SMTP

Déclaré par `SMTP_HOST` ; écrit dans Vault (`infra/smtp`), comme **Administration → Notifications & SMTP**.

| Variable | Défaut |
|---|---|
| `SMTP_HOST` | — |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` (TLS implicite, port 465) |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | — |
| `SMTP_FROM_ADDRESS` | — (obligatoire) |
| `SMTP_FROM_NAME` | `Shipcove` |

Avec le profil `dev` de Compose : `SMTP_HOST=mailpit`, `SMTP_PORT=1025`.

## Connexion et paramètres plateforme

| Variable | Paramètre |
|---|---|
| `AUTH_LOCAL_LOGIN_ENABLED` | `auth.localLoginEnabled` (attention : sans SSO fonctionnel, plus personne ne peut se connecter) |
| `AUTH_REGISTRATION_ENABLED` | `auth.registrationEnabled` |
| `AUTH_MFA_POLICY` | `auth.mfaPolicy` (`optional`, `required_admins`, `required_all`) |
| `PLATFORM_SETTINGS` | Objet JSON `{ "<section>": { … } }` fusionné aux paramètres actuels, pour toute section : `auth`, `editor`, `sandbox`, `previews`, `quotas`, `attachments`, `skills`, `mcp`, `git`, `subagents`, `conversations`, `notifications`. Les variables à plat ci-dessus l'emportent. |

```dotenv
PLATFORM_SETTINGS='{"sandbox":{"cpu":4,"memoryMb":8192,"startupScript":"npm config set registry https://npm.example.com"},"quotas":{"enabled":true}}'
```

Les valeurs sont validées comme dans la console ; une valeur hors bornes empêche le démarrage.

## Exemple complet (Docker Compose)

```dotenv
# … variables CAP_* habituelles …
LITELLM_MODELS_FILE=/run/secrets/litellm-models.json   # ou LITELLM_MODELS='[…]'
LITELLM_DEFAULT_MODEL=claude-sonnet

SSO_OIDC_ISSUER=https://keycloak.example.com/realms/acme
SSO_OIDC_CLIENT_ID=shipcove
SSO_OIDC_CLIENT_SECRET=…
SSO_OIDC_NAME=Keycloak
SSO_OIDC_MFA=trust_idp

GIT_GITLAB_HOST=gitlab.example.com
GIT_GITLAB_CLIENT_ID=…
GIT_GITLAB_CLIENT_SECRET=…

SMTP_HOST=smtp.example.com
SMTP_USERNAME=shipcove
SMTP_PASSWORD=…
SMTP_FROM_ADDRESS=shipcove@example.com
```

Un fichier `_FILE` doit être lisible **dans le conteneur `api`** : avec Compose, montez-le via un
fichier `compose.override.yml` (`volumes` ou `secrets` du service `api`).
