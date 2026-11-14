# Configurer les fournisseurs d'identité

La connexion locale (identifiant + mot de passe, MFA TOTP) fonctionne sans fournisseur externe.
Les fournisseurs se gèrent dans **Administration → IAM & connexion** (administrateur plateforme).
Pour chacun : *Enregistrer* (désactivé par défaut), *Tester*, puis *Activer*.

Les exemples ci-dessous ne contiennent aucun secret réel. Les secrets saisis dans la console
(secret client, mot de passe de liaison, clé privée SAML) sont écrits dans **Vault**
(`<montage KV>/auth-providers/<id>`). L'API ne les renvoie jamais, et laisser le champ vide conserve
le secret existant.

URL de retour : chaque fournisseur affiche dans la console l'URL à déclarer chez lui :
`https://<PUBLIC_URL>/api/v1/auth/sso/<id>/callback`. Pour SAML, c'est l'URL ACS en HTTP-POST.
`PUBLIC_URL` doit être l'adresse publique exacte de la plateforme.

## Politique MFA (`mfa`)

| Valeur | Effet |
|---|---|
| `auto` (défaut OIDC/SAML) | La politique MFA locale s'applique, **sauf** si le fournisseur atteste une MFA (`amr`/`acr` OIDC, `AuthnContextClassRef` SAML). |
| `require_idp` | Connexion refusée si le fournisseur n'atteste pas de MFA. |
| `trust_idp` | Le fournisseur impose lui-même la MFA : pas de TOTP local. |
| `local` | Toujours la politique locale (seule valeur pour LDAP, GitHub, GitLab). |

## Comptes et rattachement

- Une identité externe est liée à un compte par l'identifiant stable du fournisseur, jamais
  par l'adresse email.
- **Première connexion** : le compte est créé si « Création automatique des comptes » est activé.
  Il n'est pas créé si l'adresse email appartient déjà à un compte : l'utilisateur se connecte
  alors avec ce compte, puis va dans **Paramètres → Sécurité → Identités de connexion →
  Rattacher**.
- Un utilisateur ne peut pas retirer sa dernière méthode de connexion.

## OIDC / Keycloak

Côté Keycloak, créez un client *OpenID Connect* confidentiel :
- *Standard flow* : activé.
- *Valid redirect URIs* : l'URL de retour affichée par la console.
- *PKCE* : `S256`.

```json
{
  "issuer": "https://sso.exemple.com/realms/entreprise",
  "clientId": "coding-platform",
  "scopes": ["openid", "profile", "email"],
  "usernameClaim": "preferred_username",
  "emailClaim": "email",
  "nameClaim": "name",
  "mfa": "auto"
}
```

Secret : *Client secret* (laisser vide pour un client public). Le test vérifie la découverte
(`/.well-known/openid-configuration`) et la prise en charge de PKCE.
Pour que `mfa: auto` reconnaisse la MFA Keycloak, exposez `amr`/`acr` dans le jeton
(ACR/LoA avec flux conditionnel OTP), ou utilisez `trust_idp` si Keycloak impose déjà l'OTP.

## SAML 2.0

1. Enregistrez le fournisseur, puis téléchargez les **métadonnées SP** (lien dans la console,
   `/api/v1/auth/sso/<id>/metadata`) et importez-les chez le fournisseur d'identité.
2. Le fournisseur doit signer les assertions (`wantAssertionsSigned: true` par défaut).
3. Préférez un NameID **persistant** : il sert d'identifiant stable.

```json
{
  "entryPoint": "https://sso.exemple.com/realms/entreprise/protocol/saml",
  "issuer": "coding-platform",
  "idpCert": "MIIC…(certificat de signature du fournisseur, base64 ou PEM)",
  "emailAttribute": "email",
  "nameAttribute": "displayName",
  "usernameAttribute": "username",
  "wantAssertionsSigned": true,
  "wantAuthnResponseSigned": false,
  "mfa": "auto"
}
```

Secret facultatif : clé privée PEM, pour signer les AuthnRequest si le fournisseur l'exige. Le
test contrôle le certificat (lisibilité, expiration) et la génération des métadonnées.

## LDAP / Active Directory

```json
{
  "url": "ldaps://ldap.exemple.com",
  "bindDn": "cn=svc-coding,ou=services,dc=exemple,dc=com",
  "searchBase": "ou=people,dc=exemple,dc=com",
  "searchFilter": "(|(uid={{username}})(sAMAccountName={{username}}))",
  "usernameAttribute": "uid",
  "emailAttribute": "mail",
  "nameAttribute": "cn",
  "startTls": false,
  "tlsRejectUnauthorized": true
}
```

- **Secret** : mot de passe du compte de service. Ce compte n'a besoin que du droit de lecture
  sur la base de recherche.
- **Active Directory** : `usernameAttribute: "sAMAccountName"`,
  `nameAttribute: "displayName"`, `ldaps://` (port 636) ou `startTls: true` sur 389.
- **Sécurité** :
  - `{{username}}` est échappé (RFC 4515) ;
  - un mot de passe vide est refusé (pas de bind anonyme) ;
  - un identifiant est verrouillé temporairement après le nombre d'échecs défini dans la
    politique de connexion.
- **Test** : liaison du compte de service et existence de la base de recherche.

## OAuth GitHub (github.com ou GitHub Enterprise Server)

Créez une *OAuth App*, avec comme *Authorization callback URL* l'URL de retour affichée par la
console.

```json
{ "host": "github.com", "clientId": "Iv1.xxxxxxxx", "allowLogin": true, "allowedOrganizations": ["mon-entreprise"] }
```

- **Portées demandées** : `read:user user:email`, plus `read:org` si `allowedOrganizations` est
  renseigné.
- **Adresse email** : l'adresse principale vérifiée.
- **GitHub Enterprise** : `host: "github.exemple.com"`. L'API est appelée sur `/api/v3`.

## OAuth GitLab (gitlab.com ou auto-hébergé)

Créez une *Application* :
- *Redirect URI* : l'URL de retour affichée par la console.
- *Confidential* : activé.
- Portée `read_user`, plus `read_api` si `allowedGroups` est renseigné.

```json
{ "host": "gitlab.exemple.com", "clientId": "xxxxxxxx", "allowLogin": true, "allowedGroups": ["equipe/plateforme"] }
```

Le flux utilise PKCE. Un compte GitLab bloqué ou désactivé est refusé.

## Dépannage

- **Messages d'erreur** : l'interface affiche un message générique, avec un code dans l'URL
  (`sso_error=…`). Le détail est dans les journaux de l'API (contexte `Federation`).
- **`sso_expired`** : le retour du fournisseur est arrivé plus de 10 minutes après le départ,
  ou a été rejoué.
- **Émetteur OIDC** : il doit être identique pour l'API et le navigateur (même nom d'hôte).
  Derrière un proxy, configurez l'URL publique du fournisseur (`KC_HOSTNAME` pour Keycloak).

## Environnement de test

`tests/e2e/sso/` fournit Keycloak (OIDC + SAML) et OpenLDAP, **réservés aux tests** :

```sh
cd tests/e2e && pnpm sso:up && pnpm test:sso
```
