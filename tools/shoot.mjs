/**
 * Headless screenshot helper, used to check the model renders correctly without
 * needing an interactive browser.
 *
 * Usage:
 *   node tools/shoot.mjs <outDir> [shotName:x,y,z,yaw,pitch,hours] ...
 *
 * Each shot places the camera, waits for a few frames, and writes a PNG.
 * Requires a Chrome or Edge install and a dev server on http://localhost:5183.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('no Chrome or Edge found');
  process.exit(1);
}

const URL_BASE = process.env.CITY_URL ?? 'http://localhost:5183';
const outDir = process.argv[2] ?? 'shots';
const shots = process.argv.slice(3).map((s) => {
  const [name, rest] = s.split(':');
  const [x, y, z, yaw, pitch, hours] = rest.split(',').map(Number);
  return { name, x, y, z, yaw, pitch, hours };
});
if (!shots.length) {
  shots.push({ name: 'opening', hours: 13 });
}
fs.mkdirSync(outDir, { recursive: true });

const PORT = 9333 + (process.pid % 500);
const profile = path.join(process.env.TEMP ?? '.', `city-shoot-${process.pid}`);

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1600,900',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-swiftshader',      // software WebGL, no GPU in headless
  '--use-angle=swiftshader',
  '--disable-features=CalculateNativeWinOcclusion',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(port, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(300);
  }
  throw new Error('devtools never opened');
}

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function main() {
  await waitPort(PORT);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // CITY_MOBILE=1 emulates a handset: device metrics plus real touch support,
  // so `(pointer: coarse)` matches and the on-screen controls engage.
  if (process.env.CITY_MOBILE) {
    const [w, h] = (process.env.CITY_MOBILE_SIZE ?? '390x844').split('x').map(Number);
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 3, mobile: true,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }

  await send('Page.navigate', { url: URL_BASE });

  // Wait for the world to finish building.
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready: !!window.city?.ready, step: document.getElementById("loaderStep")?.textContent})',
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value ?? '{}');
    if (state.ready) break;
    if (i % 5 === 0) console.log('  waiting…', state.step ?? '');
  }

  const errors = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__errors ?? [])', returnByValue: true,
  });
  if (errors.result.value && errors.result.value !== '[]') console.log('page errors:', errors.result.value);

  if (process.env.CITY_PROBE) {
    const probe = await send('Runtime.evaluate', {
      expression: process.env.CITY_PROBE, returnByValue: true, awaitPromise: true,
    });
    console.log('probe:', probe.result.value ?? probe.exceptionDetails?.text ?? probe.result);
  }

  for (const shot of shots) {
    const expr = shot.x === undefined
      ? `window.city.setTime(${shot.hours ?? 13}); 'ok'`
      : `(() => {
          const c = window.city;
          c.ctrl.pos.set(${shot.x}, ${shot.y}, ${shot.z});
          c.ctrl.yaw = ${shot.yaw}; c.ctrl.pitch = ${shot.pitch};
          c.ctrl.vel.set(0,0,0);
          c.ctrl.applyToCamera();
          c.setTime(${shot.hours ?? 13});
          return 'ok';
        })()`;
    await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    await sleep(2200);   // let a few frames render and the water reflection settle
    const shotResult = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${shot.name}.png`);
    fs.writeFileSync(file, Buffer.from(shotResult.data, 'base64'));
    const fps = await send('Runtime.evaluate', {
      expression: 'document.getElementById("hFps")?.textContent', returnByValue: true,
    });
    console.log(`wrote ${file}  (${fps.result.value ?? '?'})`);
  }

  ws.close();
  chrome.kill();
  // Chrome often still holds locks in the profile directory; leaving it in TEMP
  // is harmless.
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((e) => {
  console.error(e);
  chrome.kill();
  process.exit(1);
});
