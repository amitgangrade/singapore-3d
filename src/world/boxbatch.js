import * as THREE from 'three';

/**
 * Accumulates axis-aligned-ish boxes and prisms into a single vertex-coloured
 * geometry. Used for bridge structure, parapets, pylons, rooftop plant, jetties
 * and the hand-modelled landmarks — anything that is a handful of slabs.
 */
export class BoxBatch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this._c = new THREE.Color();
  }

  get count() { return this.pos.length / 3; }

  /** Box centred on (x, z), spanning y0..y1, rotated `rot` radians about Y. */
  box(x, y0, z, w, d, y1, rot, color) {
    const hw = w / 2, hd = d / 2;
    const cs = Math.cos(rot || 0), sn = Math.sin(rot || 0);
    const p = (lx, ly, lz) => [x + lx * cs - lz * sn, ly, z + lx * sn + lz * cs];
    const a = p(-hw, y0, -hd), b = p(hw, y0, -hd), c = p(hw, y0, hd), d2 = p(-hw, y0, hd);
    const e = p(-hw, y1, -hd), f = p(hw, y1, -hd), g = p(hw, y1, hd), h = p(-hw, y1, hd);
    this._c.set(color);
    const col = [this._c.r, this._c.g, this._c.b];
    this.quad(e, f, g, h, [0, 1, 0], col);                       // top
    this.quad(d2, c, b, a, [0, -1, 0], col);                     // bottom
    this.quad(a, b, f, e, [-sn, 0, -cs], col);                   // -z side
    this.quad(c, d2, h, g, [sn, 0, cs], col);                    // +z side
    this.quad(b, c, g, f, [cs, 0, sn], col);                     // +x side
    this.quad(d2, a, e, h, [-cs, 0, -sn], col);                  // -x side
  }

  /** Quad a-b-c-d, wound so the given normal faces out. */
  quad(a, b, c, d, n, col) {
    this.tri(a, b, c, n, col);
    this.tri(a, c, d, n, col);
  }

  /**
   * Emits a triangle, flipping the winding if it disagrees with `n`, so callers
   * only have to get the outward normal right and never the vertex order.
   */
  tri(a, b, c, n, col) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * n[0] + gy * n[1] + gz * n[2] < 0) { const t = b; b = c; c = t; }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) {
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(col[0], col[1], col[2]);
    }
  }

  /** Prism between two points, `w` wide, from y0 to y1. Used for parapets. */
  wall(ax, az, bx, bz, y0, y1, w, color) {
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) return;
    const rot = Math.atan2(dz, dx);
    this.box((ax + bx) / 2, y0, (az + bz) / 2, L, w, y1, rot, color);
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Colour helper for vertex-coloured batches. */
export function rgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
