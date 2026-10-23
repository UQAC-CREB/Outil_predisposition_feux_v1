// MAMH — Prédisposition aux feux de forêt d'un projet — outil d'aide à la décision (v1.0 ; dossier web_v3)
//  1. l'utilisateur importe l'emprise d'un projet (points, lignes, polygones) → sites (entités à moins de 50 km)
//  2. INFO-PROJET : combustibles et potentiel I/P dans une zone tampon de 1 à 50 km autour du site choisi
//  3. INFO-TERRITOIRE : historique des feux dans une zone régionale (carré automatique, MRC, rectangle, zone importée)
import {
  TILES, BASEMAP, QC_BOUNDS, YEAR_END, PT_YEAR_END, BUFFER_DEFAULT, BUFFER_MAX,
  FIRE_MIN_ZOOM, INDEX_PALETTE, INDEX_MAX, COLORS, FIRE_RAMP, DATA_VERSION, AUTO_SIZES, AUTO_DEFAULT, SITE_GAP_KM,
} from './config.js';
import { loadCore, loadPoints } from './data.js';
import { unitSeries, zoneSeries, geomToLccPolys, makeContains, indexAt, indexStats, toLcc } from './stats.js';
import { occChart, supChart, hbarChart, bindChartTips, fmtInt } from './charts.js';
import { Combo, norm } from './combobox.js';
import { openReportDialog, refreshReportDialog } from './report.js';
import { RasterPicker } from './rasterpick.js';
import { readGeoFiles, GeoImportError } from './importgeo.js';
import { buildProject, siteBuffer, siteFC, siteTypes, autoSquare } from './project.js';
import { siteRings, bufferSums } from './rasterstats.js';
import { initErrors, watchMap, logEvent } from './errors.js';
import { t, loc, getLang, setLang, onLang, applyStatic, cAbb, cLbl, cGrp, pLbl, pShort, LEGEND } from './i18n.js';

const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── État ───────────────────────────────────────────────────────────────────
export const S = {
  core: null, map: null,
  mode: 'auto',           // 'auto' | 'mrc' | 'rect' | 'file'
  autoKm: AUTO_DEFAULT,   // côté du carré automatique (km)
  unit: null,             // id de l'unité MRC sélectionnée
  zone: null,             // { geojson, polys, kind: { k: 'auto'|'drawn'|'file', side?, enlarged?, name? }, pending }
  series: null,           // série INFO-TERRITOIRE courante
  terrName: '',
  idx: null,              // indice du territoire : { mean, sd, n }
  project: null,          // projet importé (project.js)
  site: null,             // site sélectionné
  bufKm: BUFFER_DEFAULT,
  buf: null,              // { comb[], pot[] } superficies ha dans la zone tampon
  siteIdx: null,          // indice dans la zone tampon : { mean, sd, n }
  autoComb: false,        // combustibles affichés automatiquement à la sélection d'un site
  log: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// Utilitaires
// ═══════════════════════════════════════════════════════════════════════════
/** Couleur (opaque) de l'indice : pastilles et chiffres ; sous 0,25 on garde le vert lisible. */
export function indexColor(v) {
  const x = Math.max(0, Math.min(1, v / INDEX_MAX));
  for (let i = 1; i < INDEX_PALETTE.length; i++) {
    if (x <= INDEX_PALETTE[i][0]) return INDEX_PALETTE[x - INDEX_PALETTE[i - 1][0] < INDEX_PALETTE[i][0] - x ? i - 1 : i][1];
  }
  return INDEX_PALETTE.at(-1)[1];
}
export const fmtIdx = (v) => (v == null ? '—' : (+v).toLocaleString(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function geomBBox(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }
    else c.forEach(walk);
  };
  if (g.type === 'FeatureCollection') g.features.forEach(f => walk(f.geometry.coordinates));
  else if (g.type === 'Feature') walk(g.geometry.coordinates);
  else walk(g.coordinates);
  return [[x0, y0], [x1, y1]];
}

export const unitProps = (id) => S.core.units.features.find(f => f.properties.id === id)?.properties;

/** Unité MRC contenant le point [lon, lat] (polygones Lambert calculés à la demande). */
let unitPolys = null;
export function unitAt(lon, lat) {
  unitPolys ??= S.core.units.features.map(f => ({ id: f.properties.id, inside: makeContains(geomToLccPolys(f.geometry, 200)) }));
  const [x, y] = toLcc().forward([lon, lat]);
  return unitPolys.find(u => u.inside(x, y))?.id || null;
}

/** Nom du territoire courant dans la langue active. */
function terrLabel() {
  if (S.unit) return `${t('mrc')} ${unitProps(S.unit)?.nom || ''}`;
  if (!S.zone) return '';
  const k = S.zone.kind;
  if (k.k === 'auto') return t('zone.auto', { s: fmtInt(k.side) });
  if (k.k === 'file') return t('zone.file', { n: k.name });
  return t('zone.drawn');
}

// ── Sites du projet ────────────────────────────────────────────────────────
const TYPE_KEYS = { Point: 'ty.pt', LineString: 'ty.line', Polygon: 'ty.poly' };

/** Nom affiché d'un site : nom du projet s'il n'y a qu'un site, sinon « Site k ». */
export function siteLabel(site) {
  const p = S.project;
  return p.sites.length === 1 ? p.name : t('site.n', { k: site.k });
}

/** Description d'un site : nombre d'entités par type et noms des entités. */
export function siteSub(site, { names = true } = {}) {
  const ty = siteTypes(S.project, site);
  const parts = Object.entries(ty).map(([k, n]) => t(TYPE_KEYS[k], { n }));
  const nm = [...new Set(site.feats.map(i => S.project.features[i].properties.name).filter(Boolean))];
  const nmTxt = names && nm.length && !(S.project.sites.length === 1 && nm.length === 1 && nm[0] === S.project.name)
    ? ` — ${nm.slice(0, 3).join(', ')}${nm.length > 3 ? '…' : ''}` : '';
  return parts.join(' · ') + nmTxt;
}

/** Anneaux combustibles / potentiel d'un site (calcul unique par site, en cache). */
const ringCache = new WeakMap();
export function getRings(site, onProgress) {
  let p = ringCache.get(site);
  if (!p) {
    p = siteRings(S.project, site, S.core.classes, onProgress).catch(e => { ringCache.delete(site); throw e; });
    ringCache.set(site, p);
  }
  return p;
}

/** Indice de prédisposition dans la zone tampon d'un site (pixels de 5 km dont le centre est dans la zone). */
export function siteIndex(site, km) {
  return indexStats(S.core, geomToLccPolys(siteBuffer(S.project, site, km)), site.center);
}

/** Masque mondial troué par la zone tampon (anneaux extérieurs, sens inverse). */
function bufferMask(buf) {
  const g = buf.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...polys.map(p => p[0].slice().reverse())] } };
}

/** Affiche (ou retire) la zone tampon du site et son masque. */
function showBuffer(site) {
  const b = site ? siteBuffer(S.project, site, S.bufKm) : null;
  S.map.getSource('buffer').setData(b || EMPTY);
  S.map.getSource('buffer-mask').setData(b ? bufferMask(b) : EMPTY);
}

