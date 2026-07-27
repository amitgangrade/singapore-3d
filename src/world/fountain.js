import * as THREE from 'three';
import { FOUNTAIN, WATER_Y } from '../config.js';
import { rng, clamp } from '../core/util.js';

/**
 * The light and water show on Marina Bay, off the Marina Bay Sands Event Plaza.
 *
 * An arc of nozzles in the bay throws water columns that rise and fall on
 * overlapping sine cycles, with occasional full-height bursts running along the
 * arc as a wave. After dark the jets are lit from below in cycling colours and
 * searchlight beams sweep out over the water.
 *
 * Everything is additive, unlit geometry — water spray and light beams are
 * emissive by nature, and additive blending is both the right look and far
 * cheaper than trying to light a particle system. The jets are one instanced
 * mesh whose per-instance scale is rewritten each frame.
 */
export function buildFountainShow(hf, uniforms) {
  const group = new THREE.Group();
  group.name = 'fountain-show';
  const random = rng(5150);

  // ---- find open water near the requested spot
  const [tx, tz] = FOUNTAIN.target;
  let cx = tx;
  let cz = tz;
  if (hf.landAt(cx, cz) > 0.2) {
    let best = Infinity;
    for (let r = 20; r <= 320; r += 20) {
      for (let a = 0; a < 24; a++) {
        const x = tx + Math.cos((a / 24) * Math.PI * 2) * r;
        const z = tz + Math.sin((a / 24) * Math.PI * 2) * r;
        if (hf.landAt(x, z) > 0.15) continue;
        const d = Math.hypot(x - tx, z - tz);
        if (d < best) { best = d; cx = x; cz = z; }
      }
      if (best < Infinity) break;
    }
  }

  // Lay the nozzles along an arc facing the open bay (back toward the centre).
  const facing = Math.atan2(-cz, -cx);
  const across = facing + Math.PI / 2;

  const jetCount = FOUNTAIN.jets;
  const jets = [];
  for (let i = 0; i < jetCount; i++) {
    const t = jetCount > 1 ? i / (jetCount - 1) - 0.5 : 0;
    // Slight bow so the arc curves away from the plaza.
    const bow = (1 - Math.abs(t) * 2) * 14;
    const x = cx + Math.cos(across) * t * FOUNTAIN.spread + Math.cos(facing) * bow;
    const z = cz + Math.sin(across) * t * FOUNTAIN.spread + Math.sin(facing) * bow;
    jets.push({
      x, z,
      pos: t + 0.5,
      phase: random() * Math.PI * 2,
      speed: 0.55 + random() * 0.5,
      // Nozzles toward the middle of the arc throw higher.
      scale: 0.45 + (1 - Math.abs(t) * 2) * 0.55 + random() * 0.2,
      width: 1.25 + random() * 1.0,
    });
  }

  // ---- jet columns
  const jetGeo = new THREE.CylinderGeometry(0.32, 1.0, 1, 7, 1, true);
  jetGeo.translate(0, 0.5, 0);   // grows upward from the waterline
  const jetMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  jetMat.name = 'fountain-jet';
  const jetMesh = new THREE.InstancedMesh(jetGeo, jetMat, jetCount);
  jetMesh.name = 'fountain-jets';
  jetMesh.frustumCulled = false;
  jetMesh.castShadow = false;
  group.add(jetMesh);

  // ---- spray crowns at the top of each column
  const crownGeo = new THREE.SphereGeometry(1, 8, 6);
  const crownMat = jetMat.clone();
  crownMat.opacity = 0.3;
  const crownMesh = new THREE.InstancedMesh(crownGeo, crownMat, jetCount);
  crownMesh.name = 'fountain-spray';
  crownMesh.frustumCulled = false;
  group.add(crownMesh);

  /*
   * Pool of light on the water at the base of the arc. Radial falloff rather
   * than a flat disc — a constant-alpha circle reads as a sticker laid on the
   * bay, and its hard rim runs visibly over the promenade.
   */
  const poolMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uOpacity: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vLocal;
      void main() {
        float r = length(vLocal) / ${(FOUNTAIN.spread * 0.8).toFixed(1)};
        float a = pow(1.0 - clamp(r, 0.0, 1.0), 2.2);
        gl_FragColor = vec4(uColor, a * uOpacity);
      }
    `,
  });
  poolMat.name = 'fountain-glow';
  const pool = new THREE.Mesh(new THREE.CircleGeometry(FOUNTAIN.spread * 0.8, 48), poolMat);
  pool.name = 'fountain-glow';
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(cx, WATER_Y + 0.12, cz);
  group.add(pool);

  // ---- searchlight beams
  const beamCount = FOUNTAIN.beams;
  // Narrow at the nozzle, widening with distance — a cone the other way up.
  const beamGeo = new THREE.CylinderGeometry(1, 0.12, 1, 10, 1, true);
  beamGeo.translate(0, 0.5, 0);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, toneMapped: true,
  });
  beamMat.name = 'fountain-beam';
  const beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, beamCount);
  beamMesh.name = 'fountain-beams';
  beamMesh.frustumCulled = false;
  group.add(beamMesh);

  const beams = [];
  for (let i = 0; i < beamCount; i++) {
    const t = beamCount > 1 ? i / (beamCount - 1) - 0.5 : 0;
    beams.push({
      x: cx + Math.cos(across) * t * FOUNTAIN.spread * 0.9,
      z: cz + Math.sin(across) * t * FOUNTAIN.spread * 0.9,
      phase: random() * Math.PI * 2,
      speed: 0.18 + random() * 0.16,
      dir: random() < 0.5 ? 1 : -1,
      // Fan the beams out across the bay rather than firing them in parallel.
      splay: (beamCount > 1 ? i / (beamCount - 1) - 0.5 : 0) * 1.5,
      length: 95 + random() * 85,
    });
  }

  const palette = FOUNTAIN.palette.map((hex) => new THREE.Color(hex));

  // ---- per-frame state
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const colour = new THREE.Color();
  const mixA = new THREE.Color();
  const mixB = new THREE.Color();
  let clock = 0;

  function update(dt, nightT) {
    clock += dt;

    // Colour cycles slowly through the palette; by day the water is plain white.
    const cyc = (clock * 0.11) % palette.length;
    const i0 = Math.floor(cyc);
    const i1 = (i0 + 1) % palette.length;
    mixA.copy(palette[i0]).lerp(palette[i1], cyc - i0);
    // Daylight: white water. Night: lit in colour.
    mixB.setRGB(1, 1, 1).lerp(mixA, nightT * 0.85);

    jetMat.color.copy(mixB);
    crownMat.color.copy(mixB);
    jetMat.opacity = 0.22 + 0.20 * nightT;
    crownMat.opacity = 0.07 + 0.09 * nightT;

    // A swell travelling along the arc, plus each nozzle's own cycle.
    const wave = clock * 0.55;
    for (let i = 0; i < jetCount; i++) {
      const j = jets[i];
      const own = 0.5 + 0.5 * Math.sin(clock * j.speed + j.phase);
      const travelling = Math.max(0, Math.sin(wave - j.pos * Math.PI * 2.2));
      const burst = Math.pow(travelling, 3) * 0.85;
      const h = clamp((own * 0.55 + burst) * j.scale, 0.04, 1.35) * FOUNTAIN.maxHeight;

      p.set(j.x, WATER_Y, j.z);
      s.set(j.width, h, j.width);
      jetMesh.setMatrixAt(i, m.compose(p, q.identity(), s));

      // Flattened, not spherical: a ball on a stick reads as a lollipop.
      const spread = j.width * (1.3 + 1.3 * (h / FOUNTAIN.maxHeight));
      p.set(j.x, WATER_Y + h * 0.97, j.z);
      s.set(spread, spread * 0.3, spread);
      crownMesh.setMatrixAt(i, m.compose(p, q.identity(), s));
    }
    jetMesh.instanceMatrix.needsUpdate = true;
    crownMesh.instanceMatrix.needsUpdate = true;

    poolMat.uniforms.uOpacity.value = 0.06 + 0.26 * nightT;
    poolMat.uniforms.uColor.value.copy(mixB);

    // Beams only after dark.
    beamMat.opacity = 0.035 * nightT;
    beamMesh.visible = nightT > 0.02;
    if (beamMesh.visible) {
      beamMat.color.copy(mixA);
      for (let i = 0; i < beamCount; i++) {
        const b = beams[i];
        const sweep = Math.sin(clock * b.speed + b.phase) * 0.55 * b.dir;
        const tilt = 0.42 + 0.3 * Math.sin(clock * b.speed * 0.7 + b.phase);
        e.set(tilt, facing + b.splay + sweep * 0.5, 0, 'YXZ');
        q.setFromEuler(e);
        p.set(b.x, WATER_Y + 1.5, b.z);
        const w = 2.6 + 1.6 * Math.sin(clock * 0.4 + b.phase);
        s.set(w, b.length, w);
        beamMesh.setMatrixAt(i, m.compose(p, q, s));
      }
      beamMesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(0, 0);

  return {
    group,
    update,
    position: [cx, cz],
    materials: [jetMat, crownMat, poolMat, beamMat],
  };
}
