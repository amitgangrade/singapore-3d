import * as THREE from 'three';
import './style.css';

import { QUALITY, PALETTE, HALF, DAY_HOUR, NIGHT_HOUR } from './config.js';
import { Heightfield } from './core/heightfield.js';
import { FootprintIndex } from './core/footprintIndex.js';
import { makeCityUniforms } from './render/materials.js';
import { SkySystem } from './render/sky.js';
import { createComposer } from './render/composer.js';
import { buildTerrain } from './world/terrain.js';
import { buildWater } from './world/water.js';
import { buildRoads } from './world/roads.js';
import { buildBuildings } from './world/buildings.js';
import { buildTrees } from './world/nature.js';
import { buildStreetLights } from './world/lights.js';
import { buildTraffic } from './world/traffic.js';
import { buildLandmarks, REPLACED_BY_LANDMARK } from './world/landmarks.js';
import { Controller } from './controls/controller.js';
import { Hud } from './ui/hud.js';
import { LabelLayer } from './ui/labels.js';
import { clamp, lerp } from './core/util.js';

const canvas = document.getElementById('scene');

// Collected so the headless screenshot tool can report failures it cannot see.
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,          // the composer's target is multisampled instead
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let quality = QUALITY.high;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(PALETTE.day.fogColor, PALETTE.day.fogDensity);

const camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.3, 14000);
camera.rotation.order = 'YXZ';

// ------------------------------------------------------------------ lights ----
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 2600;
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.7;
scene.add(sun, sun.target);

const hemi = new THREE.HemisphereLight(0x9fc6e8, 0x6b6152, 0.85);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x33475a, 0.22);
scene.add(ambient);

const uniforms = makeCityUniforms();

// ------------------------------------------------------------------- boot -----
const hud = new Hud({});
const world = {};
let sky, post, ctrl, labels;
let hours = DAY_HOUR;
let targetHours = DAY_HOUR;
let transition = 0;          // seconds remaining in a day/night fade

/**
 * Yield to the browser so the loading bar actually paints between steps.
 * Falls back to a timer in a background tab, where rAF never fires and the
 * whole boot would otherwise stall.
 */
const yieldFrame = () => new Promise((resolve) => {
  if (document.visibilityState === 'hidden') setTimeout(resolve, 0);
  else requestAnimationFrame(() => requestAnimationFrame(resolve));
});

async function step(fraction, label, fn) {
  hud.setLoading(fraction, label);
  await yieldFrame();
  return fn();
}

