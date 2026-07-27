import * as THREE from 'three';
import {
  MOVE, GRAVITY, JUMP_V, PLAYER_RADIUS, STEP_UP, WATER_Y, HALF, START,
} from '../config.js';
import { clamp } from '../core/util.js';

/**
 * Movement. Two modes share one camera:
 *
 *  - fly: a free camera with no collision, for surveying the model. W follows
 *    the view direction so you can dive at the skyline.
 *  - ground: walk or run at human speed, with gravity, a 1.68 m eye height,
 *    collision against building walls, kerb-height step-up, and bridge decks
 *    picked up from the deck grid so the river can be crossed on foot.
 */
export class Controller {
  constructor(camera, hf, index, dom) {
    this.camera = camera;
    this.hf = hf;
    this.index = index;
    this.dom = dom;

    this.mode = 'fly';
    this.running = false;
    this.pos = new THREE.Vector3(START.x, START.y, START.z);
    this.vel = new THREE.Vector3();
    this.yaw = START.yaw;
    this.pitch = START.pitch;
    this.flySpeedScale = 1;
    this.onGround = false;
    this.locked = false;
    this.sensitivity = 0.0021;

    this.keys = new Set();
    this._push = { x: 0, z: 0, top: 0 };
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._flat = new THREE.Vector3();

    this._bind();
    this.applyToCamera();
  }

  // ------------------------------------------------------------------ input --
  _bind() {
    const onKey = (e, down) => {
      const k = e.code;
      if (down) this.keys.add(k); else this.keys.delete(k);
      // Keys the browser would otherwise scroll or search with.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
    };
    this._onKeyDown = (e) => onKey(e, true);
    this._onKeyUp = (e) => onKey(e, false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = clamp(this.pitch - e.movementY * this.sensitivity, -1.54, 1.54);
    };
    document.addEventListener('mousemove', this._onMouseMove);

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    };
    document.addEventListener('pointerlockchange', this._onLockChange);

