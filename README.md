# ORCHARD-SCAN

Relevé arboricole hors ligne — verger de Heretiskari, Kakhétie.
2 980 arbres, deux opérateurs, du 8 au 25 août 2026.

PWA sans framework, sans dépendance, sans build. On dépose les fichiers, ça marche.

---

## 1. Déployer sur GitHub Pages — 5 étapes

1. Créer un dépôt GitHub **public** (Pages est gratuit sur les dépôts publics).
2. Y déposer le contenu de ce dossier, **à la racine** — pas dans un sous-dossier :
   `index.html`, `app.js`, `styles.css`, `strings.json`, `service-worker.js`,
   `manifest.json`, `rangs_registry_v2.csv`, et le dossier `assets/`.
3. Dépôt → **Settings** → **Pages** → *Source* : `Deploy from a branch`,
   *Branch* : `main` / `/ (root)` → **Save**.
4. Attendre ~1 minute. L'URL s'affiche en haut de la page Settings → Pages :
   `https://<compte>.github.io/<depot>/`
5. Ouvrir cette URL **dans Chrome sur le téléphone**. Le HTTPS de GitHub Pages
   est indispensable : sans lui, pas de service worker, donc pas de mode hors ligne.

> Avant tout déploiement, lancer la vérification des chaînes (§6). Une clé
> manquante ne se voit pas au bureau et se voit très bien au champ.

## 2. Installer sur le téléphone — 5 étapes

1. Ouvrir l'URL dans **Chrome** (pas dans un navigateur intégré à une autre app).
2. Menu ⋮ en haut à droite → **Ajouter à l'écran d'accueil** / **Installer l'application**.
3. Confirmer. Une icône ORCHARD apparaît sur l'écran d'accueil.
4. **Fermer Chrome et rouvrir l'application par cette icône.** C'est ce lancement-là
   qui obtient le stockage permanent ; ouvert comme un simple onglet, Android
   s'autorise à effacer les données sous pression mémoire.
5. Saisir le prénom de l'opérateur. **Une seule fois, au bureau** — c'est la seule
   saisie clavier de toute l'application.

Vérifier ensuite dans **ÉTAT DES DONNÉES** que `STOCKAGE PERMANENT` vaut **OUI**.
Si c'est NON, un bandeau rouge le dit et la saisie reste bloquée : reprendre
l'étape 4. L'application refuse de démarrer une session plutôt que de laisser
croire que les données sont à l'abri.

### À faire une fois, au premier dépôt de fichier

Au premier export automatique, Chrome demande
« Autoriser le téléchargement de plusieurs fichiers ? » → **Autoriser**.
Sans cette autorisation, les dépôts de fin de rang suivants échouent
silencieusement, et la couche de sauvegarde qui protège vraiment le travail
disparaît sans prévenir.

## 3. Au champ

- L'application **assigne** le rang. L'opérateur ne choisit pas.
- Un tap = une valeur écrite sur disque. Il n'y a rien à valider, rien à enregistrer.
- **En fin de rang, un CSV part tout seul** dans les Téléchargements du téléphone
  (`T1_R07_AXATYA_20260808_1432.csv`). C'est la sauvegarde qui survit à un vidage
  de cache, une désinstallation, un crash.
- Si la barre du haut passe au **rouge**, plus de 45 minutes se sont écoulées
  sans export : faire *EXPORT COMPLET* depuis l'accueil dès que possible.
  La saisie n'est jamais bloquée pour autant — bloquer un opérateur en plein
  rang serait pire que le risque évité.
- **TERMINER CE RANG** demande *pourquoi*, et les deux réponses n'ont pas le
  même sens : « il n'y a plus d'arbres » clôt le rang et corrige le registre au
  compte réel ; « je m'arrête ici » le met en pause, l'exclut des calculs de
  taux, et le rang sera repris à la même position.

### Récupérer les fichiers

Brancher le téléphone en USB, ou copier le dossier `Download` vers le PC.
Tout regrouper dans un même dossier, puis §5.

## 4. Remplacer une photo de référence

Écraser le fichier dans `assets/` en gardant **exactement** le même nom, puis
pousser sur GitHub. Recharger l'application : la nouvelle image apparaît.
Aucune modification de code, aucun changement dans `service-worker.js`.

Le service worker sert le réseau en premier avec repli sur le cache : en ligne
il voit le fichier écrasé, hors ligne il sert la copie locale sans délai.

## 5. Fusionner les exports — `merge.py`

Nécessite Python 3.9 ou plus récent. Rien d'autre : aucune bibliothèque externe.

```bash
python merge.py chemin/vers/le/dossier_des_csv
```

Produit, dans le même dossier :

| fichier | contenu |
|---|---|
| `consolide_<horodatage>.csv` | une ligne par arbre par passe, dédoublonnée |
| `doublons.csv` | les saisies écartées, conservées telles quelles |
| `liste_taille_2026-27.csv` | la feuille du tailleur, un bloc par rang |

Le dédoublonnage se fait sur `arbre_id + passe`, **la saisie la plus récente
gagne**. Les perdantes ne sont pas jetées : le cas qui produit un doublon — un
rang refait après une pause mal reprise — est précisément celui où l'on veut
pouvoir vérifier ce qui a été écrasé.

Les lignes du jeu de démonstration (`terrain = TD`, `source = DEMO`) sont
exclues automatiquement.

