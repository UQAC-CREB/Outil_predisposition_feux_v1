// Projet importé : entités (points, lignes, polygones) regroupées en sites, zones tampons et zone automatique
//  - deux entités distantes de moins de SITE_GAP_KM appartiennent au même site (lien simple) ;
//    chaque site a sa fiche INFO-PROJET et sa page dans le rapport
//  - les distances sont calculées en Lambert (EPSG:32198) puis corrigées du facteur d'échelle local,
//    comme les statistiques raster (rasterstats.js)
import { SITE_GAP_KM } from './config.js';
import { toLcc } from './stats.js';

const R_SPHERE = 6371008.8;          // rayon utilisé par turf (zones tampons affichées)

/** Facteur d'échelle de la projection Lambert au point [lon, lat] (distance Lambert / distance réelle). */
export function lccScale(lon, lat) {
  const t = toLcc(), d = 0.02;
  const a = t.forward([lon, lat - d]), b = t.forward([lon, lat + d]);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / (R_SPHERE * (2 * d * Math.PI / 180));
}

/** Entité → géométrie Lambert : points, segments, anneaux (polygones). */
function toParts(geom) {
  const t = toLcc();
  const P = (c) => t.forward(c);
  if (geom.type === 'Point') return { pts: [P(geom.coordinates)], segs: [], polys: [] };
  if (geom.type === 'LineString') {
    const c = geom.coordinates.map(P);
    return { pts: c, segs: c.slice(1).map((p, i) => [c[i], p]), polys: [] };
  }
  const rings = geom.coordinates.map(r => r.map(P));
  const segs = rings.flatMap(r => r.slice(1).map((p, i) => [r[i], p]));
  return { pts: rings.flat(), segs, polys: [rings] };
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

function segDist2(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (poly, x, y) => ringContains(poly[0], x, y) && !poly.slice(1).some(h => ringContains(h, x, y));

/** Distance minimale (m, Lambert) entre deux entités. */
function partsDist(A, B) {
  let d2 = Infinity;
  const fromPts = (pts, other) => {
    for (const [x, y] of pts) {
      if (other.polys.some(p => inPoly(p, x, y))) return 0;
      for (const s of other.segs) d2 = Math.min(d2, segDist2(x, y, s));
      if (!other.segs.length) for (const [qx, qy] of other.pts) d2 = Math.min(d2, (x - qx) ** 2 + (y - qy) ** 2);
    }
    return null;
  };
  if (fromPts(A.pts, B) === 0 || fromPts(B.pts, A) === 0) return 0;
  return Math.sqrt(d2);
}

/**
 * Projet : { name, features, parts, sites: [{ k, feats: [index], bbox (Lambert), center [lon,lat], scale }] }.
 * Les sites sont numérotés dans l'ordre des entités du fichier.
 */
export function buildProject(name, features) {
  const parts = features.map(f => toParts(f.geometry));
  const boxes = parts.map(p => bboxOf(p.pts));
  const n = features.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const gap = SITE_GAP_KM * 1000;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const a = boxes[i], b = boxes[j];
      // distance entre emprises : borne inférieure (corrigée de l'échelle Lambert, ≤ 1,02 au Québec)
      const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
      if (Math.hypot(dx, dy) > gap * 1.03) continue;
      const ll = features[i].geometry.type === 'Point' ? features[i].geometry.coordinates : features[i].geometry.coordinates.flat(2).slice(0, 2);
      if (partsDist(parts[i], parts[j]) / lccScale(ll[0], ll[1]) <= gap) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const t = toLcc();
  const sites = [...groups.values()].map((feats, k) => {
    const bb = bboxOf(feats.flatMap(i => parts[i].pts));
    const center = t.inverse([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]);
    return { k: k + 1, feats, bbox: bb, center, scale: lccScale(center[0], center[1]) };
  });
  return { name, features, parts, sites, bbox: bboxOf(parts.flatMap(p => p.pts)) };
}

/** Types d'entités d'un site : { Point: n, LineString: n, Polygon: n }. */
export function siteTypes(project, site) {
  const c = {};
  for (const i of site.feats) { const ty = project.features[i].geometry.type; c[ty] = (c[ty] || 0) + 1; }
  return c;
}

/** Entités d'un site (FeatureCollection WGS84). */
export function siteFC(project, site) {
  return { type: 'FeatureCollection', features: site.feats.map(i => project.features[i]) };
}

/** Zone tampon (coins arrondis) d'un site, en WGS84 (turf : projection locale équidistante). */
const bufCache = new WeakMap();
export function siteBuffer(project, site, km) {
  let c = bufCache.get(site);
  if (!c) bufCache.set(site, (c = new Map()));
  if (c.has(km)) return c.get(km);
  const bufs = site.feats.map(i => turf.buffer(project.features[i], km, { units: 'kilometers', steps: 24 })).filter(Boolean);
  let out = bufs[0];
  if (bufs.length > 1) {
    out = turf.union(turf.featureCollection(bufs)) || out;
  }
  out = { type: 'Feature', properties: {}, geometry: out.geometry };
  c.set(km, out);
  return out;
}

/**
 * Zone régionale automatique : carré (Lambert) de côté `km` centré sur l'emprise du projet,
 * agrandi au besoin pour couvrir tout le projet. Retourne { geojson, sideKm, enlarged }.
 */
export function autoSquare(project, km) {
  const [x0, y0, x1, y1] = project.bbox;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const t = toLcc();
  const c = t.inverse([cx, cy]);
  const k = lccScale(c[0], c[1]);
  const needed = Math.max(x1 - x0, y1 - y0) / k / 1000;      // km réels
  const side = Math.max(km, Math.ceil(needed));
  const h = (side * 1000 * k) / 2;
  const ring = [], n = 32;
  const edge = (ax, ay, bx, by) => { for (let i = 0; i < n; i++) ring.push(t.inverse([ax + (bx - ax) * i / n, ay + (by - ay) * i / n])); };
  edge(cx - h, cy - h, cx + h, cy - h); edge(cx + h, cy - h, cx + h, cy + h);
  edge(cx + h, cy + h, cx - h, cy + h); edge(cx - h, cy + h, cx - h, cy - h);
  ring.push(ring[0]);
  return {
    geojson: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])] } },
    sideKm: side, enlarged: side > km,
  };
}