    this._onWheel = (e) => {
      if (this.mode !== 'fly') return;
      this.flySpeedScale = clamp(this.flySpeedScale * (e.deltaY > 0 ? 0.86 : 1.16), 0.12, 8);
      this.onSpeedScale?.(this.flySpeedScale);
      e.preventDefault();
    };
    this.dom.addEventListener('wheel', this._onWheel, { passive: false });
  }

  requestLock() {
    this.dom.requestPointerLock?.();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.dom.removeEventListener('wheel', this._onWheel);
  }

  // ------------------------------------------------------------------ state --
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.vel.set(0, 0, 0);
    if (mode === 'ground') {
      // Drop in from wherever the camera is, feet first.
      this.onGround = false;
      const g = this.groundHeight(this.pos.x, this.pos.z, this.pos.y);
      if (this.pos.y > g + 400) this.pos.y = g + 60;
      this.pitch = clamp(this.pitch, -0.7, 0.7);
    }
  }

  teleport(place) {
    this.pos.set(place.x, place.y, place.z);
    if (place.look) {
      const dx = place.look[0] - place.x;
      const dz = place.look[2] - place.z;
      const dy = (place.look[1] ?? place.y) - place.y;
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -1.3, 1.3);
    }
    this.setMode(place.mode === 'walk' ? 'ground' : 'fly');
    if (this.mode === 'ground') {
      this.pos.y = this.groundHeight(this.pos.x, this.pos.z, 1e9) + MOVE.walk.eye;
      this.onGround = true;
    }
    this.vel.set(0, 0, 0);
    this.applyToCamera();
  }

  reset() {
    this.pos.set(START.x, START.y, START.z);
    this.yaw = START.yaw;
    this.pitch = START.pitch;
    this.vel.set(0, 0, 0);
    this.setMode('fly');
    this.applyToCamera();
  }

  /** Walkable surface height under a point: terrain, or a bridge deck above it. */
  groundHeight(x, z, feetY) {
    let g = this.hf.at(x, z);
    const deck = this.hf.deckAt(x, z, 1);
    if (deck > -9000 && deck > g && deck <= feetY + STEP_UP + 0.35) g = deck;
    return g;
  }

  // ----------------------------------------------------------------- update --
  update(dt) {
    dt = Math.min(dt, 1 / 20);   // never let a stalled frame teleport the player
    const ground = this.mode === 'ground';
    const profile = ground ? MOVE.walk : MOVE.fly;

    this.running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    // Facing vectors.
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this._fwd.set(-sy * cp, sp, -cy * cp).normalize();
    this._right.set(cy, 0, -sy).normalize();

    // Desired direction.
    const wish = this._wish.set(0, 0, 0);
    // On foot you walk where you are facing horizontally; in the air you fly
    // where you are looking, pitch included.
    const f = ground ? this._flat.set(-sy, 0, -cy) : this._fwd;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) wish.add(f);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) wish.sub(f);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) wish.add(this._right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) wish.sub(this._right);

    if (ground) {
      wish.y = 0;
      if (wish.lengthSq() > 0) wish.normalize();
      const maxSpeed = MOVE.walk.max * (this.running ? MOVE.walk.boost : 1);
      const accel = MOVE.walk.accel * (this.onGround ? 1 : 0.32);
      this.vel.x += wish.x * accel * dt;
      this.vel.z += wish.z * accel * dt;

      // Horizontal damping, then clamp to the walk / run speed.
      const damp = Math.exp(-MOVE.walk.damp * (this.onGround ? 1 : 0.25) * dt);
      this.vel.x *= damp;
      this.vel.z *= damp;
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > maxSpeed) {
        this.vel.x = (this.vel.x / hs) * maxSpeed;
        this.vel.z = (this.vel.z / hs) * maxSpeed;
      }

      if (this.keys.has('Space') && this.onGround) {
        this.vel.y = JUMP_V;
        this.onGround = false;
      }
      this.vel.y -= GRAVITY * dt;

      this._moveGround(dt);
    } else {
      if (this.keys.has('Space')) wish.y += 1;
      if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) wish.y -= 1;
      if (wish.lengthSq() > 0) wish.normalize();
      const boost = this.running ? MOVE.fly.boost : 1;
      const accel = MOVE.fly.accel * this.flySpeedScale * boost;
      this.vel.addScaledVector(wish, accel * dt);
      this.vel.multiplyScalar(Math.exp(-MOVE.fly.damp * dt));
      const maxSpeed = MOVE.fly.max * this.flySpeedScale * boost;
      if (this.vel.length() > maxSpeed) this.vel.setLength(maxSpeed);
      this.pos.addScaledVector(this.vel, dt);

      // Never sink through the ground, even while flying.
      const floor = this.hf.at(this.pos.x, this.pos.z) + 1.6;
      if (this.pos.y < floor) {
        this.pos.y = floor;
        this.vel.y = Math.max(this.vel.y, 0);
      }
    }

    // Stay inside the modelled square.
    const lim = HALF - 4;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);
    this.pos.y = clamp(this.pos.y, -3, 2400);

    this.applyToCamera();
  }

  _moveGround(dt) {
    const feet = this.pos.y - MOVE.walk.eye;
    const r = PLAYER_RADIUS;

    // Horizontal step, resolved against walls one axis at a time so sliding
    // along a facade feels right rather than sticking.
    for (const axis of ['x', 'z']) {
      const delta = this.vel[axis] * dt;
      if (delta === 0) continue;
      const nx = this.pos.x + (axis === 'x' ? delta : 0);
      const nz = this.pos.z + (axis === 'z' ? delta : 0);

      // Refuse to wade into deep water.
      const g = this.groundHeight(nx, nz, feet);
      if (g < WATER_Y - 0.55) { this.vel[axis] = 0; continue; }

      this.index.resolve(nx, nz, r, feet, this._push);
      this.pos.x = nx + this._push.x;
      this.pos.z = nz + this._push.z;
      // A push that opposes the step means a wall was hit: stop pressing into it
      // but keep the other axis, so you slide along facades instead of sticking.
      const opposing = (axis === 'x' ? this._push.x : this._push.z) * delta;
      if (opposing < 0) this.vel[axis] = 0;
    }

    // Vertical.
    const newFeet = this.pos.y - MOVE.walk.eye + this.vel.y * dt;
    const g = this.groundHeight(this.pos.x, this.pos.z, Math.max(newFeet, this.pos.y - MOVE.walk.eye));
    if (newFeet <= g) {
      this.pos.y = g + MOVE.walk.eye;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.pos.y = newFeet + MOVE.walk.eye;
      this.onGround = false;
      // Step up over kerbs and low steps without needing to jump.
      const stepTarget = this.groundHeight(this.pos.x, this.pos.z, newFeet + STEP_UP);
      if (stepTarget > newFeet && stepTarget - newFeet <= STEP_UP) {
        this.pos.y = stepTarget + MOVE.walk.eye;
        this.vel.y = 0;
        this.onGround = true;
      }
    }
  }

  applyToCamera() {
    this.camera.position.copy(this.pos);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  get speedKmh() {
    const v = this.mode === 'ground' ? Math.hypot(this.vel.x, this.vel.z) : this.vel.length();
    return v * 3.6;
  }

  get altitude() {
    return this.pos.y - this.hf.at(this.pos.x, this.pos.z);
  }

  get modeLabel() {
    if (this.mode === 'fly') return 'FLY';
    return this.running ? 'RUN' : 'WALK';
  }
}
