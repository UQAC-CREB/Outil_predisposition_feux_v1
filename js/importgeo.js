// Import de fichiers géospatiaux (emprise d'un projet ou zone régionale) → entités WGS84 2D
//  - formats : KML, KMZ, Shapefile (.zip ou .shp/.dbf/.prj sélectionnés ensemble), GeoJSON,
//    GeoPackage, GPX, FlatGeobuf, CSV (lon/lat ou WKT), WKT
//  - les entités multiples (MultiPoint, MultiLineString, MultiPolygon, collections) sont éclatées :
//    une entité = un point, une ligne ou un polygone (regroupés ensuite en sites, cf. project.js)
//  - reprojection vers WGS84 : .prj / WKT / code EPSG reconnu ; erreur explicite sinon
import { PROJ_LCC } from './config.js';

export class GeoImportError extends Error {
  constructor(code, info = {}) { super(code); this.code = code; this.info = info; }
}

const ext = (f) => f.name.toLowerCase().split('.').pop();
const base = (f) => f.name.replace(/\.[^.]+$/, '');

// ── Systèmes de coordonnées courants au Québec (fichiers sans .prj, GeoJSON « crs », GeoPackage, CSV) ──
const utm = (z, datum) => `+proj=utm +zone=${z} +datum=${datum} +units=m +no_defs`;
const MTM_LON = { 1: -53, 2: -56, 3: -58.5, 4: -61.5, 5: -64.5, 6: -67.5, 7: -70.5, 8: -73.5, 9: -76.5, 10: -79.5 };
const mtm = (z) => `+proj=tmerc +lat_0=0 +lon_0=${MTM_LON[z]} +k=0.9999 +x_0=304800 +y_0=0 +datum=NAD83 +units=m +no_defs`;
const EPSG = {
  4326: 'EPSG:4326', 4269: 'EPSG:4326', 4617: 'EPSG:4326', 4258: 'EPSG:4326',
  3857: 'EPSG:3857', 900913: 'EPSG:3857', 102100: 'EPSG:3857',
  32198: PROJ_LCC, 6622: PROJ_LCC,
  3347: '+proj=lcc +lat_0=63.390675 +lon_0=-91.8666666666667 +lat_1=49 +lat_2=77 +x_0=6200000 +y_0=3000000 +datum=NAD83 +units=m +no_defs',
  3348: '+proj=lcc +lat_0=63.390675 +lon_0=-91.8666666666667 +lat_1=49 +lat_2=77 +x_0=6200000 +y_0=3000000 +datum=NAD83 +units=m +no_defs',
  3978: '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs',
  3979: '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs',
};
for (let z = 17; z <= 21; z++) {
  EPSG[26900 + z] = utm(z, 'NAD83');          // NAD83 / UTM
  EPSG[32600 + z] = utm(z, 'WGS84');          // WGS 84 / UTM
  EPSG[2941 + z] = utm(z, 'NAD83');           // NAD83(CSRS) / UTM 17N-21N (2958-2962)
}
for (let z = 1; z <= 10; z++) EPSG[32180 + z] = mtm(z);   // NAD83 / MTM 1-10 (32181-32190)

/** Définition proj4 à partir d'un code EPSG, d'une URN, d'un WKT ou d'une chaîne proj4. */
function crsDef(s) {
  if (s == null || s === '') return null;
  const str = String(s).trim();
  const m = str.match(/EPSG[^\d]{0,3}(\d{4,6})\s*$/i) || str.match(/^(\d{4,6})$/) || str.match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/i);
  if (m && EPSG[+m[1]]) return EPSG[+m[1]];
  if (/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|\+proj)/i.test(str)) return str;
  if (m) throw new GeoImportError('crsUnknown', { crs: `EPSG:${m[1]}` });
  return null;
}

/** Fonction de reprojection vers WGS84 (null : aucune). */
function reprojector(def) {
  if (!def || def === 'EPSG:4326') return null;
  if (/^GEOGCS/i.test(def) && /WGS|NAD|North_American|D_North/i.test(def)) return null;   // géographique ≈ WGS84
  try {
    const p = proj4(def, 'EPSG:4326');
    return (c) => p.forward([c[0], c[1]]);
  } catch (e) {
    throw new GeoImportError('crsUnknown', { crs: def.slice(0, 60) });
  }
}

