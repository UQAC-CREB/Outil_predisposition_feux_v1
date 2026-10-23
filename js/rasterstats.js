// Combustibles et potentiel I/P autour d'un site de projet (zone tampon variable de 1 à 50 km)
//
// Équivalent « à la volée » des anneaux précalculés de la v2 (rings.bin.gz) :
//  1. distance de chaque point du secteur (site + 50 km) aux entités du site : transformée de distance
//     euclidienne exacte sur une grille Lambert de 50 m et plus, corrigée du facteur d'échelle local ;
//  2. lecture des tuiles PMTiles de la carte (PNG à palette : index = code de classe, ≈ 25-40 m au zoom 12) ;
//  3. superficie de chaque pixel cumulée par anneau de 1 km (0-50 km) et par classe.
// Le curseur de la zone tampon additionne ensuite les anneaux, sans nouveau calcul.
import { TILES } from './config.js';
import { decodePalettePNG } from './rasterpick.js';
import { toLcc, cellsInPolys } from './stats.js';

export const NR = 50;                 // anneaux de 1 km
const TS = 256;
const MAX_TILES = 400;                // tuiles par couche : le zoom baisse au-delà (longues entités)
const WM_C = 2 * Math.PI * 6378137;   // circonférence Web Mercator (m)
const INF = 1e20;

const pms = {};
const pm = (k) => (pms[k] ??= new pmtiles.PMTiles(TILES[k]));

// ── Transformée de distance euclidienne (Felzenszwalb & Huttenlocher, 2012) ──
function dt1d(f, n, d, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] >= INF) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    let s;
    for (;;) {
      const r = v[k];
      s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
      if (s <= z[k]) k--; else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) { for (let q = 0; q < n; q++) d[q] = INF; return; }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

/** Distances au carré (en cellules) aux cellules nulles de `g` (Float32Array w × h, INF ailleurs) ; en place. */
export function edt2d(g, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = g[o + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[o + x] = d[x];
  }
  return g;
}

/** Grille des distances réelles (m) aux entités du site, sur le site + 50 km. */
export function siteDistanceGrid(project, site) {
  const k = site.scale;
  const pad = (NR + 2) * 1000 * k;
  const [bx0, by0, bx1, by1] = site.bbox;
  const X0 = bx0 - pad, Y1 = by1 + pad, W = bx1 - bx0 + 2 * pad, H = by1 - by0 + 2 * pad;
  const res = Math.max(50, Math.ceil(Math.max(W, H) / 2400 / 10) * 10);
  const nc = Math.ceil(W / res), nr = Math.ceil(H / res);
  const g = new Float32Array(nc * nr).fill(INF);
  const mark = (x, y) => {
    const c = Math.floor((x - X0) / res), r = Math.floor((Y1 - y) / res);
    if (c >= 0 && r >= 0 && c < nc && r < nr) g[r * nc + c] = 0;
  };
  for (const i of site.feats) {
    const p = project.parts[i];
    p.pts.forEach(([x, y]) => mark(x, y));
    for (const [[ax, ay], [bx, by]] of p.segs) {
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (res / 2)));
      for (let s = 0; s <= n; s++) mark(ax + (bx - ax) * s / n, ay + (by - ay) * s / n);
    }
    for (const poly of p.polys) for (const idx of cellsInPolys([poly], { x0: X0, y0: Y1, res, ncols: nc, nrows: nr })) g[idx] = 0;
  }
  edt2d(g, nc, nr);
  const f = res / k;                               // cellules → mètres réels
  for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i]) * f;
  return { X0, Y1, res, nc, nr, d: g };
}

// ── Tuiles ────────────────────────────────────────────────────────────────
const lon2x = (lon, n) => ((lon + 180) / 360) * n;
const lat2y = (lat, n) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n; };
const y2lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

function gridLonLatBounds(G) {
  const t = toLcc();
  let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity;
  const W = G.nc * G.res, H = G.nr * G.res;
  for (let i = 0; i <= 16; i++) {
    for (const [x, y] of [[G.X0 + W * i / 16, G.Y1], [G.X0 + W * i / 16, G.Y1 - H], [G.X0, G.Y1 - H * i / 16], [G.X0 + W, G.Y1 - H * i / 16]]) {
      const [lo, la] = t.inverse([x, y]);
      lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); la0 = Math.min(la0, la); la1 = Math.max(la1, la);
    }
  }
  return [lo0, la0, lo1, la1];
}

function tileRange([lo0, la0, lo1, la1], z) {
  const n = 2 ** z;
  return { x0: Math.floor(lon2x(lo0, n)), x1: Math.floor(lon2x(lo1, n)), y0: Math.floor(lat2y(la1, n)), y1: Math.floor(lat2y(la0, n)) };
}

