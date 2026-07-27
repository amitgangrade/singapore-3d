import { pointInRing, distToSegment2, clamp } from './util.js';
import { HALF, PAD } from '../config.js';

/**
 * Uniform grid over building footprints. Used both for walk-mode collision and
 * to keep scattered props (trees, lamps, cars) out of buildings.
 */
export class FootprintIndex {
  constructor(footprints, cell = 24) {
    this.items = footprints;
    this.cell = cell;
    this.origin = -(HALF + PAD);
    this.n = Math.ceil(((HALF + PAD) * 2) / cell) + 1;
    this.buckets = new Array(this.n * this.n);
    // Visited stamps make `near` allocation-free and O(hits) rather than O(n^2).
    this._stamp = new Uint32Array(footprints.length);
    this._token = 0;
    this._out = [];

    for (let k = 0; k < footprints.length; k++) {
      const [x0, z0, x1, z1] = footprints[k].bbox;
      const i0 = this._ix(x0), i1 = this._ix(x1);
      const j0 = this._ix(z0), j1 = this._ix(z1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const b = j * this.n + i;
          (this.buckets[b] ||= []).push(k);
        }
      }
    }
  }

  _ix(v) { return clamp(Math.floor((v - this.origin) / this.cell), 0, this.n - 1); }

  /**
   * Footprint indices in the cells overlapping a query circle.
   * The returned array is reused between calls — copy it if you need to keep it.
   */
  near(x, z, radius = 0) {
    const i0 = this._ix(x - radius), i1 = this._ix(x + radius);
    const j0 = this._ix(z - radius), j1 = this._ix(z + radius);
    const token = ++this._token;
    const stamp = this._stamp;
    const out = this._out;
    out.length = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const b = this.buckets[j * this.n + i];
        if (!b) continue;
        for (const k of b) {
          if (stamp[k] === token) continue;
          stamp[k] = token;
          out.push(k);
        }
      }
    }
    return out;
  }

  /** Is the point inside any footprint whose base is at or below `y`? */
  inside(x, z, y = Infinity) {
    for (const k of this.near(x, z)) {
      const f = this.items[k];
      if (f.base > y) continue;
      const [x0, z0, x1, z1] = f.bbox;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      if (pointInRing(x, z, f.ring)) return f;
    }
    return null;
  }

  /**
   * Pushes a circle of radius r out of any wall it overlaps.
   * Returns [dx, dz] to add to the position, and the top of anything hit.
   */
  resolve(x, z, r, y, out) {
    let px = 0, pz = 0;
    let hitTop = -Infinity;
    const r2 = r * r;
    const p = { x: 0, z: 0, t: 0 };

    for (const k of this.near(x, z, r + 2)) {
      const f = this.items[k];
      // Ignore volumes entirely above the head or below the feet (bridges,
      // overhangs, elevated building parts).
      if (f.base > y + 1.7 || f.top < y + 0.15) continue;
      const [x0, z0, x1, z1] = f.bbox;
      if (x < x0 - r || x > x1 + r || z < z0 - r || z > z1 + r) continue;

      const ring = f.ring;
      const n = ring.length / 2;
      const inside = pointInRing(x, z, ring);

      // Nearest point on the outline.
      let best = Infinity, bx = 0, bz = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d2 = distToSegment2(x, z, ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], p);
        if (d2 < best) { best = d2; bx = p.x; bz = p.z; }
      }
      if (!inside && best > r2) continue;

      let dx = x - bx, dz = z - bz;
      let d = Math.hypot(dx, dz);
      if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
      if (inside) {
        // Eject to the outside of the nearest wall.
        px += (-dx / d) * (r + d);
        pz += (-dz / d) * (r + d);
      } else {
        const push = r - d;
        px += (dx / d) * push;
        pz += (dz / d) * push;
      }
      if (f.top > hitTop) hitTop = f.top;
    }
    out.x = px;
    out.z = pz;
    out.top = hitTop;
    return out;
  }
}
