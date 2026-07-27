import * as THREE from 'three';
import { ROAD_STYLE, WATER_Y } from '../config.js';
import { roadMaterial, structureMaterial, emissiveMaterial } from '../render/materials.js';
import { BoxBatch, rgb } from './boxbatch.js';
import { simplify, polylineLength, clamp, hash01, openRing, bboxOf, pointInRing } from '../core/util.js';

/**
 * Carriageways, footpaths, bridges and jetties.
 *
 * Every way becomes a flat ribbon whose UVs are metric across and along, so the
 * road shader can paint lane markings at the right physical size. Ways tagged
 * bridge are lifted onto a smoothed deck profile with parapets and pylons, and
 * the deck height is stamped into the heightfield so you can actually walk
 * across the river on foot.
 */

/** Bridges are lit in one of three colours after dark. */
const BRIDGE_GLOW = [0xff2f4e, 0xa54bff, 0x2f7bff];

/** Stable seed from a bridge name, so both carriageways get the same colour. */
function nameSeed(name) {
  if (!name) return null;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Per-class render height above the ground, to stop junctions z-fighting. */
const Z_ORDER = {
  motorway: 0.105, trunk: 0.1, primary: 0.095, secondary: 0.09, tertiary: 0.085,
  raceway: 0.08, residential: 0.075, service: 0.07, pedestrian: 0.062,
  cycleway: 0.055, footway: 0.05, steps: 0.045,
};

class RibbonBatch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.w = [];
    this.mark = [];
  }
  get count() { return this.pos.length / 3; }

  tri(a, b, c, n, uvA, uvB, uvC, col, width, mark) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * n[0] + gy * n[1] + gz * n[2] < 0) {
      const t = b; b = c; c = t;
      const tu = uvB; uvB = uvC; uvC = tu;
    }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.uv.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
    for (let i = 0; i < 3; i++) {
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(col[0], col[1], col[2]);
      this.w.push(width);
      this.mark.push(mark);
    }
  }

  quad(a, b, c, d, n, uvA, uvB, uvC, uvD, col, width, mark) {
    this.tri(a, b, c, n, uvA, uvB, uvC, col, width, mark);
    this.tri(a, c, d, n, uvA, uvC, uvD, col, width, mark);
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aW', new THREE.Float32BufferAttribute(this.w, 1));
    g.setAttribute('aMark', new THREE.Float32BufferAttribute(this.mark, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Per-vertex left/right offsets from a centreline, using averaged normals. */
function offsets(pts, halfWidth) {
  const n = pts.length / 2;
  const left = new Float64Array(n * 2);
  const right = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const ip = Math.max(i - 1, 0);
    const inx = Math.min(i + 1, n - 1);
    let dx = pts[inx * 2] - pts[ip * 2];
    let dz = pts[inx * 2 + 1] - pts[ip * 2 + 1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    const nx = dz, nz = -dx;
    left[i * 2] = pts[i * 2] + nx * halfWidth;
    left[i * 2 + 1] = pts[i * 2 + 1] + nz * halfWidth;
    right[i * 2] = pts[i * 2] - nx * halfWidth;
    right[i * 2 + 1] = pts[i * 2 + 1] - nz * halfWidth;
  }
  return { left, right };
}

const UP = [0, 1, 0];

function addRibbon(batch, pts, ys, width, col, mark, skirt) {
  const n = pts.length / 2;
  if (n < 2) return;
  const { left, right } = offsets(pts, width / 2);
  let v = 0;
  for (let i = 0; i < n - 1; i++) {
    const segLen = Math.hypot(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
    const A = [left[i * 2], ys[i], left[i * 2 + 1]];
    const B = [right[i * 2], ys[i], right[i * 2 + 1]];
    const C = [right[(i + 1) * 2], ys[i + 1], right[(i + 1) * 2 + 1]];
    const D = [left[(i + 1) * 2], ys[i + 1], left[(i + 1) * 2 + 1]];
    batch.quad(A, B, C, D, UP, [0, v], [1, v], [1, v + segLen], [0, v + segLen], col, width, mark);

    if (skirt > 0) {
      const A2 = [A[0], ys[i] - skirt, A[2]];
      const B2 = [B[0], ys[i] - skirt, B[2]];
      const C2 = [C[0], ys[i + 1] - skirt, C[2]];
      const D2 = [D[0], ys[i + 1] - skirt, D[2]];
      // Deck edges: normals point away from the centreline.
      let ex = A[0] - B[0], ez = A[2] - B[2];
      const eL = Math.hypot(ex, ez) || 1;
      ex /= eL; ez /= eL;
      batch.quad(A, D, D2, A2, [ex, 0, ez], [0, v], [0, v], [0, v], [0, v], col, width, 0);
      batch.quad(B, C, C2, B2, [-ex, 0, -ez], [0, v], [0, v], [0, v], [0, v], col, width, 0);
      batch.quad(A2, B2, C2, D2, [0, -1, 0], [0, v], [1, v], [1, v], [0, v], col, width, 0);
    }
    v += segLen;
  }
}

/** Smooth a height array in place, pinning the endpoints. */
function smoothHeights(ys, passes) {
  const n = ys.length;
  if (n < 3) return;
  for (let p = 0; p < passes; p++) {
    const prev = ys.slice();
    for (let i = 1; i < n - 1; i++) ys[i] = (prev[i - 1] + prev[i] * 2 + prev[i + 1]) / 4;
  }
}

export function buildRoads(city, hf, uniforms, quality) {
  const road = new RibbonBatch();
  const structure = new BoxBatch();
  const bridgeGlow = new BoxBatch();
  const lamps = [];
  const carPaths = [];
  const bridgeDecks = [];   // handed to the landmark builder (Helix Bridge)

  const CONCRETE = rgb(0x8f8d88);
  const RAIL_BALLAST = rgb(0x4a4642);
  const WOOD = rgb(0x6d5744);

  // ---------------------------------------------------------------- roads ----
  for (let ri = 0; ri < city.roads.length; ri++) {
    const r = city.roads[ri];
    if (r.t) continue;                                   // tunnels are unseen
    const style = ROAD_STYLE[r.c] ?? ROAD_STYLE.service;
    let pts = simplify(r.p, 1.2);
    const n = pts.length / 2;
    if (n < 2) continue;
    const total = polylineLength(pts);
    if (total < 1.5) continue;

    const zo = Z_ORDER[r.c] ?? 0.07;
    const ys = new Array(n);
    const isBridge = !!r.b;
    let waterVerts = 0;

    if (!isBridge) {
      for (let i = 0; i < n; i++) ys[i] = hf.at(pts[i * 2], pts[i * 2 + 1]) + zo;
    } else {
      // Deck profile: a straight line between the two abutments, pushed up
      // wherever it would otherwise clip the ground or the water.
      const y0 = hf.at(pts[0], pts[1]) + 0.5;
      const y1 = hf.at(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]) + 0.5;
      const layer = Math.max(r.l ?? 0, 0);
      let run = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) run += Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
        const t = total > 0 ? run / total : 0;
        const x = pts[i * 2], z = pts[i * 2 + 1];
        const g = hf.at(x, z);
        let y = y0 + (y1 - y0) * t;
        y = Math.max(y, g + 0.55);
        const land = hf.landAt(x, z);
        if (land < 0.4) y = Math.max(y, WATER_Y + 5.2);   // clear the boats
        // Counted with a stricter threshold than the clearance test above: the
        // shoreline mask is blurred, so 0.4 also catches viaducts merely
        // running along the quay.
        if (land < 0.22) waterVerts++;
        if (layer >= 1) y = Math.max(y, g + 5.4 * layer);
        ys[i] = y;
      }
      smoothHeights(ys, 4);
      for (let i = 0; i < n; i++) ys[i] += zo * 0.4;
    }

    addRibbon(road, pts, ys, r.w, rgb(style.color), style.lane, isBridge ? 0.85 : 0);

    // ---- bridge structure and walkable deck
    if (isBridge) {
      const { left, right } = offsets(pts, r.w / 2);
      /*
       * Each crossing is lit in one colour along its whole length, so a bridge
       * reads as a single object at night. The colour is keyed off the name so
       * both carriageways of a divided bridge match.
       *
       * Only spans over water are lit. `bridge` in OSM covers every road-over-
       * road flyover too, and the Marina Coastal interchange alone has dozens;
       * lighting those buries the skyline in neon lines. Restricting to water
       * crossings gives exactly the bridges you would expect to be lit — the
       * Helix, Jubilee, Esplanade, Anderson, Cavenagh, Elgin and the rest of
       * the Singapore River crossings.
       */
      const lit = waterVerts >= 3 && waterVerts / n >= 0.3;
      const glowColour = BRIDGE_GLOW[
        Math.floor(hash01(nameSeed(r.n) ?? ri * 2654435761) * BRIDGE_GLOW.length) % BRIDGE_GLOW.length
      ];
      for (let i = 0; i < n - 1; i++) {
        // Parapets down both edges.
        structure.wall(left[i * 2], left[i * 2 + 1], left[(i + 1) * 2], left[(i + 1) * 2 + 1],
          ys[i], ys[i] + 1.05, 0.28, 0x9d9a94);
        structure.wall(right[i * 2], right[i * 2 + 1], right[(i + 1) * 2], right[(i + 1) * 2 + 1],
          ys[i], ys[i] + 1.05, 0.28, 0x9d9a94);
        if (!lit) continue;
        // Lit capping along the top of each parapet.
        bridgeGlow.wall(left[i * 2], left[i * 2 + 1], left[(i + 1) * 2], left[(i + 1) * 2 + 1],
          ys[i] + 1.05, ys[i] + 1.24, 0.32, glowColour);
        bridgeGlow.wall(right[i * 2], right[i * 2 + 1], right[(i + 1) * 2], right[(i + 1) * 2 + 1],
          ys[i] + 1.05, ys[i] + 1.24, 0.32, glowColour);
        // A recessed strip under the deck edge, which is what throws the colour
        // down onto the water. Only worth it where there is water to catch it.
        if (lit) {
          bridgeGlow.wall(left[i * 2], left[i * 2 + 1], left[(i + 1) * 2], left[(i + 1) * 2 + 1],
            ys[i] - 1.05, ys[i] - 0.86, 0.28, glowColour);
          bridgeGlow.wall(right[i * 2], right[i * 2 + 1], right[(i + 1) * 2], right[(i + 1) * 2 + 1],
            ys[i] - 1.05, ys[i] - 0.86, 0.28, glowColour);
        }
      }
      // Pylons roughly every 30 m where the deck stands clear of the ground.
      let acc = 0;
      for (let i = 0; i < n - 1; i++) {
        const segLen = Math.hypot(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
        acc += segLen;
        if (acc < 30) continue;
        acc = 0;
        const x = pts[i * 2], z = pts[i * 2 + 1];
        const g = hf.at(x, z);
        if (ys[i] - g < 3.2) continue;
        const s = clamp(r.w * 0.22, 1.1, 3.2);
        structure.box(x, g - 1.2, z, s, s, ys[i] - 0.9, 0, 0x8e8b85);
      }
      // Stamp the deck so walk mode can cross it.
      stampDeck(hf, pts, ys, r.w);
      if (r.n) bridgeDecks.push({ name: r.n, pts, ys, w: r.w, len: total });
    }

    // ---- street lighting
    if (style.lamp && r.w >= 5.5) {
      const step = quality.lampStep;
      let acc = step * hash01(ri * 13);
      const { left, right } = offsets(pts, r.w / 2 + 0.85);
      let side = 0;
      for (let i = 0; i < n - 1; i++) {
        const segLen = Math.hypot(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
        acc += segLen;
        if (acc < step) continue;
        acc = 0;
        const src = side++ % 2 ? left : right;
        lamps.push({ x: src[i * 2], y: ys[i], z: src[i * 2 + 1], ped: r.c === 'pedestrian' || r.c === 'footway' });
      }
    }

    // ---- traffic routes
    if (style.lane && r.w >= 8 && total > 45) {
      carPaths.push({ pts, ys, w: r.w, oneway: !!r.o, len: total });
    }
  }

  // ----------------------------------------------------------------- rail ----
  for (const r of city.rail) {
    if (r.t) continue;
    const pts = simplify(r.p, 1.5);
    const n = pts.length / 2;
    if (n < 2) continue;
    const ys = new Array(n);
    const isBridge = !!r.b;
    for (let i = 0; i < n; i++) {
      const g = hf.at(pts[i * 2], pts[i * 2 + 1]);
      ys[i] = isBridge ? Math.max(g + 6.5, WATER_Y + 6.5) : g + 0.35;
    }
    if (isBridge) smoothHeights(ys, 3);
    addRibbon(road, pts, ys, 4.2, RAIL_BALLAST, 0, isBridge ? 1.0 : 0);
    if (isBridge) stampDeck(hf, pts, ys, 4.2);
  }

  // ---------------------------------------------------- piers and jetties ----
  for (const p of city.piers) {
    const pts = simplify(p.p, 1.5);
    const n = pts.length / 2;
    if (n < 2) continue;

    // Piers mapped as areas are filled decks, not centrelines — ribboning them
    // produces a floating slab across the middle of the pier instead.
    if (p.closed && n >= 4) {
      const ring = openRing(pts);
      const y = Math.max(hf.minUnder(ring) + 0.4, WATER_Y + 1.4);
      addPolygonSurface(road, ring, y, WOOD, 0.9, structure);
      stampDeckRing(hf, ring, y);
      continue;
    }
    const ys = new Array(n).fill(0).map((_, i) =>
      Math.max(hf.at(pts[i * 2], pts[i * 2 + 1]) + 0.3, WATER_Y + 1.5));
    smoothHeights(ys, 2);
    addRibbon(road, pts, ys, 4.5, WOOD, 0, 0.35);
    stampDeck(hf, pts, ys, 4.5);
    // Piles.
    for (let i = 0; i < n; i += 3) {
      const g = hf.at(pts[i * 2], pts[i * 2 + 1]);
      if (ys[i] - g < 1.2) continue;
      structure.box(pts[i * 2], g - 0.8, pts[i * 2 + 1], 0.42, 0.42, ys[i] - 0.35, 0, 0x54443a);
    }
  }

  // --------------------------------------------------------------- meshes ----
  const group = new THREE.Group();
  group.name = 'roads';
  const materials = [];

  const rmat = roadMaterial(uniforms);
  materials.push(rmat);
  const rmesh = new THREE.Mesh(road.toGeometry(), rmat);
  rmesh.name = 'road-surfaces';
  rmesh.receiveShadow = true;
  rmesh.matrixAutoUpdate = false;
  group.add(rmesh);

  if (bridgeGlow.count) {
    const gmat = emissiveMaterial(uniforms, 0xffffff, {
      strength: 2.6, dayVisible: 0.32, vertexColors: true,
    });
    materials.push(gmat);
    const gmesh = new THREE.Mesh(bridgeGlow.toGeometry(), gmat);
    gmesh.name = 'bridge-lighting';
    gmesh.matrixAutoUpdate = false;
    group.add(gmesh);
  }

  if (structure.count) {
    const smat = structureMaterial(uniforms);
    materials.push(smat);
    const smesh = new THREE.Mesh(structure.toGeometry(), smat);
    smesh.name = 'road-structure';
    smesh.castShadow = true;
    smesh.receiveShadow = true;
    smesh.matrixAutoUpdate = false;
    group.add(smesh);
  }

  return { group, materials, lamps, carPaths, bridgeDecks };
}

/** Filled horizontal deck over a closed ring, with a skirt down to the water. */
function addPolygonSurface(batch, ring, y, col, skirt, structure) {
  const pts = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(pts, []);
  } catch {
    return;
  }
  for (const f of faces) {
    const a = pts[f[0]], b = pts[f[1]], c = pts[f[2]];
    if (!a || !b || !c) continue;
    batch.tri(
      [a.x, y, a.y], [b.x, y, b.y], [c.x, y, c.y], UP,
      [0.5, a.x], [0.5, b.x], [0.5, c.x], col, 6, 0
    );
  }
  if (skirt > 0 && structure) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      structure.wall(ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1],
        y - skirt, y, 0.3, 0x5b4a3d);
    }
  }
}

