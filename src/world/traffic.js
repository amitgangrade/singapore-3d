import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { emissiveMaterial } from '../render/materials.js';
import { rng, clamp } from '../core/util.js';
import { WATER_Y } from '../config.js';

/**
 * Moving traffic and river craft.
 *
 * Cars drive the real carriageways, offset into the correct lane (Singapore
 * drives on the left) and follow the deck profile over bridges. Bumboats work
 * loops on Marina Bay. Neither is simulated in any real sense — they follow
 * arc-length along a path — but movement is most of what makes a city model feel
 * inhabited, and the head and tail lights carry the night view.
 */

const CAR_COLOURS = [
  0xd8dadd, 0x2b2f36, 0x8b9099, 0x9c2f2a, 0x1f3f6b,
  0xe4e6e8, 0x4a4f55, 0x255c46, 0xb8b2a6, 0x30353c,
];

function carBodyGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(4.3, 0.85, 1.78);
  body.translate(0, 0.62, 0);
  parts.push(body);
  const cabin = new THREE.BoxGeometry(2.25, 0.72, 1.6);
  cabin.translate(-0.15, 1.35, 0);
  parts.push(cabin);
  return mergeGeometries(parts);
}

function busBodyGeometry() {
  const g = new THREE.BoxGeometry(11.5, 3.0, 2.5);
  g.translate(0, 1.75, 0);
  return g;
}

function boatGeometry() {
  const parts = [];
  const hull = new THREE.BoxGeometry(11, 1.3, 3.4);
  hull.translate(0, 0.65, 0);
  parts.push(hull);
  const bow = new THREE.ConeGeometry(1.7, 3, 4);
  bow.rotateZ(-Math.PI / 2);
  bow.scale(1, 1, 0.78);
  bow.translate(6.4, 0.65, 0);
  parts.push(bow);
  const cabin = new THREE.BoxGeometry(3.6, 1.9, 2.6);
  cabin.translate(-1.6, 2.2, 0);
  parts.push(cabin);
  const roof = new THREE.BoxGeometry(6.5, 0.2, 3.2);
  roof.translate(1.2, 2.05, 0);
  parts.push(roof);
  return mergeGeometries(parts);
}

/** Precompute cumulative arc length so cars can be positioned by distance. */
function prepPath(p) {
  const n = p.pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(
      p.pts[i * 2] - p.pts[(i - 1) * 2],
      p.pts[i * 2 + 1] - p.pts[(i - 1) * 2 + 1]
    );
  }
  return { ...p, cum, total: cum[n - 1] };
}

/** Position, heading and height at arc-length s along a path. */
function samplePath(path, s, lateral, out) {
  const { pts, ys, cum } = path;
  const n = cum.length;
  s = clamp(s, 0, path.total);
  let i = 1;
  // Paths are short; a linear scan beats the bookkeeping of a cursor per car.
  while (i < n - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (s - cum[i - 1]) / seg;
  const ax = pts[(i - 1) * 2], az = pts[(i - 1) * 2 + 1];
  const bx = pts[i * 2], bz = pts[i * 2 + 1];
  let dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz) || 1;
  dx /= L; dz /= L;
  out.x = ax + (bx - ax) * t + dz * lateral;
  out.z = az + (bz - az) * t - dx * lateral;
  out.y = ys[i - 1] + (ys[i] - ys[i - 1]) * t;
  out.yaw = Math.atan2(dz, dx);
  return out;
}

