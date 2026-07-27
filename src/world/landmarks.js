import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { emissiveMaterial } from '../render/materials.js';
import { rng, centroidOf, bboxOf, scatterInRing, clamp } from '../core/util.js';
import { WATER_Y } from '../config.js';

/**
 * The four things OpenStreetMap does not describe well enough to extrude.
 *
 *  - The Merlion itself. OSM has the park and a POI node, no statue.
 *  - The Supertrees. Mapped only as the outline of Supertree Grove.
 *  - The Helix Bridge. Mapped as a plain bridge way, losing the double helix.
 *  - The Singapore Flyer. Mapped as a few blocky parts; replaced with a wheel.
 *
 * Everything else in the model — the Esplanade domes, the MBS towers and
 * SkyPark, the ArtScience Museum, the CBD — comes straight from OSM geometry.
 */

/** OSM volumes superseded by the hand-built versions below. */
export const REPLACED_BY_LANDMARK = (b) => /^Singapore Flyer$/.test(b.n ?? '') && b.h > 40;

/**
 * @param replaced the OSM volumes filtered out in favour of these landmarks;
 *   the Flyer's position and wheel orientation are derived from them.
 */
export function buildLandmarks(city, hf, uniforms, bridgeDecks, replaced = []) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const materials = [];
  const animated = [];
  const labels = [];

  const stone = new THREE.MeshStandardMaterial({ color: 0xd9d5cb, roughness: 0.62, metalness: 0.04 });
  stone.name = 'merlion-stone';
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9bfc4, roughness: 0.32, metalness: 0.72 });
  steel.name = 'steel';
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x5e6469, roughness: 0.45, metalness: 0.7 });
  darkSteel.name = 'dark-steel';
  const bark = new THREE.MeshStandardMaterial({ color: 0x5c4a42, roughness: 0.85, metalness: 0.05 });
  bark.name = 'supertree-trunk';
  const foliage = new THREE.MeshStandardMaterial({ color: 0x3f6238, roughness: 0.82 });
  foliage.name = 'supertree-canopy';
  const jet = new THREE.MeshStandardMaterial({
    color: 0xdff2ff, roughness: 0.06, metalness: 0.1,
    transparent: true, opacity: 0.42, depthWrite: false,
  });
  jet.name = 'water-jet';
  const glow = emissiveMaterial(uniforms, 0xd050ff, { strength: 1.7, dayVisible: 0.02 });
  const capsuleGlow = emissiveMaterial(uniforms, 0xbfe9ff, { strength: 1.5, dayVisible: 0.06 });
  materials.push(stone, steel, darkSteel, bark, foliage, jet, glow, capsuleGlow);

  // ------------------------------------------------------------- Merlion ----
  {
    // The statue stands at the origin of the model. Nudge to solid ground in
    // case the shoreline mask puts the exact point in the water.
    let sx = 0, sz = 0;
    if (hf.landAt(sx, sz) < 0.7) {
      outer: for (let r = 4; r <= 40; r += 4) {
        for (let a = 0; a < 12; a++) {
          const x = Math.cos((a / 12) * Math.PI * 2) * r;
          const z = Math.sin((a / 12) * Math.PI * 2) * r;
          if (hf.landAt(x, z) > 0.85) { sx = x; sz = z; break outer; }
        }
      }
    }
    const gy = hf.at(sx, sz);
    const merlion = new THREE.Group();
    merlion.name = 'merlion';
    merlion.position.set(sx, gy, sz);
    merlion.rotation.y = 0.35;     // faces out east-north-east across the bay

    /*
     * Roughly 9 m tall, like the real statue: a low plinth, a fish body rising
     * steeply, a curled tail behind, then a maned lion head on top. The pieces
     * are deliberately slim relative to the plinth — an earlier, fatter version
     * merged into a single featureless white mass at street level.
     */
    const parts = [];
    const apron = new THREE.CylinderGeometry(4.2, 4.5, 0.4, 28);
    apron.translate(0, 0.2, 0);
    parts.push(apron);
    const plinth = new THREE.CylinderGeometry(2.5, 2.9, 1.0, 24);
    plinth.translate(0, 0.9, 0);
    parts.push(plinth);

    // Fish body: tall and tapering, not a squat cone.
    const body = new THREE.CylinderGeometry(1.05, 1.95, 5.2, 18);
    body.translate(0, 4.0, 0);
    parts.push(body);

    // Scaled tail, curling low behind the body. Left in the default XY plane so
    // it reads as a curl side-on; rotating it into XZ swung it over the head.
    const tail = new THREE.TorusGeometry(1.6, 0.42, 8, 20, Math.PI * 0.9);
    tail.rotateZ(Math.PI * 0.1);
    tail.translate(-1.7, 3.0, 0);
    parts.push(tail);

    // Shoulders, then the mane as a ring around the head facing forward.
    const chest = new THREE.SphereGeometry(1.45, 18, 14);
    chest.scale(1, 0.85, 1);
    chest.translate(-0.1, 6.5, 0);
    parts.push(chest);
    const mane = new THREE.TorusGeometry(1.5, 0.46, 8, 22);
    mane.rotateY(Math.PI / 2);
    mane.translate(-0.15, 7.6, 0);
    parts.push(mane);
    const head = new THREE.SphereGeometry(1.1, 18, 14);
    head.translate(0.4, 7.7, 0);
    parts.push(head);
    const muzzle = new THREE.ConeGeometry(0.55, 1.4, 10);
    muzzle.rotateZ(-Math.PI / 2);
    muzzle.translate(1.55, 7.5, 0);
    parts.push(muzzle);
    for (const side of [0.6, -0.6]) {
      const ear = new THREE.ConeGeometry(0.28, 0.72, 6);
      ear.translate(0.15, 8.6, side);
      parts.push(ear);
    }

    merlion.add(new THREE.Mesh(mergeGeometries(parts), stone));

    // The jet: a tapering column of water arcing from the mouth into the bay.
    const jetLen = 18;
    const jetGeo = new THREE.CylinderGeometry(0.24, 1.0, jetLen, 12, 1, true);
    jetGeo.translate(0, -jetLen / 2, 0);
    const jetMesh = new THREE.Mesh(jetGeo, jet);
    jetMesh.position.set(2.3, 7.5, 0);
    jetMesh.rotation.z = Math.PI * 0.32;   // arcs forward, not straight down
    jetMesh.name = 'merlion-jet';
    merlion.add(jetMesh);

    for (const m of merlion.children) { m.castShadow = true; m.receiveShadow = true; }
    group.add(merlion);
    labels.push({ name: 'The Merlion', x: sx, z: sz, y: gy + 10, kind: 'landmark' });
  }

  // ----------------------------------------------------------- Supertrees ----
  {
    const grove = city.green.filter((g) => /supertree/i.test(g.n ?? ''));
    const random = rng(31415);
    for (const g of grove) {
      // Over-sample candidates: the minimum-spacing filter rejects most of them,
      // and asking for exactly 12 points only ever yielded three or four trees.
      const pts = scatterInRing(g.p, 90, random, g.holes);
      const placed = [];
      for (let i = 0; i < pts.length && placed.length < 12; i += 2) {
        const x = pts[i], z = pts[i + 1];
        if (placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < 20)) continue;
        placed.push([x, z]);
      }
      for (let i = 0; i < placed.length; i++) {
        const [x, z] = placed[i];
        const gy = hf.at(x, z);
        const H = 26 + random() * 24;
        const topR = clamp(H * 0.19, 5, 10);
        const tree = new THREE.Group();
        tree.name = 'supertree';
        tree.position.set(x, gy, z);

        const trunk = new THREE.CylinderGeometry(topR * 0.32, 1.05, H * 0.82, 14, 1);
        trunk.translate(0, (H * 0.82) / 2, 0);
        const trunkMesh = new THREE.Mesh(trunk, bark);
        trunkMesh.castShadow = true;
        tree.add(trunkMesh);

        // Planted ribs up the outside of the trunk — the lit panels after dark.
        // They must be pushed clear of the trunk radius, or they end up buried
        // inside it and the trunk just reads as a black post.
        const ribs = [];
        const ribCount = 12;
        const trunkMidR = (topR * 0.32 + 1.05) / 2;
        for (let k = 0; k < ribCount; k++) {
          const a = (k / ribCount) * Math.PI * 2;
          const rib = new THREE.BoxGeometry(0.3, H * 0.68, 0.3);
          rib.translate(trunkMidR + 0.35, H * 0.44, 0);
          rib.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
          ribs.push(rib);
        }
        tree.add(new THREE.Mesh(mergeGeometries(ribs), glow));

        const canopy = new THREE.CylinderGeometry(topR, topR * 0.5, 2.0, 18, 1);
        canopy.translate(0, H * 0.82 + 1.0, 0);
        const canopyMesh = new THREE.Mesh(canopy, foliage);
        canopyMesh.castShadow = true;
        tree.add(canopyMesh);

        // Underside glow, the colour the grove is known for.
        const disc = new THREE.CylinderGeometry(topR * 0.94, topR * 0.94, 0.25, 18);
        disc.translate(0, H * 0.82 - 0.1, 0);
        tree.add(new THREE.Mesh(disc, glow));

        group.add(tree);
      }
      if (placed.length) {
        const [cx, cz] = centroidOf(g.p);
        labels.push({ name: 'Supertree Grove', x: cx, z: cz, y: hf.at(cx, cz) + 52, kind: 'landmark' });
      }
    }
  }

  // ---------------------------------------------------------- Helix Bridge ----
  {
    const helixDecks = bridgeDecks.filter((d) => /helix/i.test(d.name));
    helixDecks.sort((a, b) => b.len - a.len);
    const deck = helixDecks[0];
    if (deck && deck.pts.length >= 8) {
      const spine = [];
      for (let i = 0; i < deck.pts.length; i += 2) {
        spine.push(new THREE.Vector3(deck.pts[i], deck.ys[i / 2] + 0.6, deck.pts[i + 1]));
      }
      const curve = new THREE.CatmullRomCurve3(spine, false, 'catmullrom', 0.4);
      const turns = Math.max(2.5, deck.len / 26);
      const R = deck.w * 0.52 + 1.2;
      const samples = Math.min(420, Math.max(90, Math.round(deck.len * 1.6)));

      const up = new THREE.Vector3(0, 1, 0);
      const tangent = new THREE.Vector3();
      const side = new THREE.Vector3();
      const vert = new THREE.Vector3();

      const strand = (phase) => {
        const pts = [];
        for (let i = 0; i <= samples; i++) {
          const t = i / samples;
          const base = curve.getPointAt(t);
          curve.getTangentAt(t, tangent);
          side.copy(tangent).cross(up).normalize();
          vert.copy(side).cross(tangent).normalize();
          const a = t * turns * Math.PI * 2 + phase;
          pts.push(new THREE.Vector3(
            base.x + side.x * Math.cos(a) * R + vert.x * Math.sin(a) * R * 0.55,
            base.y + side.y * Math.cos(a) * R + vert.y * Math.sin(a) * R * 0.55,
            base.z + side.z * Math.cos(a) * R + vert.z * Math.sin(a) * R * 0.55
          ));
        }
        return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), samples, 0.3, 6, false);
      };

      const helix = new THREE.Group();
      helix.name = 'helix-bridge';
      const a = new THREE.Mesh(strand(0), steel);
      const b = new THREE.Mesh(strand(Math.PI), steel);
      a.castShadow = b.castShadow = true;
      helix.add(a, b);
      group.add(helix);
      const mid = curve.getPointAt(0.5);
      labels.push({ name: 'Helix Bridge', x: mid.x, z: mid.z, y: mid.y + 8, kind: 'landmark' });
    }
  }

  // ------------------------------------------------------- Singapore Flyer ----
  {
    const flyerParts = replaced;
    if (flyerParts.length) {
      // Centre and wheel-plane direction from the footprints being replaced.
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of flyerParts) {
        const [a, b, c, d] = bboxOf(p.p);
        x0 = Math.min(x0, a); z0 = Math.min(z0, b);
        x1 = Math.max(x1, c); z1 = Math.max(z1, d);
      }
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const wheelR = 75;
      const hubY = 88;
      // The wheel plane follows the longer axis of the supporting structure.
      const yaw = (x1 - x0) >= (z1 - z0) ? 0 : Math.PI / 2;
      const gy = hf.at(cx, cz);

      const flyer = new THREE.Group();
      flyer.name = 'singapore-flyer';
      flyer.position.set(cx, 0, cz);
      flyer.rotation.y = yaw;

      // Wheel: two rims, spokes and a hub, all in the local XY plane.
      const wheel = new THREE.Group();
      wheel.name = 'flyer-wheel';
      wheel.position.y = hubY;

      const rimParts = [];
      for (const off of [-2.6, 2.6]) {
        const rim = new THREE.TorusGeometry(wheelR, 0.85, 8, 96);
        rim.translate(0, 0, off);
        rimParts.push(rim);
      }
      const spokeCount = 32;
      for (let i = 0; i < spokeCount; i++) {
        const a = (i / spokeCount) * Math.PI * 2;
        const s = new THREE.CylinderGeometry(0.22, 0.22, wheelR, 5);
        s.translate(0, wheelR / 2, 0);
        s.applyMatrix4(new THREE.Matrix4().makeRotationZ(a));
        rimParts.push(s);
      }
      const hub = new THREE.CylinderGeometry(3.4, 3.4, 7.5, 16);
      hub.rotateX(Math.PI / 2);
      rimParts.push(hub);
      const wheelMesh = new THREE.Mesh(mergeGeometries(rimParts), steel);
      wheelMesh.castShadow = true;
      wheel.add(wheelMesh);

      // Capsules ride the outside of the rim.
      const capsuleGeo = new THREE.CapsuleGeometry(2.0, 2.4, 6, 10);
      capsuleGeo.rotateZ(Math.PI / 2);
      const capsules = new THREE.InstancedMesh(capsuleGeo, capsuleGlow, 28);
      capsules.name = 'flyer-capsules';
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const one = new THREE.Vector3(1, 1, 1);
      const p = new THREE.Vector3();
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        p.set(Math.cos(a) * (wheelR + 3.4), Math.sin(a) * (wheelR + 3.4), 0);
        capsules.setMatrixAt(i, m.compose(p, q.identity(), one));
      }
      capsules.instanceMatrix.needsUpdate = true;
      wheel.add(capsules);
      flyer.add(wheel);

      // A-frame legs.
      const legs = [];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const legTop = new THREE.Vector3(0, hubY, sz * 3.0);
          const legFoot = new THREE.Vector3(sx * 34, gy, sz * 20);
          const dir = legFoot.clone().sub(legTop);
          const len = dir.length();
          const leg = new THREE.CylinderGeometry(1.5, 2.6, len, 10);
          leg.translate(0, -len / 2, 0);
          const rot = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, -1, 0), dir.clone().normalize());
          leg.applyQuaternion(rot);
          leg.translate(legTop.x, legTop.y, legTop.z);
          legs.push(leg);
        }
      }
      const legMesh = new THREE.Mesh(mergeGeometries(legs), darkSteel);
      legMesh.castShadow = true;
      flyer.add(legMesh);

      group.add(flyer);
      // 30 minutes per revolution, like the real thing.
      animated.push({ obj: wheel, rate: (Math.PI * 2) / (30 * 60) });
      labels.push({ name: 'Singapore Flyer', x: cx, z: cz, y: hubY + wheelR * 0.6, kind: 'landmark' });
    }
  }

  for (const child of group.children) child.traverse?.((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  return {
    group,
    materials,
    labels,
    update(dt) {
      for (const a of animated) a.obj.rotation.z += a.rate * dt;
    },
  };
}
