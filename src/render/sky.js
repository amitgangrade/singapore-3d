import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { MERLION, PALETTE } from '../config.js';
import { clamp, lerp, smoothstep, rng } from '../core/util.js';

/**
 * Sky, sun, moon, stars and the environment map.
 *
 * The sun follows a real solar path for latitude 1.29 N, which is why the light
 * climbs almost vertically at midday and why dusk is short — both are
 * characteristic of the equator and neither would come out of an arbitrary
 * rotating light. The environment map is baked from the sky itself, so glass
 * towers reflect whatever colour the sky currently is.
 */

const DEG = Math.PI / 180;
const LAT = MERLION.lat * DEG;
const DECLINATION = 10 * DEG;      // a bright northern-summer day
const MOON_DECL = -8 * DEG;

/** Sun (or moon) direction in world axes for a given decimal hour. */
function bodyDirection(hours, declination, out) {
  const H = (hours - 12) * 15 * DEG;      // hour angle, 0 at solar noon
  const cd = Math.cos(declination), sd = Math.sin(declination);
  const east = -cd * Math.sin(H);
  const north = sd * Math.cos(LAT) - cd * Math.sin(LAT) * Math.cos(H);
  const up = sd * Math.sin(LAT) + cd * Math.cos(LAT) * Math.cos(H);
  return out.set(east, up, -north).normalize();
}

export class SkySystem {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.sky = new Sky();
    this.sky.scale.setScalar(9000);
    this.sky.name = 'sky';
    scene.add(this.sky);

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.nightT = 0;
    this.look = { ...PALETTE.day };

    // ---- stars
    const starCount = 2600;
    const random = rng(90210);
    const pos = new Float32Array(starCount * 3);
    const size = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      // Upper hemisphere only; the rest is below the city.
      const u = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const y = Math.abs(u) * 0.98 + 0.02;
      pos[i * 3] = Math.cos(phi) * r * 4500;
      pos[i * 3 + 1] = y * 4500;
      pos[i * 3 + 2] = Math.sin(phi) * r * 4500;
      size[i] = 5 + random() * 16;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.PointsMaterial({
      color: 0xdce8ff, size: 12, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false,
    });
    this.starMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSize;')
        .replace('gl_PointSize = size;', 'gl_PointSize = aSize;');
    };
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.name = 'stars';
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // ---- moon
    this.moonMat = new THREE.MeshBasicMaterial({
      color: 0xf2f4ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(75, 24, 18), this.moonMat);
    this.moon.name = 'moon';
    this.moon.frustumCulled = false;
    scene.add(this.moon);

    // ---- environment map baked from the sky
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(9000);
    this.envScene.add(this.envSky);
    this.envTarget = null;
    this._lastEnvHour = -99;
  }

  /**
   * @param hours decimal hour of day, 0..24
   * @returns the interpolated look, for other systems to match
   */
  setTime(hours) {
    bodyDirection(hours, DECLINATION, this.sunDir);
    bodyDirection((hours + 12) % 24, MOON_DECL, this.moonDir);

    // Night fraction from the sun's altitude: full day above +5 degrees, full
    // night below -7. Near the equator this transition is genuinely fast.
    const altDeg = Math.asin(clamp(this.sunDir.y, -1, 1)) / DEG;
    this.nightT = 1 - smoothstep(clamp((altDeg + 7) / 12, 0, 1));

    const d = PALETTE.day;
    const n = PALETTE.night;
    const t = this.nightT;
    const L = this.look;
    for (const key of Object.keys(d)) {
      if (typeof d[key] === 'number') L[key] = lerp(d[key], n[key], t);
    }
    // Colours interpolate in RGB, which is close enough over these ranges.
    for (const key of ['sunColor', 'hemiSky', 'hemiGround', 'ambient', 'fogColor', 'waterColor']) {
      L[key] = mixHex(d[key], n[key], t);
    }
    // Warm the sun and redden the horizon while it is low.
    const low = 1 - clamp(Math.abs(altDeg) / 18, 0, 1);
    if (altDeg > -8) {
      L.sunColor = mixHex(L.sunColor, 0xff8a3c, low * 0.85);
      L.fogColor = mixHex(L.fogColor, 0xd88a5a, low * 0.5);
      L.turbidity = lerp(L.turbidity, 12, low * 0.8);
      L.rayleigh = lerp(L.rayleigh, 2.6, low * 0.7);
    }

    // Shadow-casting direction: the sun while it is up, the moon after that.
    const sunUp = this.sunDir.y > 0.02;
    this.lightDir.copy(sunUp ? this.sunDir : this.moonDir);
    if (!sunUp && this.moonDir.y < 0.05) this.lightDir.set(0.2, 0.9, 0.3).normalize();

    // ---- sky shader
    for (const sky of [this.sky, this.envSky]) {
      const u = sky.material.uniforms;
      u.turbidity.value = L.turbidity;
      u.rayleigh.value = L.rayleigh;
      u.mieCoefficient.value = L.mieCoefficient;
      u.mieDirectionalG.value = L.mieDirectionalG;
      u.sunPosition.value.copy(this.sunDir);
    }

    this.starMat.opacity = clamp((t - 0.25) / 0.55, 0, 1) * 0.95;
    this.moonMat.opacity = clamp((t - 0.15) / 0.4, 0, 1);
    this.moon.visible = this.moonDir.y > -0.1 && this.moonMat.opacity > 0.01;
    this.moon.position.copy(this.moonDir).multiplyScalar(4700);

    return L;
  }

  /** Follow the camera so sky, stars and moon never come within reach. */
  follow(camera) {
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.moon.position.copy(this.moonDir).multiplyScalar(4700).add(camera.position);
  }

  /** Rebake the environment map. Throttled by the caller via `hours`. */
  updateEnvironment(hours, force = false) {
    if (!force && Math.abs(hours - this._lastEnvHour) < 0.12) return;
    this._lastEnvHour = hours;
    const prev = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene);
    this.scene.environment = this.envTarget.texture;
    if (prev) prev.dispose();
  }

  dispose() {
    this.pmrem.dispose();
    if (this.envTarget) this.envTarget.dispose();
  }
}

const _a = new THREE.Color();
const _b = new THREE.Color();
function mixHex(a, b, t) {
  _a.set(a);
  _b.set(b);
  return _a.lerp(_b, t).getHex();
}
