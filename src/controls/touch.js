import { TOUCH } from '../config.js';
import { clamp } from '../core/util.js';

/**
 * On-screen controls for phones and tablets.
 *
 * Pointer Lock — which the desktop mouse-look depends on — does not exist on
 * iOS and is unreliable elsewhere on touch, so look is a straight drag instead.
 *
 * The layout follows the convention players already know from mobile games: a
 * thumbstick under the left thumb for movement, look anywhere else, and action
 * buttons under the right thumb. Every finger is tracked by pointerId so that
 * looking, walking and pinching can happen at the same time without the
 * gestures stealing each other's touches.
 */
export class TouchControls {
  /**
   * @param ctrl   the Controller to drive
   * @param canvas the render surface, which handles look and pinch
   * @param els    { stick, knob, mode, up, down } DOM elements
   */
  constructor(ctrl, canvas, els) {
    this.ctrl = ctrl;
    this.canvas = canvas;
    this.els = els;

    /** pointerId -> role, so a finger keeps its job until it lifts. */
    this.look = new Map();     // pointerId -> {x, y}
    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.pinchStart = 0;
    this.pinchScale = 0;
    this._announced = ctrl.flySpeedScale;

    this._bindLook();
    this._bindStick();
    this._bindButtons();
    this.syncMode();
  }

  // ------------------------------------------------------------------ look --
  _bindLook() {
    const onDown = (e) => {
      if (e.pointerType !== 'touch') return;
      this.look.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.canvas.setPointerCapture?.(e.pointerId);
      if (this.look.size === 2) {
        this.pinchStart = this._pinchDistance();
        this.pinchScale = this.ctrl.flySpeedScale;
      }
    };

    const onMove = (e) => {
      if (e.pointerType !== 'touch') return;
      const prev = this.look.get(e.pointerId);
      if (!prev) return;

      if (this.look.size >= 2) {
        // Two fingers: pinch to change fly speed, no look.
        prev.x = e.clientX;
        prev.y = e.clientY;
        const d = this._pinchDistance();
        if (this.pinchStart > 8 && d > 8) {
          const ratio = d / this.pinchStart;
          this.ctrl.flySpeedScale = clamp(
            this.pinchScale * (1 + (ratio - 1) * TOUCH.pinchSpeed), 0.12, 8
          );
          if (Math.abs(this.ctrl.flySpeedScale - this._announced) > this._announced * 0.15) {
            this._announced = this.ctrl.flySpeedScale;
            this.ctrl.onSpeedScale?.(this.ctrl.flySpeedScale);
          }
        }
        return;
      }

      this.ctrl.look(
        (e.clientX - prev.x) * TOUCH.lookSpeed,
        (e.clientY - prev.y) * TOUCH.lookSpeed
      );
      prev.x = e.clientX;
      prev.y = e.clientY;
    };

    const onUp = (e) => {
      if (e.pointerType !== 'touch') return;
      this.look.delete(e.pointerId);
      this.canvas.releasePointerCapture?.(e.pointerId);
      // Re-seed the pinch if one of two fingers lifted, so the remaining
      // finger does not jump the view on its next move.
      if (this.look.size === 1) {
        const only = this.look.values().next().value;
        if (only) { only.x = e.clientX; only.y = e.clientY; }
      }
    };

    this.canvas.addEventListener('pointerdown', onDown);
    this.canvas.addEventListener('pointermove', onMove);
    this.canvas.addEventListener('pointerup', onUp);
    this.canvas.addEventListener('pointercancel', onUp);
    this._look = { onDown, onMove, onUp };
  }

  _pinchDistance() {
    const [a, b] = [...this.look.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // ----------------------------------------------------------------- stick --
  _bindStick() {
    const { stick, knob } = this.els;
    if (!stick) return;

    const setKnob = (dx, dy) => {
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };

    const apply = (clientX, clientY) => {
      let dx = clientX - this.stickOrigin.x;
      let dy = clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      const max = TOUCH.stickRadius;
      if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
      setKnob(dx, dy);

      const mag = Math.min(len / max, 1);
      // Screen up is forward; screen right is strafe right.
      this.ctrl.touch.forward = -dy / max;
      this.ctrl.touch.strafe = dx / max;
      this.ctrl.touch.forward = clamp(this.ctrl.touch.forward, -1, 1);
      this.ctrl.touch.strafe = clamp(this.ctrl.touch.strafe, -1, 1);
      // Pushing the stick to its limit is the run / boost gesture, so there is
      // no separate button to hold.
      this.ctrl.touch.run = mag >= TOUCH.runThreshold;
      stick.classList.toggle('running', this.ctrl.touch.run);
    };

    const release = () => {
      this.stickId = null;
      this.ctrl.touch.forward = 0;
      this.ctrl.touch.strafe = 0;
      this.ctrl.touch.run = false;
      stick.classList.remove('active', 'running');
      setKnob(0, 0);
    };

    stick.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      stick.setPointerCapture?.(e.pointerId);
      stick.classList.add('active');
      // Anchor on the pad's centre so the knob is always reachable.
      const r = stick.getBoundingClientRect();
      this.stickOrigin.x = r.left + r.width / 2;
      this.stickOrigin.y = r.top + r.height / 2;
      apply(e.clientX, e.clientY);
      e.preventDefault();
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      apply(e.clientX, e.clientY);
      e.preventDefault();
    });
    // Not 'pointerleave': it fires even while the pointer is captured, which
    // would release the stick the moment the thumb travelled outside the pad.
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      stick.addEventListener(type, (e) => {
        if (e.pointerId !== this.stickId) return;
        release();
      });
    }
  }

  // --------------------------------------------------------------- buttons --
  _bindButtons() {
    const { mode, up, down } = this.els;

    // Hold-to-act buttons: ascend / descend while flying, jump on foot.
    const hold = (el, apply, clear) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('held');
        apply();
        e.preventDefault();
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        el.addEventListener(type, () => { el.classList.remove('held'); clear(); });
      }
    };

    hold(up,
      () => { if (this.ctrl.mode === 'fly') this.ctrl.touch.up = 1; else this.ctrl.touch.jump = true; },
      () => { this.ctrl.touch.up = 0; this.ctrl.touch.jump = false; });
    hold(down,
      () => { this.ctrl.touch.up = -1; },
      () => { this.ctrl.touch.up = 0; });

    mode?.addEventListener('click', () => {
      this.ctrl.setMode(this.ctrl.mode === 'fly' ? 'ground' : 'fly');
      this.syncMode();
      this.onModeChange?.(this.ctrl.mode);
    });
  }

  /** Relabel the buttons for the current movement mode. */
  syncMode() {
    const flying = this.ctrl.mode === 'fly';
    if (this.els.mode) this.els.mode.textContent = flying ? 'FLY' : 'WALK';
    if (this.els.up) this.els.up.textContent = flying ? '▲' : '⤒';
    if (this.els.down) this.els.down.style.visibility = flying ? 'visible' : 'hidden';
    // Vertical intent does not carry across a mode change.
    this.ctrl.touch.up = 0;
    this.ctrl.touch.jump = false;
  }
}
