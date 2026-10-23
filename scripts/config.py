# -*- coding: utf-8 -*-
"""Chemins et constantes partagés par les scripts de préparation des données v3.

La v3 réutilise les données vectorielles de la v2 (copiées dans data/ : unités MRC, séries par
unité, points d'origine, grille des superficies brûlées, indice) ; seuls les rasters de
combustibles et de potentiel sont reconstruits sur tout le Québec (et non plus à 50 km des
lieux habités), ainsi que les dénominateurs « superficie combustible » qui en dépendent.
"""
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
OUT = WEB / "data"
# Tuiles raster (PMTiles) : exclues de Git (.gitignore), à téléverser sur Cloudflare R2
TILES_OUT = WEB / "tiles_v3"

# Rasters couvrant tout le Québec et fichiers intermédiaires lourds : hors dépôt
WORK = WEB.parent / "work_v3"

# ── Données de référence 2026-10-20 ────────────────────────────────────────
DATA_20261020 = r"C:/0_Projet/MAMH_prediposition_feux/3_Analyse_carto/20260514_MAMH_feux/Data_20261020"
PROV_SHORE = DATA_20261020 + "/Prov_qclcc_shoreline_s.shp"         # contour provincial découpé à la côte
LH_BUFFER50 = DATA_20261020 + "/LH_50km_ident_Qc_singlepart_v2_s.shp"  # CO_TER : Quebec_buffer | EAU | No-Data

# ── Sources (lecture seule) ─────────────────────────────────────────────────
COMB_TIF_RAW = r"C:/1_Data/Geomatique/Combustible/Quebec/MRNF/Combustibles2025_combFBP_25m.tif"
POT_TIF_RAW = r"C:/1_Data/Geomatique/Combustible/Quebec/Propagation_feux/Potentiel_Intensite_Propagation_Feux/Couche globale/Potentiel_IP_25-26.tif"
LUT_COMB = r"C:/1_Data/Geomatique/Combustible/Quebec/_LUT/LUT_FBP_FUELTYPE_mrnf.csv"
LUT_POT = r"C:/1_Data/Geomatique/Combustible/Quebec/_LUT/MunicID_propag_class_lut.csv"

# Rasters utilisés par la v3 : couverture complète du Québec (build_full_rasters.py)
COMB_TIF = str(WORK / "combustibles_2025_qc.tif")
POT_TIF = str(WORK / "potentiel_ip_2025_qc.tif")

# Unités MRC (Lambert) produites par la v2 (web/scripts/build_units.py), copiées ici
UNITS_GPKG = WEB / "scripts" / "_units_lcc.gpkg"

# ── Constantes ──────────────────────────────────────────────────────────────
CRS_LCC = "EPSG:32198"   # NAD83 / Québec Lambert
GRID_RES = 1000          # grille de statistiques (m)
COMB_NODATA = 255
POT_NODATA = 15
NFUEL_CODES = (101, 102, 103, 104)   # non combustibles (exclus du dénominateur)
COMB_WATER = 103          # classe « Eau »
POT_NOFUEL = 0            # classe « Absence combustible »
