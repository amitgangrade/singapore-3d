import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { emissiveMaterial } from '../render/materials.js';
import { hash01 } from '../core/util.js';

/**
 * Street lighting and aviation warning lights.
 *
 * None of these are real THREE lights — a few thousand point lights would be
 * unrenderable. They are emissive geometry that the bloom pass turns into
 * glows, backed by the warm ground term in the hemisphere light and the sodium
 * spill baked into the road shader. Together that reads as a lit city at a
 * fraction of the cost.
 */

function lampPostGeometry(height, armLength) {
  const parts = [];
  const post = new THREE.CylinderGeometry(0.075, 0.11, height, 6);
  post.translate(0, height / 2, 0);
  parts.push(post);
  if (armLength > 0) {
    const arm = new THREE.BoxGeometry(armLength, 0.1, 0.1);
    arm.translate(armLength / 2, height - 0.12, 0);
    parts.push(arm);
    const hood = new THREE.BoxGeometry(0.62, 0.14, 0.3);
    hood.translate(armLength, height - 0.24, 0);
    parts.push(hood);
  }
  return mergeGeometries(parts);
}

export function buildStreetLights(lamps, towers, uniforms) {
  const group = new THREE.Group();
  group.name = 'city-lights';

  const postMat = new THREE.MeshStandardMaterial({ color: 0x33383c, roughness: 0.55, metalness: 0.6 });
  postMat.name = 'lamp-post';

  const roadLamp = emissiveMaterial(uniforms, 0xffc078, { strength: 2.2, dayVisible: 0.04 });
  const pedLamp = emissiveMaterial(uniforms, 0xffe2b0, { strength: 1.7, dayVisible: 0.04 });
  const aviation = emissiveMaterial(uniforms, 0xff3322, { strength: 2.8, dayVisible: 0.5 });

  const road = lamps.filter((l) => !l.ped);
  const ped = lamps.filter((l) => l.ped);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  const addLamps = (list, height, arm, bulbMat, bulbR, name) => {
    if (!list.length) return;
    const posts = new THREE.InstancedMesh(lampPostGeometry(height, arm), postMat, list.length);
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(bulbR, 8, 6), bulbMat, list.length);
    posts.castShadow = false;
    posts.name = `${name}-posts`;
    bulbs.name = `${name}-bulbs`;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      // Turn the arm to face the carriageway, deduced from the offset side.
      const yaw = Math.atan2(-l.z, -l.x) + (hash01(i * 977) > 0.5 ? 0 : Math.PI);
      e.set(0, yaw, 0);
      q.setFromEuler(e);
      pos.set(l.x, l.y, l.z);
      posts.setMatrixAt(i, m.compose(pos, q, one));
      pos.set(l.x + Math.cos(yaw) * arm, l.y + height - 0.28, l.z + Math.sin(yaw) * arm);
      bulbs.setMatrixAt(i, m.compose(pos, q, one));
    }
    posts.instanceMatrix.needsUpdate = true;
    bulbs.instanceMatrix.needsUpdate = true;
    group.add(posts, bulbs);
  };

  addLamps(road, 8.2, 1.7, roadLamp, 0.3, 'road-lamp');
  addLamps(ped, 4.0, 0.0, pedLamp, 0.22, 'ped-lamp');

  // ---- aviation obstruction lights on the tall towers
  const tall = towers.filter((t) => t.h >= 85);
  if (tall.length) {
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.55, 8, 6), aviation, tall.length);
    bulbs.name = 'aviation-lights';
    for (let i = 0; i < tall.length; i++) {
      pos.set(tall[i].x, tall[i].y + 1.6, tall[i].z);
      bulbs.setMatrixAt(i, m.compose(pos, q.identity(), one));
    }
    bulbs.instanceMatrix.needsUpdate = true;
    group.add(bulbs);
  }

  return { group, materials: [postMat, roadLamp, pedLamp, aviation] };
}
