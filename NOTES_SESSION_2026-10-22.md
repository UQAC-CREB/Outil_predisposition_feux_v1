# Notes de session — v3 (22 octobre 2026)

État de la v3 à la fin de la journée, à relire avant de reprendre. **Prochaine étape : premier commit et dépôt GitHub.**

La v3 est fonctionnelle en local dans `web_v3/`. La v2 (`web/`) n'a pas été modifiée. Testée de bout en bout dans un navigateur headless avec les 4 KMZ de `../work_v3/`, rapport PDF compris.

Lancer en local : `python scripts/serve.py` dans `web_v3/`, puis ouvrir http://localhost:8000.

## Ce que fait la v3

- **Ordre du panneau** : 1. Emprise du projet, puis 2. Zone régionale. INFO-COMMUNAUTÉ devient INFO-PROJET, et INFO-MRC devient INFO-TERRITOIRE.
- **Import du projet** : par bouton ou par glisser-déposer sur le panneau ou sur la carte.
  - Formats acceptés : KML, KMZ, Shapefile (en .zip ou en fichiers .shp/.dbf/.prj sélectionnés ensemble), GeoJSON, GeoPackage, GPX, FlatGeobuf, CSV (lon/lat ou WKT) et WKT.
  - La reprojection est automatique.
  - L'infobulle ℹ détaille les particularités de chaque format, et les erreurs sont expliquées en clair (pas de .prj, géodatabase .gdb, coordonnées hors du Québec, etc.).
- **Après l'import** : la carte se cadre sur le projet et les combustibles s'affichent dans la zone tampon arrondie, avec un masque gris à l'extérieur. Le curseur va de 1 à 50 km (25 km par défaut).
- **Sites** : les entités à plus de 50 km les unes des autres forment des « Site 1 », « Site 2 », etc. Chaque site a sa fiche, et une page par site est cochée dans le rapport. C'est l'équivalent des villes n° 1 et n° 2 de la v2.
- **Zone régionale automatique par défaut** : un carré de 100 km centré sur le projet, avec les choix ×0,5 = 50 km, ×1,5 = 150 km et ×2 = 200 km. Les autres modes sont MRC (celle du projet est présélectionnée), Rectangle et Ma zone (import d'un polygone, mêmes formats).
- **Rapport PDF** : la page territoire, avec les sites sur la carte de localisation, puis une page par site, puis les légendes.

## Pipeline de données

- **Combustibles et potentiel** : reconstruits sur tout le Québec, alors que la v2 les limitait à 50 km des lieux habités. À moins de 50 km d'un lieu habité, les valeurs sont identiques à la v2.
- **Calcul autour des entités** : les statistiques sont calculées à la volée à partir des tuiles de la carte, sans précalcul par entité. Avec le cache par site, le curseur reste instantané.
- **Précision** : pour un tampon de 10 km, la superficie analysée diffère de 0,24 % de celle du tampon affiché.
- **Python** : les tuiles nécessitent le Python de miniconda (`mercantile` et `pmtiles` ne sont pas installés dans `C:\Python314`).

Détails des commandes et de l'architecture : voir `README.md`.

## Points à valider

1. **Projet très étendu** : si les entités dépassent la taille choisie, le carré est agrandi pour tout couvrir. Avec les 4 KMZ ensemble (sites distants d'environ 300 km), il fait 339 km, au-delà du maximum de 200 km. Une autre option serait une zone régionale par site. À trancher.
2. **Problème dans la v2, non corrigé** : ses dénominateurs « superficie combustible » sont calculés sur les rasters découpés à 50 km. Le total est de 46,7 M ha au lieu de 121,3 M ha. Les taux « par 100 000 ha » des grandes MRC nordiques y sont donc surestimés (par exemple MRC_992 : 6,7 M ha comptés au lieu de 42 M ha). La v3 utilise les valeurs complètes.
3. **Hébergement** : les tuiles font 386 Mo (combustibles) et 270 Mo (potentiel). Il faudra `rclone` pour Cloudflare R2, car la limite de `wrangler` est de 300 Mo par fichier.
4. **Suivi des visites** : le suivi Google et Umami a été retiré pour le développement local. Il faudra le rétablir à la mise en ligne.

## Pour demain : mise sur GitHub

- Le dépôt git est initialisé (branche `main`), sans remote et sans commit.
- `tiles_v3/` et `scripts/_*` sont exclus par `.gitignore`.
- Étapes : premier commit, création du dépôt (ex. `UQAC-CREB/MAMH_Combustibles_fiches_v3`), ajout du remote. La poussée (push) est faite par Hugues.
- Analyse pilote de la taille de zone : `../analyse_v3/emprise_regionale_pilote.py` (résultats dans `resultats_pilote.json`).
