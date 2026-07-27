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

    /*
     * The atmosphere model returns radiance well above 1.0, and ACES tone
     * mapping compresses everything up there to white — so no amount of
     * rayleigh tuning produces a blue sky, only a brighter white one. Scaling
     * the output back into the tone mapper's colourful range is what actually
     * makes the daytime sky read blue.
     */
    this.skyGain = { value: 0.22 };
    this.skySat = { value: 1.55 };
    this.skyBias = { value: 0.34 };
    this.skyTint = { value: new THREE.Color(0.62, 0.82, 1.18) };
    this.sky.material.onBeforeCompile = (shader) => {
      shader.uniforms.uSkyGain = this.skyGain;
      shader.uniforms.uSkySat = this.skySat;
      shader.uniforms.uSkyBias = this.skyBias;
      shader.uniforms.uSkyTint = this.skyTint;
      shader.fragmentShader = `
        uniform float uSkyGain;
        uniform float uSkySat;
        uniform float uSkyBias;
        uniform vec3 uSkyTint;
        ${shader.fragmentShader}`
        .replace('gl_FragColor = vec4( retColor, 1.0 );', `
          vec3 skyCol = retColor * uSkyGain;
          float skyLum = dot(skyCol, vec3(0.2126, 0.7152, 0.0722));
          // Saturate, then bias toward blue. Near the horizon the model goes
          // warm and grey, and a low equatorial sun leaves it that way across
          // most of the visible sky from street level.
          skyCol = mix(vec3(skyLum), skyCol, uSkySat);
          skyCol = mix(skyCol, vec3(skyLum) * uSkyTint, uSkyBias);
          gl_FragColor = vec4( max(skyCol, vec3(0.0)), 1.0 );`);
    };
    this.sky.material.needsUpdate = true;

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.nightT = 0;
    this.look = { ...PALETTE.day };

    this.sky.renderOrder = -3;
    this.uTime = { value: 0 };

    /*
     * Night gradient dome.
     *
     * With the sun 50 degrees below the horizon the atmosphere model has almost
     * nothing left to scatter and renders a flat near-black, which is accurate
     * but not what a clear tropical night looks like from a lit city. This dome
     * lays a deep blue gradient over it — lighter at the horizon, where the city
     * glow sits — plus a soft halo around the moon.
     */
    this.nightUniforms = {
      uHorizon: { value: new THREE.Color(0x1d3260) },
      uZenith: { value: new THREE.Color(0x050a1c) },
      uOpacity: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonGlow: { value: new THREE.Color(0x9fc0ff) },
    };
    this.nightDome = new THREE.Mesh(
      new THREE.SphereGeometry(8000, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.nightUniforms,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        // Depth testing must stay on. These are transparent, so three draws
        // them after the opaque pass; without the depth test they paint over
        // the entire city instead of sitting behind it.
        depthTest: true,
        fog: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uHorizon;
          uniform vec3 uZenith;
          uniform vec3 uMoonGlow;
          uniform vec3 uMoonDir;
          uniform float uOpacity;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(h, 0.6));
            // Warm lift right on the horizon: light pollution off the city.
            col += vec3(0.05, 0.035, 0.02) * pow(1.0 - h, 9.0);
            // Moon halo.
            float m = max(dot(normalize(vDir), normalize(uMoonDir)), 0.0);
            col += uMoonGlow * (pow(m, 220.0) * 0.55 + pow(m, 9.0) * 0.055);
            gl_FragColor = vec4(col, uOpacity);
          }
        `,
      })
    );
    this.nightDome.name = 'night-sky';
    this.nightDome.renderOrder = -2;
    this.nightDome.frustumCulled = false;
    scene.add(this.nightDome);

    // ---- stars
    const starCount = 4200;
    const random = rng(90210);
    const pos = new Float32Array(starCount * 3);
    const size = new Float32Array(starCount);
    const phase = new Float32Array(starCount);
    const tint = new Float32Array(starCount * 3);
    const c = new THREE.Color();
    for (let i = 0; i < starCount; i++) {
      // Upper hemisphere only; the rest is below the city.
      const u = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const y = Math.abs(u) * 0.98 + 0.02;
      pos[i * 3] = Math.cos(phi) * r * 4500;
      pos[i * 3 + 1] = y * 4500;
      pos[i * 3 + 2] = Math.sin(phi) * r * 4500;
      // A few bright ones among many faint, as in a real sky.
      const mag = random();
      size[i] = 5 + mag * mag * mag * 34;
      phase[i] = random();
      // Stars run from warm white through to blue-white.
      c.setHSL(0.55 + random() * 0.09, 0.35 * random(), 0.86 + random() * 0.14);
      tint[i * 3] = c.r; tint[i * 3 + 1] = c.g; tint[i * 3 + 2] = c.b;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    starGeo.setAttribute('color', new THREE.BufferAttribute(tint, 3));
    this.starMat = new THREE.PointsMaterial({
      size: 12, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0, depthWrite: false, depthTest: true, fog: false,
    });
    this.starMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          attribute float aSize;
          attribute float aPhase;
          varying float vTwinkle;`)
        .replace('gl_PointSize = size;', `gl_PointSize = aSize;
          vTwinkle = 0.62 + 0.38 * sin(uTime * 1.7 + aPhase * 43.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTwinkle;')
        .replace('#include <premultiplied_alpha_fragment>', `
          // Round the square point sprite off and fade its edge.
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          gl_FragColor.a *= smoothstep(0.5, 0.06, d) * vTwinkle;
          #include <premultiplied_alpha_fragment>`);
    };
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.name = 'stars';
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // ---- moon
    this.moonMat = new THREE.MeshBasicMaterial({
      color: 0xfdfaf0, transparent: true, opacity: 0,
      depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(110, 32, 24), this.moonMat);
    this.moon.name = 'moon';
    this.moon.renderOrder = -1;
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

    // Blue night dome fades in with dusk and carries the moon halo.
    this.nightUniforms.uOpacity.value = clamp((t - 0.08) / 0.5, 0, 1);
    this.nightUniforms.uMoonDir.value.copy(this.moonDir);
    this.nightDome.visible = this.nightUniforms.uOpacity.value > 0.005;

    this.starMat.opacity = clamp((t - 0.2) / 0.5, 0, 1);
    this.stars.visible = this.starMat.opacity > 0.01;
    this.moonMat.opacity = clamp((t - 0.12) / 0.35, 0, 1);
    this.moon.visible = this.moonDir.y > -0.06 && this.moonMat.opacity > 0.01;
    this.moon.position.copy(this.moonDir).multiplyScalar(4700);

    return L;
  }

  /** Follow the camera so sky, stars and moon never come within reach. */
  follow(camera, dt = 0) {
    this.uTime.value += dt;
    this.sky.position.copy(camera.position);
    this.nightDome.position.copy(camera.position);
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