// ── Lecture des fichiers ──────────────────────────────────────────────────
const readBuf = (f) => f.arrayBuffer();
const readTxt = async (f) => new TextDecoder('utf-8').decode(await f.arrayBuffer());

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error(`${src} introuvable`));
    document.head.appendChild(s);
  });
}

// KML / KMZ / GPX (togeojson)
function parseXml(txt) {
  const dom = new DOMParser().parseFromString(txt, 'text/xml');
  if (dom.getElementsByTagName('parsererror').length) throw new GeoImportError('read', { msg: 'XML' });
  return dom;
}
async function readKmz(f) {
  const zip = await JSZip.loadAsync(await readBuf(f));
  const names = Object.keys(zip.files).filter(n => n.toLowerCase().endsWith('.kml'));
  if (!names.length) throw new GeoImportError('read', { msg: 'KMZ sans fichier .kml' });
  const doc = names.find(n => /(^|\/)doc\.kml$/i.test(n)) || names[0];
  return toGeoJSON.kml(parseXml(await zip.file(doc).async('string')));
}

// Shapefile (shpjs) : archive .zip ou fichiers séparés
async function readShpZip(f) {
  const r = await shp(await readBuf(f));
  return Array.isArray(r) ? { type: 'FeatureCollection', features: r.flatMap(x => x.features) } : r;
}
async function readShpParts(files) {
  const find = (e) => files.find(f => ext(f) === e);
  const fShp = find('shp');
  if (!fShp) throw new GeoImportError('shpParts');
  const prj = find('prj') ? await readTxt(find('prj')) : null;
  const geoms = shp.parseShp(await readBuf(fShp), prj || undefined);
  const dbf = find('dbf') ? shp.parseDbf(await readBuf(find('dbf')), find('cpg') ? await readBuf(find('cpg')) : undefined) : geoms.map(() => ({}));
  return { fc: shp.combine([geoms, dbf]), hasPrj: !!prj };
}

// GeoJSON
function readGeoJSON(txt) {
  let obj;
  try { obj = JSON.parse(txt); } catch (e) { throw new GeoImportError('read', { msg: 'JSON' }); }
  const def = crsDef(obj.crs?.properties?.name || obj.crs?.properties?.code);
  const fc = obj.type === 'FeatureCollection' ? obj
    : obj.type === 'Feature' ? { type: 'FeatureCollection', features: [obj] }
      : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: obj }] };
  return { fc, def };
}

// GeoPackage (sql.js, chargé à la demande) : en-tête GPKG + WKB
let SQL = null;
async function sqljs() {
  if (!SQL) {
    if (!window.initSqlJs) await loadScript('lib/sql-wasm.js');
    SQL = await initSqlJs({ locateFile: (f) => `lib/${f}` });
  }
  return SQL;
}

/** WKB (ISO, EWKB) → géométrie GeoJSON (2D). */
export function parseWKB(dv, off = 0) {
  const le = dv.getUint8(off) === 1; off += 1;
  let type = dv.getUint32(off, le); off += 4;
  let hasZ = !!(type & 0x80000000), hasM = !!(type & 0x40000000);
  if (type & 0x20000000) off += 4;                       // SRID (EWKB)
  type &= 0x0fffffff;
  if (type >= 3000) { hasZ = hasM = true; type -= 3000; } else if (type >= 2000) { hasM = true; type -= 2000; } else if (type >= 1000) { hasZ = true; type -= 1000; }
  const step = 8 * (2 + hasZ + hasM);
  const u32 = () => { const v = dv.getUint32(off, le); off += 4; return v; };
  const pt = () => { const c = [dv.getFloat64(off, le), dv.getFloat64(off + 8, le)]; off += step; return c; };
  const pts = () => Array.from({ length: u32() }, pt);
  const subs = () => Array.from({ length: u32() }, () => { const r = parseWKB(dv, off); off = r.off; return r.geom; });
  let geom;
  switch (type) {
    case 1: geom = { type: 'Point', coordinates: pt() }; break;
    case 2: geom = { type: 'LineString', coordinates: pts() }; break;
    case 3: geom = { type: 'Polygon', coordinates: Array.from({ length: u32() }, pts) }; break;
    case 4: geom = { type: 'MultiPoint', coordinates: subs().map(g => g.coordinates) }; break;
    case 5: geom = { type: 'MultiLineString', coordinates: subs().map(g => g.coordinates) }; break;
    case 6: geom = { type: 'MultiPolygon', coordinates: subs().map(g => g.coordinates) }; break;
    case 7: geom = { type: 'GeometryCollection', geometries: subs() }; break;
    default: throw new GeoImportError('read', { msg: `WKB type ${type}` });
  }
  return { geom, off };
}

