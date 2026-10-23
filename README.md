# dsh-proof — le harnais qui exige des preuves

Plugin **DeepSeek Harness** (DSH) : après chaque modification de fichiers, il exécute les vérifications du projet (typecheck, lint, tests) et **refuse de laisser l'agent terminer son tour tant qu'elles échouent**. L'agent reçoit la sortie d'erreur et un tour supplémentaire pour corriger — au lieu de déclarer « c'est fait » sans preuve.

_______

## Pourquoi ce plugin

Le mode d'échec le plus coûteux d'un agent de code n'est pas la mauvaise syntaxe : c'est **la conclusion prématurée**. L'agent modifie trois fichiers, écrit « terminé », et l'utilisateur découvre à la main que le typecheck casse et que deux tests échouent.

Les garde-fous existants couvrent le coût, les permissions ou la revue de code. `dsh-proof` couvre le moment précis où l'agent veut s'arrêter : il transforme les checks du projet en **condition de sortie du tour**.

- **Zéro configuration** sur un projet Node : les scripts `typecheck`, `lint`, `test` de `package.json` sont détectés automatiquement.
- **Boucle de correction bornée** : `maxReruns` limite les relances, donc pas de boucle infinie.
- **Outil `verify`** : l'agent peut lancer les mêmes checks lui-même avant de conclure.
- **Section de prompt** : l'agent sait quelles vérifications sont actives et qu'elles sont bloquantes.
- **Hôte uniquement** : aucun bundle navigateur, aucune dépendance UI.

## Installation

### Depuis npm (après publication)

```sh
dsh plugin --profile web add dsh-proof
```

### Depuis ce dépôt (tarball)

```sh
pnpm install
pnpm build
pnpm pack
dsh plugin --profile web add ./dsh-proof-0.1.0.tgz
```

Puis **redémarrez le profil** : les changements de manifeste et d'exports ne sont pas rechargés à chaud.

## Configuration

Les valeurs par défaut fonctionnent sans configuration sur un projet Node. Pour un réglage explicite, dans `~/.dsh/profiles/<profil>/cordis.patch.yml` :

```yaml
- insert:
    - id: proof
      name: dsh-proof
      config:
        enabled: true
        maxReruns: 2
        checks:
          - name: typecheck
            command: pnpm run typecheck
            timeoutMs: 120000
          - name: test
            command: pnpm test
```

> Dès que `checks` n'est pas vide, l'auto-détection est désactivée et seules ces commandes sont exécutées.

| Clé | Défaut | Rôle |
|---|---|---|
| `enabled` | `true` | Interrupteur général. |
| `autoDetect` | `true` | Détecte `typecheck`, `lint`, `test` (ou `check`) dans `package.json`. |
| `checks` | `[]` | Liste `{ name, command, timeoutMs }` ; prioritaire sur l'auto-détection. |
| `cwd` | `''` | Répertoire des checks ; relatif au dossier de la session. |
| `maxReruns` | `2` | Nombre maximal de relances correctives par tour (`0` : vérifier sans relancer). |
| `outputChars` | `6000` | Taille maximale de la sortie renvoyée au modèle. |
| `watchShell` | `false` | Compter aussi les commandes shell destructrices comme des éditions. |
| `mutatingShellPattern` | (regex fournie) | Motif des commandes shell considérées comme des éditions. |
| `includeSubagents` | `false` | Appliquer la porte aux sessions de sous-agents. |
| `stopOnFirstFailure` | `true` | S'arrêter au premier check en échec. |

## Fonctionnement

1. Le plugin observe les événements de session. Un appel à `write`, `edit`, `str_replace_editor`, `apply_patch`… marque l'espace de travail comme modifié.
2. À `agent/turn-stopping` — le moment où l'agent n'a plus rien à faire —, si des fichiers ont changé, les checks sont exécutés dans le dossier de la session.
3. En cas d'échec, la sortie est envoyée à l'agent via `agent.steer(...)`, ce qui **empêche la fermeture du tour** et ouvre une étape de correction.
4. Le tour ne se termine sans vérification que si les checks passent, ou si `maxReruns` est épuisé (un avertissement est alors journalisé).

### Outil `verify`

```
verify()            # exécute tous les checks
verify(only="test") # exécute uniquement le check nommé
```

Il renvoie un objet `{ passed, skipped, cwd, checks[] }` et un rendu texte compact : statut global, nom du check, code de sortie, sortie en cas d'échec.

### Détection automatique

Selon le gestionnaire de paquets détecté (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, sinon npm), les scripts suivants sont transformés en commandes :

- `typecheck` → `pnpm run typecheck` / `npm run typecheck` / …
- `lint` → …
- `test` → …
- `check` (uniquement si aucun des trois précédents n'existe)

## Sécurité

Les checks sont des **commandes shell exécutées avec les privilèges de l'utilisateur, en dehors du bac à sable de DSH** — comme un script `npm test` lancé à la main. Ne configurez que des commandes de confiance, et n'activez `watchShell` que si vous acceptez que les commandes shell soient analysées.

Le plugin ne modifie jamais les fichiers et ne contourne pas les approbations de DSH : il observe les événements et relance l'agent.

## Limites assumées

- Seuls les outils d'édition connus déclenchent la porte. Les modifications via shell ne sont prises en compte qu'avec `watchShell: true` (heuristique, pas une preuve).
- Aucun rollback automatique : le plugin relance la correction, il ne restaure pas les fichiers.
- Les checks s'exécutent séquentiellement ; un projet dont la suite de tests dépasse le timeout doit ajuster `timeoutMs`.
- Le suivi est par session ; les sous-agents sont ignorés par défaut.

## Développement

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # build + tests unitaires (node:test)
pnpm pack       # archive installable
```

Structure :

```
src/index.ts        entrée Cordis : outil verify, section de prompt, hooks
src/gate.ts         machine à états de la porte (testable sans DSH)
src/runner.ts       exécution bornée des commandes
src/types.ts        configuration + source de message « proof »
src/__tests__/      tests unitaires
cordis.patch.yml    couche de configuration du bundle
```

## Licence

MIT.


