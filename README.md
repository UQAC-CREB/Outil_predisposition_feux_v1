# Prédisposition aux feux de forêt d'un projet

**Outil d'aide à la décision — portrait des combustibles, du potentiel et de l'historique des feux** · version 1.0 (bêta)

> Application cartographique interactive : l'utilisateur importe l'emprise d'un projet (camp de travailleurs, route, ligne électrique, parc éolien…) ; l'application dresse le portrait des combustibles et du potentiel d'intensité et de propagation autour du projet (INFO-PROJET) et l'historique des feux dans une zone régionale (INFO-TERRITOIRE), puis produit un rapport PDF.

Outil distinct de l'application de consultation par MRC et communauté (`../web`, dépôts `MAMH_Combustibles_fiches` et `_v2`, non modifiée), dont il reprend les données et une partie du code. Développé dans le dossier local `web_v3/` (d'où les mentions « v3 » dans le code et les scripts).

Dépôt : [UQAC-CREB/Outil_predisposition_feux_v1](https://github.com/UQAC-CREB/Outil_predisposition_feux_v1)

---

## Fonctionnalités

| Élément | Comportement |
|---|---|
| **1. Emprise du projet** | Import d'un fichier (bouton, glisser-déposer sur la section ou sur la carte) : points, lignes, polygones. Formats : KML, KMZ, Shapefile (.zip ou .shp/.dbf/.prj sélectionnés ensemble), GeoJSON, GeoPackage, GPX, FlatGeobuf, CSV (lon/lat ou WKT), WKT ; reprojection automatique (.prj, WKT, EPSG). Infobulle ℹ : détails par format. La carte se cadre sur le projet et les combustibles s'affichent dans la zone tampon. |
| **Sites** | Les entités sont regroupées en **sites** : deux entités à moins de 50 km appartiennent au même site (lien simple). Chaque site a sa fiche INFO-PROJET et sa page dans le rapport (équivalent des communautés n° 1, n° 2 de la v2). Clic sur une entité de la carte = choix du site. |
| **INFO-PROJET** | Combustibles 2025 et potentiel I/P dans une zone tampon **à coins arrondis** de 1 à 50 km (25 km par défaut) autour des entités du site ; indice de prédisposition moyen dans la zone tampon. |
| **2. Zone régionale** | **Automatique** (par défaut) : carré Lambert centré sur le projet, ×0,5 = 50 km, ×1 = **100 km**, ×1,5 = 150 km, ×2 = 200 km (maximum), agrandi au besoin pour couvrir tout le projet. Ou **MRC** (MRC du projet présélectionnée), **rectangle** tracé à l'écran, **zone importée** (polygones, mêmes formats que le projet). |
| **INFO-TERRITOIRE** | Occurrences annuelles par cause et superficies brûlées dans la zone régionale (mêmes graphiques que l'INFO-MRC de la v2). |
| **Rapport PDF** | Page territoire (zone régionale, avec les sites du projet sur la carte de localisation) + une page par site coché (tous cochés par défaut) + page de légendes. |
| **Couches, bilinguisme, indice** | Comme en v2. Les combustibles et le potentiel couvrent désormais **tout le Québec**. |

### Taille de la zone régionale automatique

Analyse pilote (`../analyse_v3/emprise_regionale_pilote.py`, 1 200 centres virtuels, carrés de 10 à 400 km) :
N ≥ 100 feux (CV ≈ 10 % sur le taux d'occurrence) est atteint vers 40-100 km selon la latitude ; le CV des superficies brûlées plafonne vers 0,4-0,55 (années extrêmes synchrones) et se stabilise vers 150-250 km. Choix retenu : 100 km par défaut, 50 à 200 km au choix.

---

## Architecture

```
web_v3/
├── index.html, css/, js/ (modules ES)
│   ├── app.js          état, carte, panneau (projet → sites → zone régionale)
│   ├── importgeo.js    lecture des formats géospatiaux → entités WGS84 2D
│   ├── project.js      sites (regroupement à 50 km), zones tampons (turf), carré automatique
│   ├── rasterstats.js  combustibles / potentiel par anneau de 1 km autour d'un site
│   ├── stats.js        séries de feux (MRC ou zone), indice
│   └── report.js       rapport PDF
├── lib/   MapLibre 5, pmtiles, flatgeobuf, proj4, jsPDF, turf 7, togeojson, JSZip, shpjs, sql.js (GeoPackage, chargé à la demande)
├── data/  (≈ 11 Mo)
│   ├── grid_fuel.bin.gz, unit_fuel.json   superficie combustible — recalculées sur tout le Québec (build_fuel.py)
│   └── units.geojson, unit_stats.json, pts_origine.json, grid_burn.bin.gz, indice*, classes.json, province.geojson
│       copiés de la v2 (web/data, produits par web/scripts)
└── tiles_v3/ (hors Git → Cloudflare R2)
    ├── combustibles_2025_qc.pmtiles, potentiel_ip_2025_qc.pmtiles   tout le Québec, z5-12
    └── feux.fgb                                                      copie de la v2
```

**Statistiques autour d'un projet, sans précalcul** (`rasterstats.js`) : la v2 précalculait des anneaux par lieu habité ; en v3, les entités sont quelconques. Pour un site :

1. grille Lambert (≥ 50 m) couvrant le site + 50 km : distance euclidienne exacte aux entités (transformée de distance de Felzenszwalb), corrigée du facteur d'échelle de la projection ;
2. lecture des tuiles PMTiles de la carte (PNG à palette : index = code de classe ; zoom 12, ≈ 25-40 m, ou moins si l'entité est très longue) ;
3. superficie de chaque pixel cumulée par anneau de 1 km et par classe.

Le curseur de zone tampon additionne ensuite les anneaux (instantané). La zone tampon affichée (coins arrondis) est construite par turf ; écart avec la distance de calcul < 0,3 %.

---

## Pipeline de données (`scripts/`)

```powershell
cd scripts
$env:PYTHONIOENCODING = "utf-8"
python build_full_rasters.py      # rasters tout Québec → ../work_v3/ (~6 min)
python build_fuel.py              # grid_fuel.bin.gz + unit_fuel.json (~1 min)
# Python avec mercantile et pmtiles (ex. miniconda) :
python build_tiles.py comb        # → tiles_v3/combustibles_2025_qc.pmtiles
python build_tiles.py pot         # → tiles_v3/potentiel_ip_2025_qc.pmtiles
```

Règles des rasters v3 (`build_full_rasters.py`) : Québec terrestre (`Prov_qclcc_shoreline_s`) et zones EAU de la v2 → données conservées, pixels sans donnée = Eau (combustibles) / Absence combustible (potentiel) ; zones No-Data de la v2 et reste → NA. À moins de 50 km d'un lieu habité, les valeurs sont identiques à celles de la v2.

`scripts/_units_lcc.gpkg` (unités MRC en Lambert) est une copie du fichier produit par `web/scripts/build_units.py`.

## Développement local

```powershell
python scripts/serve.py        # → http://localhost:8000  (requêtes HTTP Range pour PMTiles et FlatGeobuf)
```

Fichiers de test : `../work_v3/*.kmz` (point, ligne, polygone, parc éolien).

## Mise en ligne (à faire)

- Téléverser `tiles_v3/*.pmtiles` et `feux.fgb` sur Cloudflare R2 (fichiers > 300 Mo : `rclone`), puis inscrire l'URL dans `js/config.js` (`R2_TILES_URL`).
- Rétablir le suivi des visites (balises Google et Umami de la v2, avec `data-tag="v3"`).

---

**Observatoire régional de recherche sur la forêt boréale (CREB) — UQAC** · Partenaire : Ministère des Affaires municipales et de l'Habitation (MAMH)
