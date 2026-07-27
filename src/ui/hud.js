import { MERLION, METRES_PER_DEG_LAT, METRES_PER_DEG_LON, PLACES } from '../config.js';

/** Head-up display: readouts, compass, and the day/night and quality controls. */
export class Hud {
  constructor(handlers) {
    this.h = handlers;
    this.el = {
      hud: document.getElementById('hud'),
      mode: document.getElementById('hMode'),
      speed: document.getElementById('hSpeed'),
      alt: document.getElementById('hAlt'),
      latlon: document.getElementById('hLatLon'),
      near: document.getElementById('hNear'),
      clock: document.getElementById('hClock'),
      fps: document.getElementById('hFps'),
      tris: document.getElementById('hTris'),
      strip: document.getElementById('compassStrip'),
      compass: document.getElementById('compass'),
      slider: document.getElementById('timeSlider'),
      btnDay: document.getElementById('btnDay'),
      btnNight: document.getElementById('btnNight'),
      quality: document.getElementById('quality'),
      reflect: document.getElementById('cbReflect'),
      shadow: document.getElementById('cbShadow'),
      labels: document.getElementById('cbLabels'),
      teleport: document.getElementById('teleport'),
      help: document.getElementById('help'),
      crosshair: document.getElementById('crosshair'),
      toast: document.getElementById('toast'),
      loader: document.getElementById('loader'),
      loaderStep: document.getElementById('loaderStep'),
      barFill: document.getElementById('barFill'),
      clickToStart: document.getElementById('clickToStart'),
    };

    this._buildCompass();
    this._buildTeleport();
    this._bind();

    this._lastFps = 0;
    this._frames = 0;
    this._fpsClock = 0;
    this._toastTimer = 0;
  }

  _buildCompass() {
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    // Two full turns so the strip can scroll continuously without a seam.
    for (let d = 0; d < 720; d += 15) {
      const deg = d % 360;
      const label = names[deg] ?? (deg % 45 === 0 ? String(deg) : '·');
      html += `<i class="${names[deg] ? 'card' : ''}">${label}</i>`;
    }
    this.el.strip.innerHTML = html;
  }

  _buildTeleport() {
    for (let i = 0; i < PLACES.length; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = PLACES[i].name;
      this.el.teleport.appendChild(o);
    }
  }

  _bind() {
    this.el.slider.addEventListener('input', () => {
      this.h.onTime?.(Number(this.el.slider.value) / 60);
    });
    this.el.btnDay.addEventListener('click', () => this.h.onPreset?.('day'));
    this.el.btnNight.addEventListener('click', () => this.h.onPreset?.('night'));
    this.el.quality.addEventListener('change', () => this.h.onQuality?.(this.el.quality.value));
    this.el.reflect.addEventListener('change', () => this.h.onReflect?.(this.el.reflect.checked));
    this.el.shadow.addEventListener('change', () => this.h.onShadow?.(this.el.shadow.checked));
    this.el.labels.addEventListener('change', () => this.h.onLabels?.(this.el.labels.checked));
    this.el.teleport.addEventListener('change', () => {
      const i = Number(this.el.teleport.value);
      if (!Number.isNaN(i) && this.el.teleport.value !== '') {
        this.h.onTeleport?.(PLACES[i]);
        this.el.teleport.value = '';
        this.el.teleport.blur();
      }
    });
    // Panels must not swallow the movement keys once clicked.
    for (const el of [this.el.quality, this.el.teleport, this.el.slider]) {
      el.addEventListener('keydown', (e) => e.stopPropagation());
    }
  }

  // ------------------------------------------------------------------ state --
  setLoading(fraction, step) {
    this.el.barFill.style.width = `${Math.round(fraction * 100)}%`;
    if (step) this.el.loaderStep.textContent = step;
  }

  finishLoading() {
    this.el.loader.classList.add('done');
    setTimeout(() => this.el.loader.remove(), 700);
    this.el.hud.classList.remove('hidden');
    this.el.clickToStart.classList.remove('hidden');
  }

  setLocked(locked) {
    this.el.clickToStart.classList.toggle('hidden', locked);
  }

  setTimeUI(hours) {
    this.el.slider.value = String(Math.round(hours * 60));
    const hh = Math.floor(hours) % 24;
    const mm = Math.floor((hours - Math.floor(hours)) * 60);
    this.el.clock.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const night = hours < 7.1 || hours > 19.1;
    this.el.btnDay.classList.toggle('on', !night);
    this.el.btnNight.classList.toggle('on', night);
  }

  /**
   * Scene triangle total. Counted once from the geometry rather than read from
   * renderer.info, which after a post-processing chain only reports the two
   * triangles of the final fullscreen quad.
   */
  setTriangleCount(scene) {
    let tris = 0;
    scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const g = o.geometry;
      if (!g) return;
      const verts = g.index ? g.index.count : g.attributes.position?.count ?? 0;
      tris += (verts / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    this.el.tris.textContent = `${(tris / 1e6).toFixed(2)}M tri`;
  }

  toast(text, ms = 1600) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('on'), ms);
  }

  toggleHelp() {
    this.el.help.classList.toggle('hidden');
  }

  /** Called every frame. */
  update(dt, ctrl, nearest, renderer) {
    this._frames++;
    this._fpsClock += dt;
    if (this._fpsClock >= 0.5) {
      this._lastFps = Math.round(this._frames / this._fpsClock);
      this._frames = 0;
      this._fpsClock = 0;
      this.el.fps.textContent = `${this._lastFps} fps`;
    }

    this.el.mode.textContent = ctrl.modeLabel;
    this.el.speed.textContent = `${ctrl.speedKmh.toFixed(ctrl.mode === 'ground' ? 1 : 0)} km/h`;
    this.el.alt.textContent = `${ctrl.altitude.toFixed(1)} m`;

    const lat = MERLION.lat - ctrl.pos.z / METRES_PER_DEG_LAT;
    const lon = MERLION.lon + ctrl.pos.x / METRES_PER_DEG_LON;
    this.el.latlon.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    this.el.near.textContent = nearest
      ? `${nearest.name} ${nearest.distance < 1000 ? `${nearest.distance.toFixed(0)} m` : `${(nearest.distance / 1000).toFixed(1)} km`}`
      : '—';

    // Compass. Camera faces north at yaw 0, and heading rises as yaw falls.
    const heading = ((-ctrl.yaw * 180) / Math.PI % 360 + 360) % 360;
    const px = -(heading / 15) * 40 + this.el.compass.clientWidth / 2 - 20;
    this.el.strip.style.transform = `translateX(${px.toFixed(1)}px)`;

    this.el.crosshair.classList.toggle('on', ctrl.mode === 'ground' && ctrl.locked);
  }
}
