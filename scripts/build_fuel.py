# -*- coding: utf-8 -*-
"""
build_fuel.py — Superficies combustibles (dénominateurs des taux) sur tout le Québec (v3)

Sorties (data/) :
  grid_fuel.bin.gz  pixels combustibles 25 m par cellule de 1 km (zones automatiques, tracées, importées)
  unit_fuel.json    superficie combustible (ha) par unité MRC

Même format et même calcul qu'en v2 (web/scripts/build_rasters.py), mais à partir du raster
couvrant tout le Québec (build_full_rasters.py) : en v2, les cellules à plus de 50 km d'un lieu
habité n'avaient pas de combustible, ce qui faussait les taux des zones éloignées.
"""
import gzip, json, struct, time
from multiprocessing import Pool
import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from rasterio.windows import Window
from rasterio.features import rasterize

from config import *

BLOCK = 1000                     # lignes par bloc (multiple de 40 → cellules 1 km entières)
CELL = GRID_RES // 25            # 40 pixels par cellule

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)

lut_c = pd.read_csv(LUT_COMB, sep=";", encoding="latin-1").dropna(subset=["VALUE"])
FUEL_C = np.zeros(256, dtype=bool)
for v in lut_c.VALUE.astype(int):
    if v not in NFUEL_CODES: FUEL_C[v] = True


def init_worker():
    global UNITS
    UNITS = gpd.read_file(UNITS_GPKG)
    UNITS["geometry"] = UNITS.geometry.simplify(10)


def work(b0):
    with rasterio.open(COMB_TIF) as s:
        h = min(BLOCK, s.height - b0)
        arr = s.read(1, window=Window(0, b0, s.width, h))
        tr, W = s.transform, s.width
    fuel = FUEL_C[arr]
    ncell_c = int(np.ceil(W / CELL)); nrow_c = int(np.ceil(h / CELL))
    pad = np.zeros((nrow_c * CELL, ncell_c * CELL), dtype=np.uint8)
    pad[:h, :W] = fuel
    grid = pad.reshape(nrow_c, CELL, ncell_c, CELL).sum(axis=(1, 3)).astype(np.uint16)
    btr = tr * tr.translation(0, b0)
    shapes = [(g, int(u) + 1) for g, u in zip(UNITS.geometry.values, UNITS.uid.values)]
    ur = rasterize(shapes, out_shape=(h, W), transform=btr, fill=0, dtype="uint8")
    return b0, grid, np.bincount(ur[fuel], minlength=256)


if __name__ == "__main__":
    units = gpd.read_file(UNITS_GPKG)
    with rasterio.open(COMB_TIF) as s:
        HC = s.height
        meta = {"ncols": int(np.ceil(s.width / CELL)), "nrows": int(np.ceil(s.height / CELL)),
                "x0": s.bounds.left, "y0": s.bounds.top, "res": GRID_RES, "px_ha": 0.0625}
    rows, ufuel = {}, np.zeros(256, dtype=np.int64)
    with Pool(7, initializer=init_worker) as pool:
        log(f"Combustibles : {int(np.ceil(HC/BLOCK))} blocs")
        for k, (b0, g, uf) in enumerate(pool.imap_unordered(work, range(0, HC, BLOCK))):
            rows[b0] = g; ufuel += uf
            if k % 10 == 0: log(f"  bloc {b0}")
    grid = np.concatenate([rows[b] for b in sorted(rows)], axis=0)
    hdr = json.dumps(meta).encode()
    raw = struct.pack("<I", len(hdr)) + hdr + b"\0" * ((4 - (4 + len(hdr)) % 4) % 4)
    raw += grid.astype("<u2").tobytes()
    (OUT / "grid_fuel.bin.gz").write_bytes(gzip.compress(raw, 9))
    log(f"→ grid_fuel.bin.gz ({(OUT/'grid_fuel.bin.gz').stat().st_size/1e6:.1f} Mo, {grid.sum()*0.0625/1e6:.1f} M ha)")
    uf = {mid: round(float(ufuel[int(u) + 1]) * 0.0625, 0) for mid, u in zip(units.MRC_IDm, units.uid)}
    (OUT / "unit_fuel.json").write_text(json.dumps(uf, ensure_ascii=False), encoding="utf-8")
    log(f"→ unit_fuel.json ({len(uf)} unités)")
