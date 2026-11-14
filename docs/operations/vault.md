# Vault : déverrouillage et jeton d'administration

Le mode se choisit avec `CAP_VAULT_UNSEAL_MODE` dans `infrastructure/docker/.env`, **avant la
première initialisation** de Vault.

| Mode | Usage | Clés | Après un redémarrage de Vault |
|---|---|---|---|
| `file` (défaut) | développement, recette | `.secrets/vault-init.json` en clair, avec le jeton root | déverrouillage automatique (`vault-unsealer`) |
| `manual` | production sans service de clés | réparties entre opérateurs, chiffrées PGP | déverrouillage humain (`scripts/vault-unseal.sh`) |
| `auto` | production avec KMS ou un Vault d'entreprise | clés de récupération chiffrées PGP | automatique, par le service de clés |

En modes `manual` et `auto` :
- aucune clé ni aucun jeton root ne reste en clair sur l'hôte ;
- le jeton root ne sert qu'à l'amorçage, puis il est **révoqué**.

## Clés PGP des opérateurs

Avant l'initialisation, déposez la clé publique de chaque détenteur dans
`infrastructure/docker/.secrets/vault-pgp/<nom>.asc` (armure ASCII) :

```bash
gpg --armor --export alice@exemple.com > .secrets/vault-pgp/alice.asc
```

Il y a une part par fichier. Le seuil vaut `VAULT_KEY_THRESHOLD` (3 par défaut, plafonné au nombre
de parts). Sans clé PGP, les clés sont écrites une seule fois dans
`.secrets/vault-keys-A-RETIRER-DE-L-HOTE.json` : remettez-les à leurs détenteurs, puis supprimez le
fichier.

## Mode `manual`

```bash
CAP_VAULT_UNSEAL_MODE=manual   # dans .env
docker compose up -d           # l'amorçage initialise Vault puis attend le déverrouillage
```

Les parts chiffrées sont dans `.secrets/vault-unseal-keys.pgp.json`. Chaque détenteur déchiffre la
sienne, puis la saisit (la saisie n'est pas affichée) :

```bash
jq -r '.["clés de déverrouillage"][0]' .secrets/vault-unseal-keys.pgp.json | base64 -d | gpg -d
./scripts/vault-unseal.sh
```

Une fois le seuil atteint, l'amorçage se termine et les services démarrent. Le même script sert
après chaque redémarrage de Vault : `vault-unsealer` ne fait alors que signaler l'état scellé.

## Mode `auto`

1. Créez une clé chez le fournisseur : AWS KMS, Google Cloud KMS, Azure Key Vault, ou le moteur
   `transit` d'un autre Vault.
2. Copiez `vault/seal.hcl.example` en `vault/seal.hcl` et gardez une seule stanza `seal`.
3. Si des identifiants sont nécessaires, mettez-les dans `vault/seal.env` (permissions 600) :
   - `AWS_*` ou `GOOGLE_APPLICATION_CREDENTIALS` ;
   - `VAULT_TOKEN` pour transit.

   Préférez une identité de l'hôte (rôle IAM, compte de service).
4. Mettez `CAP_VAULT_UNSEAL_MODE=auto`, puis lancez `docker compose up -d`.

Les **clés de récupération** (`.secrets/vault-recovery-keys.pgp.json`) ne déverrouillent pas Vault.
Elles servent à régénérer un jeton root ou à migrer de service de clés.

## Jeton d'administration après l'installation

Les mises à jour qui ajoutent des politiques demandent de relancer l'amorçage avec un jeton
d'administration. En modes `manual` et `auto`, les détenteurs des clés génèrent un jeton root
temporaire :

```bash
docker compose exec vault vault operator generate-root -init      # affiche nonce et OTP
docker compose exec vault vault operator generate-root            # chaque détenteur, avec sa part
docker compose exec vault vault operator generate-root -decode=<jeton encodé> -otp=<OTP>
VAULT_TOKEN=<jeton> docker compose run --rm -e VAULT_TOKEN bootstrap
docker compose exec -e VAULT_TOKEN=<jeton> vault vault token revoke -self
```

Sans `VAULT_TOKEN`, l'amorçage conserve la configuration existante et le signale.

## Migration depuis le mode `file`

Une instance initialisée en mode `file` garde ses clés. Pour passer en production, il faut une
nouvelle installation avec le bon mode, ou une opération manuelle :
- **vers `manual`** : `vault operator rekey` avec les clés PGP des opérateurs, puis suppression de
  `vault-init.json` ;
- **vers `auto`** : migration de seal (`seal` avec `disabled = true` sur l'ancien, voir la
  documentation de Vault).

## Vérification

`tests/e2e/vault-modes.test.mjs` démarre des Vault jetables :
- **`manual`** : 3 opérateurs PGP avec un seuil de 2, aucune clé en clair, jeton root révoqué,
  identité de service fonctionnelle, pas de déverrouillage automatique après redémarrage ;
- **`auto`** : transit d'un autre Vault, clés de récupération chiffrées, déverrouillage automatique
  y compris après redémarrage.