/** Géométrie GeoPackage (en-tête « GP » + WKB). */
export function gpkgGeom(u8) {
  if (!u8 || u8.length < 8 || u8[0] !== 0x47 || u8[1] !== 0x50) return null;
  const flags = u8[3];
  if ((flags >> 4) & 1) return null;                     // géométrie vide
  const envLen = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
  return parseWKB(new DataView(u8.buffer, u8.byteOffset, u8.byteLength), 8 + envLen).geom;
}

async function readGpkg(f) {
  const SQLm = await sqljs();
  const db = new SQLm.Database(new Uint8Array(await readBuf(f)));
  try {
    const q = (sql, p) => { const st = db.prepare(sql); if (p) st.bind(p); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
    const tables = q(`SELECT c.table_name t, g.column_name col, g.srs_id srs FROM gpkg_contents c
      JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features'`);
    const parts = [];
    for (const { t, col, srs } of tables) {
      const s = q('SELECT organization o, organization_coordsys_id id, definition d FROM gpkg_spatial_ref_sys WHERE srs_id = ?', [srs])[0];
      let def = null;
      if (s && /epsg/i.test(s.o) && EPSG[s.id]) def = EPSG[s.id];
      else if (s && s.d && s.d !== 'undefined') def = crsDef(s.d);
      else if (s) def = crsDef(`EPSG:${s.id}`);
      const feats = q(`SELECT * FROM "${t.replace(/"/g, '""')}"`).map(r => {
        const props = {};
        for (const [k, v] of Object.entries(r)) if (k !== col && !(v instanceof Uint8Array)) props[k] = v;
        return { type: 'Feature', properties: props, geometry: gpkgGeom(r[col]) };
      }).filter(x => x.geometry);
      parts.push({ fc: { type: 'FeatureCollection', features: feats }, def });
    }
    return parts;
  } finally { db.close(); }
}

// FlatGeobuf
function readFgb(u8) {
  let def = null;
  const fc = flatgeobuf.deserialize(u8, undefined, (h) => {
    const c = h?.crs;
    if (c) def = c.code && EPSG[c.code] ? EPSG[c.code] : (c.wkt ? crsDef(c.wkt) : (c.code ? crsDef(`EPSG:${c.code}`) : null));
  });
  return { fc, def };
}

// WKT (une géométrie par ligne)
export function parseWKT(src) {
  const toks = src.replace(/([(),])/g, ' $1 ').trim().split(/\s+/);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const expect = (t) => { if (next() !== t) throw new GeoImportError('read', { msg: 'WKT' }); };
  const coord = () => { const c = []; while (peek() !== ',' && peek() !== ')') c.push(+next()); return [c[0], c[1]]; };
  const list = (fn) => { expect('('); const out = [fn()]; while (peek() === ',') { next(); out.push(fn()); } expect(')'); return out; };
  const geom = () => {
    let type = next().toUpperCase();
    while (/^(Z|M|ZM)$/i.test(peek())) next();
    if (peek()?.toUpperCase() === 'EMPTY') { next(); return null; }
    switch (type) {
      case 'POINT': return { type: 'Point', coordinates: list(coord)[0] };
      case 'LINESTRING': return { type: 'LineString', coordinates: list(coord) };
      case 'POLYGON': return { type: 'Polygon', coordinates: list(() => list(coord)) };
      case 'MULTIPOINT': return { type: 'MultiPoint', coordinates: list(() => (peek() === '(' ? list(coord)[0] : coord())) };
      case 'MULTILINESTRING': return { type: 'MultiLineString', coordinates: list(() => list(coord)) };
      case 'MULTIPOLYGON': return { type: 'MultiPolygon', coordinates: list(() => list(() => list(coord))) };
      case 'GEOMETRYCOLLECTION': return { type: 'GeometryCollection', geometries: list(geom).filter(Boolean) };
      default: throw new GeoImportError('read', { msg: `WKT ${type}` });
    }
  };
  const out = [];
  while (i < toks.length) {
    if (/^SRID=/i.test(peek())) { next(); continue; }
    const g = geom();
    if (g) out.push(g);
    if (peek() === ';') next();
  }
  return out;
}

// CSV : colonnes lon/lat (ou x/y) en degrés, ou colonne WKT
function readCsv(txt) {
  const lines = txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new GeoImportError('empty');
  const head = lines[0];
  const sep = [';', '\t', ','].sort((a, b) => head.split(b).length - head.split(a).length)[0];
  const split = (l) => {                           // champs entre guillemets (WKT avec virgules)
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const cols = split(head).map(c => c.toLowerCase());
  const col = (re) => cols.findIndex(c => re.test(c));
  const iw = col(/^(wkt|geom|geometry|geometrie|géométrie|the_geom)$/);
  const ix = col(/^(lon|long|lng|longitude|x)$/), iy = col(/^(lat|latitude|y)$/);
  if (iw < 0 && (ix < 0 || iy < 0)) throw new GeoImportError('csvCols');
  const num = (s) => +String(s).replace(',', '.');
  const features = [];
  for (const l of lines.slice(1)) {
    const v = split(l);
    const props = Object.fromEntries(cols.map((c, k) => [c, v[k]]));
    if (iw >= 0) parseWKT(v[iw] || '').forEach(g => features.push({ type: 'Feature', properties: props, geometry: g }));
    else if (Number.isFinite(num(v[ix])) && Number.isFinite(num(v[iy]))) {
      features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [num(v[ix]), num(v[iy])] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ── Normalisation : entités simples 2D, reprojetées et validées ───────────
const NAME_KEYS = ['name', 'Name', 'NAME', 'nom', 'Nom', 'NOM', 'toponyme', 'TOPONYME', 'description', 'id', 'ID'];

function explode(fc, nameHint, proj) {
  const out = [];
  const fix = (c) => { const p = proj ? proj(c) : c; return [+p[0], +p[1]]; };
  const fixPts = (a) => a.map(fix).filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  for (const f of fc.features || []) {
    const props = f.properties || {};
    const nmKey = NAME_KEYS.find(k => props[k] != null && String(props[k]).trim() && String(props[k]).length < 120);
    const name = nmKey ? String(props[nmKey]).trim() : nameHint;
    const add = (geometry) => out.push({ type: 'Feature', properties: { name }, geometry });
    const walk = (g) => {
      if (!g) return;
      switch (g.type) {
        case 'Point': { const c = fixPts([g.coordinates]); if (c.length) add({ type: 'Point', coordinates: c[0] }); break; }
        case 'LineString': { const c = fixPts(g.coordinates); if (c.length >= 2) add({ type: 'LineString', coordinates: c }); break; }
        case 'Polygon': {
          const rings = g.coordinates.map(fixPts).filter(r => r.length >= 4);
          if (rings.length) add({ type: 'Polygon', coordinates: rings });
          break;
        }
        case 'MultiPoint': g.coordinates.forEach(c => walk({ type: 'Point', coordinates: c })); break;
        case 'MultiLineString': g.coordinates.forEach(c => walk({ type: 'LineString', coordinates: c })); break;
        case 'MultiPolygon': g.coordinates.forEach(c => walk({ type: 'Polygon', coordinates: c })); break;
        case 'GeometryCollection': g.geometries.forEach(walk); break;
        default: break;
      }
    };
    walk(f.geometry);
  }
  return out;
}

const looksGeographic = (fc) => {
  let ok = true, n = 0;
  const walk = (c) => {
    if (n > 2000 || !ok) return;
    if (typeof c[0] === 'number') { n++; if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) ok = false; } else c.forEach(walk);
  };
  const g = (x) => { if (!x) return; if (x.type === 'GeometryCollection') x.geometries.forEach(g); else walk(x.coordinates); };
  (fc.features || []).forEach(f => g(f.geometry));
  return ok;
};

// Emprise acceptée : Québec et environs (WGS84)
const QC_BOX = [-82, 43, -55, 64];
function checkExtent(feats) {
  for (const f of feats) {
    let bad = false;
    const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < QC_BOX[0] || c[0] > QC_BOX[2] || c[1] < QC_BOX[1] || c[1] > QC_BOX[3]) bad = true; } else c.forEach(walk); };
    walk(f.geometry.coordinates);
    if (bad) throw new GeoImportError('coords');
  }
}

/**
 * Lit une sélection de fichiers (FileList ou tableau) → { name, features: [Feature Point|LineString|Polygon] }.
 * Plusieurs fichiers indépendants (ex. deux KMZ) sont fusionnés.
 */
export async function readGeoFiles(fileList) {
  const files = [...fileList];
  if (!files.length) throw new GeoImportError('empty');
  const parts = [];      // { fc, def?, name, checkCrs }
  const shpGroup = files.filter(f => ['shp', 'dbf', 'prj', 'cpg', 'shx', 'sbn', 'sbx', 'qmd', 'xml'].includes(ext(f)));
  if (shpGroup.some(f => ext(f) === 'shp')) {
    const { fc, hasPrj } = await readShpParts(shpGroup);
    parts.push({ fc, name: base(shpGroup.find(f => ext(f) === 'shp')), noCrs: !hasPrj });
  } else if (shpGroup.length && shpGroup.length === files.length) {
    throw new GeoImportError('shpParts');
  }
  for (const f of files) {
    if (shpGroup.includes(f)) continue;
    const e = ext(f), name = base(f);
    try {
      if (e === 'kml') parts.push({ fc: toGeoJSON.kml(parseXml(await readTxt(f))), name });
      else if (e === 'kmz') parts.push({ fc: await readKmz(f), name });
      else if (e === 'gpx') parts.push({ fc: toGeoJSON.gpx(parseXml(await readTxt(f))), name });
      else if (e === 'zip') parts.push({ fc: await readShpZip(f), name });
      else if (e === 'geojson' || e === 'json') { const r = readGeoJSON(await readTxt(f)); parts.push({ ...r, name, noCrs: !r.def }); }
      else if (e === 'gpkg') (await readGpkg(f)).forEach(r => parts.push({ ...r, name }));
      else if (e === 'fgb') { const r = readFgb(new Uint8Array(await readBuf(f))); parts.push({ ...r, name, noCrs: !r.def }); }
      else if (e === 'csv' || e === 'txt') parts.push({ fc: readCsv(await readTxt(f)), name, noCrs: true });
      else if (e === 'wkt') parts.push({ fc: { type: 'FeatureCollection', features: parseWKT(await readTxt(f)).map(g => ({ type: 'Feature', properties: {}, geometry: g })) }, name, noCrs: true });
      else if (e === 'gdb' || e === 'gdbtable' || e === 'mdb') throw new GeoImportError('gdb');
      else throw new GeoImportError('format', { ext: e });
    } catch (err) {
      if (err instanceof GeoImportError) throw err;
      console.error(err);
      throw new GeoImportError('read', { msg: `${f.name} - ${err.message || err}` });
    }
  }
  const features = [];
  for (const p of parts) {
    let proj = reprojector(p.def);
    if (!proj && !looksGeographic(p.fc)) throw new GeoImportError('crs');
    features.push(...explode(p.fc, p.name, proj));
  }
  if (!features.length) throw new GeoImportError('empty');
  checkExtent(features);
  const names = [...new Set(parts.map(p => p.name))];
  return { name: names.length > 2 ? `${names[0]} (+${names.length - 1})` : names.join(' + '), features };
}
