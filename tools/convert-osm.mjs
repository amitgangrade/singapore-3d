/**
 * Convert a raw Overpass JSON extract into the compact city model the viewer loads.
 *
 * Usage: node tools/convert-osm.mjs <osm_raw.json> <out/city.json>
 *
 * Everything is projected to a local east/north metre grid centred on the Merlion,
 * then emitted in three.js axes: x = east, z = -north, y = up.
 */
import fs from 'node:fs';

const CENTER = { lat: 1.28684, lon: 103.85459 }; // Merlion
const HALF = 1000; // metres -> 2 km x 2 km = 4 km^2
const R = 6378137;
const MPD_LAT = (Math.PI / 180) * R;
const MPD_LON = MPD_LAT * Math.cos((CENTER.lat * Math.PI) / 180);

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node convert-osm.mjs <osm_raw.json> <city.json>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const elements = raw.elements;
const byId = { node: new Map(), way: new Map(), relation: new Map() };
for (const e of elements) byId[e.type].set(e.id, e);

const r1 = (n) => Math.round(n * 10) / 10;
const project = (lat, lon) => [(lon - CENTER.lon) * MPD_LON, -(lat - CENTER.lat) * MPD_LAT];

/** Way/relation-member geometry -> flat [x,z,x,z,...] in metres. */
function toXZ(geometry) {
  const out = [];
  for (const g of geometry) {
    if (!g) continue; // Overpass marks gaps in partial geometry as null
    const [x, z] = project(g.lat, g.lon);
    out.push(r1(x), r1(z));
  }
  return out;
}

const dist2 = (ax, az, bx, bz) => (ax - bx) ** 2 + (az - bz) ** 2;

/** Is any vertex inside the 2 km box (padded, so straddling geometry survives)? */
function intersectsBox(flat, pad = 250) {
  const lim = HALF + pad;
  for (let i = 0; i < flat.length; i += 2) {
    if (Math.abs(flat[i]) <= lim && Math.abs(flat[i + 1]) <= lim) return true;
  }
  return false;
}

/** Shoelace area (signed) of a flat ring. */
function ringArea(flat) {
  let a = 0;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
  }
  return a / 2;
}

function closeRing(flat) {
  const n = flat.length;
  if (n >= 6 && (flat[0] !== flat[n - 2] || flat[1] !== flat[n - 1])) flat.push(flat[0], flat[1]);
  return flat;
}

/**
 * Stitch unordered way fragments into closed rings by matching endpoints.
 * Overpass gives each multipolygon member its own geometry, in arbitrary
 * direction and order, so a naive concat produces garbage.
 */
