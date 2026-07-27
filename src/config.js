/** Tuning constants, palettes and named places. All distances in metres. */

export const MERLION = { lat: 1.28684, lon: 103.85459 };
export const EXTENT = 2000;          // 2 km x 2 km = 4 km^2
export const HALF = EXTENT / 2;
export const PAD = 200;              // terrain built slightly beyond the box
export const METRES_PER_DEG_LAT = 111319.49;
export const METRES_PER_DEG_LON = METRES_PER_DEG_LAT * Math.cos((MERLION.lat * Math.PI) / 180);

export const LAND_Y = 1.4;           // quay height above the reservoir surface
export const WATER_Y = 0.0;
export const WATER_BED = -4.5;
export const FLOOR_H = 3.4;          // storey height, drives the window grid
export const WINDOW_W = 3.6;         // facade module width

/** Movement profiles. */
export const MOVE = {
  fly:  { accel: 130, damp: 3.4, max: 95,  boost: 4.2, eye: 0 },
  walk: { accel: 46,  damp: 9.0, max: 1.5, boost: 4.0, eye: 1.68 },
};
export const GRAVITY = 22;
export const JUMP_V = 6.6;
export const PLAYER_RADIUS = 0.42;
export const STEP_UP = 0.62;         // kerbs and low steps are walked over

/** Day and night look. Everything in between is interpolated. */
export const PALETTE = {
  day: {
    // Low turbidity (little haze) with high rayleigh (strong blue scattering)
    // gives the clear light-blue sky rather than the milky white of a hazy one.
    turbidity: 1.8,
    rayleigh: 3.2,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.79,
    sunColor: 0xfff2df,
    sunIntensity: 4.3,
    hemiSky: 0x9fc6e8,
    hemiGround: 0x6b6152,
    // Indirect light is kept deliberately low. The equatorial sky is extremely
    // bright, and at full strength the hemisphere and environment terms flatten
    // the cast shadows to the point of invisibility.
    hemiIntensity: 0.34,
    ambient: 0x33475a,
    ambientIntensity: 0.07,
    fogColor: 0xaecfea,
    // Dense enough to fade the surrounds at 10 km while leaving the 2 km of
    // modelled city completely clear.
    fogDensity: 0.00019,
    waterColor: 0x25546e,
    waterAlpha: 0.94,
    waterDistortion: 2.6,
    bloomStrength: 0.16,
    bloomThreshold: 0.86,
    exposure: 0.95,
    windowLight: 0.0,
    lampLight: 0.0,
    envIntensity: 0.4,
  },
  night: {
    // Low turbidity and rayleigh, otherwise the atmosphere model keeps a bright
    // haze band on the horizon even with the sun 50 degrees below it.
    turbidity: 1.4,
    rayleigh: 0.13,
    mieCoefficient: 0.0016,
    mieDirectionalG: 0.86,
    sunColor: 0xb9cbe6,        // moonlight
    sunIntensity: 0.22,
    hemiSky: 0x16294d,         // blue skylight, matching the night dome
    hemiGround: 0x2b2016,      // sodium bounce off the streets
    hemiIntensity: 0.42,
    ambient: 0x1a2a44,
    ambientIntensity: 0.26,
    fogColor: 0x0d1a33,
    fogDensity: 0.00028,
    waterColor: 0x0a1f3d,      // deep blue bay rather than black
    waterAlpha: 0.97,
    waterDistortion: 1.9,
    // Restrained on purpose: tens of thousands of lit windows are emissive, and
    // an aggressive bloom turns the whole skyline into a white haze.
    bloomStrength: 0.42,
    bloomThreshold: 0.62,
    exposure: 1.02,
    windowLight: 1.0,
    lampLight: 1.0,
    envIntensity: 0.55,
  },
};

/** Facade families -> PBR parameters. */
export const FACADES = {
  // Roughness deliberately not mirror-sharp: on the narrow faces of the CBD
  // towers a near-perfect reflection of the equatorial sky blows out into solid
  // white slivers that read as broken geometry.
  glass:    { color: 0x7d93a4, roughness: 0.24, metalness: 0.55 },
  metal:    { color: 0x9aa4ac, roughness: 0.34, metalness: 0.7 },
  concrete: { color: 0x968f86, roughness: 0.78, metalness: 0.02 },
  plaster:  { color: 0xbcae99, roughness: 0.86, metalness: 0.0 },
  stone:    { color: 0xa79c88, roughness: 0.8,  metalness: 0.0 },
  brick:    { color: 0x9b6a55, roughness: 0.88, metalness: 0.0 },
  wood:     { color: 0x8c6a4a, roughness: 0.85, metalness: 0.0 },
};

/** Road surfaces. */
export const ROAD_STYLE = {
  motorway:   { color: 0x36393d, lane: 1, kerb: 1, lamp: 1 },
  trunk:      { color: 0x383b3f, lane: 1, kerb: 1, lamp: 1 },
  primary:    { color: 0x3a3d41, lane: 1, kerb: 1, lamp: 1 },
  secondary:  { color: 0x3c3f43, lane: 1, kerb: 1, lamp: 1 },
  tertiary:   { color: 0x3e4145, lane: 1, kerb: 1, lamp: 1 },
  residential:{ color: 0x424549, lane: 0, kerb: 1, lamp: 0 },
  service:    { color: 0x45484c, lane: 0, kerb: 0, lamp: 0 },
  raceway:    { color: 0x33363a, lane: 1, kerb: 1, lamp: 0 },
  pedestrian: { color: 0x8d8578, lane: 0, kerb: 0, lamp: 1 },
  footway:    { color: 0x8a8377, lane: 0, kerb: 0, lamp: 0 },
  steps:      { color: 0x807a70, lane: 0, kerb: 0, lamp: 0 },
  cycleway:   { color: 0x5c5f52, lane: 0, kerb: 0, lamp: 0 },
};