async function boot() {
  const city = await step(0.05, 'loading Singapore geometry…', async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/city.json`);
    if (!res.ok) throw new Error(`city.json: ${res.status} ${res.statusText}`);
    return res.json();
  });

  // Hand-modelled landmarks supersede a few OSM volumes. Keep the originals:
  // the landmark builder derives its position and orientation from them.
  const replaced = city.buildings.filter(REPLACED_BY_LANDMARK)
    .concat(city.parts.filter(REPLACED_BY_LANDMARK));
  city.parts = city.parts.filter((b) => !REPLACED_BY_LANDMARK(b));
  city.buildings = city.buildings.filter((b) => !REPLACED_BY_LANDMARK(b));

  const hf = await step(0.16, 'shaping ground, shoreline and Fort Canning…',
    () => new Heightfield(city));
  world.hf = hf;

  world.buildings = await step(0.3, 'extruding 1,400 buildings…',
    () => buildBuildings(city, hf, uniforms));
  scene.add(world.buildings.group);

  world.index = new FootprintIndex(world.buildings.footprints);

  world.roads = await step(0.48, 'laying roads, bridges and quays…',
    () => buildRoads(city, hf, uniforms, quality));
  scene.add(world.roads.group);

  world.terrain = await step(0.6, 'painting parks and reclaimed land…',
    () => buildTerrain(city, hf, uniforms));
  scene.add(world.terrain.group);

  world.water = await step(0.68, 'filling Marina Bay and the river…',
    () => buildWater(city, hf, uniforms, quality));
  scene.add(world.water.group);

  world.trees = await step(0.76, 'planting the garden city…',
    () => buildTrees(city, hf, world.index, quality));
  scene.add(world.trees.group);

  world.lights = await step(0.82, 'hanging the street lighting…',
    () => buildStreetLights(world.roads.lamps, world.buildings.towers, uniforms));
  scene.add(world.lights.group);

  world.traffic = await step(0.87, 'releasing traffic and bumboats…',
    () => buildTraffic(world.roads.carPaths, hf, uniforms, quality));
  scene.add(world.traffic.group);

  world.landmarks = await step(0.92, 'raising the Merlion and the Supertrees…',
    () => buildLandmarks(city, hf, uniforms, world.roads.bridgeDecks, replaced));
  scene.add(world.landmarks.group);

  // Roof-top mechanical plant, collected while extruding.
  await step(0.95, 'finishing rooftops…', () => addRoofPlant(world.buildings.roofBoxes));

  await step(0.97, 'lighting the sky…', () => {
    sky = new SkySystem(scene, renderer);
    post = createComposer(renderer, scene, camera, quality);
    sky.updateEnvironment(hours, true);
  });

  await step(0.99, 'ready', () => {
    ctrl = new Controller(camera, hf, world.index, canvas);
    ctrl.onLockChange = (locked) => hud.setLocked(locked);
    ctrl.onSpeedScale = (s) => hud.toast(`fly speed ${s.toFixed(2)}x`);

    labels = new LabelLayer(document.getElementById('labels'));
    labels.build({
      landmarks: world.landmarks.labels,
      towers: world.buildings.towers,
      city,
      hf,
    });

    wireHud();
    applyTime(hours, true);
  });

  const s = city.meta.stats;
  hud.setTriangleCount(scene);
  hud.finishLoading();
  hud.toast(`${s.buildings + s.buildingParts} buildings · ${s.roads} ways · ${world.trees.count} trees`, 3600);
  console.info('Singapore model:', {
    ...s,
    trees: world.trees.count,
    cars: world.traffic.counts.cars,
    boats: world.traffic.counts.boats,
    osm: city.meta.osmTimestamp,
  });

  // Handle for debugging and for the screenshot tool in tools/shoot.mjs.
  window.city = {
    THREE, renderer, scene, camera, sun, hemi, ambient, uniforms,
    sky, post, ctrl, hud, labels, world, applyTime,
    setTime(h) { hours = h; targetHours = h; transition = 0; applyTime(h, true); },
    ready: true,
  };

  animate();
}

/** Rooftop plant boxes, merged into one mesh. */
function addRoofPlant(boxes) {
  if (!boxes?.length) return;
  const geos = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0x8b8882, roughness: 0.8, metalness: 0.1 });
  mat.name = 'roof-plant';
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    g.translate(b.x, b.y + b.h / 2, b.z);
    geos.push(g);
  }
  // Concatenate manually; BoxGeometry attributes all match.
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const idx = [];
  let vo = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx.push(gi[i] + vo);
    vo += g.attributes.position.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'roof-plant';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  world.roofPlant = { mesh, materials: [mat] };
}

// ----------------------------------------------------------------- controls ---
function wireHud() {
  hud.h.onTime = (h) => { hours = h; targetHours = h; transition = 0; applyTime(h); };
  hud.h.onPreset = (which) => setPreset(which);
  hud.h.onReflect = (on) => {
    world.water.setReflections(on);
    hud.toast(on ? 'water reflections on' : 'water reflections off');
  };
  hud.h.onShadow = (on) => {
    renderer.shadowMap.enabled = on;
    sun.castShadow = on;
    scene.traverse((o) => { if (o.isMesh) o.material.needsUpdate = true; });
    hud.toast(on ? 'shadows on' : 'shadows off');
  };
  hud.h.onLabels = (on) => labels.setEnabled(on);
  hud.h.onTeleport = (place) => {
    ctrl.teleport(place);
    hud.toast(place.name);
  };
  hud.h.onQuality = (name) => {
    quality = QUALITY[name] ?? QUALITY.high;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    onResize();
    hud.toast(`${name} — tree density and reflection resolution apply on reload`, 2600);
  };

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    switch (e.code) {
      case 'KeyF':
        ctrl.setMode(ctrl.mode === 'fly' ? 'ground' : 'fly');
        hud.toast(ctrl.mode === 'fly' ? 'flying' : 'on foot — hold Shift to run');
        break;
      case 'KeyT':
        setPreset(sky.nightT > 0.5 ? 'day' : 'night');
        break;
      case 'KeyR':
        ctrl.reset();
        hud.toast('back to the opening view');
        break;
      case 'KeyH':
        hud.toggleHelp();
        break;
      default:
        break;
    }
  });

  const lock = () => { if (!ctrl.locked) ctrl.requestLock(); };
  canvas.addEventListener('click', lock);
  document.querySelector('#clickToStart div')?.addEventListener('click', lock);
}

function setPreset(which) {
  targetHours = which === 'night' ? NIGHT_HOUR : DAY_HOUR;
  transition = 1.6;
  hud.toast(which === 'night' ? 'night' : 'day');
}

/** Push the current time of day through every system that depends on it. */
function applyTime(h, force = false) {
  const look = sky.setTime(h);

  sun.color.set(look.sunColor);
  sun.intensity = look.sunIntensity;
  hemi.color.set(look.hemiSky);
  hemi.groundColor.set(look.hemiGround);
  hemi.intensity = look.hemiIntensity;
  ambient.color.set(look.ambient);
  ambient.intensity = look.ambientIntensity;

  scene.fog.color.set(look.fogColor);
  scene.fog.density = look.fogDensity;
  scene.environmentIntensity = look.envIntensity;

  uniforms.uNight.value = look.windowLight;
  post.setLook(look);
  sky.updateEnvironment(h, force);
  hud.setTimeUI(h);
  return look;
}

/** Keep the shadow frustum tight around whatever the player can see. */
const _focus = new THREE.Vector3();
const _fwd = new THREE.Vector3();
function updateShadow() {
  if (!sun.castShadow) return;
  camera.getWorldDirection(_fwd);
  // Look ahead, and widen the frustum with altitude so a flyover still has
  // shadows on the ground far below.
  const alt = clamp(ctrl.altitude, 0, 900);
  const span = clamp(quality.shadowSpan + alt * 1.15, quality.shadowSpan, 1500);
  _focus.copy(camera.position).addScaledVector(_fwd, span * 0.42);
  _focus.y = world.hf.at(clamp(_focus.x, -HALF, HALF), clamp(_focus.z, -HALF, HALF));

  sun.target.position.copy(_focus);
  sun.position.copy(_focus).addScaledVector(sky.lightDir, 1200);
  const c = sun.shadow.camera;
  if (c.right !== span) {
    c.left = -span; c.right = span; c.top = span; c.bottom = -span;
    c.updateProjectionMatrix();
  }
}

// ------------------------------------------------------------------- resize ---
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  post?.resize(w, h);
}
window.addEventListener('resize', onResize);

// -------------------------------------------------------------------- loop ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  // Day/night fade.
  if (transition > 0) {
    transition = Math.max(0, transition - dt);
    const t = 1 - transition / 1.6;
    hours = lerp(hours, targetHours, clamp(t * 0.14 + dt * 3.2, 0, 1));
    if (Math.abs(hours - targetHours) < 0.02) { hours = targetHours; transition = 0; }
    applyTime(hours);
  }

  uniforms.uTime.value += dt;

  ctrl.update(dt);
  sky.follow(camera);
  updateShadow();
  world.water.update(dt, sky.lightDir, sky.look);
  world.traffic.update(dt);
  world.landmarks.update(dt);

  labels.update(camera, window.innerWidth, window.innerHeight);
  hud.update(dt, ctrl, labels.nearest(camera), renderer);

  post.render(dt);
}

boot().catch((err) => {
  console.error(err);
  hud.setLoading(1, `failed: ${err.message}`);
});
