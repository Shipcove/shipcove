# ADR 0005 — Gateway LLM, LiteLLM et crédits pondérés

- Statut : accepté — 2026-11-13

## Décision
Chemin d'un appel LLM : Pi (sandbox) → `apps/gateway` `/llm/v1/chat/completions` → LiteLLM → provider.

1. Pi s'authentifie auprès de la gateway avec un **jeton de run** opaque (haché en base, lié à
   un workspace, un run et un utilisateur, expirant). Ce jeton ne donne accès qu'aux modèles
   autorisés et est débité sur le quota de son propriétaire : il n'élargit aucun privilège.
2. Avant chaque appel, la gateway **réserve atomiquement** un montant estimé
   (`credit_reservations`) dans une transaction verrouillant le compteur de l'utilisateur
   (ordre fixe → pas d'interblocage), en tenant compte des réservations ouvertes de toutes les
   instances.
3. Elle relaie le flux à LiteLLM (`stream_options.include_usage=true`), capture l'usage final,
   **régularise** (écriture `credit_ledger` idempotente, clé = id de requête) et libère l'excédent.
4. Usage manquant : la réservation passe en `pending_reconciliation`; un job interroge les logs
   LiteLLM (`/spend/logs`) par `litellm_call_id` ; sans donnée, la réservation est convertie selon
   la politique admin (par défaut : débit de l'estimation d'entrée seule, marquée `estimated`).
   Aucune consommation n'est inventée silencieusement.
5. Réservation refusée (quota) : réponse HTTP 402 `quota_exceeded` non rejouable ; le run est
   marqué `paused_quota` ; l'appel déjà engagé s'est terminé normalement.

## Formule
Unité : **crédits pour 1 000 tokens**, `numeric(20,8)`, calcul en décimal exact.
`input_non_cache = prompt_tokens − cached_tokens − cache_creation_tokens` (format OpenAI renvoyé par
LiteLLM, où `prompt_tokens` inclut les tokens cache) ;
`crédits = (input_non_cache·c_in + output·c_out + cache_read·c_cr + cache_write·c_cw) / 1000`.
Chaque token n'est compté qu'une fois. Coefficients versionnés (`model_coefficients`, valides à
partir de `effective_from`) ; une consommation référence la version utilisée.

## Fenêtres
5 h et 7 jours glissants, calculées par somme du ledger + réservations ouvertes sur la fenêtre.
Les deux s'appliquent à l'utilisateur, et à lui seul : un compteur par personne pour toutes ses
conversations, aucun plafond collectif (voir ADR 0015). Les titres automatiques ne sont pas décomptés.

## Révision (2026-11-15) : LiteLLM source de vérité des modèles

- La plateforme ne déclare plus les modèles dans LiteLLM : elle les **découvre** (`/model/info`,
  repli `/v1/models`) au rechargement manuel, à l'enregistrement de la connexion et toutes les
  10 minutes (worker). Un modèle découvert est créé **désactivé**, coefficients préremplis depuis
  les prix LiteLLM (1 crédit = 0,001 USD) ; un modèle disparu est marqué indisponible, jamais
  supprimé (le ledger le référence).
- **Connexion** : URL et clé d'administration dans Vault (`infra/litellm`, écriture réservée à
  l'API), lues par l'API, la gateway et le worker avec un cache de 30 s ; `LITELLM_URL` reste la
  valeur par défaut. Mise à jour d'une installation existante : la politique Vault de l'API doit
  être réappliquée (amorçage, avec `VAULT_TOKEN` en mode production).
- **Liste blanche** par modèle (`allowed_user_ids`, vide = tous), appliquée à `/models`, à la
  création et aux messages des conversations, à la configuration de Pi dans la sandbox et à la
  passerelle LLM.

## Révision (2026-11-19) : admission sur le consommé, estimation de sortie plafonnée

Constat : Pi envoie toujours `max_tokens` = sortie maximale du modèle. La réservation de ce plafond,
ajoutée au consommé, dépassait le reste disponible : l'appel était refusé (402) et l'agent suspendu
alors que l'interface affichait, par exemple, 27 % de la fenêtre utilisés.

- **Admission** : un appel est refusé seulement si la fenêtre est déjà épuisée
  (`ledger + réservations ouvertes ≥ limite`), comme pour la reprise d'un run (`canProceed`).
  Le dépassement possible est borné au coût réel des appels en cours ; il est préféré à un refus
  incompréhensible pour l'utilisateur.
- **Estimation de sortie** : `min(max_tokens, maxOutputTokens du modèle, defaultOutputReservation)`.
  Le réglage devient le plafond des tokens de sortie réservés par appel ; la régularisation débite
  toujours l'usage réel. Les réservations ouvertes (et le pourcentage affiché, qui les inclut)
  restent ainsi réalistes, y compris avec des sous-agents en parallèle.
