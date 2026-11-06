// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The real coasts the game stands its ports on, kept so that forts can be sited and tested without a network.
// Runs the page's own pipeline (real elevation, satellite, the carving back to 1550) in a headless browser and
// keeps the heights placeCoastalPort is handed. No window is opened and no GPU is asked for.
//   node scripts/harbour-coasts.mjs --out tests/data/harbours --size 257 --ports havana,lisbon
// Each file is gzipped: a little header, then metres * 10 as Int16, row by row.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const out = argument('out', 'tests/data/harbours');
const size = Number(argument('size', 257));
const year = Number(argument('year', 1689));
const wanted = argument('ports', null)?.split(',') ?? null;
fs.mkdirSync(out, { recursive: true });

const server = createDevServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`${base}server-blank-page-for-harbour-coasts`).catch(() => {});
  const ids = wanted ?? await page.evaluate(async (root) => {
    const { HISTORICAL_COLONIAL_PORTS } = await import(`${root}js/coastal-world.js`);
    return HISTORICAL_COLONIAL_PORTS.map((p) => p.id);
  }, base);
  for (const id of ids) {
    const started = Date.now();
    const result = await page.evaluate(async ({ root, id, size, year }) => {
      const world = await import(`${root}js/coastal-world.js`);
      const grid = { size, biomeSize: size - 1, albedoSize: (size - 1) * 2, vegetationCandidates: 400, deferSynthesis: true };
      const pack = world.generateProceduralCoastalPack({ id, year }, grid);
      await world.upgradeProceduralPackWithRealDEM(pack, { timeoutMs: 45000 });
      const source = pack.elevationSource;
      const upgraded = world.build1550HistoricalTerritoryPack(pack);
      const region = upgraded.region, heights = upgraded.rawHeights;
      let binary = '';
      const words = new Int16Array(heights.length);
      for (let i = 0; i < heights.length; i++) words[i] = Math.round(heights[i] * 10);
      const bytes = new Uint8Array(words.buffer);
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
      return { source, latitude: region.latitude, longitude: region.longitude, shoreBearing: region.shoreBearing, span: region.span, size: region.size, x: region.x, z: region.z, data: btoa(binary) };
    }, { root: base, id, size, year });
    if (!/terrarium/.test(result.source)) {
      console.log(`${id}: no real elevation (${result.source}), not kept`);
      continue;
    }
    const raw = Buffer.from(result.data, 'base64');
    const header = Buffer.from(JSON.stringify({ id, source: result.source, latitude: result.latitude, longitude: result.longitude, shoreBearing: result.shoreBearing, span: result.span, size: result.size, x: result.x, z: result.z }));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    const file = path.join(out, `${id}.bin.gz`);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([length, header, raw]), { level: 9 }));
    console.log(`${id}: ${(fs.statSync(file).size / 1024).toFixed(0)} kB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
}
