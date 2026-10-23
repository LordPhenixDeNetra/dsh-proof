# dsh-proof — le harnais qui exige des preuves

> **English:** dsh-proof runs your project's typecheck/lint/tests after file edits and prevents the agent from ending the turn while they fail.

Plugin **DeepSeek Harness** (DSH) : après chaque modification de fichiers, il exécute les vérifications du projet (typecheck, lint, tests) et **refuse de laisser l'agent terminer son tour tant qu'elles échouent**. L'agent reçoit la sortie d'erreur et un tour supplémentaire pour corriger — au lieu de déclarer « c'est fait » sans preuve.

---

## Pourquoi ce plugin

Le mode d'échec le plus coûteux d'un agent de code n'est pas la mauvaise syntaxe : c'est **la conclusion prématurée**. L'agent modifie trois fichiers, écrit « terminé », et vous découvrez à la main que le typecheck casse et que deux tests échouent.

`dsh-proof` couvre le moment précis où l'agent veut s'arrêter : il transforme les checks du projet en **condition de sortie du tour**.

- **Zéro configuration** sur un projet Node dont le gestionnaire de paquets est disponible.
- **Boucle de correction bornée** : `maxReruns` limite les relances, donc pas de boucle infinie.
- **Outil `verify`** : l'agent peut lancer les mêmes checks lui-même avant de conclure.
- **Section de prompt** : l'agent sait quelles vérifications sont actives et qu'elles sont bloquantes.
- **Hôte uniquement** : aucun bundle navigateur, aucune dépendance UI.

## Prérequis

- DSH `>=0.2.1-rc.2 <0.3.0` (le paquet déclare cette plage dans `engines.dsh`).
- Node.js `>=22.19`.
- Le gestionnaire de paquets du projet (`npm`, `pnpm`, `yarn` ou `bun`) disponible dans le `PATH`.
- Un `package.json` avec au moins un script `typecheck`, `lint`, `test` ou `check`, ou des `checks` explicites.

## Installation

### Application Desktop

