import * as THREE from 'three';
import { FACADES, FLOOR_H, WINDOW_W } from '../config.js';

/**
 * All city surfaces are MeshStandardMaterial with a small amount of injected
 * GLSL. Going through the standard material (rather than a bespoke
 * ShaderMaterial) keeps shadows, fog, tone mapping and the environment map
 * working, while the injection adds the things that make the model read as a
 * city: per-building tint, a procedural window grid that lights up at night,
 * and lane markings on the roads.
 *
 * Custom attributes are used instead of `uv` so no `#ifdef USE_UV` gymnastics
 * are needed.
 */

const GLSL_HASH = /* glsl */ `
  float h21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
`;

export function makeCityUniforms() {
  return {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uWinWarm: { value: new THREE.Color(0xffc98a) },
    uWinCool: { value: new THREE.Color(0xbfe4ff) },
    uMarking: { value: new THREE.Color(0xf2e9d0) },
  };
}

function patch(material, uniforms, vertexHead, vertexBody, fragHead, fragBody) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_HASH}\n${fragHead}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${fragBody}`);
  };
  // Distinguish the shader program from a stock standard material.
  material.customProgramCacheKey = () => material.name || 'city';
  return material;
}

// ------------------------------------------------------------- buildings ----

/**
 * @param family key into FACADES
 * @param uniforms shared city uniforms
 */
export function buildingMaterial(family, uniforms) {
  const spec = FACADES[family] ?? FACADES.concrete;
  const mat = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
    envMapIntensity: 0.8,
  });
  mat.name = `bldg-${family}`;
  const isGlass = family === 'glass' || family === 'metal';

  const vertexHead = /* glsl */ `
    attribute vec2 aUv;      // x = facade module index, y = storey index
    attribute float aId;     // per-building id
    attribute float aRoof;   // 1 on horizontal caps
    attribute vec3 aTint;    // per-building colour multiplier
    varying vec2 vAUv;
    varying float vId;
    varying float vRoof;
    varying vec3 vTint;
  `;
  const vertexBody = /* glsl */ `
    vAUv = aUv; vId = aId; vRoof = aRoof; vTint = aTint;
  `;
  const fragHead = /* glsl */ `
    uniform float uNight;
    uniform float uTime;
    uniform vec3 uWinWarm;
    uniform vec3 uWinCool;
    varying vec2 vAUv;
    varying float vId;
    varying float vRoof;
    varying vec3 vTint;
  `;
  const fragBody = /* glsl */ `
    diffuseColor.rgb *= vTint;

    if (vRoof > 0.5) {
      // Roofs: plant, gravel and mechanical clutter rather than glass.
      float g = h21(floor(vAUv * 0.55) + vId);
      diffuseColor.rgb *= 0.62 + 0.28 * g;
      #ifdef IS_GLASS
        roughnessFactor = 0.85;
        metalnessFactor = 0.12;
      #endif
    } else {
      vec2 cell = floor(vAUv);
      vec2 f = fract(vAUv);

      // Window pane inside its frame. Slightly taller than wide, like a
      // curtain-wall module.
      float paneX = smoothstep(0.14, 0.22, f.x) * smoothstep(0.86, 0.78, f.x);
      float paneY = smoothstep(0.18, 0.27, f.y) * smoothstep(0.93, 0.84, f.y);
      float pane = paneX * paneY;

      float r = h21(cell + vId * 17.0);
      // Ground floor of every building reads as shopfront: mostly lit.
      float groundFloor = 1.0 - step(1.0, vAUv.y);
      float litChance = mix(0.33, 0.74, groundFloor);
      float lit = step(1.0 - litChance, r) * pane;

      // A few offices flicker off/on very slowly so the skyline is not static.
      float slow = 0.86 + 0.14 * sin(uTime * 0.35 + r * 40.0 + vId * 3.0);
      vec3 tone = mix(uWinWarm, uWinCool, h21(cell * 1.7 + vId));
      totalEmissiveRadiance += tone * lit * slow * uNight * 0.8;

      // Daytime glass: panes darker and glossier than the frames.
      float dayPane = mix(1.0, 0.72, pane) ;
      diffuseColor.rgb *= mix(dayPane, 1.0, uNight * 0.55);
      float mullion = 1.0 - pane;
      diffuseColor.rgb *= 0.94 + 0.14 * mullion;
      roughnessFactor = clamp(roughnessFactor * mix(1.0, 0.55, pane), 0.05, 1.0);

      // Subtle vertical soiling streaks; stops large facades looking painted.
      float streak = h21(vec2(floor(vAUv.x * 2.0), 3.0) + vId);
      diffuseColor.rgb *= 1.0 - 0.06 * streak;
    }
  `;

  patch(mat, uniforms, vertexHead, vertexBody, fragHead, fragBody);
  if (isGlass) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.fragmentShader = '#define IS_GLASS\n' + shader.fragmentShader;
    };
  }
  return mat;
}

// ----------------------------------------------------------------- roads ----

export function roadMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.02,
    envMapIntensity: 0.4,
  });
  mat.name = 'road';
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;

  const vertexHead = /* glsl */ `
    attribute vec2 aUv;     // x = 0..1 across the carriageway, y = metres along
    attribute vec3 aColor;
    attribute float aW;     // width in metres
    attribute float aMark;  // 1 = has lane markings
    varying vec2 vAUv;
    varying vec3 vCol;
    varying float vW;
    varying float vMark;
  `;
  const vertexBody = `vAUv = aUv; vCol = aColor; vW = aW; vMark = aMark;`;
  const fragHead = /* glsl */ `
    uniform float uNight;
    uniform vec3 uMarking;
    varying vec2 vAUv;
    varying vec3 vCol;
    varying float vW;
    varying float vMark;
  `;
  const fragBody = /* glsl */ `
    diffuseColor.rgb *= vCol;

    // Aggregate speckle, and a faint longitudinal wear pattern in the wheel paths.
    float grain = h21(floor(vec2(vAUv.x * vW, vAUv.y) * 3.0));
    diffuseColor.rgb *= 0.9 + 0.2 * grain;
    float wheel = exp(-pow((abs(vAUv.x - 0.5) - 0.22) * 9.0, 2.0));
    diffuseColor.rgb *= 1.0 - 0.1 * wheel * vMark;

    if (vMark > 0.5) {
      float halfW = max(vW * 0.5, 0.5);
      // 0.12 m paint, expressed in normalised across-width units.
      float pw = 0.12 / vW;
      float centre = 1.0 - smoothstep(pw * 0.6, pw * 1.6, abs(vAUv.x - 0.5));
      float dash = step(0.45, fract(vAUv.y / 13.0));
      float edgeL = 1.0 - smoothstep(pw * 0.6, pw * 1.7, abs(vAUv.x - 0.055));
      float edgeR = 1.0 - smoothstep(pw * 0.6, pw * 1.7, abs(vAUv.x - 0.945));
      float paint = clamp(centre * dash + (edgeL + edgeR) * 0.9, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, uMarking * 0.92, paint * 0.85);
      // Retro-reflective at night.
      totalEmissiveRadiance += uMarking * paint * uNight * 0.16;
      // Kerb shading at the very edge.
      float kerb = smoothstep(0.5, 0.49, abs(vAUv.x - 0.5) * 2.0) ;
      diffuseColor.rgb *= 0.75 + 0.25 * kerb;
    }

    // Wet-look asphalt after dark: sharper highlights, slightly darker base.
    roughnessFactor = clamp(roughnessFactor * mix(1.0, 0.42, uNight), 0.04, 1.0);
    metalnessFactor = mix(metalnessFactor, 0.22, uNight);
    diffuseColor.rgb *= mix(1.0, 0.78, uNight);

    /*
     * Pavement picks up the surrounding light after dark. Carriageways get a
     * sodium wash pooling under the street lamps; footways and plazas get a
     * cooler, softer lift, since they are lit by shopfronts and bollards rather
     * than by high-pressure sodium. Cheaper and steadier than the hundreds of
     * real point lights this stands in for.
     */
    vec3 sodium = vec3(0.26, 0.165, 0.068);
    vec3 spill  = vec3(0.125, 0.140, 0.180);
    float pool = 0.66 + 0.34 * sin(vAUv.y * 0.196);   // ~32 m lamp spacing
    totalEmissiveRadiance += mix(spill, sodium * pool, vMark) * uNight;
  `;
  return patch(mat, uniforms, vertexHead, vertexBody, fragHead, fragBody);
}

// ----------------------------------------------------------------- green ----

export function surfaceMaterial(uniforms, { roughness = 0.9, metalness = 0, name = 'surface' } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness,
    metalness,
    envMapIntensity: 0.55,
    vertexColors: true,
  });
  mat.name = name;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;

  const vertexHead = `attribute vec2 aUv;\nvarying vec2 vAUv;`;
  const vertexBody = `vAUv = aUv;`;
  const fragHead = `uniform float uNight;\nvarying vec2 vAUv;`;
  const fragBody = /* glsl */ `
    // Mottled vegetation so lawns are not flat colour fields.
    float m = h21(floor(vAUv * 0.34)) * 0.5 + h21(floor(vAUv * 1.3)) * 0.5;
    diffuseColor.rgb *= 0.82 + 0.34 * m;
    diffuseColor.rgb *= mix(1.0, 0.82, uNight);
    // Ground catches the city's ambient glow at night; planted ground keeps its
    // colour rather than washing to grey.
    vec3 groundGlow = mix(vec3(0.075, 0.082, 0.105), diffuseColor.rgb * 1.4, 0.45);
    totalEmissiveRadiance += groundGlow * uNight;
  `;
  return patch(mat, uniforms, vertexHead, vertexBody, fragHead, fragBody);
}

/** Plain concrete for bridge structure, parapets, pylons, plinths. */
export function structureMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9c9a95,
    roughness: 0.8,
    metalness: 0.05,
    envMapIntensity: 0.6,
    vertexColors: true,
  });
  mat.name = 'structure';
  return mat;
}

/**
 * Foliage lit by the city rather than by the sun.
 *
 * The canopy tints are deliberately dark so trees read correctly in daylight,
 * but scaling those directly leaves them near-black at night. The glow is
 * therefore pushed toward a saturated green, so park planting and street trees
 * stay recognisably green after dark instead of becoming grey silhouettes.
 */
export function foliageNightGlow(material, uniforms, strength = 0.09, green = 0.65) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         vec3 leafGlow = mix(diffuseColor.rgb, vec3(0.16, 0.62, 0.24), ${green.toFixed(3)});
         totalEmissiveRadiance += leafGlow * uNight * ${strength.toFixed(3)};`
      );
  };
  material.customProgramCacheKey = () => `foliage-${strength}-${green}`;
  return material;
}

/**
 * Emissive material used for lamps, aviation lights, neon and the bridge
 * lighting. With `vertexColors` the hue comes from the geometry, so a single
 * material can carry every bridge's colour.
 */
export function emissiveMaterial(uniforms, color, {
  strength = 1, dayVisible = 0.15, vertexColors = false,
} = {}) {
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: true, vertexColors });
  mat.name = 'emissive';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // Scale before tone mapping so values above 1 actually reach the bloom pass.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uNight;`)
      .replace(
        '#include <opaque_fragment>',
        `diffuseColor.rgb *= mix(${dayVisible.toFixed(3)}, ${strength.toFixed(3)}, uNight);\n#include <opaque_fragment>`
      );
  };
  mat.customProgramCacheKey = () => `emissive-${color}-${strength}-${vertexColors}`;
  return mat;
}

export const FLOOR_HEIGHT = FLOOR_H;
export const MODULE_WIDTH = WINDOW_W;
