import * as THREE from 'three';
import { FLOOR_H, WINDOW_W, FACADES } from '../config.js';
import { buildingMaterial } from '../render/materials.js';
import {
  hash01, openRing, signedArea, reverseRing, bboxOf, centroidOf, clamp,
} from '../core/util.js';

/**
 * Extrudes OSM footprints into massed volumes.
 *
 * Geometry is built by hand rather than with ExtrudeGeometry because the facade
 * UVs have to be metric: u counts window modules around the perimeter and v
 * counts storeys upward, which is what lets the shader put a plausible lit
 * window grid on every building at night.
 *
 * Buildings are batched into one non-indexed mesh per facade family, so the
 * whole city is a handful of draw calls.
 */

const RIDGE_ROOFS = new Set(['gabled', 'hipped', 'skillion']);
const POINTY_ROOFS = new Set(['pyramidal', 'dome', 'round', 'onion']);

class Batch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.id = [];
    this.roof = [];
    this.tint = [];
  }
  get count() { return this.pos.length / 3; }

  tri(a, b, c, n, uvA, uvB, uvC, id, roof, tint) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
    for (let i = 0; i < 3; i++) {
      this.id.push(id);
      this.roof.push(roof);
      this.tint.push(tint[0], tint[1], tint[2]);
    }
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aId', new THREE.Float32BufferAttribute(this.id, 1));
    g.setAttribute('aRoof', new THREE.Float32BufferAttribute(this.roof, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Face normal from three points, flipping nothing (caller controls winding). */
function faceNormal(a, b, c, out) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / L; out[1] = ny / L; out[2] = nz / L;
  return out;
}

const _n = [0, 0, 0];

export function buildBuildings(city, hf, uniforms, onProgress) {
  const batches = new Map();
  for (const key of Object.keys(FACADES)) batches.set(key, new Batch());

  // Shell outlines of part-modelled complexes are replaced by their parts.
  const items = city.buildings.filter((b) => !b.shell).concat(city.parts);

  /** Collision + label metadata. */
  const footprints = [];
  const towers = [];   // tall, named — used for labels and aviation lights
  const roofBoxes = [];

  const tmpTint = [1, 1, 1];

  for (let bi = 0; bi < items.length; bi++) {
    const b = items[bi];
    let ring = openRing(b.p);
    if (ring.length < 6) continue;
    if (signedArea(ring) < 0) ring = reverseRing(ring);   // force CCW
    const n = ring.length / 2;

    const ground = hf.minUnder(ring);
    const minH = b.min ?? 0;
    const base = ground + minH;
    const top = ground + b.h;
    const bodyH = top - base;
    if (bodyH < 1.2) continue;

    const id = (bi % 997) + hash01(bi * 7919) * 0.97;
    const family = FACADES[b.f] ? b.f : 'concrete';
    const batch = batches.get(family);

    // ---- per-building colour
    const t = hash01(bi * 2654435761);
    let tr = 0.86 + 0.3 * t;
    let tg = 0.86 + 0.3 * hash01(bi * 40503 + 11);
    let tb = 0.86 + 0.3 * hash01(bi * 69069 + 7);
    if (b.c) {
      const c = new THREE.Color(b.c);
      const spec = new THREE.Color(FACADES[family].color);
      tr = clamp(c.r / Math.max(spec.r, 0.05), 0.35, 2.2);
      tg = clamp(c.g / Math.max(spec.g, 0.05), 0.35, 2.2);
      tb = clamp(c.b / Math.max(spec.b, 0.05), 0.35, 2.2);
    }
    tmpTint[0] = tr; tmpTint[1] = tg; tmpTint[2] = tb;

    // ---- walls
    let perim = 0;
    const uStart = hash01(bi * 131) * 4;   // decorrelate window phase per building
    const vBase = minH / FLOOR_H;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1];
      const bx = ring[j * 2], bz = ring[j * 2 + 1];
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 0.05) continue;
      const u0 = uStart + perim / WINDOW_W;
      const u1 = uStart + (perim + segLen) / WINDOW_W;
      perim += segLen;

      // Outward normal for a CCW ring in xz is (dz, -dx).
      const nx = (bz - az) / segLen;
      const nz = -(bx - ax) / segLen;
      _n[0] = nx; _n[1] = 0; _n[2] = nz;

      const p0 = [ax, base, az], p1 = [bx, base, bz];
      const q0 = [ax, top, az], q1 = [bx, top, bz];
      const v0 = vBase, v1 = vBase + bodyH / FLOOR_H;
      batch.tri(p0, q0, q1, _n, [u0, v0], [u0, v1], [u1, v1], id, 0, tmpTint);
      batch.tri(p0, q1, p1, _n, [u0, v0], [u1, v1], [u1, v0], id, 0, tmpTint);
    }

    // ---- roof
    const [x0, z0, x1, z1] = bboxOf(ring);
    const w = x1 - x0, d = z1 - z0;
    const minDim = Math.min(w, d);
    const area = Math.abs(signedArea(ring));
    const rectangularity = area / Math.max(w * d, 1e-3);
    const shape = b.rs;

    let roofDone = false;
    if (shape && POINTY_ROOFS.has(shape) && minDim > 2) {
      // Scaling purely with footprint width turns wide, low buildings — the
      // Marina Bay Sands podium, exhibition halls — into giant bulbous tents.
      // Clamp against both an absolute limit and the building's own height.
      const domed = shape === 'dome' || shape === 'onion';
      const rh = b.rh ?? clamp(
        minDim * (domed ? 0.42 : 0.5),
        1.5,
        Math.min(18, Math.max(5, bodyH * 1.1))
      );
      addPointyRoof(batch, ring, top, rh, shape, id, tmpTint);
      roofDone = true;
    } else if (shape && RIDGE_ROOFS.has(shape) && rectangularity > 0.8 && n <= 8 && minDim > 2) {
      const rh = b.rh ?? Math.min(minDim * 0.34, 5.0);
      addRidgeRoof(batch, x0, z0, x1, z1, top, rh, shape === 'skillion', id, tmpTint);
      roofDone = true;
    }

    if (!roofDone) {
      addCap(batch, ring, top, id, tmpTint, true);
      // Parapet: a rim around flat roofs. Reads well both from the air and
      // from the street, and is what real flat-roofed blocks have.
      if (bodyH >= 7 && area >= 70) {
        const ph = clamp(0.55 + bodyH * 0.012, 0.6, 1.5);
        addParapet(batch, ring, top, top + ph, id, tmpTint);
      }
      // Rooftop plant on larger flat roofs.
      if (area > 380 && bodyH > 14) {
        const [cx, cz] = centroidOf(ring);
        const cnt = 1 + ((hash01(bi * 337) * 3) | 0);
        for (let k = 0; k < cnt; k++) {
          const s = 2.6 + hash01(bi * 71 + k * 13) * 5.0;
          const hh = 1.6 + hash01(bi * 91 + k * 29) * 3.4;
          const ox = (hash01(bi * 53 + k * 7) - 0.5) * Math.min(w * 0.45, 14);
          const oz = (hash01(bi * 59 + k * 17) - 0.5) * Math.min(d * 0.45, 14);
          roofBoxes.push({ x: cx + ox, z: cz + oz, y: top, w: s, d: s * (0.7 + hash01(k + bi) * 0.6), h: hh });
        }
      }
    }

    footprints.push({ ring, base, top, bbox: [x0, z0, x1, z1] });
    if (b.n && b.h >= 45) towers.push({ name: b.n, x: (x0 + x1) / 2, z: (z0 + z1) / 2, y: top, h: b.h, area });
    if (onProgress && (bi & 255) === 0) onProgress(bi / items.length);
  }

  // ---- meshes
  const group = new THREE.Group();
  group.name = 'buildings';
  const materials = [];
  for (const [family, batch] of batches) {
    if (!batch.count) continue;
    const mat = buildingMaterial(family, uniforms);
    materials.push(mat);
    const mesh = new THREE.Mesh(batch.toGeometry(), mat);
    mesh.name = `buildings-${family}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  return { group, footprints, towers, roofBoxes, materials };
}

// ------------------------------------------------------------- roof types ----

/** Horizontal cap over a ring. `up` picks the facing. */
function addCap(batch, ring, y, id, tint, up) {
  const pts = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(pts, []);
  } catch {
    return;
  }
  const nrm = up ? [0, 1, 0] : [0, -1, 0];
  for (const f of faces) {
    // Contour is CCW in xz; that triangulates to -y facing in 3D, so flip for up.
    const [i0, i1, i2] = up ? [f[2], f[1], f[0]] : [f[0], f[1], f[2]];
    const a = pts[i0], b = pts[i1], c = pts[i2];
    if (!a || !b || !c) continue;
    batch.tri(
      [a.x, y, a.y], [b.x, y, b.y], [c.x, y, c.y], nrm,
      [a.x * 0.3, a.y * 0.3], [b.x * 0.3, b.y * 0.3], [c.x * 0.3, c.y * 0.3],
      id, 1, tint
    );
  }
}

/** Double-sided rim wall around a flat roof. */
function addParapet(batch, ring, y0, y1, id, tint) {
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], az = ring[i * 2 + 1];
    const bx = ring[j * 2], bz = ring[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) continue;
    const nx = (bz - az) / L, nz = -(bx - ax) / L;
    _n[0] = nx; _n[1] = 0; _n[2] = nz;
    const p0 = [ax, y0, az], p1 = [bx, y0, bz];
    const q0 = [ax, y1, az], q1 = [bx, y1, bz];
    batch.tri(p0, q0, q1, _n, [0, 0], [0, 1], [1, 1], id, 1, tint);
    batch.tri(p0, q1, p1, _n, [0, 0], [1, 1], [1, 0], id, 1, tint);
    _n[0] = -nx; _n[2] = -nz;
    batch.tri(p0, q1, q0, _n, [0, 0], [1, 1], [0, 1], id, 1, tint);
    batch.tri(p0, p1, q1, _n, [0, 0], [1, 0], [1, 1], id, 1, tint);
  }
  // Cap the top of the rim.
  addCap(batch, ring, y1, id, tint, true);
}

/**
 * Emits a triangle facing away from `ref`, an interior reference point. Roof
 * geometry has too many orientation cases to wind by hand; this makes every
 * face correct by construction.
 */
function triOut(batch, A, B, C, ref, uvA, uvB, uvC, id, tint) {
  faceNormal(A, B, C, _n);
  const away = _n[0] * (A[0] - ref[0]) + _n[1] * (A[1] - ref[1]) + _n[2] * (A[2] - ref[2]);
  if (away < 0) {
    _n[0] = -_n[0]; _n[1] = -_n[1]; _n[2] = -_n[2];
    batch.tri(A, C, B, _n, uvA, uvC, uvB, id, 1, tint);
  } else {
    batch.tri(A, B, C, _n, uvA, uvB, uvC, id, 1, tint);
  }
}

function quadOut(batch, A, B, C, D, ref, id, tint) {
  triOut(batch, A, B, C, ref, [0, 0], [1, 0], [1, 1], id, tint);
  triOut(batch, A, C, D, ref, [0, 0], [1, 1], [0, 1], id, tint);
}

/** Cone / dome / pyramid roof: the ring contracts toward a shared apex. */
function addPointyRoof(batch, ring, y, rh, shape, id, tint) {
  const [cx, cz] = centroidOf(ring);
  const n = ring.length / 2;
  const domed = shape === 'dome' || shape === 'round' || shape === 'onion';
  const steps = domed ? 6 : 1;
  const ref = [cx, y - 3, cz];
  const prof = (t) => (domed
    ? { r: Math.cos((t * Math.PI) / 2), h: Math.sin((t * Math.PI) / 2) }
    : { r: 1 - t, h: t });

  for (let s = 0; s < steps; s++) {
    const p0 = prof(s / steps);
    const p1 = prof((s + 1) / steps);
    const h0 = y + rh * p0.h, h1 = y + rh * p1.h;
    const shrink = (i, r) => [cx + (ring[i * 2] - cx) * r, cz + (ring[i * 2 + 1] - cz) * r];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ax, az] = shrink(i, p0.r);
      const [bx, bz] = shrink(j, p0.r);
      const A = [ax, h0, az], B = [bx, h0, bz];
      if (p1.r < 1e-3) {
        // Final ring collapses to the apex: one triangle, not a degenerate quad.
        triOut(batch, A, B, [cx, h1, cz], ref, [0, 0], [1, 0], [0.5, 1], id, tint);
      } else {
        const [c2x, c2z] = shrink(j, p1.r);
        const [d2x, d2z] = shrink(i, p1.r);
        quadOut(batch, A, B, [c2x, h1, c2z], [d2x, h1, d2z], ref, id, tint);
      }
    }
  }
}

/** Ridge (gable / hip / lean-to) roof over the footprint's bounding box. */
function addRidgeRoof(batch, x0, z0, x1, z1, y, rh, skillion, id, tint) {
  const alongX = x1 - x0 >= z1 - z0;
  const top = y + rh;
  const ref = [(x0 + x1) / 2, y - 3, (z0 + z1) / 2];

  if (skillion) {
    // Single slope, rising across the shorter axis.
    if (alongX) {
      quadOut(batch, [x0, y, z0], [x1, y, z0], [x1, top, z1], [x0, top, z1], ref, id, tint);
      triOut(batch, [x0, y, z0], [x0, top, z1], [x0, y, z1], ref, [0, 0], [1, 1], [1, 0], id, tint);
      triOut(batch, [x1, y, z0], [x1, top, z1], [x1, y, z1], ref, [0, 0], [1, 1], [1, 0], id, tint);
    } else {
      quadOut(batch, [x0, y, z0], [x0, y, z1], [x1, top, z1], [x1, top, z0], ref, id, tint);
      triOut(batch, [x0, y, z0], [x1, top, z0], [x1, y, z0], ref, [0, 0], [1, 1], [1, 0], id, tint);
      triOut(batch, [x0, y, z1], [x1, top, z1], [x1, y, z1], ref, [0, 0], [1, 1], [1, 0], id, tint);
    }
    return;
  }

  if (alongX) {
    const mz = (z0 + z1) / 2;
    quadOut(batch, [x0, y, z0], [x1, y, z0], [x1, top, mz], [x0, top, mz], ref, id, tint);
    quadOut(batch, [x1, y, z1], [x0, y, z1], [x0, top, mz], [x1, top, mz], ref, id, tint);
    triOut(batch, [x0, y, z0], [x0, top, mz], [x0, y, z1], ref, [0, 0], [0.5, 1], [1, 0], id, tint);
    triOut(batch, [x1, y, z1], [x1, top, mz], [x1, y, z0], ref, [0, 0], [0.5, 1], [1, 0], id, tint);
  } else {
    const mx = (x0 + x1) / 2;
    quadOut(batch, [x0, y, z1], [x0, y, z0], [mx, top, z0], [mx, top, z1], ref, id, tint);
    quadOut(batch, [x1, y, z0], [x1, y, z1], [mx, top, z1], [mx, top, z0], ref, id, tint);
    triOut(batch, [x0, y, z0], [mx, top, z0], [x1, y, z0], ref, [0, 0], [0.5, 1], [1, 0], id, tint);
    triOut(batch, [x1, y, z1], [mx, top, z1], [x0, y, z1], ref, [0, 0], [0.5, 1], [1, 0], id, tint);
  }
}