export function buildTraffic(carPaths, hf, uniforms, quality) {
  const random = rng(70707);
  const group = new THREE.Group();
  group.name = 'traffic';

  const paths = carPaths.filter((p) => p.len > 45).map(prepPath);
  const carCount = Math.round(clamp(paths.length * 0.55, 40, 260) * clamp(quality.treeScatter + 0.4, 0.5, 1.4));

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.5 });
  bodyMat.name = 'car-body';
  const headMat = emissiveMaterial(uniforms, 0xfff4de, { strength: 2.5, dayVisible: 0.25 });
  const tailMat = emissiveMaterial(uniforms, 0xff2a18, { strength: 1.9, dayVisible: 0.3 });
  const boatMat = new THREE.MeshStandardMaterial({ color: 0x8a7c63, roughness: 0.7, metalness: 0.15 });
  boatMat.name = 'boat';
  const boatLampMat = emissiveMaterial(uniforms, 0xffd9a0, { strength: 2.1, dayVisible: 0.1 });

  const cars = [];
  if (paths.length) {
    for (let i = 0; i < carCount; i++) {
      const path = paths[(random() * paths.length) | 0];
      const bus = random() < 0.11;
      // Left-hand traffic: forward lane is offset to the left of the direction
      // of travel, which in this axis convention is the negative normal.
      const dir = path.oneway ? 1 : (random() < 0.5 ? 1 : -1);
      const laneOffset = clamp(path.w * 0.24, 1.5, 4.2);
      cars.push({
        path,
        s: random() * path.total,
        dir,
        lateral: dir > 0 ? laneOffset : -laneOffset,
        speed: (bus ? 9 : 13) + random() * (bus ? 4 : 9),
        bus,
        colour: CAR_COLOURS[(random() * CAR_COLOURS.length) | 0],
      });
    }
  }

  const carMeshes = { car: null, bus: null, head: null, tail: null };
  const carsOnly = cars.filter((c) => !c.bus);
  const busesOnly = cars.filter((c) => c.bus);

  const colour = new THREE.Color();
  const mkInstanced = (geo, mat, n, name, shadow = true) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
    im.name = name;
    im.castShadow = shadow;
    im.frustumCulled = false;   // matrices change every frame
    im.count = n;
    return im;
  };

  carMeshes.car = mkInstanced(carBodyGeometry(), bodyMat, carsOnly.length, 'cars');
  carMeshes.bus = mkInstanced(busBodyGeometry(), bodyMat, busesOnly.length, 'buses');
  carMeshes.head = mkInstanced(new THREE.BoxGeometry(0.3, 0.24, 1.5), headMat, cars.length, 'headlights', false);
  carMeshes.tail = mkInstanced(new THREE.BoxGeometry(0.22, 0.2, 1.6), tailMat, cars.length, 'taillights', false);

  for (let i = 0; i < carsOnly.length; i++) {
    colour.set(carsOnly[i].colour);
    carMeshes.car.setColorAt(i, colour);
  }
  for (let i = 0; i < busesOnly.length; i++) {
    colour.set(0xd8dadd);
    carMeshes.bus.setColorAt(i, colour);
  }
  if (carMeshes.car.instanceColor) carMeshes.car.instanceColor.needsUpdate = true;
  if (carMeshes.bus.instanceColor) carMeshes.bus.instanceColor.needsUpdate = true;
  group.add(carMeshes.car, carMeshes.bus, carMeshes.head, carMeshes.tail);

  // ---------------------------------------------------------------- boats ----
  // Candidate loops in the open water, validated against the land mask so a
  // boat is never left sailing across the quay.
  const boatLoops = [];
  const candidates = [
    { cx: 620, cz: 150, r: 230 },
    { cx: 780, cz: -140, r: 150 },
    { cx: 330, cz: 250, r: 120 },
    { cx: 480, cz: -220, r: 110 },
  ];
  for (const c of candidates) {
    let r = c.r;
    let ok = false;
    for (let attempt = 0; attempt < 6 && r > 40; attempt++) {
      ok = true;
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        if (hf.landAt(c.cx + Math.cos(a) * r, c.cz + Math.sin(a) * r) > 0.22) { ok = false; break; }
      }
      if (ok) break;
      r *= 0.8;
    }
    if (ok) boatLoops.push({ ...c, r });
  }

  const boats = [];
  for (const loop of boatLoops) {
    const count = 1 + ((random() * 2) | 0);
    for (let i = 0; i < count; i++) {
      boats.push({
        loop,
        a: random() * Math.PI * 2,
        w: (random() < 0.5 ? 1 : -1) * (0.045 + random() * 0.04),
      });
    }
  }
  const boatMesh = mkInstanced(boatGeometry(), boatMat, boats.length, 'boats');
  const boatLamp = mkInstanced(new THREE.SphereGeometry(0.3, 6, 5), boatLampMat, boats.length, 'boat-lamps', false);
  group.add(boatMesh, boatLamp);

  // ---------------------------------------------------------------- update ---
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const sp = { x: 0, y: 0, z: 0, yaw: 0 };
  let clock = 0;

  function writeCar(mesh, idx, s, lightIdx) {
    // Body
    e.set(0, -sp.yaw, 0);
    q.setFromEuler(e);
    pos.set(sp.x, sp.y, sp.z);
    mesh.setMatrixAt(idx, m.compose(pos, q, one));
    // Lamps at either end, nudged outboard.
    const fwdX = Math.cos(sp.yaw), fwdZ = Math.sin(sp.yaw);
    const f = s.dir > 0 ? 1 : -1;
    pos.set(sp.x + fwdX * 2.2 * f, sp.y + 0.62, sp.z + fwdZ * 2.2 * f);
    carMeshes.head.setMatrixAt(lightIdx, m.compose(pos, q, one));
    pos.set(sp.x - fwdX * 2.2 * f, sp.y + 0.72, sp.z - fwdZ * 2.2 * f);
    carMeshes.tail.setMatrixAt(lightIdx, m.compose(pos, q, one));
  }

  function update(dt) {
    clock += dt;
    let ci = 0, bi = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      c.s += c.speed * dt * c.dir;
      if (c.s > c.path.total) c.s -= c.path.total;
      if (c.s < 0) c.s += c.path.total;
      samplePath(c.path, c.s, c.lateral, sp);
      if (c.bus) writeCar(carMeshes.bus, bi++, c, i);
      else writeCar(carMeshes.car, ci++, c, i);
    }
    carMeshes.car.instanceMatrix.needsUpdate = true;
    carMeshes.bus.instanceMatrix.needsUpdate = true;
    carMeshes.head.instanceMatrix.needsUpdate = true;
    carMeshes.tail.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      b.a += b.w * dt * 0.35;
      const x = b.loop.cx + Math.cos(b.a) * b.loop.r;
      const z = b.loop.cz + Math.sin(b.a) * b.loop.r;
      const bob = Math.sin(clock * 1.3 + i) * 0.12;
      // Tangent of the circle, in the direction of travel.
      const yaw = Math.atan2(Math.cos(b.a) * Math.sign(b.w), -Math.sin(b.a) * Math.sign(b.w));
      e.set(Math.sin(clock * 0.9 + i) * 0.015, -yaw, Math.sin(clock * 1.1 + i * 2) * 0.02);
      q.setFromEuler(e);
      pos.set(x, WATER_Y + 0.05 + bob, z);
      boatMesh.setMatrixAt(i, m.compose(pos, q, one));
      pos.set(x, WATER_Y + 3.4 + bob, z);
      boatLamp.setMatrixAt(i, m.compose(pos, q, one));
    }
    boatMesh.instanceMatrix.needsUpdate = true;
    boatLamp.instanceMatrix.needsUpdate = true;
  }

  update(0);

  return {
    group,
    update,
    materials: [bodyMat, headMat, tailMat, boatMat, boatLampMat],
    counts: { cars: cars.length, boats: boats.length },
  };
}