/** Park / vegetation surfaces. */
export const GREEN_STYLE = {
  park:   { color: 0x4e7342, trees: 1 / 260 },
  garden: { color: 0x577c46, trees: 1 / 190 },
  forest: { color: 0x3c5c34, trees: 1 / 70 },
  grass:  { color: 0x5c7d4c, trees: 1 / 900 },
  pitch:  { color: 0x4a7a48, trees: 0 },
};

/**
 * Quality presets. `treeScatter`, `lampStep` and `reflectRes` are baked when the
 * world is built, so changing preset at runtime only moves shadows, pixel ratio
 * and shadow span — the rest applies on reload.
 *
 * `phone` is picked automatically on touch devices: the mirror pass for the
 * water reflections is the single most expensive thing in the frame, so it is
 * cut hardest there.
 */
export const QUALITY = {
  ultra:  { shadowMap: 4096, shadowSpan: 420, reflectRes: 1024, pixelRatio: 1.6, treeScatter: 1.0, lampStep: 34, aa: 4 },
  high:   { shadowMap: 2048, shadowSpan: 340, reflectRes: 512,  pixelRatio: 1.25, treeScatter: 0.7, lampStep: 44, aa: 4 },
  medium: { shadowMap: 1024, shadowSpan: 250, reflectRes: 256,  pixelRatio: 1.0, treeScatter: 0.35, lampStep: 70, aa: 0 },
  phone:  { shadowMap: 1024, shadowSpan: 190, reflectRes: 128,  pixelRatio: 0.85, treeScatter: 0.2, lampStep: 95, aa: 0 },
};

/** Touch look and movement tuning. */
export const TOUCH = {
  lookSpeed: 0.0034,      // radians per CSS pixel dragged
  stickRadius: 52,        // px travel before the stick reads full deflection
  runThreshold: 0.82,     // stick deflection at which walking becomes running
  pinchSpeed: 0.9,        // fly-speed change per unit of pinch scale
};

/**
 * Jump targets, in local metres (x east, z south) derived from real coordinates.
 * `y` is a camera height; `look` is a point to face.
 */
export const PLACES = [
  { name: 'Merlion (centre)',       x: -6,    z: 26,   y: 14,  look: [40, 40, -60],  mode: 'walk' },
  { name: 'Marina Bay Sands',       x: 590,   z: 368,  y: 250, look: [0, 60, 0] },
  { name: 'MBS SkyPark view',       x: 585,   z: 300,  y: 215, look: [-300, 90, -60] },
  { name: 'Gardens by the Bay',     x: 985,   z: 520,  y: 90,  look: [600, 120, 380] },
  { name: 'Raffles Place / CBD',    x: -354,  z: 341,  y: 30,  look: [-250, 120, 250], mode: 'walk' },
  { name: 'Esplanade & Padang',     x: 132,   z: -303, y: 60,  look: [0, 20, 100] },
  { name: 'Singapore Flyer',        x: 940,   z: -250, y: 120, look: [200, 60, 100] },
  { name: 'Helix Bridge',           x: 683,   z: -8,   y: 12,  look: [200, 30, 120], mode: 'walk' },
  { name: 'Boat Quay',              x: -463,  z: 6,    y: 8,   look: [-200, 30, 60], mode: 'walk' },
  { name: 'Clarke Quay',            x: -889,  z: -407, y: 10,  look: [-500, 40, 0],  mode: 'walk' },
  { name: 'Fort Canning Hill',      x: -960,  z: -780, y: 62,  look: [-200, 60, 200] },
  { name: 'Skyline flyover',        x: 620,   z: 620,  y: 420, look: [-300, 100, -150] },
];

// Opening shot: hovering over Marina Bay, looking back across the Merlion at
// the CBD skyline. yaw solves forward = normalize(-x, -z) for (470, 430).
export const START = { x: 470, y: 118, z: 430, yaw: 0.829, pitch: -0.155 };

/**
 * Default clock positions. Mid-afternoon rather than noon: at 1.29 N the midday
 * sun is within 10 degrees of vertical, which leaves the city with no shadows
 * and no modelling at all.
 */
export const DAY_HOUR = 16.2;
export const NIGHT_HOUR = 21.4;

/**
 * The moon is placed by eye rather than by the ephemeris: low in the sky, on
 * the bearing of Marina Bay Sands, so it sits over the towers in the view the
 * model opens on. The real moon for a given date would be wherever it happened
 * to be, usually overhead and out of frame.
 */
export const MOON = { bearing: [590, 368], altitudeDeg: 17 };

/** Spectra, the light and water show on the bay at Marina Bay Sands. */
export const FOUNTAIN = {
  target: [505, 292],   // in the bay off the MBS Event Plaza
  jets: 30,
  spread: 105,          // metres across the arc of nozzles
  maxHeight: 26,
  beams: 8,
  palette: [0xff2f6e, 0x9b4bff, 0x2f8bff, 0x30e0c0, 0xffc24a, 0xff5a2f],
};