1. Dépliez la barre latérale gauche (**Ctrl+B** si elle est repliée).
2. Ouvrez le panneau **Plugins** (icône en forme d'hélice, sous « Nouvelle session »).
3. Cliquez sur **Ajouter un plugin**.
4. Collez le chemin absolu de l'archive, ou le nom `dsh-proof` après publication npm.
5. Cochez la case de confiance, installez, puis redémarrez DSH si l'application le demande.

```text
N:\OneDrive - Université Cheikh Anta DIOP de DAKAR\MixedProjects\HarnessPluginTest\dsh-proof-0.1.1.tgz
```

> Le profil `desktop` est géré exclusivement par l'application : `dsh plugin --profile desktop` est refusé par la CLI.

### Profil CLI (`web`, `headless`)

```sh
dsh plugin --profile web add dsh-proof
```

ou, depuis ce dépôt :

```sh
pnpm install
pnpm test
pnpm pack
dsh plugin --profile web add ./dsh-proof-0.1.1.tgz
```

Puis redémarrez le profil : les changements de manifeste et d'exports ne sont pas rechargés à chaud.

## Utilisation

### Automatique

Après un appel à `write`, `edit`, `apply_patch`, etc., la porte s'active à la fin du tour :

1. elle exécute les checks dans le dossier de la session ;
2. si tout passe, le tour se termine normalement ;
3. si un check échoue, la sortie est renvoyée à l'agent via `agent.steer(...)`, qui **empêche la fermeture du tour** et ouvre une étape de correction ;
4. `maxReruns` borne les relances (2 par défaut).

Un succès est silencieux. Un échec produit un message `[Proof gate]` dans la conversation.

### Outil `verify`

```text
verify()             # exécute tous les checks
verify(only="test")  # exécute uniquement le check nommé
```

Il renvoie `{ passed, skipped, cwd, checks[] }` et un rendu texte compact : statut global, nom du check, code de sortie, sortie en cas d'échec.

## Configuration

Les valeurs par défaut suffisent sur un projet Node. Pour un réglage explicite, ajoutez une **surcharge de haut niveau** dans `~/.dsh/profiles/<profil>/cordis.patch.yml` :

```yaml
- id: proof
  config:
    checks:
      - name: typecheck
        command: npm run typecheck
        timeoutMs: 120000
      - name: test
        command: npm test
        timeoutMs: 180000
```

> Le bundle a déjà inséré la ligne `proof`. Utilisez `- id: proof` pour la surcharger ; un second `insert` avec le même `id` créerait un doublon au démarrage.

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

### Détection automatique

Le gestionnaire de paquets est choisi d'après le lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, sinon npm), **mais uniquement s'il est réellement disponible dans le `PATH`**. Sinon, le plugin se replie sur `npm`. Les scripts suivants sont transformés en commandes :

- `typecheck` → `npm run typecheck` (ou le gestionnaire détecté) ;
- `lint` → …
- `test` → …
- `check` (uniquement si aucun des trois précédents n'existe).

## Fonctionnement

1. Le plugin observe les événements de session. Un appel à `write`, `edit`, `str_replace_editor`, `apply_patch`… marque le workspace comme modifié.
2. À `agent/turn-stopping`, si des fichiers ont changé, les checks sont exécutés dans le dossier de la session.
3. En cas d'échec, la sortie est envoyée à l'agent, qui doit corriger avant de conclure.
4. Le tour ne se termine sans vérification que si les checks passent, ou si `maxReruns` est épuisé (un avertissement est alors journalisé).

## Sécurité

Les checks sont des **commandes shell exécutées avec les privilèges de l'utilisateur, en dehors du bac à sable de DSH** — comme un script `npm test` lancé à la main. Ne configurez que des commandes de confiance.

Le plugin ne modifie pas les fichiers lui-même. En revanche, les commandes qu'il lance peuvent le faire (formatters, mise à jour de snapshots). Leur sortie est visible par le modèle : évitez d'y imprimer des secrets.

## Dépannage

- **`'pnpm' n'est pas reconnu`** : le gestionnaire du lockfile n'est pas dans le `PATH`. Le plugin se replie désormais sur `npm` ; sinon, installez pnpm ou utilisez des `checks` explicites avec `npm`.
- **`Verification skipped`** : aucun `package.json` ni check configuré. Ajoutez un script `test` ou des `checks`.
- **Aucun blocage après une édition** : l'édition a peut-être été faite via `pwsh`/`bash`. Activez `watchShell: true` ou utilisez les outils d'édition.
- **Les checks sont trop lents** : ajustez `timeoutMs` ou limitez la liste des checks.

## Limites assumées

- Seuls les outils d'édition connus déclenchent la porte ; le suivi des commandes shell est une heuristique optionnelle.
- Aucun rollback automatique : le plugin relance la correction, il ne restaure pas les fichiers.
- Les checks s'exécutent séquentiellement ; un projet dont la suite de tests dépasse le timeout doit ajuster `timeoutMs`.
- Le suivi est par session ; les sous-agents sont ignorés par défaut.

## Développement

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # build + tests (node:test)
pnpm pack       # archive installable
```

Structure :

```text
src/index.ts        entrée Cordis : outil verify, section de prompt, hooks
src/gate.ts         machine à états de la porte (testable sans DSH)
src/runner.ts       exécution bornée des commandes
src/types.ts        configuration + source de message « proof »
src/__tests__/      tests unitaires
cordis.patch.yml    couche de configuration du bundle
```

## Publication

Les releases GitHub sont automatisées par le workflow [release.yml](.github/workflows/release.yml) : pousser un tag `v*` exécute les tests, vérifie la version, construit l'archive et crée la release avec l'asset. La publication npm reste manuelle.

Voir [PUBLISHING.md](PUBLISHING.md) pour la checklist complète npm, GitHub et tarball.

## Licence

MIT.
