# Publication de `dsh-proof`

Ce document décrit la procédure recommandée avant la première publication.

## 1. Vérifications avant publication

```sh
npm view dsh-proof version     # le nom doit être libre
pnpm install --frozen-lockfile
pnpm test
npm pack --dry-run             # inspecter le contenu de l'archive
```

Contrôler dans `npm pack --dry-run` :

- `lib/index.js`, `lib/gate.js`, `lib/runner.js`, `lib/types.js` ;
- `lib/types/*.d.ts` ;
- `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json` ;
- **aucun** fichier de test (`lib/__tests__/`) ;
- aucune archive `.tgz` ni `node_modules`.

Vérifier aussi :

- `package.json` : `version`, `engines.dsh`, `peerDependencies`, `dsh.bundle`, `files` ;
- `cordis.patch.yml` : une seule ligne `- id: proof` insérée, pas de doublon ;
- le README ne promet pas une fonctionnalité absente ;
- la version des peer dependencies correspond à la version de DSH ciblée.

## 2. Test dans un profil vierge

Ne testez pas seulement dans le profil Desktop déjà modifié. Utilisez un `DSH_HOME` isolé :

```powershell
$env:DSH_HOME = "C:\Users\DELL\AppData\Local\Temp\dsh-proof-release"
$env:PATH = "<chemin-vers-pnpm>;$env:PATH"

node <chemin-vers-dsh>/lib/bin.js plugin --profile release add .\dsh-proof-0.1.3.tgz
node <chemin-vers-dsh>/lib/bin.js --profile release --dump-config
node <chemin-vers-dsh>/lib/bin.js --profile release --help
```

Attendu :

- le profil contient `dsh-proof` dans `dependencies` et `dsh.profile.bundles` ;
- `--dump-config` affiche une couche `# == dsh-proof` avec `id: proof` ;
- le profil démarre sans erreur d'import.

## 3. Publier sur npm

La publication est **automatisée** par le workflow `release.yml` à chaque tag `v*`, via OIDC Trusted Publishing et `npm publish --provenance`. Aucun token npm n'est stocké dans GitHub.

La **première** publication OIDC valide la configuration Trusted Publisher. Elle doit avoir lieu avant l'échéance affichée dans npm (environ 48 heures après sa création).

Pour une publication manuelle de secours (OTP 2FA requis) :

```sh
npm login
npm publish
```

`prepublishOnly` reconstruit `lib/` avant l'envoi. Après publication :

```sh
npm view dsh-proof version
npm view dsh-proof dist.tarball
```

Puis, dans un profil vierge :

```sh
dsh plugin --profile release add dsh-proof
```

## 4. Publier sur GitHub

### 4.1 Release automatique sur tag

Le workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) se déclenche au push d'un tag `v*` :

1. installe les dépendances et exécute `pnpm test` ;
2. vérifie que le tag correspond à `package.json` (`v0.1.3` ↔ `0.1.3`) ;
3. construit l'archive avec `pnpm pack` ;
4. publie sur npm avec `npm publish --provenance` via OIDC ;
5. crée la release GitHub et y attache le `.tgz`, avec des notes générées automatiquement.

```sh
git tag -a v0.1.3 -m "dsh-proof 0.1.3"
git push origin v0.1.3
```

Le workflow utilise `GITHUB_TOKEN` avec `permissions: contents: write`. La publication npm n'est **pas** automatisée : elle reste une étape séparée (section 3).

En cas d'échec, le tag reste sur le dépôt. Corrigez, puis supprimez et recréez le tag :

```sh
git push --delete origin v0.1.3
git tag -d v0.1.3
# corrections, commit, puis nouveau tag
```

### 4.2 Distribution via Git

1. Poussez le dépôt et ajoutez le topic **`dsh-plugin`** (découverte).
2. Ajoutez un script `prepare` (déjà présent : `tsc -p tsconfig.json`) pour que les installations Git compilent le paquet.
3. Les utilisateurs devront autoriser le script de build :

```yaml
# ~/.dsh/profiles/<profil>/pnpm-workspace.yaml
allowBuilds:
  dsh-proof: true
```

4. Installation :

```sh
dsh plugin --profile web add github:<compte>/dsh-proof#<sha>
```

Épinglez un commit : une installation Git exécute du code au moment de l'installation.

## 5. Distribuer un tarball

Le workflow de release attache automatiquement `dsh-proof-<version>.tgz`. Pour une distribution manuelle :

```sh
pnpm pack
```

Joignez l'archive à une release GitHub. Les utilisateurs l'installent par chemin local ou URL :

```sh
dsh plugin --profile web add ./dsh-proof-0.1.3.tgz
```

## 6. Après publication

- Vérifier l'installation depuis npm dans un profil vierge.
- Vérifier `verify` sur un petit projet et le blocage sur un test en échec.
- Mettre à jour `CHANGELOG.md` et la version pour la prochaine release.
- Vérifier `repository`, `homepage`, `bugs` et `author` dans `package.json`.

## Checklist finale

- [ ] `pnpm test` passe (16 tests).
- [ ] `npm pack --dry-run` ne contient ni tests ni artefacts indésirables.
- [ ] `engines.dsh` et les peer dependencies ciblent la bonne version de DSH.
- [ ] Installation testée dans un profil vierge.
- [ ] `--dump-config` montre la couche `dsh-proof`.
- [ ] README et CHANGELOG à jour.
- [ ] Licence MIT présente.
- [x] `repository`, `homepage`, `bugs` et `author` renseignés.
- [ ] Workflow `Release` actif ; tag `v*` poussé et égal à `package.json`.
- [ ] Release GitHub créée avec l'asset `.tgz`.
- [ ] Aucun secret dans le dépôt ou l'archive.
