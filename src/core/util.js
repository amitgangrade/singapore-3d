/** Small geometry / numeric helpers shared by the world builders. */

/** Deterministic 32-bit hash -> [0,1). Keeps the city identical between runs. */
export function hash01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Signed area of a flat [x,z,...] ring (positive = CCW in the xz sense). */
export function signedArea(f) {
  let a = 0;
  const n = f.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += f[i * 2] * f[j * 2 + 1] - f[j * 2] * f[i * 2 + 1];
  }
  return a / 2;
}

/** Drop a repeated closing vertex, if present. */
export function openRing(f) {
  const n = f.length;
  if (n >= 6 && f[0] === f[n - 2] && f[1] === f[n - 1]) return f.slice(0, n - 2);
  return f;
}

/** Reverse a flat ring in place-ish (returns a new array). */
export function reverseRing(f) {
  const out = new Array(f.length);
  const n = f.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = f[(n - 1 - i) * 2];
    out[i * 2 + 1] = f[(n - 1 - i) * 2 + 1];
  }
  return out;
}

export function bboxOf(f) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < f.length; i += 2) {
    const x = f[i], z = f[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

export function centroidOf(f) {
  let x = 0, z = 0;
  const n = f.length / 2;
  for (let i = 0; i < n; i++) { x += f[i * 2]; z += f[i * 2 + 1]; }
  return [x / n, z / n];
}

export function pointInRing(px, pz, f) {
  let inside = false;
  const n = f.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = f[i * 2], zi = f[i * 2 + 1];
    const xj = f[j * 2], zj = f[j * 2 + 1];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Squared distance from a point to segment ab, plus the closest point. */
export function distToSegment2(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cz = az + dz * t;
  if (out) { out.x = cx; out.z = cz; out.t = t; }
  const ex = px - cx, ez = pz - cz;
  return ex * ex + ez * ez;
}

/** Total length of a flat polyline. */
export function polylineLength(f) {
  let L = 0;
  for (let i = 2; i < f.length; i += 2) {
    L += Math.hypot(f[i] - f[i - 2], f[i + 1] - f[i - 1]);
  }
  return L;
}

/** Drop points closer together than `min` (keeps ends). Avoids ribbon pinching. */
export function simplify(f, min = 0.7) {
  if (f.length <= 4) return f;
  const out = [f[0], f[1]];
  const m2 = min * min;
  for (let i = 2; i < f.length - 2; i += 2) {
    const dx = f[i] - out[out.length - 2];
    const dz = f[i + 1] - out[out.length - 1];
    if (dx * dx + dz * dz >= m2) out.push(f[i], f[i + 1]);
  }
  out.push(f[f.length - 2], f[f.length - 1]);
  return out.length >= 4 ? out : f;
}

/**
 * Even-odd scanline fill of one or more flat rings into a value grid.
 * Far cheaper than a per-cell point-in-polygon sweep, and holes come for free
 * because all rings share one crossing list.
 *
 * @param rings   array of flat [x,z,...] rings (outer and inner together)
 * @param grid    Float32Array of size n*n, indexed z*n + x
 * @param n       grid resolution
 * @param origin  world coordinate of cell 0 centre
 * @param cell    cell size in metres
 * @param value   value written into covered cells
 */
export function rasterizeRings(rings, grid, n, origin, cell, value) {
  const xs = [];
  for (let j = 0; j < n; j++) {
    const z = origin + j * cell;
    xs.length = 0;
    for (const ring of rings) {
      const m = ring.length / 2;
      for (let i = 0, k = m - 1; i < m; k = i++) {
        const zi = ring[i * 2 + 1], zk = ring[k * 2 + 1];
        if ((zi > z) === (zk > z)) continue;
        const xi = ring[i * 2], xk = ring[k * 2];
        xs.push(xi + ((z - zi) / (zk - zi)) * (xk - xi));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      let a = Math.ceil((xs[s] - origin) / cell);
      let b = Math.floor((xs[s + 1] - origin) / cell);
      if (b < 0 || a >= n) continue;
      if (a < 0) a = 0;
      if (b >= n) b = n - 1;
      const row = j * n;
      for (let i = a; i <= b; i++) grid[row + i] = value;
    }
  }
}

/** Separable box blur over a square grid, `passes` times. */
export function blurGrid(grid, n, passes = 1, radius = 1) {
  const tmp = new Float32Array(grid.length);
  const w = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) {
      const row = j * n;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) {
          s += grid[row + clamp(i + k, 0, n - 1)];
        }
        tmp[row + i] = s / w;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) {
          s += tmp[clamp(j + k, 0, n - 1) * n + i];
        }
        grid[j * n + i] = s / w;
      }
    }
  }
}

/** Uniform-ish random points inside a polygon (rejection sampling with bbox). */
export function scatterInRing(ring, count, random, holes) {
  const [x0, z0, x1, z1] = bboxOf(ring);
  const pts = [];
  const tries = count * 14 + 40;
  for (let i = 0; i < tries && pts.length < count; i++) {
    const x = x0 + random() * (x1 - x0);
    const z = z0 + random() * (z1 - z0);
    if (!pointInRing(x, z, ring)) continue;
    if (holes && holes.some((h) => pointInRing(x, z, h))) continue;
    pts.push(x, z);
  }
  return pts;
}
