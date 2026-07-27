import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { WATER_Y } from '../config.js';
import { signedArea } from '../core/util.js';

/**
 * Marina Reservoir, the Singapore River, Dragonfly Lake and the smaller pools.
 *
 * The large bodies share one planar surface at the reservoir level and are drawn
 * with three's Water shader, which renders a real mirror pass — that is what
 * puts Marina Bay Sands and the CBD upside-down in the bay. Small fountains and
 * ponds sit at local ground level with a cheaper glossy material.
 *
 * Shape geometry is authored in XY and rotated onto XZ, because that is the
 * orientation Water derives its reflection plane from.
 */

const BIG_AREA = 2200;

/** Tiling normal map for the ripples, generated so there is no asset to load. */
function rippleNormals(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const waves = [
    { fx: 1, fz: 2, a: 1.0, p: 0.0 },
    { fx: 3, fz: -1, a: 0.55, p: 1.7 },
    { fx: -2, fz: 4, a: 0.35, p: 3.1 },
    { fx: 5, fz: 3, a: 0.22, p: 0.7 },
    { fx: 7, fz: -5, a: 0.12, p: 2.2 },
  ];
  const height = (u, v) => {
    let h = 0;
    for (const w of waves) {
      h += w.a * Math.sin(2 * Math.PI * (w.fx * u + w.fz * v) + w.p);
    }
    return h;
  };
  const e = 1 / size;
  const scale = 0.55;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const dx = (height(u + e, v) - height(u - e, v)) * scale;
      const dz = (height(u, v + e) - height(u, v - e)) * scale;
      const nx = -dx, ny = 1, nz = -dz;
      const L = Math.hypot(nx, ny, nz);
      const k = (j * size + i) * 4;
      data[k] = ((nx / L) * 0.5 + 0.5) * 255;
      data[k + 1] = ((ny / L) * 0.5 + 0.5) * 255;
      data[k + 2] = ((nz / L) * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Flat [x,z,...] ring -> Vector2 path in shape space (shape y = -world z). */
function toShapePoints(ring) {
  const pts = [];
  for (let i = 0; i < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i], -ring[i + 1]));
  return pts;
}

function shapeFor(rings, holes) {
  const shapes = [];
  for (const ring of rings) {
    const pts = toShapePoints(ring);
    if (pts.length < 3) continue;
    const shape = new THREE.Shape(pts);
    if (holes) {
      for (const h of holes) {
        const hp = toShapePoints(h);
        if (hp.length >= 3) shape.holes.push(new THREE.Path(hp));
      }
    }
    shapes.push(shape);
  }
  return shapes;
}

