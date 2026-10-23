# -*- coding: utf-8 -*-
"""
build_full_rasters.py — Rasters combustibles / potentiel couvrant tout le Québec (v3)

En v2, les rasters étaient limités aux zones tampons de 50 km des lieux habités. La v3 analyse
des projets situés n'importe où : on conserve tout le territoire québécois.

Zones (par ordre de priorité croissante) :
  1  Québec terrestre (Prov_qclcc_shoreline_s) : données conservées ; pixels sans donnée
     → classe Eau (combustibles) ou Absence combustible (potentiel)
  2  EAU des zones tampons v2 (fleuve, golfe, baies hors de la couche MRNF) : même règle
  3  No-Data des zones tampons v2 (autres provinces, États-Unis) : NA
  0  ailleurs : NA (exclu des calculs)

Les règles 2 et 3 sont celles de la v2 : à moins de 50 km d'un lieu habité, les deux versions
donnent les mêmes valeurs.

Sorties (../work_v3/, hors dépôt) : combustibles_2025_qc.tif, potentiel_ip_2025_qc.tif
(tuilés 256, deflate, aperçus nearest) — utilisés par build_fuel.py et build_tiles.py.
"""
import sys, time
from multiprocessing import Pool
import numpy as np
import geopandas as gpd
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.windows import Window

from config import *

BLOCK = 1024

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)


def zone_shapes():
    prov = gpd.read_file(PROV_SHORE).to_crs(CRS_LCC)
    b = gpd.read_file(LH_BUFFER50).to_crs(CRS_LCC)
    shapes = [(g, 1) for g in prov.geometry.values]
    shapes += [(g, 2) for g in b[b.CO_TER == "EAU"].geometry.values]
    shapes += [(g, 3) for g in b[b.CO_TER == "No-Data"].geometry.values]
    return shapes            # rasterize : la dernière forme l'emporte


def init_worker(src_path, nodata, fill):
    global SRC, SHAPES, NODATA, FILL
    SRC = rasterio.open(src_path)
    NODATA, FILL = nodata, fill
    SHAPES = zone_shapes()


def work(r0):
    h = min(BLOCK, SRC.height - r0)
    win = Window(0, r0, SRC.width, h)
    arr = SRC.read(1, window=win)
    tr = rasterio.windows.transform(win, SRC.transform)
    zone = rasterize(SHAPES, out_shape=(h, SRC.width), transform=tr, fill=0, dtype="uint8")
    keep = (zone == 1) | (zone == 2)
    out = np.where(keep, np.where(arr == NODATA, FILL, arr), NODATA)
    return r0, out.astype(np.uint8), np.bincount(zone.ravel(), minlength=4)


def build(src_path, dst_path, nodata, fill):
    WORK.mkdir(exist_ok=True)
    with rasterio.open(src_path) as s:
        prof = s.profile.copy()
        H = s.height
    prof.update(driver="GTiff", dtype="uint8", nodata=nodata, tiled=True, blockxsize=256, blockysize=256,
                compress="deflate", predictor=1, BIGTIFF="IF_SAFER")
    cnt = np.zeros(4, dtype=np.int64)
    with rasterio.open(dst_path, "w", **prof) as dst, \
         Pool(6, initializer=init_worker, initargs=(src_path, nodata, fill)) as pool:
        for k, (r0, out, c) in enumerate(pool.imap(work, range(0, H, BLOCK))):
            dst.write(out, 1, window=Window(0, r0, out.shape[1], out.shape[0]))
            cnt += c
            if k % 10 == 0: log(f"  bloc {r0}/{H}")
    log(f"  zones (km²) : Québec {cnt[1]*625/1e6:,.0f} · EAU {cnt[2]*625/1e6:,.0f} · No-Data {cnt[3]*625/1e6:,.0f}")
    log("  aperçus…")
    with rasterio.open(dst_path, "r+") as dst:
        dst.build_overviews([2, 4, 8, 16, 32, 64], Resampling.nearest)
    log(f"→ {dst_path}")


if __name__ == "__main__":
    which = sys.argv[1:] or ["comb", "pot"]
    if "comb" in which:
        log("Combustibles"); build(COMB_TIF_RAW, COMB_TIF, COMB_NODATA, COMB_WATER)
    if "pot" in which:
        log("Potentiel I/P"); build(POT_TIF_RAW, POT_TIF, POT_NODATA, POT_NOFUEL)
