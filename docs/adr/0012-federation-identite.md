# ADR 0012 — Fédération d'identité (OIDC, SAML, LDAP, OAuth GitHub/GitLab)

- Statut : accepté — 2026-11-14 (précise l'ADR 0008)

## Contexte

SPEC §4 : la plateforme garde une IAM intégrée, Keycloak n'étant qu'un fournisseur facultatif.
L'administration doit pouvoir activer, configurer et **tester** OIDC/Keycloak, SAML 2.0,
LDAP/AD, OAuth GitHub et GitLab (.com et auto-hébergé), en respectant les politiques MFA des
fournisseurs. Les secrets vont dans Vault. L'API tourne en plusieurs répliques sans affinité.

## Décisions

- **Bibliothèques** : `openid-client` 6 (OIDC certifié, PKCE), `@node-saml/node-saml` 5,
  `ldapts` 9. GitHub/GitLab : OAuth 2 direct via `fetch`, sans dépendance supplémentaire.
- **État des redirections en base** (`auth_flows`) : empreinte SHA-256 du `state`/`RelayState`,
  `nonce`, vérificateur PKCE, chemin de retour, durée de vie 10 min, **usage unique**
  (consommation atomique par `UPDATE … WHERE used_at IS NULL RETURNING`). Fonctionne avec
  plusieurs instances et empêche le rejeu d'un retour.
- **SAML** : `InResponseTo` est exigé ; l'identifiant de l'AuthnRequest est mémorisé dans le flux
  (et non dans le cache mémoire par défaut de node-saml, inopérant en multi-instance).
  Assertions signées exigées par défaut ; horloge ±60 s ; âge max 5 min. L'ACS (POST intersite)
  est exempté de CSRF : il est protégé par la signature et le flux à usage unique.
- **OIDC** : code d'autorisation + PKCE S256 + `state` + `nonce` ; découverte mise en cache
  10 min par version de configuration ; `allowInsecureHttp` réservé aux tests.
- **LDAP/AD** : compte de service → recherche (filtre échappé RFC 4515, résultat unique exigé)
  → *bind* de l'utilisateur. Mot de passe vide refusé (bind anonyme). Identifiant stable :
  `objectGUID` (AD), `entryUUID` (OpenLDAP), sinon DN. Verrouillage après
  `maxFailedLogins` échecs sur 15 min par (fournisseur, identifiant), et limitation par IP.
- **Comptes** : une identité est liée par `(provider_id, subject)`. **Aucune fusion par email**
  (risque de prise de contrôle) : si l'adresse appartient déjà à un compte, la connexion est
  refusée (`account_exists`) et l'utilisateur rattache l'identité **depuis une session active**
  (`/auth/sso/:id/start?link=1`). Sinon, création automatique si `autoProvision`.
  Le retrait de la dernière méthode de connexion d'un compte est refusé.
- **MFA** (`config.mfa`) : `auto` (MFA locale selon la politique plateforme, sauf si le
  fournisseur atteste une MFA via `amr`/`acr` OIDC ou `AuthnContextClassRef` SAML),
  `require_idp` (refus sans MFA attestée), `trust_idp` (le fournisseur impose la MFA),
  `local` (toujours la politique locale). LDAP, GitHub et GitLab : `local`.
- **Secrets** dans Vault (`auth-providers/<id>`) : `clientSecret`, `bindPassword`, `privateKey`
  SAML. Jamais renvoyés par l'API ; un secret vide à l'enregistrement conserve l'existant ;
  révoqués à la suppression du fournisseur.
- **Erreurs** : le retour vers l'interface ne porte qu'un **code** stable (`sso_error=…`),
  jamais de détail technique (journalisé côté serveur). Chemin de retour relatif uniquement
  (pas de redirection ouverte).
- **Restrictions OAuth** facultatives : organisations GitHub, groupes GitLab.

## Conséquences

- Tests de bout en bout contre un **vrai Keycloak** (OIDC + SAML) et un **vrai OpenLDAP**
  (`tests/e2e/sso/`). GitHub/GitLab : testés unitairement (pas d'instance publique en CI) ;
  le bouton « Tester » de l'administration vérifie l'accès à l'instance et la présence du secret.
- Non couverts en v1 : déconnexion unique (SLO SAML / RP-initiated logout OIDC), mappage
  groupes → rôles plateforme / équipes, SCIM. L'architecture (`auth_identities.raw_profile`,
  configuration JSON validée par type) permet de les ajouter.