export function buildWater(city, hf, uniforms, quality) {
  const group = new THREE.Group();
  group.name = 'water';

  const bigShapes = [];
  const poolShapes = [];
  const poolYs = [];

  for (const w of city.water) {
    const a = w.rings.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
    if (w.n && /infinity/i.test(w.n)) continue;   // rooftop pool, no elevation in OSM
    if (a >= BIG_AREA) {
      bigShapes.push(...shapeFor(w.rings, w.holes));
    } else {
      const shapes = shapeFor(w.rings, w.holes);
      for (const s of shapes) {
        poolShapes.push(s);
        // Small bodies follow the local ground.
        const p = w.rings[0];
        poolYs.push(hf.at(p[0], p[1]) + 0.07);
      }
    }
  }

  // ---- large water surface
  let waterMesh = null;
  let flatMesh = null;
  if (bigShapes.length) {
    // The rotation onto the XZ plane must stay on the object, not be baked into
    // the geometry: Water builds its mirror plane from `matrixWorld` applied to
    // a hardcoded local normal of (0,0,1). Bake it and the bay is treated as a
    // vertical wall facing north, and no reflection appears at all.
    const geo = new THREE.ShapeGeometry(bigShapes, 6);
    geo.computeBoundingSphere();

    waterMesh = new Water(geo, {
      textureWidth: quality.reflectRes,
      textureHeight: quality.reflectRes,
      waterNormals: rippleNormals(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: 0x2c4a58,
      distortionScale: 2.6,
      fog: true,
      alpha: 0.95,
    });
    waterMesh.name = 'reservoir';
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = WATER_Y;
    waterMesh.material.uniforms.size.value = 3.2;
    waterMesh.renderOrder = 1;

    /*
     * three's Water shader mixes in a flat `vec3(0.1)` ambient floor plus 90%
     * of the mirror sample, with a Fresnel term that saturates at the grazing
     * angles you see a bay from. By day that is fine. At night the mirror
     * contains a dense, self-illuminated city that averages to a pale grey, so
     * the whole reservoir lifts to the colour of wet concrete instead of going
     * dark. Attenuating both terms after dark keeps the bright reflected
     * highlights while letting the water itself fall to near-black.
     */
    waterMesh.material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = uniforms.uNight;
      shader.fragmentShader = `uniform float uNight;\n${shader.fragmentShader}`.replace(
        'vec3( 0.1 ) + reflectionSample * 0.9',
        'vec3( 0.1 ) * ( 1.0 - uNight * 0.93 ) + reflectionSample * mix( 0.9, 0.3, uNight )'
      );
    };
    waterMesh.material.needsUpdate = true;

    group.add(waterMesh);

    // Cheap stand-in used when reflections are switched off.
    const flatMat = new THREE.MeshStandardMaterial({
      color: 0x223c48,
      roughness: 0.07,
      metalness: 0.42,
      envMapIntensity: 1.4,
    });
    flatMat.name = 'water-flat';
    flatMesh = new THREE.Mesh(geo, flatMat);
    flatMesh.name = 'reservoir-flat';
    flatMesh.rotation.x = -Math.PI / 2;
    flatMesh.position.y = WATER_Y;
    flatMesh.visible = false;
    flatMesh.matrixAutoUpdate = false;
    flatMesh.updateMatrix();
    group.add(flatMesh);
  }

  // ---- fountains, ponds, hotel pools
  const poolMat = new THREE.MeshStandardMaterial({
    color: 0x2f6f78,
    roughness: 0.06,
    metalness: 0.3,
    envMapIntensity: 1.5,
  });
  poolMat.name = 'pool';
  if (poolShapes.length) {
    // Each pool sits at its own height, so build them as one geometry with the
    // y baked per vertex.
    const geos = [];
    for (let i = 0; i < poolShapes.length; i++) {
      const g = new THREE.ShapeGeometry(poolShapes[i], 4);
      g.rotateX(-Math.PI / 2);
      g.translate(0, poolYs[i], 0);
      geos.push(g);
    }
    const merged = mergeSimple(geos);
    const pools = new THREE.Mesh(merged, poolMat);
    pools.name = 'pools';
    pools.renderOrder = 1;
    pools.matrixAutoUpdate = false;
    group.add(pools);
  }

  const api = {
    group,
    materials: [poolMat],
    reflectionsOn: true,
    setReflections(on) {
      api.reflectionsOn = on;
      if (waterMesh) waterMesh.visible = on;
      if (flatMesh) flatMesh.visible = !on;
    },
    /** Advance the ripples and match the surface to the current lighting. */
    update(dt, sunDir, look) {
      if (!waterMesh) return;
      const u = waterMesh.material.uniforms;
      u.time.value += dt * 0.32;
      u.sunDirection.value.copy(sunDir);
      u.sunColor.value.set(look.sunColor);
      u.waterColor.value.set(look.waterColor);
      u.distortionScale.value = look.waterDistortion;
      u.alpha.value = look.waterAlpha;
      if (flatMesh) {
        flatMesh.material.color.set(look.waterColor).multiplyScalar(1.7);
        flatMesh.material.roughness = 0.05 + 0.06 * (1 - look.windowLight);
      }
    },
  };
  return api;
}

/** Minimal position/normal/uv concatenation — avoids pulling in BufferGeometryUtils. */
function mergeSimple(geos) {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of geos) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const idx = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const nn = g.attributes.normal.array;
    pos.set(p, vo * 3);
    nrm.set(nn, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
