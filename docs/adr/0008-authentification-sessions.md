# ADR 0008 — Authentification, sessions et CSRF

- Statut : accepté — 2026-11-13

- Sessions serveur en PostgreSQL (`user_sessions`) : cookie `cap_session` opaque (256 bits,
  stocké haché), `HttpOnly`, `Secure` (hors dev), `SameSite=Lax`, expiration glissante + absolue,
  révocation individuelle / globale. Stateless côté API → multi-instance sans affinité.
- CSRF : double-submit — cookie `cap_csrf` lisible (non HttpOnly) + en-tête `X-CSRF-Token`
  exigé sur toute méthode non sûre (intercepteur Angular `HttpClientXsrfModule` équivalent).
- Mots de passe : Argon2id (`@node-rs/argon2`, m=19 MiB, t=2, p=1 — recommandations OWASP).
- MFA : TOTP (RFC 6238) + 10 codes de récupération hachés ; architecture `mfa_factors` typée
  (`totp`, `webauthn` réservé).
- Force brute : limitation par compte et par IP en base, verrouillage progressif, journal.
- Fournisseurs : local, OIDC (openid-client, Keycloak inclus), SAML 2.0 (@node-saml), LDAP/AD
  (ldapts), OAuth GitHub, OAuth GitLab (.com et self-hosted). Une identité externe est liée par
  `(provider_id, subject)` ; **jamais** de fusion automatique sur l'email.
- Connexions Git (`git_connections`) indépendantes de l'identité de login ; plusieurs par
  utilisateur ; tokens dans Vault.