function stitchRings(segments, tol = 1.0) {
  const open = segments.filter((s) => s.length >= 4).map((s) => s.slice());
  const rings = [];
  const t2 = tol * tol;
  while (open.length) {
    let cur = open.pop();
    let joined = true;
    while (joined) {
      joined = false;
      const ex = cur[cur.length - 2];
      const ez = cur[cur.length - 1];
      if (dist2(cur[0], cur[1], ex, ez) <= t2) break; // already closed
      for (let i = 0; i < open.length; i++) {
        const s = open[i];
        const sx = s[0];
        const sz = s[1];
        const tx = s[s.length - 2];
        const tz = s[s.length - 1];
        if (dist2(ex, ez, sx, sz) <= t2) {
          cur = cur.concat(s.slice(2));
        } else if (dist2(ex, ez, tx, tz) <= t2) {
          const rev = [];
          for (let k = s.length - 2; k >= 0; k -= 2) rev.push(s[k], s[k + 1]);
          cur = cur.concat(rev.slice(2));
        } else continue;
        open.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (cur.length >= 8) rings.push(closeRing(cur));
  }
  return rings;
}

/** Relation -> {outer:[ring], inner:[ring]}, closed & stitched. */
function relationRings(rel) {
  const outerSegs = [];
  const innerSegs = [];
  for (const m of rel.members || []) {
    if (m.type !== 'way' || !m.geometry) continue;
    const flat = toXZ(m.geometry);
    if (flat.length < 4) continue;
    (m.role === 'inner' ? innerSegs : outerSegs).push(flat);
  }
  return { outer: stitchRings(outerSegs), inner: stitchRings(innerSegs) };
}

// ---------------------------------------------------------------- heights ----

const LEVEL_H = 3.4;

function parseLen(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const feet = /^([\d.]+)\s*(ft|')$/i.exec(s);
  if (feet) return parseFloat(feet[1]) * 0.3048;
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_H = {
  roof: 4.5, kiosk: 3.5, toilets: 3.5, shophouse: 11, retail: 12, church: 18,
  temple: 14, mosque: 16, house: 8, residential: 16, apartments: 30,
  commercial: 34, office: 42, hotel: 40, train_station: 14, university: 22,
  public: 18, government: 24, parking: 14, school: 14, construction: 20,
  bridge: 6, yes: 16,
};

function buildingHeight(t) {
  const explicit = parseLen(t.height) ?? parseLen(t['building:height']);
  if (explicit && explicit > 0.5) return explicit;
  const lv = parseFloat(t['building:levels']);
  if (Number.isFinite(lv) && lv > 0) {
    const roof = parseLen(t['roof:height']) || 0;
    return lv * LEVEL_H + roof;
  }
  const kind = (t.building || t['building:part'] || 'yes').split(';')[0];
  return DEFAULT_H[kind] ?? DEFAULT_H.yes;
}

function minHeight(t) {
  const m = parseLen(t.min_height) ?? parseLen(t['building:min_height']);
  if (m) return m;
  const ml = parseFloat(t['building:min_level']);
  if (Number.isFinite(ml) && ml > 0) return ml * LEVEL_H;
  return 0;
}

function normColour(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  const named = {
    white: '#e8e6e1', grey: '#8d8d8d', gray: '#8d8d8d', black: '#2b2b2b',
    red: '#9c4a3c', brown: '#7a5a44', beige: '#d8c8ac', cream: '#e0d6bd',
    yellow: '#d8c070', green: '#5d7a5a', blue: '#5a6f88', sandstone: '#d2c0a0',
    silver: '#b9bcc0', tan: '#c8ae87', darkgrey: '#5c5c5c', lightgrey: '#c2c2c2',
  };
  return named[s.replace(/[\s_]/g, '')] ?? null;
}

const MATERIAL = {
  glass: 'glass', mirror: 'glass', metal: 'metal', steel: 'metal',
  concrete: 'concrete', cement: 'concrete', brick: 'brick', stone: 'stone',
  sandstone: 'stone', plaster: 'plaster', wood: 'wood',
};

/** Guess a facade family when OSM does not say, so the skyline is not uniform. */
function facade(t, h) {
  const m = MATERIAL[(t['building:material'] || '').toLowerCase()];
  if (m) return m;
  const kind = (t.building || t['building:part'] || 'yes').split(';')[0];
  if (h >= 70) return 'glass';
  if (kind === 'office' || kind === 'commercial' || kind === 'hotel') return h >= 40 ? 'glass' : 'concrete';
  if (kind === 'shophouse' || kind === 'retail') return 'plaster';
  if (kind === 'church' || kind === 'temple' || kind === 'mosque') return 'stone';
  if (h >= 40) return 'glass';
  return 'concrete';
}

const ROOF_SHAPES = new Set(['flat', 'gabled', 'hipped', 'pyramidal', 'dome', 'skillion', 'round', 'onion']);

// ------------------------------------------------------------------ roads ----

const ROAD = {
  motorway:      { w: 16, cls: 'motorway' },
  motorway_link: { w: 8,  cls: 'motorway' },
  trunk:         { w: 15, cls: 'trunk' },
  trunk_link:    { w: 7.5, cls: 'trunk' },
  primary:       { w: 13, cls: 'primary' },
  primary_link:  { w: 7,  cls: 'primary' },
  secondary:     { w: 11, cls: 'secondary' },
  secondary_link:{ w: 6.5, cls: 'secondary' },
  tertiary:      { w: 9,  cls: 'tertiary' },
  tertiary_link: { w: 6,  cls: 'tertiary' },
  residential:   { w: 7.5, cls: 'residential' },
  unclassified:  { w: 7,  cls: 'residential' },
  living_street: { w: 6.5, cls: 'residential' },
  road:          { w: 7,  cls: 'residential' },
  service:       { w: 4.5, cls: 'service' },
  pedestrian:    { w: 6,  cls: 'pedestrian' },
  footway:       { w: 2.4, cls: 'footway' },
  path:          { w: 2,  cls: 'footway' },
  steps:         { w: 2,  cls: 'steps' },
  cycleway:      { w: 2.6, cls: 'cycleway' },
  raceway:       { w: 12, cls: 'raceway' },
};

// ------------------------------------------------------------------ green ----

const GREEN = {
  park: 'park', garden: 'garden', pitch: 'pitch', playground: 'pitch',
  grass: 'grass', meadow: 'grass', forest: 'forest', flowerbed: 'garden',
  greenfield: 'grass', recreation_ground: 'grass', golf_course: 'grass',
};

// ------------------------------------------------------------------- POIs ----

const POI_KINDS = new Map([
  ['tourism=hotel', 'hotel'], ['tourism=hostel', 'hotel'], ['tourism=apartment', 'hotel'],
  ['tourism=museum', 'museum'], ['tourism=gallery', 'museum'],
  ['tourism=attraction', 'attraction'], ['tourism=viewpoint', 'viewpoint'],
  ['tourism=theme_park', 'attraction'], ['tourism=artwork', 'artwork'],
  ['office=*', 'office'], ['historic=*', 'historic'],
  ['amenity=place_of_worship', 'worship'], ['amenity=restaurant', 'food'],
  ['amenity=cafe', 'food'], ['amenity=bar', 'food'], ['amenity=pub', 'food'],
  ['amenity=fast_food', 'food'], ['amenity=theatre', 'culture'],
  ['amenity=arts_centre', 'culture'], ['amenity=university', 'edu'],
  ['amenity=college', 'edu'], ['amenity=hospital', 'civic'],
  ['amenity=police', 'civic'], ['amenity=fire_station', 'civic'],
  ['amenity=ferry_terminal', 'transport'], ['amenity=bus_station', 'transport'],
]);

function poiKind(t) {
  for (const key of ['tourism', 'historic', 'office', 'amenity']) {
    const v = t[key];
    if (!v) continue;
    const hit = POI_KINDS.get(`${key}=${v}`) ?? POI_KINDS.get(`${key}=*`);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------- conversion ----

const out = {
  meta: {
    center: [CENTER.lat, CENTER.lon],
    centerName: 'Merlion, Singapore',
    extentMetres: HALF * 2,
    metresPerDegLat: MPD_LAT,
    metresPerDegLon: MPD_LON,
    source: 'OpenStreetMap contributors, ODbL 1.0',
    osmTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
  },
  buildings: [], parts: [], roads: [], rail: [], water: [], waterways: [],
  green: [], plazas: [], piers: [], trees: [], pois: [],
};

// Way ids consumed as relation members, so we do not emit them twice.
const consumedWays = new Set();
for (const rel of elements) {
  if (rel.type !== 'relation') continue;
  for (const m of rel.members || []) if (m.type === 'way') consumedWays.add(m.ref);
}

function pushBuilding(target, flat, t, isPart) {
  const ring = closeRing(flat);
  if (ring.length < 8) return;
  if (!intersectsBox(ring)) return;
  const h = buildingHeight(t);
  if (!(h > 0.5)) return; // parent shells of part-modelled complexes carry height=0
  const area = Math.abs(ringArea(ring));
  if (area < 12) return;
  const b = { p: ring, h: r1(h), f: facade(t, h) };
  const mh = minHeight(t);
  if (mh > 0.5) b.min = r1(mh);
  const name = t.name || t['name:en'];
  if (name) b.n = name;
  const kind = (t.building || t['building:part'] || 'yes').split(';')[0];
  if (kind !== 'yes') b.k = kind;
  const col = normColour(t['building:colour'] || t['building:color']);
  if (col) b.c = col;
  const roof = (t['roof:shape'] || '').toLowerCase();
  if (ROOF_SHAPES.has(roof) && roof !== 'flat') {
    b.rs = roof;
    const rh = parseLen(t['roof:height']);
    if (rh) b.rh = r1(rh);
  }
  const rcol = normColour(t['roof:colour'] || t['roof:color']);
  if (rcol) b.rc = rcol;
  if (t.layer) b.layer = parseInt(t.layer, 10) || 0;
  b.a = Math.round(area);
  target.push(b);
}

function pushWater(rings, inner, name) {
  const outer = rings.filter((r) => intersectsBox(r) && Math.abs(ringArea(r)) > 30);
  if (!outer.length) return;
  const w = { rings: outer.map(closeRing) };
  const holes = (inner || []).filter((r) => Math.abs(ringArea(r)) > 30);
  if (holes.length) w.holes = holes.map(closeRing);
  if (name) w.n = name;
  out.water.push(w);
}

function pushGreen(rings, kind, name, inner) {
  for (const ring of rings) {
    const closed = closeRing(ring);
    if (closed.length < 8 || !intersectsBox(closed)) continue;
    if (Math.abs(ringArea(closed)) < 25) continue;
    const g = { p: closed, k: kind };
    if (name) g.n = name;
    if (inner && inner.length) g.holes = inner.map(closeRing);
    out.green.push(g);
  }
}

for (const e of elements) {
  const t = e.tags;
  if (!t) continue;

  // ---- nodes: trees and POIs
  if (e.type === 'node') {
    const [x, z] = project(e.lat, e.lon);
    if (Math.abs(x) > HALF || Math.abs(z) > HALF) continue;
    if (t.natural === 'tree') {
      const spread = parseLen(t['diameter_crown']) || 0;
      const th = parseLen(t.height) || 0;
      out.trees.push(r1(x), r1(z), Math.round(th * 10) / 10, Math.round(spread));
      continue;
    }
    const kind = poiKind(t);
    if (!kind) continue;
    const name = t.name || t['name:en'];
    if (!name && kind !== 'artwork') continue;
    const poi = { x: r1(x), z: r1(z), k: kind };
    if (name) poi.n = name;
    if (t.height) poi.h = r1(parseLen(t.height) || 0);
    out.pois.push(poi);
    continue;
  }

  // ---- relations: multipolygon buildings, water, parks
  if (e.type === 'relation') {
    const { outer, inner } = relationRings(e);
    if (!outer.length) continue;
    if (t.building || t.type === 'building') {
      for (const ring of outer) pushBuilding(out.buildings, ring, t, false);
    } else if (t['building:part']) {
      for (const ring of outer) pushBuilding(out.parts, ring, t, true);
    } else if (t.natural === 'water' || t.water || t.waterway) {
      pushWater(outer, inner, t.name || t['name:en']);
    } else if (GREEN[t.leisure] || GREEN[t.landuse]) {
      pushGreen(outer, GREEN[t.leisure] || GREEN[t.landuse], t.name || t['name:en'], inner);
    } else if (t.leisure === 'swimming_pool') {
      pushWater(outer, inner, null);
    }
    continue;
  }

  // ---- ways
  if (e.type !== 'way' || !e.geometry) continue;
  const flat = toXZ(e.geometry);
  if (flat.length < 4) continue;
  const isMember = consumedWays.has(e.id);

  if (t.building) {
    if (!isMember || t.building) pushBuilding(out.buildings, flat, t, false);
    continue;
  }
  if (t['building:part']) {
    pushBuilding(out.parts, flat, t, true);
    continue;
  }

  if (t.highway && ROAD[t.highway]) {
    if (t.area === 'yes') continue;
    if (!intersectsBox(flat)) continue;
    const spec = ROAD[t.highway];
    const lanes = parseFloat(t.lanes);
    let w = spec.w;
    if (Number.isFinite(lanes) && lanes > 0 && spec.cls !== 'footway') {
      w = Math.max(spec.w * 0.6, lanes * (spec.cls === 'service' ? 3.0 : 3.4));
    }
    const wd = parseLen(t.width);
    if (wd && wd > 1 && wd < 40) w = wd;
    const road = { p: flat, w: r1(w), c: spec.cls };
    const layer = parseInt(t.layer, 10) || 0;
    if (t.bridge && t.bridge !== 'no') road.b = 1;
    if (t.tunnel && t.tunnel !== 'no') road.t = 1;
    if (layer) road.l = layer;
    if (t.oneway === 'yes') road.o = 1;
    const name = t.name || t['name:en'];
    if (name) road.n = name;
    out.roads.push(road);
    continue;
  }

  if (t.railway) {
    if (!['rail', 'light_rail', 'subway', 'monorail', 'tram', 'narrow_gauge', 'funicular'].includes(t.railway)) continue;
    if (!intersectsBox(flat)) continue;
    const r = { p: flat, k: t.railway };
    const layer = parseInt(t.layer, 10) || 0;
    if (t.bridge && t.bridge !== 'no') r.b = 1;
    if (t.tunnel && t.tunnel !== 'no') r.t = 1;
    if (layer) r.l = layer;
    const name = t.name || t['name:en'];
    if (name) r.n = name;
    out.rail.push(r);
    continue;
  }

  if (t.natural === 'water' || t.water || t.leisure === 'swimming_pool') {
    if (isMember) continue; // handled by its relation
    pushWater([flat], null, t.name || t['name:en']);
    continue;
  }

  if (t.waterway) {
    if (['river', 'canal', 'stream'].includes(t.waterway)) {
      if (t.tunnel) continue; // Stamford Canal runs in a culvert
      if (!intersectsBox(flat)) continue;
      const w = parseLen(t.width) || (t.waterway === 'river' ? 40 : 12);
      out.waterways.push({ p: flat, w: r1(w), n: t.name || t['name:en'] || undefined });
    }
    continue;
  }

  if (GREEN[t.leisure] || GREEN[t.landuse]) {
    if (isMember) continue;
    pushGreen([flat], GREEN[t.leisure] || GREEN[t.landuse], t.name || t['name:en'], null);
    continue;
  }

  if (t.highway === 'pedestrian' && t.area === 'yes') {
    const closed = closeRing(flat);
    if (intersectsBox(closed)) out.plazas.push({ p: closed });
    continue;
  }

  if (t.man_made === 'pier' || t.man_made === 'bridge') {
    if (!intersectsBox(flat)) continue;
    out.piers.push({ p: flat, k: t.man_made, closed: t.area === 'yes' ? 1 : 0 });
    continue;
  }
}

// ---- building:part reconciliation -------------------------------------------
// Where a complex is modelled in detail (Marina Bay Sands, MBFC, Raffles Place),
// OSM carries both a parent outline and finer building:part volumes. Rendering
// both gives z-fighting and wrong silhouettes, so flag any parent that contains
// a part centroid; the viewer then draws the parts and skips the shell.
function centroid(f) {
  let x = 0, z = 0, n = f.length / 2;
  for (let i = 0; i < n; i++) { x += f[i * 2]; z += f[i * 2 + 1]; }
  return [x / n, z / n];
}
function bbox(f) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < f.length; i += 2) {
    if (f[i] < x0) x0 = f[i];
    if (f[i] > x1) x1 = f[i];
    if (f[i + 1] < z0) z0 = f[i + 1];
    if (f[i + 1] > z1) z1 = f[i + 1];
  }
  return [x0, z0, x1, z1];
}
function pointInRing(px, pz, f) {
  let inside = false;
  for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) {
    const xi = f[i * 2], zi = f[i * 2 + 1], xj = f[j * 2], zj = f[j * 2 + 1];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const bboxes = out.buildings.map((b) => bbox(b.p));
for (const part of out.parts) {
  const [cx, cz] = centroid(part.p);
  for (let i = 0; i < out.buildings.length; i++) {
    const [x0, z0, x1, z1] = bboxes[i];
    if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
    if (!pointInRing(cx, cz, out.buildings[i].p)) continue;
    const parent = out.buildings[i];
    parent.shell = 1;
    // Inherit the parent's name so labels survive on the detailed volumes.
    if (!part.n && parent.n && part.h >= parent.h * 0.8) part.n = parent.n;
  }
}
out.meta.shellCount = out.buildings.filter((b) => b.shell).length;

// Landmark labels for the HUD compass / POI overlay.
const NAMED_TALL = out.buildings
  .filter((b) => !b.shell)
  .concat(out.parts)
  .filter((b) => b.n && b.h >= 60)
  .sort((a, b) => b.h - a.h)
  .slice(0, 60)
  .map((b) => b.n);
out.meta.tallest = NAMED_TALL;

const stats = {
  buildings: out.buildings.length,
  buildingParts: out.parts.length,
  roads: out.roads.length,
  rail: out.rail.length,
  waterPolys: out.water.length,
  waterways: out.waterways.length,
  green: out.green.length,
  plazas: out.plazas.length,
  piers: out.piers.length,
  trees: out.trees.length / 4,
  pois: out.pois.length,
  bridges: out.roads.filter((r) => r.b).length,
};
out.meta.stats = stats;

fs.mkdirSync(outPath.replace(/[^/\\]+$/, ''), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
const mb = (fs.statSync(outPath).size / 1048576).toFixed(2);
console.log(stats);
console.log(`wrote ${outPath} (${mb} MB)`);