Un jeu d'essai est fourni dans `exemples_export/` : deux appareils, un doublon
volontaire sur les positions 2 et 3, un arbre incomplet, des lignes de
démonstration à filtrer.

```bash
python merge.py exemples_export
```

## 6. Vérifier les traductions avant déploiement

```bash
node check-strings.js
```

Sort en erreur si une clé manque dans l'une des deux langues, si une clé
utilisée par le code n'existe pas, ou si les marqueurs `{n}` diffèrent entre
le français et l'anglais.

Un équivalent Python est fourni pour les postes sans Node — même verdict :

```bash
python check_strings.py
```

---

## Le format d'export, et pourquoi il est ainsi

Les fichiers commencent par **le BOM UTF-8**, puis par la ligne **`sep=;`**,
puis par les en-têtes.

Ces deux détails ne sont pas décoratifs :

- sans le BOM, Excel sous Windows affiche `Ã‰CORCE` au lieu de `ÉCORCE` ;
- sans `sep=;`, un CSV en point-virgule ouvert sur un poste configuré en
  virgule s'affiche **entièrement dans une seule colonne**.

Le fichier doit s'ouvrir correctement **au double-clic**, sans passer par
l'assistant d'import, sur n'importe quelle locale. `merge.py` saute cette
première ligne à la lecture et la réécrit à l'écriture.

Chaque classe occupe **deux colonnes** : un code ordinal pour calculer, un
libellé texte pour relire. Tout bloc non renseigné vaut `NULL` explicite —
jamais zéro. Un zéro par défaut fabriquerait des faux zéros indiscernables
des vrais.

Les libellés d'export sont **toujours en français**, quelle que soit la langue
de l'interface : deux appareils réglés différemment doivent produire des
fichiers fusionnables. La langue de saisie est tracée par la colonne
`langue_saisie`.

### Colonnes ajoutées au-delà du minimum demandé

| colonne | pourquoi |
|---|---|
| `espece` | Terrain 3 : l'espèce est le premier tap, elle ne pouvait pas se ranger dans `etat` sans perdre l'information |
| `version` | une correction crée une version horodatée et n'écrase jamais ; sans ce numéro, `doublons.csv` serait illisible |
| `source` | distingue `SAISIE`, `RECONTROLE` et `DEMO` |
| `media_ref` | rattache une note vocale de 30 s à sa ligne |

### `rang_statut`

| valeur | signification |
|---|---|
| `COMPLET` | « il n'y a plus d'arbres » — registre corrigé au compte réel |
| `PARTIEL` | « je m'arrête ici » — **à exclure des calculs de taux** |
| `ECART` | rang terminé, mais le registre n'avait pas de compte fiable (`a_verifier`, ou aucune valeur attendue) : il n'y a rien à quoi comparer |
| `EN_COURS` | rang non encore clos au moment de l'export |

`EN_COURS` et `ECART` sont des ajouts d'interprétation : la spécification
nomme les trois premiers mais ne dit pas quoi écrire pour un rang encore
ouvert, et laisser la colonne vide aurait été un NULL silencieux dans une
colonne obligatoire.

---

## Écarts assumés par rapport à la maquette v5

1. **Gris secondaire assombri** — `#7A8288` → `#4A5157`. La maquette fait foi
   pour les couleurs, mais la règle d'interface 10.5 exige un contraste ≥ 7:1
   pour la lecture au soleil, et le gris d'origine plafonnait à 3,9:1. Le
   nouveau gris tient 8:1 et reste visuellement identique. La palette des
   surfaces d'action est inchangée.
2. **Fiche ÉCORCE : les quatre photos remplacent les schémas provisoires.**
   La maquette v5 affiche encore un encadré « PROVISOIRE » et des tracés
   vectoriels ; la spécification §7.1 demande les photos, et elles existent.
3. **Zone tactile des pastilles `?` portée à 60 px** sans changer leur taille
   visible — elles se visent au pouce, avec des gants.
4. **Sens de parcours non affiché.** La maquette annonce « pars du BAS », mais
   la colonne `origine_position_1` est vide pour les 88 rangs du registre livré.
   Afficher une direction que rien ne fonde serait pire que ne rien afficher :
   l'écran de mission montre le nombre d'arbres seul. Dès que la colonne sera
   renseignée, le sens s'affichera sans modification de code.
5. **Numéro de rang du Terrain 3 au pavé tactile.** La maquette propose 1 à 5
   et « … » ; le « … » ouvre un pavé de chiffres, pas un clavier — aucune
   saisie clavier n'est autorisée au champ.

---

## Structure

```
index.html            écrans
app.js                toute la logique, en sections numérotées
styles.css            reprise de la maquette v5
strings.json          toutes les chaînes, fr + en
service-worker.js     hors ligne + revalidation des images
manifest.json         installation sur l'écran d'accueil
rangs_registry_v2.csv 88 rangs, 2 980 positions
assets/               6 photos + 2 icônes
merge.py              fusion et liste de taille
check-strings.js      barrière de traduction (+ check_strings.py)
exemples_export/      jeu d'essai pour merge.py
```

Le jeu de démonstration (50 arbres) se charge depuis **ÉTAT DES DONNÉES →
CHARGER LE JEU DE DÉMONSTRATION**. Il vit sur un terrain fictif `TD`, ne touche
jamais T1/T2/T3, et se supprime d'un bouton.