async function tileIdx(kind, z, x, y) {
  try {
    const r = await pm(kind).getZxy(z, x, y);
    return r && r.data ? await decodePalettePNG(r.data) : null;
  } catch (e) { return null; }
}

/**
 * Anneaux d'un site : superficies (ha) par anneau de 1 km et par classe (ordre de classes.json).
 * `onProgress(fraction)` pendant la lecture des tuiles.
 */
export async function siteRings(project, site, classes, onProgress) {
  const G = siteDistanceGrid(project, site);
  const bounds = gridLonLatBounds(G);
  let z = 12, tr;
  for (; z > 6; z--) {
    tr = tileRange(bounds, z);
    if ((tr.x1 - tr.x0 + 1) * (tr.y1 - tr.y0 + 1) <= MAX_TILES) break;
  }
  const NC = classes.comb.length, NP = classes.pot.length;
  const mapC = new Int16Array(256).fill(-1), mapP = new Int16Array(256).fill(-1);
  classes.comb.forEach((c, i) => { mapC[c.v] = i; });
  classes.pot.forEach((c, i) => { mapP[c.v] = i; });
  const comb = new Float64Array(NR * NC), pot = new Float64Array(NR * NP);
  const n = 2 ** z, t = toLcc(), dmax = NR * 1000;
  const LX = new Float64Array(17 * 17), LY = new Float64Array(17 * 17);
  const { X0, Y1, res, nc, nr, d: D } = G;

  const accumulate = (x, y, ic, ip) => {
    // grille 17 × 17 de coordonnées Lambert (tous les 16 px), interpolée pour chaque pixel
    for (let gy = 0; gy <= 16; gy++) {
      const la = y2lat(y + gy / 16, n);
      for (let gx = 0; gx <= 16; gx++) {
        const [px, py] = t.forward([((x + gx / 16) / n) * 360 - 180, la]);
        LX[gy * 17 + gx] = px; LY[gy * 17 + gx] = py;
      }
    }
    for (let j = 0; j < TS; j++) {
      const la = y2lat(y + (j + 0.5) / TS, n);
      const area = ((WM_C * Math.cos((la * Math.PI) / 180)) / (TS * n)) ** 2 / 1e4;     // ha
      const fy = (j + 0.5) / 16, gy = Math.min(15, Math.floor(fy)), wy = fy - gy;
      for (let i = 0; i < TS; i++) {
        const o = j * TS + i;
        const vc = ic ? ic[o] : 255, vp = ip ? ip[o] : 255;
        if (vc === 255 && vp === 255) continue;
        const fx = (i + 0.5) / 16, gx = Math.min(15, Math.floor(fx)), wx = fx - gx;
        const a = gy * 17 + gx;
        const lx = (LX[a] * (1 - wx) + LX[a + 1] * wx) * (1 - wy) + (LX[a + 17] * (1 - wx) + LX[a + 18] * wx) * wy;
        const ly = (LY[a] * (1 - wx) + LY[a + 1] * wx) * (1 - wy) + (LY[a + 17] * (1 - wx) + LY[a + 18] * wx) * wy;
        const c = Math.floor((lx - X0) / res), r = Math.floor((Y1 - ly) / res);
        if (c < 0 || r < 0 || c >= nc || r >= nr) continue;
        const dist = D[r * nc + c];
        if (dist >= dmax) continue;
        const ring = Math.floor(dist / 1000);
        if (vc !== 255 && mapC[vc] >= 0) comb[ring * NC + mapC[vc]] += area;
        if (vp !== 255 && mapP[vp] >= 0) pot[ring * NP + mapP[vp]] += area;
      }
    }
  };

  const jobs = [];
  for (let y = tr.y0; y <= tr.y1; y++) for (let x = tr.x0; x <= tr.x1; x++) jobs.push([x, y]);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      const [ic, ip] = await Promise.all([tileIdx('comb', z, x, y), tileIdx('pot', z, x, y)]);
      if (ic || ip) accumulate(x, y, ic, ip);
      done++;
      if (onProgress && done % 8 === 0) onProgress(done / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { nr: NR, nc: NC, np: NP, comb, pot, z, res, nTiles: jobs.length };
}

/** Superficies (ha) par classe à moins de `km` du site. */
export function bufferSums(R, km) {
  const sum = (arr, nk) => {
    const out = new Float64Array(nk);
    const n = Math.min(km, R.nr);
    for (let r = 0; r < n; r++) for (let k = 0; k < nk; k++) out[k] += arr[r * nk + k];
    return Array.from(out);
  };
  return { comb: sum(R.comb, R.nc), pot: sum(R.pot, R.np) };
}
