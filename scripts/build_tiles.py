# -*- coding: utf-8 -*-
"""
build_tiles.py — Tuiles raster PMTiles (combustibles, potentiel I/P) couvrant tout le Québec (v3)

Usage :  python build_tiles.py comb|pot [zmax]
Sortie : ../tiles_v3/combustibles_2025_qc.pmtiles | potentiel_ip_2025_qc.pmtiles
         (hors dépôt Git → à téléverser sur Cloudflare R2)

PNG à palette (nearest) : l'index de chaque pixel = code de la classe (255 = transparent).
Le navigateur décode ces tuiles pour la carte, l'infobulle ET les statistiques des zones
tampons des projets (js/rasterstats.js) : pas de précalcul par entité.
Différences avec la v2 : pas de masque à 50 km des lieux habités (le raster source est déjà
limité au Québec, cf. build_full_rasters.py).
"""
import io, sys, time
from multiprocessing import Pool
import numpy as np
import pandas as pd
import geopandas as gpd
import mercantile
import rasterio
import shapely
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.windows import from_bounds as win_from_bounds
from pmtiles.tile import zxy_to_tileid, TileType, Compression
from pmtiles.writer import Writer

from config import *

KIND = sys.argv[1] if len(sys.argv) > 1 else "comb"
ZMIN, ZMAX = 5, int(sys.argv[2]) if len(sys.argv) > 2 else 12
TS = 256

if KIND == "comb":
    TIF, NODATA, NAME = COMB_TIF, COMB_NODATA, "combustibles_2025_qc"
    lut = pd.read_csv(LUT_COMB, sep=";", encoding="latin-1").dropna(subset=["VALUE"])
else:
    TIF, NODATA, NAME = POT_TIF, POT_NODATA, "potentiel_ip_2025_qc"
    lut = pd.read_csv(LUT_POT, sep=";", encoding="latin-1")

# Palette : index = valeur raster ; 255 = transparent
PAL = np.zeros((256, 3), dtype=np.uint8)
VALID = np.zeros(256, dtype=bool)
for v, h in zip(lut.VALUE.astype(int), lut.HEX_CODE.str.strip()):
    PAL[v] = [int(h[i:i + 2], 16) for i in (1, 3, 5)]
    VALID[v] = True

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:7.1f}s] {msg}", flush=True)


def init_worker():
    global SRC, TO_LCC
    SRC = rasterio.open(TIF)
    TO_LCC = Transformer.from_crs(3857, CRS_LCC, always_xy=True)


def render(t):
    z, x, y = t
    b = mercantile.xy_bounds(x, y, z)
    # centres des pixels de la tuile (EPSG:3857) → Lambert
    px = (b.right - b.left) / TS
    xs = b.left + (np.arange(TS) + 0.5) * px
    ys = b.top - (np.arange(TS) + 0.5) * px
    X, Y = np.meshgrid(xs, ys)
    lx, ly = TO_LCC.transform(X, Y)
    x0, x1, y0, y1 = lx.min(), lx.max(), ly.min(), ly.max()
    win = win_from_bounds(x0 - 50, y0 - 50, x1 + 50, y1 + 50, SRC.transform)
    win = win.round_offsets().round_lengths()
    try:
        win = win.intersection(rasterio.windows.Window(0, 0, SRC.width, SRC.height))
    except rasterio.errors.WindowError:
        return t, None
    r0, c0 = int(win.row_off), int(win.col_off)
    h, w = int(win.height), int(win.width)
    if h < 1 or w < 1:
        return t, None
    # lecture décimée (aperçus .ovr aux petits zooms)
    scale = max(1.0, (x1 - x0) / TS / 25 / 1.2)
    oh, ow = max(1, int(h / scale)), max(1, int(w / scale))
    arr = SRC.read(1, window=win, out_shape=(oh, ow), resampling=Resampling.nearest)
    inv = ~SRC.transform
    cc, rr = inv * (lx, ly)
    inside = (rr >= r0) & (rr < r0 + h) & (cc >= c0) & (cc < c0 + w)
    ri = np.clip(((rr - r0) * oh / h).astype(int), 0, oh - 1)
    ci = np.clip(((cc - c0) * ow / w).astype(int), 0, ow - 1)
    vals = np.where(inside, arr[ri, ci], NODATA)
    vals = np.where(VALID[vals], vals, 255).astype(np.uint8)
    if (vals == 255).all():
        return t, None
    img = Image.fromarray(vals, mode="P")
    img.putpalette(PAL.ravel().tolist())
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True, transparency=255)
    return t, buf.getvalue()


if __name__ == "__main__":
    TILES_OUT.mkdir(exist_ok=True)
    # ── Emprise utile : Québec terrestre + eaux des zones tampons v2 (même règle que le raster)
    prov = gpd.read_file(PROV_SHORE).to_crs(CRS_LCC)
    b = gpd.read_file(LH_BUFFER50).to_crs(CRS_LCC)
    parts = list(prov.geometry.values) + list(b[b.CO_TER == "EAU"].geometry.values)
    u = shapely.union_all(shapely.make_valid(np.array(parts))).buffer(500).simplify(500)
    mask_ll = gpd.GeoSeries([u], crs=CRS_LCC).to_crs(4326).iloc[0]
    shapely.prepare(mask_ll)

    tiles = []
    w, s, e, n = mask_ll.bounds
    for z in range(ZMIN, ZMAX + 1):
        cand = list(mercantile.tiles(w, s, e, n, z))
        boxes = shapely.box(*np.array([mercantile.bounds(t) for t in cand]).T)
        keep = shapely.intersects(mask_ll, boxes)
        tiles += [(t.z, t.x, t.y) for t, k in zip(cand, keep) if k]
        log(f"z{z}: {int(keep.sum())} tuiles")
    tiles.sort(key=lambda t: zxy_to_tileid(*t))

    out = TILES_OUT / f"{NAME}.pmtiles"
    n_ok, size = 0, 0
    with open(out, "wb") as f, Pool(8, initializer=init_worker) as pool:
        wr = Writer(f)
        for k, (t, data) in enumerate(pool.imap(render, tiles, chunksize=16)):
            if data is not None:
                wr.write_tile(zxy_to_tileid(*t), data); n_ok += 1; size += len(data)
            if k % 10000 == 0: log(f"  {k}/{len(tiles)} ({size/1e6:.0f} Mo)")
        wr.finalize(
            {"tile_type": TileType.PNG, "tile_compression": Compression.NONE,
             "min_zoom": ZMIN, "max_zoom": ZMAX,
             "min_lon_e7": int(w * 1e7), "min_lat_e7": int(s * 1e7),
             "max_lon_e7": int(e * 1e7), "max_lat_e7": int(n * 1e7),
             "center_zoom": 7, "center_lon_e7": int(-71.5e7), "center_lat_e7": int(48.5e7)},
            {"name": NAME, "attribution": "MRNF 2025 — Données Québec"},
        )
    log(f"→ {out} : {n_ok} tuiles, {out.stat().st_size/1e6:.0f} Mo")
