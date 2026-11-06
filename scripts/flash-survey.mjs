// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How many flashes per second, and how bright, in each kind of scene and under each kind of sun.
// WEBGPU_BACKEND=metal node scripts/flash-survey.mjs [scene or sun filter] [--out=file.json] [--pictures=dir]
// Headless, and it moves the camera slowly. Before and after a change, the two files compare directly.
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { coastalRegionStageURL } from '../js/landfall.js';
import { installFlashProbe, runFlashMeasure, setSun, summariseFlashes } from '../tests/flash-probe.mjs';

const D = Math.PI / 180;
// Offsets the sun from where the camera looks: 0 is straight into it, 180 is at the back.
export const SUNS = Object.freeze([
  { id: 'low-ahead', elevation: 8, offset: 0 },
  { id: 'sunset-ahead', elevation: 2, offset: 10 },
  { id: 'low-behind', elevation: 10, offset: 180 },
  { id: 'side-noon', elevation: 55, offset: 70 },
]);

// Where a camera stands to look at a stand of trees, from a little way off and over clear ground.
export const forestCamera = (range) => {
  const t = oceanFleet.terrain, grid = t.forestTrunks, roots = grid.roots;
  const cx = t.port?.center?.x ?? t.region?.x ?? 0, cz = t.port?.center?.z ?? t.region?.z ?? 0;
  const cells = new Map();
  for (let i = 0; i < grid.trees; i++) {
    const r = grid.rootOf[i] * 12, key = `${Math.round(roots[r] / 60)},${Math.round(roots[r + 2] / 60)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const dense = [...cells.entries()].map(([key, n]) => { const [u, v] = key.split(',').map(Number); return { x: u * 60, z: v * 60, n, far: Math.hypot(u * 60 - cx, v * 60 - cz) }; }).filter((c) => c.far < 2500).sort((a, b) => b.n - a.n).slice(0, 24);
  let best = null;
  for (const cell of dense) {
    const y = t.groundSample(cell.x, cell.z);
    if (y < 1.5) continue;
    for (let a = 0; a < 24; a++) {
      const angle = (a / 24) * Math.PI * 2, ex = cell.x + Math.cos(angle) * range, ez = cell.z + Math.sin(angle) * range;
      const ground = t.groundSample(ex, ez), eyeY = Math.max(ground, 0) + 4;
      let clear = true;
      for (let s = 0.1; s <= 0.7 && clear; s += 0.05) {
        const px = ex + (cell.x - ex) * s, pz = ez + (cell.z - ez) * s;
        clear = t.groundSample(px, pz) < eyeY + (y + 8 - eyeY) * s;
      }
      if (!clear) continue;
      let near = 0;
      for (let i = 0; i < grid.trees && near < 3; i++) {
        const r = grid.rootOf[i] * 12;
        if (Math.hypot(roots[r] - ex, roots[r + 2] - ez) < range * 0.25) near++;
      }
      if (near >= 3) continue;
      const score = cell.n;
      if (!best || score > best.score) best = { score, ex, ez, eyeY, x: cell.x, y: y + 10, z: cell.z, trees: cell.n };
    }
  }
  if (!best) return null;
  const yaw = Math.atan2(best.x - best.ex, -(best.z - best.ez)), pitch = Math.atan2(best.y - best.eyeY, Math.hypot(best.x - best.ex, best.z - best.ez));
  return { x: best.ex, y: best.eyeY, z: best.ez, yaw, pitch, trees: best.trees };
};

export const fortCamera = (range) => {
  const port = oceanFleet.terrain?.port;
  const list = port?.instances ?? [];
  const fort = list.find((i) => /fort|bastion|castle|tower/i.test(i.prefabId ?? '')) ?? list[0];
  if (!fort) return null;
  const t = oceanFleet.terrain;
  let best = null;
  for (let a = 0; a < 24; a++) {
    const angle = (a / 24) * Math.PI * 2, ex = fort.x + Math.cos(angle) * range, ez = fort.z + Math.sin(angle) * range;
    const ground = t.groundSample(ex, ez), base = fort.baseY ?? fort.y ?? 0, eyeY = Math.max(ground, 0) + 5;
    const score = Math.abs(eyeY - base);
    if (!best || score < best.score) best = { score, ex, ez, eyeY, base };
  }
  const yaw = Math.atan2(fort.x - best.ex, -(fort.z - best.ez)), pitch = Math.atan2(best.base + 6 - best.eyeY, range);
  return { x: best.ex, y: best.eyeY, z: best.ez, yaw, pitch, prefab: fort.prefabId };
};

export const townCamera = () => {
  const port = oceanFleet.terrain?.port, walkers = port?.streets?.walkers;
  const cx = port?.center?.x ?? 0, cz = port?.center?.z ?? 0;
  const t = oceanFleet.terrain, base = t.groundSample(cx, cz);
  return { x: cx + 36, y: Math.max(base, 0) + 22, z: cz + 36, yaw: Math.atan2(-36, 36), pitch: -18 * Math.PI / 180, people: port?.streets?.people ?? 0, walkers: walkers?.length ?? 0 };
};

export const shipCamera = () => {
  const boat = oceanFleet.vessels[0].boat, heading = (boat.heading ?? 0) * Math.PI / 180;
  const out = [Math.cos(heading), -Math.sin(heading)];
  const ex = boat.x + out[0] * 26, ez = boat.z + out[1] * 26;
  return { x: ex, y: 12, z: ez, yaw: Math.atan2(boat.x - ex, -(boat.z - ez)), pitch: -8 * Math.PI / 180, ship: oceanFleet.vessels[0].asset?.model?.name };
};

// The stand of trees nearest in view from the ship, and the look that holds them in frame as she sways.
export const forestFromShip = () => {
  const t = oceanFleet.terrain, grid = t.forestTrunks, roots = grid.roots, boat = oceanFleet.vessels[0].boat;
  const cells = new Map();
  for (let i = 0; i < grid.trees; i++) {
    const r = grid.rootOf[i] * 12, key = `${Math.round(roots[r] / 50)},${Math.round(roots[r + 2] / 50)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  let best = null;
  for (const [key, n] of cells) {
    const [u, v] = key.split(',').map(Number), x = u * 50, z = v * 50, far = Math.hypot(x - boat.x, z - boat.z);
    if (far < 250 || far > 1800) continue;
    const score = n / (far + 200);
    if (!best || score > best.score) best = { score, x, z, trees: n, far };
  }
  if (!best) return null;
  return { target: [best.x, t.groundSample(best.x, best.z) + 8, best.z], trees: best.trees, far: best.far, sunElevation: Number(document.getElementById('sea-sunElev')?.value), sunAzimuth: Number(document.getElementById('sea-sunAzim')?.value), speed: boat.speed, station: boat.viewStation };
};

// The same sums as aimCameraAtVessel: what a look relative to a swaying ship must be to hold a point.
export const shipLook = ([tx, ty, tz]) => `(i)=>{const c=oceanFleet.camera,b=oceanFleet.vessels[0].boat,dx=${tx}-c.x,dy=${ty}-c.y,dz=${tz}-c.z,l=Math.hypot(dx,dy,dz)||1,wx=dx/l,wy=dy/l,wz=dz/l,h=(b.heading||0)*Math.PI/180,p=b.pitch||0,r=b.roll||0,ch=Math.cos(h),sh=Math.sin(h),cp=Math.cos(p),sp=Math.sin(p),cr=Math.cos(r),sr=Math.sin(r),xx=ch*wx+sh*wz,zp=-sh*wx+ch*wz,yy=cp*wy+sp*zp,fz=-sp*wy+cp*zp,fx=cr*xx+sr*yy,fy=-sr*xx+cr*yy;return {yaw:Math.atan2(fx,-fz),pitch:Math.asin(Math.max(-1,Math.min(1,fy)))};}`;

export const SCENES = Object.freeze([
  { id: 'lisbon-crows-nest', start: true, query: {}, camera: { fn: forestFromShip } },
  { id: 'forest-san-juan-near', region: 'san-juan', query: { prow: 0, follower: 0 }, camera: { fn: forestCamera, arg: 110 }, needsForest: true },
  { id: 'forest-san-juan-far', region: 'san-juan', query: { prow: 0, follower: 0 }, camera: { fn: forestCamera, arg: 420 }, needsForest: true },
  { id: 'forest-jamestown', region: 'jamestown', query: { prow: 0, follower: 0 }, camera: { fn: forestCamera, arg: 160 }, needsForest: true },
  { id: 'lisbon-town', region: 'lisbon', query: { prow: 0, follower: 0 }, camera: { fn: townCamera } },
  { id: 'fort-san-juan', region: 'san-juan', query: { prow: 0, follower: 0 }, camera: { fn: fortCamera, arg: 130 } },
  { id: 'ship-crew', region: 'lisbon', query: { ship: 'victory', boatSpeed: 0, follower: 0 }, camera: { fn: shipCamera } },
]);

export async function openScene(browser, base, scene, { width = 960, height = 540, query = {} } = {}) {
  // scene.start is the game as a player opens it: Lisbon's dock, at its own time of day and sea.
  const url = scene.start ? new URL(base) : coastalRegionStageURL(base, scene.region, 'dock', 'clear', scene.year ?? 1650);
  const settings = scene.start ? { resolution: 'native', polygons: 'fixed', ui: 0, sound: 0 } : { w: width, h: height, polygons: 'fixed', view: 'free', clouds: 0, ui: 0, sound: 0, sunElev: 8 };
  for (const [key, value] of Object.entries({ ...settings, ...scene.query, ...query })) url.searchParams.set(key, String(value));
  const page = await browser.newPage({ viewport: { width, height } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(installFlashProbe);
  await page.goto(url.toString());
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 240000, polling: 200 });
  const state = await page.evaluate(() => window.oceanStartup.state);
  if (state !== 'ready') throw new Error(`${scene.id}: startup ${state}: ${errors.join('; ')}`);
  if (scene.start) {
    await page.waitForFunction(() => window.oceanFleet?.terrain?.forestTrunks?.trees > 0, null, { timeout: 120000, polling: 200 });
    await page.evaluate(async () => { const { setBoatViewStation } = await import('/js/boat.js'); setBoatViewStation(window.oceanFleet.vessels[0].boat, 'crows-nest'); });
  }
  if (scene.needsForest) await page.waitForFunction(() => window.oceanFleet?.terrain?.forestTrunks?.trees > 0, null, { timeout: 120000, polling: 200 });
  return { page, errors };
}

// Slow enough that a leaf stays under the same few pixels: a degree a second and a metre or two.
export const slowPath = (camera, { yawRate = 1.2, slide = 1.6 } = {}) => {
  const right = [Math.cos(camera.yaw), Math.sin(camera.yaw)];
  return `(i)=>({x:${camera.x}+${(right[0] * slide) / 60}*i,y:${camera.y},z:${camera.z}+${(right[1] * slide) / 60}*i,yaw:${camera.yaw}-${(yawRate * D) / 60}*i,pitch:${camera.pitch}})`;
};

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith('--'));
  const out = args.find((a) => a.startsWith('--out='))?.slice(6);
  const picturesAt = args.find((a) => a.startsWith('--pictures='))?.slice(11);
  const frames = Number(args.find((a) => a.startsWith('--frames='))?.slice(9) ?? 120);
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
  const rows = [];
  try {
    for (const scene of SCENES) {
      if (filter && !scene.id.includes(filter) && !SUNS.some((s) => s.id.includes(filter))) continue;
      const started = Date.now();
      const { page, errors } = await openScene(browser, base, scene);
      try {
        const camera = await page.evaluate(`(${scene.camera.fn})(${JSON.stringify(scene.camera.arg ?? null)})`);
        if (!camera) { rows.push({ scene: scene.id, error: 'no camera' }); continue; }
        console.log(scene.id, JSON.stringify(camera), `loaded in ${Math.round((Date.now() - started) / 1000)} s`);
        if (!scene.start) await page.evaluate((c) => Object.assign(window.oceanFleet.camera, c), camera);
        for (const sun of scene.start ? [{ id: 'start' }] : SUNS) {
          if (filter && !scene.id.includes(filter) && !sun.id.includes(filter)) continue;
          if (!scene.start) await setSun(page, sun.elevation, camera.yaw / D + sun.offset);
          const measured = await runFlashMeasure(page, { frames, settle: 45, pose: scene.start ? shipLook(camera.target) : slowPath(camera), keepPictures: picturesAt ? 1 : 0 });
          const summary = { scene: scene.id, sun: sun.id, ...summariseFlashes(measured) };
          rows.push(summary);
          console.log(JSON.stringify(summary));
          if (picturesAt && measured.flashes.length + measured.display.length) {
            await mkdir(picturesAt, { recursive: true });
            for (const [name, which, crop, zoom] of [['before', 0, 0, 1], ['flash', 1, 0, 1], ['after', 2, 0, 1], ['flash-zoom', 1, 48, 10], ['before-zoom', 0, 48, 10]]) {
              const data = await page.evaluate(([w, c, z]) => window.flashProbe.picture(0, w, c, z), [which, crop, zoom]);
              if (data) await writeFile(`${picturesAt}/${scene.id}-${sun.id}-${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
            }
          }
          if (errors.length) console.log('page errors:', errors.join('; ').slice(0, 400));
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    server.close();
  }
  if (out) await writeFile(out, JSON.stringify(rows, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
