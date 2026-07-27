import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GREEN_STYLE, HALF } from '../config.js';
import { foliageNightGlow } from '../render/materials.js';
import { rng, scatterInRing, signedArea, clamp } from '../core/util.js';

/**
 * Street trees and park planting.
 *
 * Every tree tagged in OSM is placed exactly, then park, garden and forest
 * polygons are filled in at a per-class density so the green space reads as
 * planted rather than mown. Two silhouettes are used — broadleaf (rain trees,
 * angsana) and palm — because that mix is what makes Singapore's streets
 * recognisable from the ground.
 */

function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.17, 0.3, 1, 6, 1);
  trunk.translate(0, 0.5, 0);
  return trunk;
}

function canopyGeometry() {
  // Two offset lumps read as a spreading crown without extra draw calls.
  const a = new THREE.IcosahedronGeometry(1, 1);
  a.scale(1, 0.62, 1);
  const b = new THREE.IcosahedronGeometry(0.62, 1);
  b.translate(0.5, 0.3, -0.25);
  b.scale(1, 0.7, 1);
  return mergeGeometries([a, b]);
}

function palmTrunkGeometry() {
  const t = new THREE.CylinderGeometry(0.12, 0.22, 1, 6, 1);
  t.translate(0, 0.5, 0);
  return t;
}

function palmCrownGeometry() {
  const parts = [];
  const fronds = 7;
  for (let i = 0; i < fronds; i++) {
    const f = new THREE.ConeGeometry(0.3, 2.5, 4, 1, true);
    f.scale(1, 1, 0.35);
    f.translate(0, 1.05, 0);
    const m = new THREE.Matrix4()
      .makeRotationZ(Math.PI * 0.42)
      .premultiply(new THREE.Matrix4().makeRotationY((i / fronds) * Math.PI * 2));
    f.applyMatrix4(m);
    parts.push(f);
  }
  return mergeGeometries(parts);
}

export function buildTrees(city, hf, index, quality, uniforms) {
  const random = rng(20260726);
  const spots = [];   // {x, z, h, palm}

  // ---- trees mapped individually
  const t = city.trees;
  for (let i = 0; i < t.length; i += 4) {
    const x = t[i], z = t[i + 1];
    const h = t[i + 2] > 1 ? t[i + 2] : 7 + random() * 7;
    if (Math.abs(x) > HALF || Math.abs(z) > HALF) continue;
    if (hf.landAt(x, z) < 0.55) continue;
    spots.push({ x, z, h, palm: random() < 0.22 });
  }

  // ---- park planting
  for (const g of city.green) {
    const style = GREEN_STYLE[g.k] ?? GREEN_STYLE.grass;
    if (!style.trees) continue;
    const area = Math.abs(signedArea(g.p));
    const want = Math.round(area * style.trees * quality.treeScatter);
    if (want < 1) continue;
    const pts = scatterInRing(g.p, Math.min(want, 420), random, g.holes);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], z = pts[i + 1];
      if (Math.abs(x) > HALF || Math.abs(z) > HALF) continue;
      if (hf.landAt(x, z) < 0.55) continue;
      if (index.inside(x, z, 3)) continue;
      const big = g.k === 'forest' || g.k === 'park';
      spots.push({
        x, z,
        h: (big ? 8 : 5.5) + random() * (big ? 9 : 5),
        palm: random() < (g.k === 'garden' ? 0.4 : 0.2),
      });
    }
  }

  const broad = spots.filter((s) => !s.palm);
  const palms = spots.filter((s) => s.palm);

  const group = new THREE.Group();
  group.name = 'trees';

  const barkMat = new THREE.MeshStandardMaterial({ color: 0x51443a, roughness: 0.92, metalness: 0 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, vertexColors: false });
  const frondMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  barkMat.name = 'bark';
  leafMat.name = 'leaf';
  frondMat.name = 'frond';
  // Foliage catches street and shopfront light after dark.
  if (uniforms) {
    foliageNightGlow(leafMat, uniforms, 0.62, 0.7);
    foliageNightGlow(frondMat, uniforms, 0.62, 0.7);
    foliageNightGlow(barkMat, uniforms, 0.12, 0.1);
  }

  const leafBase = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const place = (list, trunkGeo, crownGeo, trunkMat, crownMat, crownScale, palm) => {
    if (!list.length) return;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, list.length);
    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = false;
    trunks.name = palm ? 'palm-trunks' : 'tree-trunks';
    crowns.name = palm ? 'palm-crowns' : 'tree-crowns';

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const y = hf.at(s.x, s.z);
      const trunkH = palm ? s.h * 0.82 : s.h * 0.55;
      const lean = (random() - 0.5) * 0.06;

      q.setFromEuler(new THREE.Euler(lean, random() * Math.PI * 2, lean * 0.7));
      pos.set(s.x, y, s.z);
      scl.set(1, trunkH, 1);
      trunks.setMatrixAt(i, m.compose(pos, q, scl));

      const spread = (palm ? 1.5 : s.h * 0.34) * crownScale;
      pos.set(s.x, y + trunkH, s.z);
      scl.set(spread, palm ? 1.15 : spread * (0.85 + random() * 0.4), spread);
      crowns.setMatrixAt(i, m.compose(pos, q, scl));

      // Tropical greens skew yellow in the sun and blue in the shade.
      leafBase.setHSL(0.26 + random() * 0.055, 0.34 + random() * 0.22, 0.2 + random() * 0.13);
      crowns.setColorAt(i, leafBase);
    }
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    group.add(trunks, crowns);
  };

  place(broad, broadleafGeometry(), canopyGeometry(), barkMat, leafMat, 1, false);
  place(palms, palmTrunkGeometry(), palmCrownGeometry(), barkMat, frondMat, 1, true);

  return { group, materials: [barkMat, leafMat, frondMat], count: spots.length };
}