/** Deck stamp for a filled pier: rasterise its bounding box, testing the ring. */
function stampDeckRing(hf, ring, y) {
  const [x0, z0, x1, z1] = bboxOf(ring);
  for (let z = z0; z <= z1; z += 2) {
    for (let x = x0; x <= x1; x += 2) {
      if (pointInRing(x, z, ring)) hf.stampDeck(x, z, y);
    }
  }
}

/** Write a ribbon's surface height into the walkable deck grid. */
function stampDeck(hf, pts, ys, width) {
  const { left, right } = offsets(pts, width / 2 - 0.3);
  const n = pts.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const steps = Math.max(2, Math.ceil(
      Math.hypot(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]) / 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const y = ys[i] + (ys[i + 1] - ys[i]) * t;
      const lx = left[i * 2] + (left[(i + 1) * 2] - left[i * 2]) * t;
      const lz = left[i * 2 + 1] + (left[(i + 1) * 2 + 1] - left[i * 2 + 1]) * t;
      const rx = right[i * 2] + (right[(i + 1) * 2] - right[i * 2]) * t;
      const rz = right[i * 2 + 1] + (right[(i + 1) * 2 + 1] - right[i * 2 + 1]) * t;
      const across = Math.max(2, Math.ceil(width / 2));
      for (let k = 0; k <= across; k++) {
        const u = k / across;
        hf.stampDeck(lx + (rx - lx) * u, lz + (rz - lz) * u, y);
      }
    }
  }
}
