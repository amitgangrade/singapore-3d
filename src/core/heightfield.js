import { HALF, PAD, LAND_Y, WATER_BED } from '../config.js';
import { rasterizeRings, blurGrid, clamp, smoothstep, signedArea } from './util.js';

/**
 * The ground surface.
 *
 * Central Singapore is reclaimed and almost perfectly flat, so land sits at a
 * constant quay height. Two things modulate it:
 *
 *  - Water bodies are carved down to WATER_BED. Blurring the land/water mask
 *    turns the hard OSM shoreline into a short bank, so the reservoir surface
 *    meets the ground without z-fighting.
 *  - Fort Canning Hill (and the smaller Ann Siang ridge) are raised by heavily
 *    blurring their park outlines into a dome, which puts the relief exactly
 *    where the real hills are instead of at a guessed coordinate.
 */
export class Heightfield {
  constructor(city) {
    this.span = (HALF + PAD) * 2;              // 2400 m
    this.n = 513;                              // 4.7 m cells
    this.cell = this.span / (this.n - 1);
    this.origin = -(HALF + PAD);

    const n = this.n;
    const cells = n * n;

    // ---- land / water mask (1 = land)
    const land = new Float32Array(cells).fill(1);
    const bigWater = city.water.filter((w) => ringsArea(w.rings) > 2200);
    for (const w of bigWater) {
      rasterizeRings(w.rings, land, n, this.origin, this.cell, 0);
      if (w.holes) rasterizeRings(w.holes, land, n, this.origin, this.cell, 1);
    }
    // Rivers arriving as centrelines still need a channel cut.
    for (const wl of city.waterways) {
      rasterizeRings([ribbonRing(wl.p, wl.w)], land, n, this.origin, this.cell, 0);
    }
    blurGrid(land, n, 2, 1);
    this.land = land;

    // ---- hills
    const hill = new Float32Array(cells);
    const relief = [
      { match: /^Fort Canning/i, height: 44 },
      { match: /^Ann Siang Hill/i, height: 15 },
      { match: /^Telok Ayer Park/i, height: 5 },
    ];
    for (const r of relief) {
      const rings = city.green.filter((g) => g.n && r.match.test(g.n)).map((g) => g.p);
      if (!rings.length) continue;
      const mask = new Float32Array(cells);
      rasterizeRings(rings, mask, n, this.origin, this.cell, 1);
      blurGrid(mask, n, 5, 3);
      // Normalise so the blurred peak still reaches the intended height.
      let peak = 0;
      for (let i = 0; i < cells; i++) if (mask[i] > peak) peak = mask[i];
      if (peak < 1e-3) continue;
      const k = r.height / peak;
      for (let i = 0; i < cells; i++) hill[i] += mask[i] * k;
    }
    this.hill = hill;

    // ---- final elevation
    const h = new Float32Array(cells);
    for (let i = 0; i < cells; i++) {
      const t = smoothstep(clamp(land[i], 0, 1));
      const top = LAND_Y + hill[i];
      h[i] = WATER_BED + (top - WATER_BED) * t;
    }
    this.h = h;

    // ---- walkable bridge decks, filled in by the road builder
    this.deckN = 601;
    this.deckCell = this.span / (this.deckN - 1);   // 4 m
    this.deck = new Float32Array(this.deckN * this.deckN).fill(-9999);
  }

  /** Bilinear ground height at a world position. */
  at(x, z) {
    const n = this.n;
    const fx = clamp((x - this.origin) / this.cell, 0, n - 1.001);
    const fz = clamp((z - this.origin) / this.cell, 0, n - 1.001);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const h = this.h;
    const a = h[j * n + i], b = h[j * n + i + 1];
    const c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** How land-like a position is: 1 = dry, 0 = open water. */
  landAt(x, z) {
    const n = this.n;
    const i = clamp(Math.round((x - this.origin) / this.cell), 0, n - 1);
    const j = clamp(Math.round((z - this.origin) / this.cell), 0, n - 1);
    return this.land[j * n + i];
  }

  /** Lowest ground height under a footprint, so buildings never float. */
  minUnder(flat) {
    let m = Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const v = this.at(flat[i], flat[i + 1]);
      if (v < m) m = v;
    }
    return m === Infinity ? LAND_Y : m;
  }

  /** Approximate surface normal, for slope-aware placement. */
  normalAt(x, z, out) {
    const e = this.cell;
    const hL = this.at(x - e, z), hR = this.at(x + e, z);
    const hD = this.at(x, z - e), hU = this.at(x, z + e);
    out.set(hL - hR, 2 * e, hD - hU).normalize();
    return out;
  }

  // ---- bridge decks ---------------------------------------------------------

  stampDeck(x, z, y) {
    const n = this.deckN;
    const i = Math.round((x - this.origin) / this.deckCell);
    const j = Math.round((z - this.origin) / this.deckCell);
    if (i < 0 || j < 0 || i >= n || j >= n) return;
    const k = j * n + i;
    if (y > this.deck[k]) this.deck[k] = y;
  }

  /** Highest stamped deck within a small radius, or -9999. */
  deckAt(x, z, r = 1) {
    const n = this.deckN;
    const ci = Math.round((x - this.origin) / this.deckCell);
    const cj = Math.round((z - this.origin) / this.deckCell);
    let best = -9999;
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= n) continue;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= n) continue;
        const v = this.deck[j * n + i];
        if (v > best) best = v;
      }
    }
    return best;
  }
}

function ringsArea(rings) {
  let a = 0;
  for (const r of rings) a += Math.abs(signedArea(r));
  return a;
}

/** Turn a centreline into a closed ring roughly `w` wide, for mask carving. */
function ribbonRing(p, w) {
  const h = w / 2;
  const left = [];
  const right = [];
  for (let i = 0; i < p.length; i += 2) {
    const px = p[i], pz = p[i + 1];
    const qx = p[Math.min(i + 2, p.length - 2)];
    const qz = p[Math.min(i + 3, p.length - 1)];
    const ax = p[Math.max(i - 2, 0)], az = p[Math.max(i - 1, 1)];
    let dx = qx - ax, dz = qz - az;
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    left.push(px + dz * h, pz - dx * h);
    right.unshift(px - dz * h, pz + dx * h);
  }
  return left.concat(right);
}
