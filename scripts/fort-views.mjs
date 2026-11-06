// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Pictures of a harbour and its forts from the real game: overhead, and from the water. Headless on the real GPU.
// No window opens. Same ports and years every run, so before and after compare.
//   OUT=dir node scripts/fort-views.mjs before havana@1650,lisbon@1650
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { coastalRegionStageURL } from '../js/landfall.js';

const label = process.argv[2] ?? 'review';
const specs = (process.argv[3] ?? 'havana@1650').split(',').map((text) => {
  const [id, year] = text.split('@');
  return { id, year: Number(year ?? 1650) };
});
const outDir = process.env.OUT;
if (!outDir) throw Error('Set OUT to the folder for the pictures');
const WIDTH = 1280, HEIGHT = 860;
await mkdir(outDir, { recursive: true });
const server = createDevServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] });
const FORTS = /bastion_trace_fortress|stone_sea_bastion|english_triangular_palisade_fort|torreon_atalaya_farol/;
const aim = (eye, at) => [Math.atan2(at[0] - eye[0], -(at[1] - eye[2])) * 180 / Math.PI, Math.atan2((at[2] ?? 0) - eye[1], Math.hypot(at[0] - eye[0], at[1] - eye[2])) * 180 / Math.PI];
for (const { id, year } of specs) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = coastalRegionStageURL(base, id, 'dock', 'clear', year);
  for (const [key, value] of Object.entries({ w: WIDTH, h: HEIGHT, polygons: 'fixed', view: 'free', prow: 0, sunElev: 55, clouds: 0, fov: 50, follower: 0 })) url.searchParams.set(key, String(value));
  const started = Date.now();
  await page.goto(url.toString());
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 240000, polling: 300 });
  if (await page.evaluate(() => oceanStartup.state) !== 'ready') throw Error(`${id} failed: ${errors.join('; ')}`);
  await page.addStyleTag({ content: 'body *{visibility:hidden!important}canvas{visibility:visible!important}' });
  // Ports that are not preset swap to the real coast a little after the page is ready.
  const settled = await page.evaluate(async () => {
    let last = null, same = 0;
    for (let i = 0; i < 80 && same < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const port = oceanFleet.terrain?.port, now = port ? `${port.instances.length}:${port.center.x}:${port.center.z}` : null;
      same = now === last ? same + 1 : 0;
      last = now;
    }
    const terrain = oceanFleet.terrain, port = terrain.port;
    const describe = (i) => ({ prefabId: i.prefabId, label: i.label, x: i.x, y: i.y, z: i.z, yaw: i.yaw, width: i.width, length: i.length, guards: i.guards ?? null });
    return { region: { id: terrain.region?.id, latitude: terrain.region?.latitude, longitude: terrain.region?.longitude, shoreBearing: terrain.region?.shoreBearing }, source: terrain.elevationSource ?? terrain.pack?.elevationSource ?? null, center: port.center, berth: port.berth, harbour: port.harbour ?? null, forts: port.instances.filter((i) => /fort|bastion/.test(i.prefabId)).map(describe), towers: port.instances.filter((i) => /torreon/.test(i.prefabId)).map(describe) };
  });
  const forts = settled.forts.length ? settled.forts : settled.towers;
  const spots = [...forts.map((f) => [f.x, f.z]), [settled.center.x, settled.center.z]];
  const minX = Math.min(...spots.map((s) => s[0])), maxX = Math.max(...spots.map((s) => s[0])), minZ = Math.min(...spots.map((s) => s[1])), maxZ = Math.max(...spots.map((s) => s[1]));
  const middle = [(minX + maxX) / 2, (minZ + maxZ) / 2], spread = Math.max(maxX - minX, (maxZ - minZ) * WIDTH / HEIGHT, 500);
  const views = [{ name: 'overhead', eye: [middle[0], spread * 1.25 + 500, middle[1]], yaw: 0, pitch: -89.5 }];
  // Close from above and from the water for each fort: the seaward side is away from the town.
  forts.slice(0, 4).forEach((fort, index) => {
    const dx = fort.x - settled.center.x, dz = fort.z - settled.center.z, length = Math.hypot(dx, dz) || 1;
    const facing = fort.yaw !== undefined ? [-Math.sin(fort.yaw), -Math.cos(fort.yaw)] : [dx / length, dz / length];
    const standoff = Math.max(fort.width, fort.length) * 2.2 + 70;
    views.push({ name: `fort${index}-above`, eye: [fort.x, Math.max(fort.width, fort.length) * 2.1 + 90, fort.z], yaw: 0, pitch: -89 });
    const eye = [fort.x + facing[0] * standoff, fort.y + 7, fort.z + facing[1] * standoff];
    const [yaw, pitch] = aim(eye, [fort.x, fort.z, fort.y + 4]);
    views.push({ name: `fort${index}-water`, eye, yaw, pitch });
  });
  for (const view of views) {
    await page.evaluate(({ eye, yaw, pitch }) => {
      const cam = oceanFleet.freeCam;
      cam.x = eye[0]; cam.y = eye[1]; cam.z = eye[2]; cam.yaw = yaw * Math.PI / 180; cam.pitch = pitch * Math.PI / 180;
    }, view);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(outDir, `${id}-${year}-${label}-${view.name}.png`) });
  }
  await writeFile(join(outDir, `${id}-${year}-${label}.json`), JSON.stringify({ ...settled, seconds: (Date.now() - started) / 1000, errors }, null, 1));
  console.log(id, year, `${((Date.now() - started) / 1000).toFixed(0)} s`, settled.source, forts.map((f) => `${f.prefabId}@${f.x.toFixed(0)},${f.z.toFixed(0)}`).join(' '), errors.length ? `ERRORS ${errors[0]}` : '');
  await page.close();
}
await browser.close();
server.closeAllConnections?.();
server.close();
