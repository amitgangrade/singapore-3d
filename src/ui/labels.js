import * as THREE from 'three';

/**
 * Projected place names.
 *
 * A fixed pool of DOM nodes is reused every frame: candidates are filtered by
 * distance and visibility, sorted by importance, and the winners are positioned
 * in screen space. DOM text stays crisp at any resolution and costs nothing on
 * the GPU, which matters because the alternative — a sprite per name — would be
 * another 1300 draw calls.
 */

const MAX_VISIBLE = 34;

const RANGE = {
  landmark: 2600,
  tower: 1150,
  park: 460,
  hotel: 230,
  poi: 200,
};

const RANK = { landmark: 0, tower: 1, park: 2, hotel: 3, poi: 4 };

export class LabelLayer {
  constructor(container) {
    this.container = container;
    this.pool = [];
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const el = document.createElement('div');
      el.className = 'lbl';
      el.style.display = 'none';
      container.appendChild(el);
      this.pool.push(el);
    }
    this.items = [];
    this.enabled = true;
    this._v = new THREE.Vector3();
    this._scored = [];
  }

  /** Collect the label set once, after the world is built. */
  build({ landmarks, towers, city, hf }) {
    const items = [];
    const seen = new Set();

    for (const l of landmarks) {
      items.push({ ...l, kind: l.kind ?? 'landmark' });
      seen.add(l.name);
    }

    // Named towers: keep the tallest instance of each name (OSM splits big
    // complexes into many parts that all carry the same name).
    const byName = new Map();
    for (const t of towers) {
      const prev = byName.get(t.name);
      if (!prev || t.h > prev.h) byName.set(t.name, t);
    }
    // Only genuinely prominent towers get a permanent name, otherwise the CBD
    // is a wall of text no matter how good the decluttering is.
    for (const t of byName.values()) {
      if (seen.has(t.name) || t.h < 70) continue;
      seen.add(t.name);
      items.push({ name: t.name, x: t.x, y: t.y + 6, z: t.z, kind: 'tower' });
    }

    for (const g of city.green) {
      if (!g.n || seen.has(g.n)) continue;
      if (!/park|garden|green|lawn|padang|promontory|grove/i.test(g.n) && g.k !== 'park') continue;
      seen.add(g.n);
      let cx = 0, cz = 0;
      const n = g.p.length / 2;
      for (let i = 0; i < n; i++) { cx += g.p[i * 2]; cz += g.p[i * 2 + 1]; }
      cx /= n; cz /= n;
      items.push({ name: g.n, x: cx, y: hf.at(cx, cz) + 6, z: cz, kind: 'park' });
    }

    for (const p of city.pois) {
      if (!p.n || seen.has(p.n)) continue;
      const kind = p.k === 'hotel' ? 'hotel'
        : ['museum', 'attraction', 'viewpoint', 'culture', 'historic', 'worship', 'transport'].includes(p.k) ? 'poi'
          : null;
      if (!kind) continue;
      seen.add(p.n);
      items.push({ name: p.n, x: p.x, y: hf.at(p.x, p.z) + 5, z: p.z, kind });
    }

    this.items = items;
    return items.length;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) for (const el of this.pool) el.style.display = 'none';
  }

  update(camera, width, height) {
    if (!this.enabled) return;
    const cam = camera.position;
    const scored = this._scored;
    scored.length = 0;

    for (const it of this.items) {
      const dx = it.x - cam.x, dz = it.z - cam.z, dy = it.y - cam.y;
      const d2 = dx * dx + dy * dy + dz * dz;
      const range = RANGE[it.kind] ?? 200;
      if (d2 > range * range) continue;
      this._v.set(it.x, it.y, it.z).project(camera);
      if (this._v.z > 1 || this._v.z < -1) continue;
      if (this._v.x < -1.05 || this._v.x > 1.05 || this._v.y < -1.05 || this._v.y > 1.05) continue;
      scored.push({
        it,
        // Importance first, then proximity.
        score: RANK[it.kind] * 1e7 + d2,
        sx: (this._v.x * 0.5 + 0.5) * width,
        sy: (-this._v.y * 0.5 + 0.5) * height,
        d: Math.sqrt(d2),
        range,
      });
    }
    scored.sort((a, b) => a.score - b.score);

    // Declutter: drop anything that would land on top of a label already
    // placed, or underneath one of the HUD panels.
    const placed = [
      { x0: 0, y0: 0, x1: 232, y1: 152 },                 // readouts, top left
      { x0: width - 210, y0: 0, x1: width, y1: 320 },     // controls, top right
      { x0: 0, y0: height - 190, x1: 292, y1: height },   // help, bottom left
    ];
    const kept = [];
    for (const s of scored) {
      const halfW = 4 + s.it.name.length * 3.4;
      const box = { x0: s.sx - halfW, x1: s.sx + halfW, y0: s.sy - 19, y1: s.sy + 2 };
      let clash = false;
      for (const p of placed) {
        if (box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0) { clash = true; break; }
      }
      if (clash) continue;
      placed.push(box);
      kept.push(s);
      if (kept.length >= MAX_VISIBLE) break;
    }

    const used = kept.length;
    for (let i = 0; i < used; i++) {
      const s = kept[i];
      const el = this.pool[i];
      if (el._name !== s.it.name) {
        el.textContent = s.it.name;
        el._name = s.it.name;
      }
      if (el._kind !== s.it.kind) {
        el.className = `lbl ${s.it.kind}`;
        el._kind = s.it.kind;
      }
      // Fade out over the last third of the range.
      const fade = 1 - Math.max(0, (s.d - s.range * 0.66) / (s.range * 0.34));
      el.style.transform = `translate(-50%, -100%) translate(${s.sx.toFixed(1)}px, ${s.sy.toFixed(1)}px)`;
      el.style.opacity = fade.toFixed(2);
      el.style.display = 'block';
    }
    for (let i = used; i < this.pool.length; i++) {
      if (this.pool[i].style.display !== 'none') this.pool[i].style.display = 'none';
    }
  }

  /** Nearest named thing, for the HUD readout. */
  nearest(camera) {
    let best = null;
    let bestD = Infinity;
    const cam = camera.position;
    for (const it of this.items) {
      if (it.kind === 'poi') continue;
      const d = Math.hypot(it.x - cam.x, it.z - cam.z);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best ? { name: best.name, distance: bestD } : null;
  }
}
