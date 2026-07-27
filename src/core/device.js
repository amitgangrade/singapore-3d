/**
 * Input-capability detection.
 *
 * Keyed off the pointer type rather than the user agent or the screen width: a
 * touchscreen laptop reports `maxTouchPoints > 0` but has a real mouse and
 * keyboard and should keep the desktop controls, while a phone in landscape can
 * be wider than a small desktop window.
 */

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
const points = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;

/** Primary input is a finger: use the on-screen controls. */
export const IS_TOUCH = coarse || (points > 0 && !fine);

/** Pointer Lock is unavailable on iOS and unreliable elsewhere on touch. */
export const HAS_POINTER_LOCK = !IS_TOUCH
  && typeof document !== 'undefined'
  && 'requestPointerLock' in document.documentElement;

/** Small screen as well as touch — drives the compact HUD and lower defaults. */
export const IS_PHONE = IS_TOUCH
  && typeof window !== 'undefined'
  && Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight) <= 820;