// ═══════════════════════════════════════════════════════════════════════════
// Carte
// ═══════════════════════════════════════════════════════════════════════════
function initMap() {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const map = new maplibregl.Map({
    container: 'map-container', style: BASEMAP, bounds: QC_BOUNDS,
    fitBoundsOptions: { padding: 20 }, attributionControl: false, maxPitch: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },   // capture pour le rapport PDF
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.on('style.load', () => { try { map.setProjection({ type: 'globe' }); } catch (e) { /* MapLibre < 5 */ } });
  S.map = map;
  return new Promise((res) => map.on('load', () => { fitQuebec(); res(); }));
}

/** Marge droite laissée au panneau des couches lors d'un cadrage. */
function rightPad() {
  const lp = $('layers-panel'), cw = S.map.getContainer().clientWidth;
  const lpw = lp && !lp.classList.contains('collapsed') ? lp.offsetWidth + 10 : 0;
  return lpw && cw - lpw > 300 ? lpw + 10 : 20;
}

/** Cadre toute la province, sans la cacher sous le panneau des couches. */
function fitQuebec() {
  S.map.fitBounds(QC_BOUNDS, { padding: { top: 20, bottom: 20, left: 20, right: rightPad() }, duration: 0 });
}

function fitTo(bbox, duration = 900) {
  S.map.fitBounds(bbox, { padding: { top: 40, bottom: 40, left: 40, right: rightPad() + 20 }, duration, maxZoom: 13 });
}

function addLayers() {
  const map = S.map, core = S.core;
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

  // Rasters (PMTiles)
  map.addSource('comb', { type: 'raster', url: `pmtiles://${TILES.comb}`, tileSize: 256 });
  map.addSource('pot', { type: 'raster', url: `pmtiles://${TILES.pot}`, tileSize: 256 });
  map.addLayer({ id: 'comb', type: 'raster', source: 'comb', layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);
  map.addLayer({ id: 'pot', type: 'raster', source: 'pot', layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);

  // Indice de prédisposition standardisé (raster 5 km, rendu EPSG:3857)
  map.addSource('indice', { type: 'image', url: `data/indice_3857.png?v=${DATA_VERSION}`, coordinates: core.indiceMeta.coords });
  map.addLayer({ id: 'indice', type: 'raster', source: 'indice',
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);

  // Unités MRC (remplissage invisible : survol et clic)
  map.addSource('units', { type: 'geojson', data: core.units, promoteId: 'uid' });
  map.addLayer({ id: 'units-fill', type: 'fill', source: 'units',
    paint: { 'fill-color': '#000', 'fill-opacity': 0 } }, firstSymbol);

  // Contours de feux (FlatGeobuf → GeoJSON selon l'emprise)
  map.addSource('feux', { type: 'geojson', data: EMPTY, tolerance: 0.3 });
  const fireColor = ['interpolate', ['linear'], ['get', 'an'], ...FIRE_RAMP.flat()];
  map.addLayer({ id: 'feux-fill', type: 'fill', source: 'feux', layout: { visibility: 'none' },
    paint: { 'fill-color': fireColor, 'fill-opacity': 0.6 } });
  map.addLayer({ id: 'feux-line', type: 'line', source: 'feux', minzoom: 8, layout: { visibility: 'none' },
    paint: { 'line-color': fireColor, 'line-width': 0.6, 'line-opacity': 0.9 } });

  map.addLayer({ id: 'units-line', type: 'line', source: 'units', paint: { 'line-color': '#555', 'line-width': 0.7, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'units-sel', type: 'line', source: 'units', filter: ['==', ['get', 'id'], '__'],
    paint: { 'line-color': COLORS.sel, 'line-width': 3 } });

  // Zone régionale (automatique, tracée ou importée)
  map.addSource('zone', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': COLORS.sel, 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': COLORS.sel, 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });

  // Zone tampon du site (coins arrondis) et masque grisé à l'extérieur
  map.addSource('buffer', { type: 'geojson', data: EMPTY });
  map.addSource('buffer-mask', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'buffer-mask', type: 'fill', source: 'buffer-mask',
    paint: { 'fill-color': '#6b7280', 'fill-opacity': 0.5, 'fill-antialias': false } });
  map.addLayer({ id: 'buffer-line', type: 'line', source: 'buffer', paint: { 'line-color': '#111', 'line-width': 2 } });

  // Points d'origine
  map.addSource('pts', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'pts', type: 'circle', source: 'pts', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 9, 3.5, 12, 5],
      'circle-color': ['match', ['get', 'c'], 1, COLORS.foudre, COLORS.humain],
      'circle-stroke-color': '#fff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0, 9, 0.8],
    } });

  // Entités du projet (site sélectionné en noir, autres sites en gris foncé)
  map.addSource('proj', { type: 'geojson', data: EMPTY });
  const projColor = ['case', ['get', 'sel'], COLORS.proj, '#4b5563'];
  map.addLayer({ id: 'proj-fill', type: 'fill', source: 'proj', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': projColor, 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'proj-halo', type: 'line', source: 'proj', filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': '#fff', 'line-width': 5.5, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'proj-line', type: 'line', source: 'proj', filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': projColor, 'line-width': 2.5 } });
  map.addLayer({ id: 'proj-pt', type: 'circle', source: 'proj', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': ['case', ['get', 'sel'], 5.5, 4.5], 'circle-color': projColor, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } });
  // Étiquettes des sites (projet à plusieurs sites)
  map.addSource('sites', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'site-label', type: 'symbol', source: 'sites',
    layout: {
      'text-field': ['get', 'label'], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': ['case', ['get', 'sel'], 14, 12], 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': true,
    },
    paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 2 } });

  bindMapEvents();
  bindLayerPanel();
}

// ── Interactions carte ─────────────────────────────────────────────────────
const PROJ_LAYERS = ['proj-pt', 'proj-line', 'proj-fill'];

function bindMapEvents() {
  const map = S.map, tt = $('map-tooltip');
  const layers = [...PROJ_LAYERS, 'pts', 'feux-fill', 'units-fill'];
  const pickers = { comb: new RasterPicker(TILES.comb), pot: new RasterPicker(TILES.pot) };
  const combByV = new Map(S.core.classes.comb.map(c => [c.v, c]));
  const potByV = new Map(S.core.classes.pot.map(c => [c.v, c]));
  const sw = (hex) => `<i class="tt-sw" style="background:${hex}"></i>`;
  let token = 0;

  const place = (pt) => {
    const r = $('map').getBoundingClientRect();
    let x = pt.x + 14, y = pt.y + 14;
    if (x + tt.offsetWidth > r.width - 6) x = pt.x - tt.offsetWidth - 14;
    if (y + tt.offsetHeight > r.height - 6) y = pt.y - tt.offsetHeight - 14;
    tt.style.left = `${x}px`; tt.style.top = `${y}px`;
  };

  /** Élément vectoriel survolé (titre + sous-titre). */
  function featureHTML(f, feats) {
    if (!f) return '';
    const p = f.properties;
    if (PROJ_LAYERS.includes(f.layer.id)) {
      const site = S.project?.sites[p.site - 1];
      return `${esc(p.name || S.project?.name)}<div class="tt-sub">${site && S.project.sites.length > 1 ? `${esc(siteLabel(site))} · ` : ''}${t('tt.projClick')}</div>`;
    }
    if (f.layer.id === 'pts') {
      const dd = String(p.j % 100).padStart(2, '0'), mm = String(Math.floor(p.j / 100)).padStart(2, '0');
      const d = p.j ? (getLang() === 'en' ? `${p.an}-${mm}-${dd}` : `${dd}/${mm}/${p.an}`) : p.an;
      return `${t('tt.fireStart', { d })}<div class="tt-sub">${t('tt.cause', { c: t(p.c ? 'cause.f' : 'cause.h') })}</div>`;
    }
    if (f.layer.id === 'feux-fill') {
      const years = [...new Set(feats.filter(x => x.layer.id === 'feux-fill').map(x => x.properties.an))].sort((a, b) => b - a);
      return t('tt.fire', { y: years.slice(0, 5).join(', ') + (years.length > 5 ? '…' : '') });
    }
    return `${p.nom}<div class="tt-sub">${t('tt.unitIdx', { m: fmtIdx(p.im), s: fmtIdx(p.isd) })}</div>`;
  }

  map.on('mousemove', async (e) => {
    if (drawing) return;
    const my = ++token;
    const feats = map.queryRenderedFeatures(e.point, { layers: layers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none') });
    const f = feats[0];
    map.getCanvas().style.cursor = f && (PROJ_LAYERS.includes(f.layer.id) || (f.layer.id === 'units-fill' && S.mode === 'mrc')) ? 'pointer' : '';
    const { lng, lat } = e.lngLat;

    const lines = [];
    if ($('ly-indice').checked) {
      const v = indexAt(S.core, lng, lat);
      if (v != null) lines.push(`${sw(indexColor(v))}${t('tt.index', { v: fmtIdx(v) })}`);
    }
    const head = featureHTML(f, feats);
    const render = () => {
      if (!head && !lines.length) { tt.style.display = 'none'; return; }
      tt.innerHTML = head + (lines.length ? `<div class="tt-sub tt-rasters">${lines.join('<br>')}</div>` : '');
      tt.style.display = 'block';
      place(e.point);
    };
    render();

    const want = ['comb', 'pot'].filter(k => $(`ly-${k}`).checked);
    if (!want.length) return;
    const vals = await Promise.all(want.map(k => pickers[k].valueAt(lng, lat, map.getZoom())));
    if (my !== token) return;
    want.forEach((k, n) => {
      const v = vals[n];
      if (v == null) return;
      const c = (k === 'comb' ? combByV : potByV).get(v);
      if (!c) return;
      lines.push(k === 'comb'
        ? `${sw(c.hex)}${t('tt.comb', { a: cAbb(c), l: cLbl(c) !== cAbb(c) ? ` — ${cLbl(c)}` : '' })}`
        : `${sw(c.hex)}${t('tt.pot', { l: pLbl(c) })}`);
    });
    render();
  });
  map.on('mouseout', () => { tt.style.display = 'none'; });
  map.on('click', (e) => {
    if (drawing) return;
    const pf = map.queryRenderedFeatures(e.point, { layers: PROJ_LAYERS })[0];
    if (pf && S.project) { selectSite(S.project.sites[pf.properties.site - 1]); return; }
    if (S.mode !== 'mrc') return;
    const u = map.queryRenderedFeatures(e.point, { layers: ['units-fill'] })[0];
    if (u) selectUnit(u.properties.id);
  });
  map.on('moveend', () => { loadFiresInView(); });
}

// ── Contours de feux : lecture FlatGeobuf par emprise ─────────────────────
const fireCache = { boxes: [], feats: new Map(), token: 0 };
function boxContains(a, b) { return a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]; }

export async function loadFiresInView() {
  const map = S.map;
  const note = $('feux-note');
  if (!$('ly-feux').checked) return;
  if (map.getZoom() < FIRE_MIN_ZOOM) {
    note.textContent = t('fires.zoom');
    return;
  }
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  if (fireCache.boxes.some(bx => boxContains(bx, view))) return;
  const dx = (view[2] - view[0]) * 0.25, dy = (view[3] - view[1]) * 0.25;
  const q = [view[0] - dx, view[1] - dy, view[2] + dx, view[3] + dy];
  const token = ++fireCache.token;
  // cache limité : trop de polygones épuisent la mémoire graphique (écran noir)
  if (fireCache.feats.size > 30000) { fireCache.feats.clear(); fireCache.boxes = []; }
  note.innerHTML = `<span class="spin-inline"></span> ${t('fires.loading')}`;
  try {
    let k = 0;
    const iter = flatgeobuf.deserialize(`${TILES.feux}?v=${DATA_VERSION}`, { minX: q[0], minY: q[1], maxX: q[2], maxY: q[3] });
    for await (const f of iter) {
      if (token !== fireCache.token) return;
      const c = f.geometry.coordinates;
      const first = f.geometry.type === 'Polygon' ? c[0][0] : c[0][0][0];
      const key = `${f.properties.an}|${f.properties.ha}|${first[0].toFixed(5)}|${first[1].toFixed(5)}`;
      fireCache.feats.set(key, f);
      if (++k % 3000 === 0) map.getSource('feux').setData({ type: 'FeatureCollection', features: [...fireCache.feats.values()] });
    }
    fireCache.boxes.push(q);
    map.getSource('feux').setData({ type: 'FeatureCollection', features: [...fireCache.feats.values()] });
    note.textContent = t('fires.hover');
  } catch (err) {
    console.warn('Feux :', err);
    logEvent('feux', err.message || err);
    note.textContent = t('fires.na');
  }
}

// ── Panneau des couches ───────────────────────────────────────────────────
const PERIODS = { recent: [1976, YEAR_END], old: [1887, 1975] };
const PERIOD_DEFAULT = 'recent';

function buildPeriods() {
  const sel = $('sel-periode'), cur = sel.value || PERIOD_DEFAULT;
  sel.innerHTML = [['recent', t('period.recent', { y: YEAR_END })], ['old', t('period.old')]]
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = cur;
}

function setPeriodRange() {
  const [lo, hi] = PERIODS[$('sel-periode').value];
  for (const [id, v] of [['yr-a', lo], ['yr-b', hi]]) Object.assign($(id), { min: lo, max: hi, value: v });
  $('yr-lo').textContent = lo; $('yr-hi').textContent = hi;
  const pct = (y) => ((y - lo) / (hi - lo) * 100).toFixed(1);
  $('ramp-feux').style.background = `linear-gradient(to right, ${FIRE_RAMP.map(([y, c]) => `${c} ${pct(y)}%`).join(', ')})`;
  applyYears();
}

function applyYears() {
  const [lo, hi] = PERIODS[$('sel-periode').value];
  let a = +$('yr-a').value, b = +$('yr-b').value;
  if (a > b) [a, b] = [b, a];
  const pct = (y) => `${(y - lo) / (hi - lo) * 100}%`;
  $('yr-shade-a').style.width = pct(a);
  $('yr-shade-b').style.left = pct(b);
  $('yr-sel').textContent = a === b ? `${a}` : `${a} – ${b}`;
  const f = ['all', ['>=', ['get', 'an'], a], ['<=', ['get', 'an'], b]];
  ['feux-fill', 'feux-line', 'pts'].forEach(id => S.map.setFilter(id, f));
}

function buildMiniLegends() {
  $('leg-comb').innerHTML = combGroups().map(gr => `<span class="leg-mini-grp">${gr.label}</span>` +
    gr.items.map(c => `<span><i style="background:${c.hex}"></i><b>${cAbb(c)}</b>${cLbl(c) !== cAbb(c) ? ` ${cLbl(c)}` : ''}</span>`).join('')).join('');
  $('leg-pot').innerHTML = S.core.classes.pot.map(c => `<span><i style="background:${c.hex}"></i>${pLbl(c)}</span>`).join('');
}

async function refreshPoints() {
  if (!$('ly-pts').checked) return;
  const map = S.map;
  if (!map.getSource('pts')._loaded) {
    const p = await loadPoints();
    const feats = new Array(p.n);
    for (let i = 0; i < p.n; i++) feats[i] = { type: 'Feature', properties: { an: p.an[i], c: p.c[i], j: p.j[i], ha: p.ha[i] }, geometry: { type: 'Point', coordinates: [p.x[i], p.y[i]] } };
    map.getSource('pts').setData({ type: 'FeatureCollection', features: feats });
    map.getSource('pts')._loaded = true;
  }
}

function bindLayerPanel() {
  const map = S.map;
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');

  buildPeriods();
  setPeriodRange();
  $('sel-periode').addEventListener('change', setPeriodRange);
  $('yr-a').addEventListener('input', applyYears);
  $('yr-b').addEventListener('input', applyYears);

  $('ly-indice').addEventListener('change', (e) => vis('indice', e.target.checked));
  $('op-indice').addEventListener('input', (e) => map.setPaintProperty('indice', 'raster-opacity', e.target.value / 100));
  $('ly-feux').addEventListener('change', (e) => { vis('feux-fill', e.target.checked); vis('feux-line', e.target.checked); loadFiresInView(); });
  $('op-feux').addEventListener('input', (e) => {
    map.setPaintProperty('feux-fill', 'fill-opacity', e.target.value / 100);
    map.setPaintProperty('feux-line', 'line-opacity', Math.min(1, e.target.value / 100 + 0.3));
  });
  $('ly-pts').addEventListener('change', async (e) => { vis('pts', e.target.checked); if (e.target.checked) await refreshPoints(); });
  const rasterToggle = (id) => {
    $(`ly-${id}`).addEventListener('change', (e) => {
      vis(id, e.target.checked);
      if (e.target.checked && $('ly-indice').checked) {
        $('ly-indice').checked = false; vis('indice', false);
      }
    });
    $(`op-${id}`).addEventListener('input', (e) => map.setPaintProperty(id, 'raster-opacity', e.target.value / 100));
  };
  rasterToggle('comb'); rasterToggle('pot');

  buildMiniLegends();

  $('lp-toggle').addEventListener('click', () => {
    $('layers-panel').classList.toggle('collapsed');
    $('lp-arrow').textContent = $('layers-panel').classList.contains('collapsed') ? '▸' : '▾';
  });
}

function setLayer(id, on) {
  if ($(id).checked === on) return;
  $(id).checked = on; $(id).dispatchEvent(new Event('change'));
}

function resetLayers() {
  const on = { 'ly-indice': true, 'ly-feux': false, 'ly-pts': false, 'ly-comb': false, 'ly-pot': false };
  for (const [id, v] of Object.entries(on)) setLayer(id, v);
  for (const el of document.querySelectorAll('#layers-panel input[type=range][id^="op-"]')) {
    el.value = el.defaultValue; el.dispatchEvent(new Event('input'));
  }
  $('sel-periode').value = PERIOD_DEFAULT; setPeriodRange();
}

// ═══════════════════════════════════════════════════════════════════════════
// Projet : import, sites
// ═══════════════════════════════════════════════════════════════════════════
let comboMRC, comboSite;

/** Message d'erreur d'import (GeoImportError → texte traduit). */
function importErrMsg(err) {
  if (err instanceof GeoImportError) return t(`imp.${err.code}`, err.info);
  console.error(err);
  return t('imp.read', { msg: err.message || err });
}

async function importProject(files) {
  if (!files || !files.length) return;
  const msg = $('proj-msg');
  msg.innerHTML = `<span class="spin-inline"></span> ${t('proj.reading')}`;
  try {
    const { name, features } = await readGeoFiles(files);
    setProject(buildProject(name, features));
  } catch (err) {
    logEvent('import projet', err.code || err.message || err);
    msg.innerHTML = `<span class="err">${esc(importErrMsg(err))}</span>`;
  }
}

function projMsg() {
  const p = S.project, el = $('proj-msg');
  if (!p) { el.innerHTML = t('proj.help'); return; }
  const n = p.features.length;
  el.innerHTML = `<b>${esc(p.name)}</b> — ${t('proj.summary', { n })}` +
    (p.sites.length > 1 ? `<br><span class="warn">${t('proj.sites', { n: p.sites.length, d: SITE_GAP_KM })}</span>` : '');
}

function siteItems() {
  return (S.project?.sites || []).map(s => ({ value: s.k, label: siteLabel(s), sub: siteSub(s), keys: siteSub(s) }));
}

function refreshSiteCombo() {
  comboSite.setItems(siteItems(), {
    disabled: !S.project, placeholder: S.project ? t('site.ph', { n: S.project.sites.length }) : t('site.ph.first'),
  });
  comboSite.set(S.site ? S.site.k : null, false);
}

/** Entités du projet et étiquettes des sites sur la carte (site sélectionné en évidence). */
function refreshProjLayers() {
  const p = S.project;
  if (!p) { S.map.getSource('proj').setData(EMPTY); S.map.getSource('sites').setData(EMPTY); return; }
  const siteOf = new Map();
  p.sites.forEach(s => s.feats.forEach(i => siteOf.set(i, s)));
  S.map.getSource('proj').setData({
    type: 'FeatureCollection',
    features: p.features.map((f, i) => ({ ...f, properties: { name: f.properties.name, site: siteOf.get(i).k, sel: siteOf.get(i) === S.site } })),
  });
  S.map.getSource('sites').setData({
    type: 'FeatureCollection',
    features: p.sites.length > 1 ? p.sites.map(s => ({ type: 'Feature', properties: { label: siteLabel(s), sel: s === S.site }, geometry: { type: 'Point', coordinates: s.center } })) : [],
  });
}

function setProject(p) {
  S.project = p;
  S.site = null;
  projMsg();
  refreshSiteCombo();
  refreshProjLayers();
  $('btn-proj-clear').disabled = false;
  // cadrage : tout le projet avec la zone tampon
  const bufs = { type: 'FeatureCollection', features: p.sites.map(s => siteBuffer(p, s, S.bufKm)) };
  fitTo(geomBBox(bufs));
  selectSite(p.sites[0], { fit: false });
  // zone régionale : calculée sur le projet (mode automatique) ou MRC du projet
  if (S.mode === 'auto') applyAutoZone({ fit: false });
  else if (S.mode === 'mrc' && !S.unit) { const u = unitAt(...p.sites[0].center); if (u) selectUnit(u, { fit: false }); }
  updateReportBtn();
}

function clearProject() {
  S.project = null;
  selectSite(null);
  projMsg();
  refreshSiteCombo();
  refreshProjLayers();
  $('btn-proj-clear').disabled = true;
  if (S.mode === 'auto') clearTerritory();
  autoMsg();
  updateReportBtn();
}

export async function selectSite(site, { fit = true } = {}) {
  S.site = site;
  comboSite.set(site ? site.k : null, false);
  refreshProjLayers();
  $('btn-big-lh').disabled = !site;
  setSummary('sum-lh', site ? siteLabel(site) : '');
  if (!site) {
    S.buf = null; S.siteIdx = null;
    showBuffer(null);
    $('lh-content').innerHTML = `<div class="placeholder">${t('lh.choose')}</div>`;
    if (S.autoComb) { S.autoComb = false; setLayer('ly-comb', false); setLayer('ly-indice', true); }
    return;
  }
  showBuffer(site);
  // combustibles affichés dans la zone tampon et zoom sur le site
  if (!$('ly-comb').checked) { setLayer('ly-comb', true); S.autoComb = true; }
  if (fit) fitTo(geomBBox(siteBuffer(S.project, site, S.bufKm)), 800);
  await updateBuffer();
}

function siteHeader(site, big = false) {
  const u = unitAt(...site.center);
  return `<div style="margin-top:4px;font-family:'Oswald',sans-serif;font-size:${big ? 19 : 15}px;color:var(--accent)">${esc(siteLabel(site))}</div>
    <div class="box-sub">${S.project.sites.length > 1 ? `${esc(S.project.name)} · ` : ''}${esc(siteSub(site))}${u ? ` · ${t('mrc')} ${esc(unitProps(u)?.nom || '')}` : ''}</div>`;
}

async function updateBuffer() {
  const site = S.site;
  if (!site) return;
  const el = $('lh-content');
  let ready = false;
  const prog = (f) => {
    if (S.site !== site || ready) return;
    el.innerHTML = `${siteHeader(site)}<div class="placeholder"><span class="spin-inline"></span> ${t('lh.loading')} ${Math.round(f * 100)} %</div>`;
  };
  if (!S.buf || S.buf.site !== site) prog(0);
  try {
    const R = await getRings(site, prog);
    ready = true;
    if (S.site !== site) return;
    S.buf = { ...bufferSums(R, S.bufKm), site };
    S.siteIdx = siteIndex(site, S.bufKm);
  } catch (err) {
    console.error(err);
    logEvent('combustibles', err.message || err, err.stack);
    el.innerHTML = `${siteHeader(site)}<div class="placeholder">${t('lh.na')}</div>`;
    return;
  }
  renderLH();
}

// ═══════════════════════════════════════════════════════════════════════════
// Zone régionale : automatique, MRC, rectangle, zone importée
// ═══════════════════════════════════════════════════════════════════════════
function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll('#mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  for (const m of ['auto', 'mrc', 'rect', 'file']) $(`sec-${m}`).style.display = m === mode ? '' : 'none';
}

function clearTerritory() {
  S.unit = null; S.zone = null; S.series = null; S.idx = null; S.terrName = '';
  S.map.setFilter('units-sel', ['==', ['get', 'id'], '__']);
  S.map.getSource('zone').setData(EMPTY);
  comboMRC.set(null, false);
  $('zone-msg').innerHTML = '';
  renderIndex(); renderMRC();
  updateReportBtn();
}

/** Changement de mode : la zone régionale est recalculée selon le nouveau mode. */
function switchMode(mode) {
  if (mode === S.mode) return;
  clearTerritory();
  setMode(mode);
  if (mode === 'auto') applyAutoZone({ fit: false });
  if (mode === 'mrc' && S.project) { const u = unitAt(...S.project.sites[0].center); if (u) selectUnit(u, { fit: false }); }
}

function buildAutoSeg() {
  $('auto-seg').innerHTML = AUTO_SIZES.map(([f, km]) =>
    `<button data-km="${km}" class="${km === S.autoKm ? 'active' : ''}" title="${t('auto.title', { f: f.toLocaleString(loc()), km })}">×${f.toLocaleString(loc())} · ${km} km</button>`).join('');
}

function autoMsg() {
  if (S.mode === 'auto' && !S.project) $('zone-msg').innerHTML = `<span class="muted">${t('auto.needProj')}</span>`;
}

function applyAutoZone({ fit = false } = {}) {
  if (!S.project) { autoMsg(); return; }
  const { geojson, sideKm, enlarged } = autoSquare(S.project, S.autoKm);
  setZone(geojson, { k: 'auto', side: sideKm, enlarged }, { fit });
}

export function selectUnit(id, { fit = true } = {}) {
  if (!id) { clearTerritory(); return; }
  setMode('mrc');
  const f = S.core.units.features.find(x => x.properties.id === id);
  S.unit = id; S.zone = null;
  S.map.getSource('zone').setData(EMPTY);
  comboMRC.set(id, false);
  S.map.setFilter('units-sel', ['==', ['get', 'id'], id]);
  if (fit && f) fitTo(geomBBox(f.geometry));
  S.terrName = terrLabel();
  S.idx = f.properties.im != null ? { mean: f.properties.im, sd: f.properties.isd, n: f.properties.in } : null;
  S.series = unitSeries(S.core, id);
  $('zone-msg').innerHTML = `<b>${esc(S.terrName)}</b> — ${t('zone.km2', { km2: fmtInt((f.properties.ha || 0) / 100) })}`;
  renderIndex(); renderMRC();
  updateReportBtn();
}

function zoneMsg() {
  if (!S.zone) return;
  const ha = S.series ? S.series.areaHa : 0;
  const k = S.zone.kind;
  $('zone-msg').innerHTML = S.zone.pending
    ? `<b>${esc(S.terrName)}</b> — ${t('zone.computing')} <span class="spin-inline"></span>`
    : `<b>${esc(S.terrName)}</b> — ${t('zone.km2', { km2: fmtInt(ha / 100) })}` +
      (k.k === 'auto' && k.enlarged ? `<br><span class="warn">${t('zone.enlarged', { km: S.autoKm })}</span>` : '');
}

async function setZone(geojson, kind, { fit = true } = {}) {
  setMode(kind.k === 'auto' ? 'auto' : kind.k === 'file' ? 'file' : 'rect');
  S.unit = null;
  comboMRC.set(null, false);
  S.map.setFilter('units-sel', ['==', ['get', 'id'], '__']);
  const polys = geomToLccPolys(geojson, 50);     // simplification 50 m (grille de calcul : 1 km)
  if (!polys.length) { $('zone-msg').innerHTML = `<span class="err">${t('zone.invalid')}</span>`; return; }
  S.zone = { geojson, polys, kind, pending: true };
  S.terrName = terrLabel();
  S.map.getSource('zone').setData(geojson);
  if (fit) fitTo(geomBBox(geojson));
  zoneMsg();
  $('mrc-content').innerHTML = `<div class="placeholder"><span class="spin-inline"></span> ${t('zone.computingStats')}</div>`;
  S.idx = indexStats(S.core, polys);
  try {
    S.series = await zoneSeries(S.core, polys);
  } catch (err) {
    console.error(err); S.series = null;
  }
  if (S.zone?.polys !== polys) return;      // zone remplacée entre-temps
  S.zone.pending = false;
  zoneMsg();
  renderIndex(); renderMRC();
  updateReportBtn();
}

async function importZone(files) {
  if (!files || !files.length) return;
  $('zone-msg').innerHTML = `<span class="spin-inline"></span> ${t('proj.reading')}`;
  try {
    const { name, features } = await readGeoFiles(files);
    const polys = features.filter(f => f.geometry.type === 'Polygon');
    if (!polys.length) throw new GeoImportError('noPolygon');
    setZone({ type: 'FeatureCollection', features: polys }, { k: 'file', name });
  } catch (err) {
    logEvent('import zone', err.code || err.message || err);
    $('zone-msg').innerHTML = `<span class="muted"><span class="err">${esc(importErrMsg(err))}</span></span>`;
  }
}

function mrcItems() {
  const units = S.core.units.features.map(f => f.properties).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  return units.map(p => ({
    value: p.id, label: p.nom,
    sub: `${t('mrc.sub', { i: fmtIdx(p.im) })}${norm(p.mrc) !== norm(p.nom) ? ` · ${t('mrc')} ${p.mrc}` : ''}`,
    keys: p.mrc,
  }));
}

function updateReportBtn() {
  $('btn-rapport').disabled = !(S.series || S.project);
}

// ── Dessin d'un rectangle ──────────────────────────────────────────────────
let drawing = false;
function startDraw() {
  const map = S.map, mapEl = $('map'), box = $('draw-box');
  drawing = true; mapEl.classList.add('drawing'); $('btn-draw').classList.add('on');
  map.dragPan.disable(); map.boxZoom.disable();
  let start = null;
  const canvas = map.getCanvasContainer();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onDown = (e) => {
    if (e.button !== 0) return;
    start = pos(e); box.style.display = 'block';
    Object.assign(box.style, { left: `${start[0]}px`, top: `${start[1]}px`, width: '0px', height: '0px' });
  };
  const onMove = (e) => {
    if (!start) return;
    const p = pos(e);
    Object.assign(box.style, {
      left: `${Math.min(p[0], start[0])}px`, top: `${Math.min(p[1], start[1])}px`,
      width: `${Math.abs(p[0] - start[0])}px`, height: `${Math.abs(p[1] - start[1])}px`,
    });
  };
  const onUp = (e) => {
    if (!start) return;
    const p = pos(e), a = start;
    start = null; stop();
    if (Math.abs(p[0] - a[0]) < 8 || Math.abs(p[1] - a[1]) < 8) return;
    setZone(screenRectToPolygon([Math.min(a[0], p[0]), Math.min(a[1], p[1])], [Math.max(a[0], p[0]), Math.max(a[1], p[1])]), { k: 'drawn' }, { fit: false });
  };
  const onKey = (e) => { if (e.key === 'Escape') { start = null; stop(); } };
  function stop() {
    drawing = false; mapEl.classList.remove('drawing'); $('btn-draw').classList.remove('on');
    box.style.display = 'none';
    map.dragPan.enable(); map.boxZoom.enable();
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
  }
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('keydown', onKey);
}

/** Rectangle écran → polygone géographique (arêtes densifiées : globe / Mercator). */
function screenRectToPolygon([x0, y0], [x1, y1]) {
  const pts = [], n = 16;
  const edge = (ax, ay, bx, by) => { for (let i = 0; i < n; i++) pts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]); };
  edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
  const ring = pts.map(p => { const ll = S.map.unproject(p); return [+ll.lng.toFixed(5), +ll.lat.toFixed(5)]; });
  ring.push(ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// ═══════════════════════════════════════════════════════════════════════════
// Panneau : indice, INFO-TERRITOIRE, INFO-PROJET
// ═══════════════════════════════════════════════════════════════════════════
function renderIndex() {
  const el = $('expo-value'), mk = $('expo-marker'), band = $('expo-band'), e = S.idx;
  if (!e) {
    el.innerHTML = `<div class="expo-note">${t(S.unit || S.zone ? 'idx.none' : 'idx.choose')}</div>`;
    mk.style.display = band.style.display = 'none';
    return;
  }
  const pos = (v) => Math.max(0, Math.min(100, (v / INDEX_MAX) * 100));
  mk.style.display = band.style.display = 'block';
  mk.style.left = `${pos(e.mean)}%`;
  band.style.left = `${pos(e.mean - e.sd)}%`;
  band.style.width = `${pos(e.mean + e.sd) - pos(e.mean - e.sd)}%`;
  el.innerHTML = `<div class="expo-value"><span class="expo-num" style="color:${indexColor(e.mean)}">${fmtIdx(e.mean)}</span>
    <span class="expo-rank">${t('idx.meanSd', { s: fmtIdx(e.sd) })}</span></div>
    <div class="expo-note">${t('idx.note', { t: esc(S.terrName), n: e.n })}</div>`;
}

function chartWidth(el) { return Math.max(300, Math.round(el.clientWidth || 420)); }

/** Contenu INFO-TERRITOIRE (panneau ou fiche agrandie). */
function mrcHTML(w, big = false) {
  const s = S.series;
  const period = `${s.y0}–${YEAR_END}`;
  const idx = S.idx ? `<span>${t('idx.short', { m: fmtIdx(S.idx.mean), s: fmtIdx(S.idx.sd) })}</span>` : '';
  const long = s.y0 < 1972;
  return `
    <div style="margin-top:4px;font-family:'Oswald',sans-serif;font-size:${big ? 19 : 15}px;color:var(--accent)">${esc(S.terrName)}</div>
    <div class="stat-line"><span class="badge ${long ? 'long' : ''}" title="${t(long ? 'mrc.longTitle' : 'mrc.shortTitle')}">${t(long ? 'mrc.long' : 'mrc.short')} · ${period}</span>
      <span>${t('mrc.fuel', { v: fmtInt(s.fuelHa) })}</span>${big ? idx : ''}</div>
    <div class="stat-line"><span>${t('mrc.fires', { y: PT_YEAR_END, n: fmtInt(s.totOcc), h: fmtInt(s.totH), f: fmtInt(s.totF) })}</span>
      <span>${t('mrc.burned', { v: fmtInt(s.totSup) })}</span></div>
    <div class="chart-title">${t('chart.occ')}</div>
    <div class="chart-legend"><span><i style="background:${COLORS.humain}"></i>${t('leg.human')}</span><span><i style="background:${COLORS.foudre}"></i>${t('leg.lightning')}</span><span><i class="band"></i>${t('leg.meanSd')}</span></div>
    <div class="chart">${occChart(s, { width: w, height: big ? 300 : 190, labels: w > 380 })}</div>
    <div class="chart-title">${t('chart.sup')}${S.log ? t('chart.log') : ''}</div>
    <div class="chart">${supChart(s, { width: w, height: big ? 280 : 180, log: S.log })}</div>`;
}

function setSummary(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.title = text ? t('summary.click', { t: text }) : '';
  el.classList.toggle('on', !!text);
}

function renderMRC() {
  const el = $('mrc-content'), s = S.series;
  $('btn-big-mrc').disabled = !s;
  setSummary('sum-mrc', s ? (S.unit ? unitProps(S.unit)?.nom : S.terrName) : '');
  if (!s) {
    el.innerHTML = `<div class="placeholder">${t(S.unit || S.zone ? 'mrc.noData' : (S.mode === 'auto' && !S.project ? 'auto.needProj' : 'mrc.choose'))}</div>`;
    return;
  }
  el.innerHTML = mrcHTML(chartWidth(el));
}

// ── Graphiques combustibles / potentiel ────────────────────────────────────
export function combRows(ha, classes) {
  return classes.comb.map((c, k) => ({ label: cAbb(c), title: `${cAbb(c)} — ${cLbl(c)}`, ha: ha[k], color: c.hex, grpKey: c.grp, group: cGrp(c.grp) }));
}
export function potRows(ha, classes) {
  return classes.pot.map((c, k) => ({ label: pShort(c), title: pLbl(c), ha: ha[k], color: c.hex })).reverse();
}
export const COMB_ORDER = ['Résineux', 'Mixtes', 'Feuillus', 'Rémanents', 'Herbes', 'Brûlis', 'Dénudé', 'Eau', 'Urbain'];
export function sortComb(rows) {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (COMB_ORDER.indexOf(a.r.grpKey) - COMB_ORDER.indexOf(b.r.grpKey)) || a.i - b.i).map(x => x.r);
}

/**
 * Paire de graphiques de MÊME hauteur (comme les fiches v1) : les classes de
 * potentiel s'alignent grossièrement sur les groupes de combustibles correspondants.
 */
export function lhChartPair(buf, cls, width, { combRowH = 14, fontSize = 9.5 } = {}) {
  const comb = sortComb(combRows(buf.comb, cls)), pot = potRows(buf.pot, cls);
  const potRowH = (combRowH * comb.length) / pot.length;
  return {
    pot: hbarChart(pot, { width, rowH: potRowH, labelW: 86, fontSize: fontSize + 1 }),
    comb: hbarChart(comb, { width, rowH: combRowH, labelW: 52, groupW: 64, fontSize }),
  };
}

function lhChartsHTML(w, big = false) {
  const b = S.buf, cls = S.core.classes;
  const tot = b.comb.reduce((a, v) => a + v, 0);
  if (!tot) return `<div class="placeholder">${t('lh.noFuel')}</div>`;
  const gap = big ? 24 : 12;
  const side = (w - gap) / 2 >= 230;
  const cw = side ? Math.floor((w - gap) / 2) : w;
  const c = lhChartPair(b, cls, cw, big ? { combRowH: 19, fontSize: 10.5 } : { combRowH: 14, fontSize: 9.5 });
  const t1 = `<div class="chart-title">${t('lh.chartA')}</div>`;
  const t2 = `<div class="chart-title">${t('lh.chartB')}</div>`;
  return side
    ? `<div class="pair-grid" style="column-gap:${gap}px">${t1}${t2}<div class="chart">${c.comb}</div><div class="chart">${c.pot}</div></div>`
    : `${t1}<div class="chart">${c.comb}</div>${t2}<div class="chart">${c.pot}</div>`;
}

function lhStatsLine() {
  const tot = S.buf.comb.reduce((a, v) => a + v, 0);
  const i = S.siteIdx;
  return `<span>${t('lh.area', { v: fmtInt(tot) })}</span>
    ${i ? `<span title="${t('idx.shortTitle')}">${t('idx.short', { m: `<b style="color:${indexColor(i.mean)}">${fmtIdx(i.mean)}</b>`, s: fmtIdx(i.sd) }).replace('<b><b', '<b').replace('</b></b>', '</b>')}</span>` : ''}`;
}

function renderLH() {
  const site = S.site, b = S.buf, el = $('lh-content');
  if (!site || !b || b.site !== site) {
    if (!site) el.innerHTML = `<div class="placeholder">${t(S.project ? 'lh.choose' : 'lh.first')}</div>`;
    return;
  }
  const w = chartWidth(el);
  const prev = el.querySelector('#rng-buf');
  const focused = document.activeElement === prev;
  el.innerHTML = `${siteHeader(site)}
    <div class="slider-row"><span class="muted">${t('lh.buffer')}</span>
      <input type="range" id="rng-buf" min="1" max="${BUFFER_MAX}" step="1" value="${S.bufKm}">
      <output id="out-buf">${S.bufKm} km</output></div>
    <div class="stat-line">${lhStatsLine()}</div>
    <div class="stat-line"><label class="toggle-line"><input type="checkbox" id="chk-show-comb" ${$('ly-comb').checked ? 'checked' : ''}> ${t('lh.showComb')}</label></div>
    ${lhChartsHTML(w)}`;
  const rng = el.querySelector('#rng-buf');
  if (focused) rng.focus();
  rng.addEventListener('input', () => {
    S.bufKm = +rng.value;
    el.querySelector('#out-buf').textContent = `${S.bufKm} km`;
    clearTimeout(rng._t); rng._t = setTimeout(() => { showBuffer(site); updateBuffer(); }, 60);
  });
  el.querySelector('#chk-show-comb').addEventListener('change', (e) => { setLayer('ly-comb', e.target.checked); S.autoComb = false; });
}

// ── Légendes des fiches (contenu commun aux fenêtres et au rapport PDF) ────
export const mdBold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

export function combGroups() {
  const groups = new Map();
  for (const c of S.core.classes.comb) {
    if (!groups.has(c.grp)) groups.set(c.grp, []);
    groups.get(c.grp).push(c);
  }
  return COMB_ORDER.filter(g => groups.has(g)).map(g => ({ g, label: cGrp(g), items: groups.get(g) }));
}

export function idxVarsHTML(L) {
  return `<ol class="vars-list">${L.idxVars.map(([n, d, p]) => `<li><b>${n}</b> — ${d} <span class="vars-p">P=${p}</span></li>`).join('')}</ol>`;
}

function buildLegends() {
  const L = LEGEND();
  $('idx-tip').innerHTML = `${L.idxConcept}<br><br><b>${L.idxVarsTitle}</b>${idxVarsHTML(L)}${L.idxVarsNote}<br><br>${L.idxScale}`;
  document.querySelectorAll('.fmt-tip').forEach(el => { el.innerHTML = t('fmt.tip'); });
  const row = (hex, txt) => `<div class="leg-row"><div class="leg-swatch" style="background:${hex}"></div><span>${txt}</span></div>`;
  const block = (b, extra = '') => `<div class="leg-block"><div class="leg-sub">${b.h}</div>${b.p.map(p => `<p>${mdBold(p)}</p>`).join('')}${extra}</div>`;
  $('leg-mrc-body').innerHTML = L.mrc.map(b => block(b,
    (b.sw ? `<p>${b.sw.map(([c, l]) => `<span class="sw-inline" style="background:${c}"></span>${l}`).join(' &nbsp; ')}</p>` : '') +
    (b.vars ? `<p><b>${L.idxVarsTitle}</b></p>${idxVarsHTML(L)}<p>${L.idxVarsNote}</p>` : ''))).join('');
  $('leg-lh-body').innerHTML = `
    <div>
      <div class="leg-col-title">${L.lhComb.h}</div>
      <p class="leg-intro">${L.lhComb.p.map(mdBold).join('<br><br>')}<br>
        <a href="https://ressources-naturelles.canada.ca" target="_blank" rel="noopener">${L.links.fbp}</a></p>
      ${combGroups().map(gr => `<div class="leg-group">${gr.label}</div>` + gr.items.map(c => row(c.hex, cAbb(c) === cLbl(c) ? cLbl(c) : `${cAbb(c)} — ${cLbl(c)}`)).join('')).join('')}
    </div>
    <div>
      <div class="leg-col-title">${L.lhPot.h}</div>
      <p class="leg-intro">${L.lhPot.p.map(mdBold).join('<br><br>')}<br>
        <a href="https://www.donneesquebec.ca/recherche/dataset/potentiel-d-intensite-et-de-propagation-des-feux-de-foret" target="_blank" rel="noopener">${L.links.pot}</a></p>
      <div class="leg-group">${L.links.classes}</div>
      ${S.core.classes.pot.map(c => row(c.hex, pLbl(c))).join('')}
      ${L.lhMore.map(b => `<div class="leg-col-title" style="margin-top:16px">${b.h}</div><p class="leg-intro">${b.p.map(mdBold).join('<br>')}</p>`).join('')}
    </div>`;
}

/** Fiche agrandie (fenêtre surgissante) : 'mrc' ou 'lh'. */
let bigKind = null;
function openBig(kind) {
  const body = $('fiche-body');
  bigKind = kind;
  $('modal-fiche').classList.add('open');
  const w = Math.max(600, body.clientWidth - 44);
  $('fiche-legend').dataset.kind = kind;
  if (kind === 'mrc' && S.series) {
    $('fiche-title').textContent = t('big.mrc');
    body.innerHTML = mrcHTML(w, true);
  } else if (kind === 'lh' && S.site && S.buf) {
    $('fiche-title').textContent = t('big.lh');
    body.innerHTML = `${siteHeader(S.site, true)}
      <div class="stat-line"><span>${t('lh.bufferKm', { k: S.bufKm })}</span>${lhStatsLine()}</div>
      ${lhChartsHTML(w, true)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Changement de langue
// ═══════════════════════════════════════════════════════════════════════════
function relabel() {
  S.terrName = terrLabel();
  buildPeriods();
  buildMiniLegends();
  buildLegends();
  buildAutoSeg();
  comboMRC.setItems(mrcItems());
  comboMRC.set(S.unit, false);
  refreshSiteCombo();
  refreshProjLayers();
  projMsg();
  if (S.zone) zoneMsg(); else if (S.unit) selectUnit(S.unit, { fit: false }); else autoMsg();
  renderIndex(); renderMRC(); renderLH();
  setSummary('sum-lh', S.site ? siteLabel(S.site) : '');
  if ($('modal-fiche').classList.contains('open') && bigKind) openBig(bigKind);
  refreshReportDialog();
  const note = $('feux-note');
  if ($('ly-feux').checked) note.textContent = t(S.map.getZoom() < FIRE_MIN_ZOOM ? 'fires.zoom' : 'fires.hover');
}

// ═══════════════════════════════════════════════════════════════════════════
// UI générale
// ═══════════════════════════════════════════════════════════════════════════
/** Zone de dépôt de fichiers (glisser-déposer) + bouton qui ouvre le sélecteur. */
function bindDrop(el, input, btn, onFiles) {
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { onFiles(input.files); input.value = ''; });
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover');
    onFiles(e.dataTransfer.files);
  });
}

function resetAll() {
  if (drawing) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  clearTerritory();
  clearProject();
  setMode('auto');
  S.autoKm = AUTO_DEFAULT; buildAutoSeg();
  S.bufKm = BUFFER_DEFAULT;
  S.autoComb = false;
  resetLayers();
  applyStatic();
  buildLegends();
  autoMsg();
  document.querySelectorAll('#box-mrc, #box-lh').forEach(b => b.classList.add('collapsed'));
  document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
  S.map.stop();
  fitQuebec();
}

function bindUI() {
  // Onglets
  const goTab = (tab) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  };
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) { closeModals(); goTab(g.dataset.goto); }
  });

  // Modals
  const closeModals = () => document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target !== m) return;
    if (m.classList.contains('modal-top')) m.classList.remove('open'); else closeModals();
  }));
  $('btn-info').addEventListener('click', () => $('popup-accueil').classList.add('open'));
  $('btn-reset').addEventListener('click', resetAll);

  // Langue
  document.querySelectorAll('.lang-btn').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
  onLang(relabel);

  // Projet : import (bouton, glisser-déposer sur la section ou sur la carte)
  bindDrop($('sec-proj'), $('file-proj'), $('btn-proj'), importProject);
  const mapEl = $('map');
  mapEl.addEventListener('dragover', (e) => { e.preventDefault(); mapEl.classList.add('dragover'); });
  mapEl.addEventListener('dragleave', (e) => { if (!mapEl.contains(e.relatedTarget)) mapEl.classList.remove('dragover'); });
  mapEl.addEventListener('drop', (e) => { e.preventDefault(); mapEl.classList.remove('dragover'); importProject(e.dataTransfer.files); });
  $('btn-proj-clear').addEventListener('click', clearProject);
  $('btn-proj-clear').disabled = true;
  comboSite = new Combo($('combo-site'), { onSelect: (v) => selectSite(v == null ? null : S.project.sites[v - 1]), empty: () => t('combo.none') });
  refreshSiteCombo();

  // Zone régionale
  document.querySelectorAll('#mode-seg button').forEach(b => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  buildAutoSeg();
  $('auto-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-km]');
    if (!b) return;
    S.autoKm = +b.dataset.km;
    buildAutoSeg();
    applyAutoZone({ fit: true });
  });
  comboMRC = new Combo($('combo-mrc'), { onSelect: (v) => selectUnit(v), empty: () => t('combo.none') });
  comboMRC.setItems(mrcItems());
  $('btn-draw').addEventListener('click', () => { if (!drawing) startDraw(); });
  bindDrop($('sec-file'), $('file-zone'), $('btn-zone-file'), importZone);
  autoMsg();

  // Boîtes repliables et fiches agrandies
  document.querySelectorAll('.box.collapsible .box-toggle').forEach(tg => tg.addEventListener('click', () => {
    const box = tg.closest('.box');
    box.classList.toggle('collapsed');
    if (!box.classList.contains('collapsed')) { if (box.id === 'box-mrc') renderMRC(); else renderLH(); }
  }));
  $('btn-big-mrc').addEventListener('click', () => openBig('mrc'));
  $('btn-big-lh').addEventListener('click', () => openBig('lh'));
  $('btn-big-mrc').disabled = $('btn-big-lh').disabled = true;
  bindChartTips($('fiche-body'));

  // Légendes des fiches
  buildLegends();
  const openLegend = (k) => $(`modal-leg-${k}`).classList.add('open');
  document.querySelectorAll('[data-legend]').forEach(b => b.addEventListener('click', () => openLegend(b.dataset.legend)));
  $('fiche-legend').addEventListener('click', () => openLegend($('fiche-legend').dataset.kind || 'mrc'));
  document.querySelectorAll('[data-close-self]').forEach(b => b.addEventListener('click', () => b.closest('.modal').classList.remove('open')));

  $('chk-log').addEventListener('change', (e) => { S.log = e.target.checked; renderMRC(); });
  $('btn-rapport').addEventListener('click', () => openReportDialog());
  bindChartTips($('tab-explorer'));

  // Re-rendu des graphiques au redimensionnement du panneau
  let lastW = 0;
  new ResizeObserver(() => {
    const w = $('mrc-content').clientWidth;
    if (Math.abs(w - lastW) < 12) return;
    lastW = w;
    clearTimeout(bindUI._t);
    bindUI._t = setTimeout(() => { renderMRC(); renderLH(); }, 120);
  }).observe($('panel'));

  // Redimensionnement du panneau
  const resizer = $('resizer'), panel = $('panel');
  let drag = false, x0 = 0, w0 = 0;
  resizer.addEventListener('mousedown', (e) => { drag = true; x0 = e.clientX; w0 = panel.offsetWidth; resizer.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const w = Math.min(Math.max(w0 + e.clientX - x0, 300), innerWidth * 0.65);
    panel.style.width = `${w}px`; panel.style.maxWidth = 'none'; S.map?.resize();
  });
  document.addEventListener('mouseup', () => { if (!drag) return; drag = false; resizer.classList.remove('dragging'); document.body.style.userSelect = ''; S.map?.resize(); });
}

// ═══════════════════════════════════════════════════════════════════════════
// Démarrage
// ═══════════════════════════════════════════════════════════════════════════
function appState() {
  const m = S.map;
  return {
    projet: S.project ? { nom: S.project.name, entites: S.project.features.length, sites: S.project.sites.length } : null,
    site: S.site?.k || null, zoneTamponKm: S.bufKm,
    territoire: S.unit || (S.zone ? `zone:${S.zone.kind.k}${S.zone.kind.side ? `:${S.zone.kind.side}km` : ''}` : null), mode: S.mode,
    zoom: m ? +m.getZoom().toFixed(2) : null, centre: m ? m.getCenter().toArray().map(v => +v.toFixed(3)) : null,
    couches: ['indice', 'feux', 'pts', 'comb', 'pot'].filter(k => $(`ly-${k}`)?.checked),
    contoursFeuxEnCache: fireCache.feats.size,
  };
}

async function init() {
  applyStatic();
  initErrors(appState);
  try {
    const [core] = await Promise.all([loadCore(), initMap()]);
    watchMap(S.map);
    S.core = core;
    addLayers();
    bindUI();
    renderIndex(); renderMRC(); renderLH();
    $('loading').classList.add('hidden');
    $('popup-accueil').classList.add('open');
    window.__v3 = { S, importProject, selectSite, switchMode };   // tests et diagnostic
  } catch (err) {
    console.error('Erreur init :', err);
    logEvent('démarrage', err.message || err, err.stack);
    $('loading-msg').textContent = t('loading.error');
  }
}
init();
