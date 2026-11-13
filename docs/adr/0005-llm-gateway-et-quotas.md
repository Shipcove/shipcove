# ADR 0005 — Gateway LLM, LiteLLM et crédits pondérés

- Statut : accepté — 2026-11-13

## Décision
Chemin d'un appel LLM : Pi (sandbox) → `apps/gateway` `/llm/v1/chat/completions` → LiteLLM → provider.

1. Pi s'authentifie auprès de la gateway avec un **jeton de run** opaque (haché en base, lié à
   un workspace, un run et un utilisateur, expirant). Ce jeton ne donne accès qu'aux modèles
   autorisés et est débité sur le quota de son propriétaire : il n'élargit aucun privilège.
2. Avant chaque appel, la gateway **réserve atomiquement** un montant estimé
   (`credit_reservations`) dans une transaction verrouillant les compteurs utilisateur puis équipe
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
Les deux s'appliquent à l'utilisateur ; le plafond d'équipe (optionnel) s'applique à l'équipe
propriétaire du projet.
