import * as THREE from 'three';
import { GREEN_STYLE, HALF, PAD } from '../config.js';
import { surfaceMaterial } from '../render/materials.js';
import { rasterizeRings, blurGrid, bboxOf, clamp } from '../core/util.js';

/**
 * The ground mesh.
 *
 * Parks, lawns and pitches are painted into the terrain's vertex colours rather
 * than being separate coplanar meshes: it follows the relief of Fort Canning
 * exactly, costs nothing extra to draw, and leaves no z-fighting seams.
 */

const URBAN = new THREE.Color(0x5d5850);
const SAND = new THREE.Color(0x7d7460);
const SILT = new THREE.Color(0x1d2622);

export function buildTerrain(city, hf, uniforms) {
  const n = hf.n;
  const cells = n * n;

  // ---- rasterise vegetation colour + coverage
  const cover = new Float32Array(cells);
  const colR = new Float32Array(cells);
  const colG = new Float32Array(cells);
  const colB = new Float32Array(cells);
  const tmp = new Float32Array(cells);
  const c = new THREE.Color();

  // Larger areas first so a pitch or flowerbed painted inside a park wins.
  const greens = city.green.slice().sort((a, b) => area(b.p) - area(a.p));
  for (const g of greens) {
    const style = GREEN_STYLE[g.k] ?? GREEN_STYLE.grass;
    c.set(style.color);
    const rings = [g.p];
    if (g.holes) rings.push(...g.holes);
    rasterizeRings(rings, tmp, n, hf.origin, hf.cell, 1);
    // Only touch the polygon's own bbox when transferring, so this stays cheap.
    const [x0, z0, x1, z1] = bboxOf(g.p);
    const i0 = clamp(Math.floor((x0 - hf.origin) / hf.cell) - 1, 0, n - 1);
    const i1 = clamp(Math.ceil((x1 - hf.origin) / hf.cell) + 1, 0, n - 1);
    const j0 = clamp(Math.floor((z0 - hf.origin) / hf.cell) - 1, 0, n - 1);
    const j1 = clamp(Math.ceil((z1 - hf.origin) / hf.cell) + 1, 0, n - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        if (tmp[k] === 0) continue;
        tmp[k] = 0;
        cover[k] = 1;
        colR[k] = c.r; colG[k] = c.g; colB[k] = c.b;
      }
    }
  }
  // Soften the edges so park boundaries do not read as a pixel staircase.
  blurGrid(cover, n, 1, 1);
  blurGrid(colR, n, 1, 1);
  blurGrid(colG, n, 1, 1);
  blurGrid(colB, n, 1, 1);

  // ---- mesh
  const positions = new Float32Array(cells * 3);
  const normals = new Float32Array(cells * 3);
  const colors = new Float32Array(cells * 3);
  const uvs = new Float32Array(cells * 2);
  const nrm = new THREE.Vector3();
  const out = new THREE.Color();

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = hf.origin + i * hf.cell;
      const z = hf.origin + j * hf.cell;
      const y = hf.h[k];
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;

      hf.normalAt(x, z, nrm);
      normals[k * 3] = nrm.x;
      normals[k * 3 + 1] = nrm.y;
      normals[k * 3 + 2] = nrm.z;

      uvs[k * 2] = x;
      uvs[k * 2 + 1] = z;

      // Base surface: silt below the waterline, a sandy band at the quay edge,
      // grey urban ground inland, with vegetation blended over the top.
      const land = hf.land[k];
      if (land < 0.5) {
        out.copy(SILT).lerp(SAND, land * 2);
      } else {
        out.copy(SAND).lerp(URBAN, clamp((land - 0.5) * 3.2, 0, 1));
      }
      const cv = clamp(cover[k], 0, 1) * clamp((land - 0.35) * 2.6, 0, 1);
      if (cv > 0.001) {
        out.lerp(new THREE.Color(colR[k] / Math.max(cover[k], 1e-4),
          colG[k] / Math.max(cover[k], 1e-4),
          colB[k] / Math.max(cover[k], 1e-4)), cv);
      }
      colors[k * 3] = out.r;
      colors[k * 3 + 1] = out.g;
      colors[k * 3 + 2] = out.b;
    }
  }

  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let t = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
      index[t++] = a; index[t++] = cc; index[t++] = b;
      index[t++] = b; index[t++] = cc; index[t++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();

  const mat = surfaceMaterial(uniforms, { roughness: 0.93, name: 'terrain' });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;

  // A dark skirt beyond the modelled square, so the horizon is not empty air.
  const skirtSize = (HALF + PAD) * 12;
  const skirt = new THREE.Mesh(
    new THREE.PlaneGeometry(skirtSize, skirtSize),
    new THREE.MeshStandardMaterial({ color: 0x2c3a3f, roughness: 1, metalness: 0 })
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.y = -1.2;
  skirt.name = 'surrounds';
  skirt.receiveShadow = false;

  const group = new THREE.Group();
  group.name = 'terrain-group';
  group.add(skirt, mesh);
  return { group, materials: [mat], cover };
}

function area(f) {
  let a = 0;
  const n = f.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += f[i * 2] * f[j * 2 + 1] - f[j * 2] * f[i * 2 + 1];
  }
  return Math.abs(a / 2);
}
