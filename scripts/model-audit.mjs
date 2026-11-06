// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Audits every ship and port building: the hand-written numbers that describe a model against the geometry drawn.
//   WEBGPU_BACKEND=metal node scripts/model-audit.mjs [--no-gpu] [--fast] [--json=out.json] [--report=MODEL_AUDIT.md] [--write-known]
// With Metal the rig is measured as the GPU really poses it, read back from the live game in a headless page.
// Without it (--no-gpu) cloth, yards and running rope stand where the rest mesh holds them.
// --write-known records what tests/model-audit.test.mjs holds the game to.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as A from './model-audit-lib.mjs';

const root = new URL('../', import.meta.url);
const flag = (name) => process.argv.includes('--' + name);
const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

export async function loadAuditModules() {
  const names = ['gunnery-control', 'building-fracture', 'coastal-world', 'ship-fracture', 'hull', 'gunnery-models', 'crew', 'crew-pose', 'crew-work', 'crew-navigation', 'ship-models', 'models/victory', 'terrain-model', 'port-props', 'gltf'];
  return Object.assign({}, ...(await Promise.all(names.map((n) => import(new URL(`../js/${n}.js`, import.meta.url).href)))));
}
export const loadCrewMeshes = (lib) => Object.fromEntries(['male', 'female'].map((sex) => [sex, lib.loadCrewGLB(readFileSync(new URL('assets/crew/' + (sex === 'female' ? 'sailor-female.glb' : 'sailor.glb'), root)))]));

const browserArgs = () => (process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader']);

// The live game in a headless page: what the GPU really posed, and what a live port and forest really hold.
export async function readLiveGame(shipIds, regions = []) {
  const { chromium } = await import('playwright');
  const { createDevServer } = await import('../server.mjs');
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: browserArgs() });
  const ready = (page) => page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 240000, polling: 200 });
  const ships = {}, world = [];
  try {
    for (const id of shipIds) {
      const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
      try {
        await page.addInitScript(() => {
          const request = GPUAdapter.prototype.requestDevice;
          GPUAdapter.prototype.requestDevice = async function (...args) { const device = await request.apply(this, args); window.auditDevice = device; return device; };
        });
        await page.goto(`${origin}/?ship=${id}&view=ship&follower=0&clouds=0&w=320&h=240&boatSpeed=0`);
        await ready(page);
        if (await page.evaluate(() => oceanStartup.state) !== 'ready') throw Error('The game did not start for ' + id);
        ships[id] = await page.evaluate(async () => {
          for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
          const vessel = oceanFleet.vessels[0], source = vessel.pose.buffer, device = window.auditDevice;
          const copy = device.createBuffer({ size: source.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(source, 0, copy, 0, source.size);
          device.queue.submit([encoder.finish()]);
          await copy.mapAsync(GPUMapMode.READ);
          const posed = new Uint8Array(copy.getMappedRange().slice(0));
          copy.unmap();
          const encode = (bytes) => {
            let binary = '';
            for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
            return btoa(binary);
          };
          const asset = vessel.asset, b = vessel.boat, view = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
          return {
            posed: encode(posed), vertices: encode(view(asset.vertices)), indices: encode(view(asset.indices)),
            groups: asset.groups.map((g) => ({ id: g.id, firstVertex: g.firstVertex, vertexCount: g.vertexCount })),
            vertexShards: encode(view(asset.fracture.vertexShards)), shardKinds: asset.fracture.shards.map((s) => s?.kind ?? 0),
            length: b.length, beam: b.beam, sinkage: b.hydrodynamics?.sinkage, sailState: b.sailState, rudder: b.rudder, hatchesClosed: b.hatchesClosed,
          };
        });
      } finally { await page.close(); }
    }
    for (const region of regions) {
      const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
      try {
        await page.goto(`${origin}/?region=${region}&view=ship&ship=nina&follower=0&clouds=0&w=320&h=240&boatSpeed=0`);
        await ready(page);
        await page.waitForTimeout(4000);
        world.push(await page.evaluate(async (region) => {
          const { buildingReach, traceShotAtBuilding } = await import('/js/building-fracture.js');
          const t = oceanFleet.terrain, ports = t.ports ?? [];
          return {
            region, roots: t.trees, treeData: (t.treeData?.length ?? 0) / 8, ports: ports.length,
            instances: ports.reduce((n, p) => n + (p.instances?.length ?? 0), 0),
            meshed: ports.reduce((n, p) => n + (p.instances?.filter((i) => buildingReach(i)).length ?? 0), 0),
            traced: ports.reduce((n, p) => n + (p.instances?.filter((i) => traceShotAtBuilding(i, [0, 0, 0], [1, 0, 0])).length ?? 0), 0),
            palmsShootable: ports.reduce((n, p) => n + Math.min((p.palms?.length ?? 0) / 8, 520), 0),
          };
        }, region));
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  const decode = (text, Type) => { const raw = Buffer.from(text, 'base64'); return new Type(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); };
  for (const live of Object.values(ships)) {
    live.posed = decode(live.posed, Float32Array);
    live.vertices = decode(live.vertices, Float32Array);
    live.indices = decode(live.indices, Uint32Array);
    live.vertexShards = decode(live.vertexShards, Uint32Array);
  }
  return { ships, world };
}

// How far the GPU moved each kind of part from its rest position, and whether the frame the audit uses is the one drawn.
export function compareLiveToRest(ship, live) {
  const moved = {}, { asset, partOf } = ship, vertexPart = new Uint8Array(asset.vertices.length / 9), vertexTriangle = new Uint32Array(asset.vertices.length / 9), hullMovers = {};
  for (let t = 0; t < partOf.length; t++) for (let k = 0; k < 3; k++) { vertexPart[asset.indices[t * 3 + k]] = partOf[t]; vertexTriangle[asset.indices[t * 3 + k]] = t; }
  for (let v = 0; v < vertexPart.length; v++) {
    const name = A.PART_NAMES[vertexPart[v]];
    if (!name) continue;
    const d = Math.hypot((live.posed[v * 8] - asset.vertices[v * 9]) * ship.scale[0], (live.posed[v * 8 + 1] - asset.vertices[v * 9 + 1]) * ship.scale[1], (live.posed[v * 8 + 2] - asset.vertices[v * 9 + 2]) * ship.scale[2]);
    moved[name] = Math.max(moved[name] ?? 0, d);
    if (name === 'hull' && d > 0.1) { const group = ship.groupId(vertexTriangle[v]).replace(/\d+/g, '#'); hullMovers[group] = Math.max(hullMovers[group] ?? 0, A.round(d)); }
  }
  const runtime = ship.model.runtime;
  return { id: ship.id, vertices: asset.vertices.length / 9, hullMovers: A.topOf(hullMovers, 5), movedM: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, A.round(v)])), lengthOff: A.round(Math.abs(live.length - runtime.length), 3), beamOff: A.round(Math.abs(live.beam - runtime.beam), 3), sinkageOff: A.round(Math.abs(live.sinkage - ship.hydro.sinkage), 3) };
}

export function auditForestTrees(lib, fan = {}) {
  const rows = [];
  for (const set of ['subtropical', 'saba']) {
    const dir = new URL(`assets/forest-scenery/${set}/`, root), manifest = JSON.parse(readFileSync(new URL('manifest.json', dir)));
    const vb = gunzipSync(readFileSync(new URL('vertices.bin.gz', dir))), ib = gunzipSync(readFileSync(new URL('indices.bin.gz', dir)));
    const vertices = new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4), indices = new Uint32Array(ib.buffer, ib.byteOffset, ib.byteLength / 4);
    for (const [i, p] of manifest.prototypes.entries()) {
      const drawn = A.forestPrototypeIndex(manifest, vertices, indices, i, { scale: 1.1, origin: [0, 5, 0] });
      // A live forest leaves terrain.treeData empty: this is what such a tree offers a ball.
      rows.push({ mode: 'forest', set, species: p.species, heightClaimM: p.heightMetres, ...A.auditTreeCollision(drawn, { ports: [], treeData: new Float32Array(0) }, lib.sweepScenerySegment, fan) });
      if (p.species === 'palm') {
        // The foreshore fringe: drawn from this prototype by terrain.js, struck through port.palms.
        for (const shape of [0.2, 0.5, 0.8]) {
          const seaX = 1, seaZ = 0, scale = 1 + shape * 0.55, yaw = Math.atan2(seaZ, seaX) - Math.atan2(0.5, 1.5);
          const palm = A.forestPrototypeIndex(manifest, vertices, indices, i, { scale, yaw, origin: [0, 1.8, 0] });
          rows.push({ mode: 'foreshore', set, species: `palm-${shape}`, heightClaimM: 22, ...A.auditTreeCollision(palm, { ports: [{ center: { x: 0, z: 0 }, palms: new Float32Array([0, 2, 0, 3.5, 22, shape, -seaX, -seaZ]) }] }, lib.sweepScenerySegment, fan) });
        }
      }
    }
  }
  return rows;
}

export const AUDIT_PORTS = Object.freeze(['lisbon', 'havana', 'san-juan', 'cartagena', 'veracruz', 'jamestown', 'boston', 'plymouth-colony', 'quebec', 'cape-town']);
export function auditPorts(lib, ids = AUDIT_PORTS) {
  const models = lib.PROP_MODELS.map((spec) => lib.readPropModel(readFileSync(new URL(spec.file, root)), spec));
  const jetties = lib.PROP_MODELS.flatMap((spec, i) => (spec.deckShare ? [A.auditJettyModel(spec, models[i])] : []));
  const ports = [];
  for (const id of ids) {
    const pack = lib.generateProceduralCoastalPack(id, { size: 257, biomeSize: 64, albedoSize: 64, vegetationCandidates: 400 });
    ports.push({ ...A.auditPortProps(pack, lib, models), ...A.auditPortMeshes(pack, lib) });
  }
  return { ports, jetties };
}

const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((v) => (v === null || v === undefined ? '–' : v)).join(' | ')} |`)].join('\n');

export function renderTables(results) {
  const out = [], ships = results.ships;
  const posed = ships.every((r) => r.posed);
  out.push(`Measured ${results.date}. Rig ${posed ? 'as the GPU posed it, read back on Metal' : 'at its rest pose'}. ${results.flags.length} measurements past their limits.\n`);
  if (results.live?.length) {
    out.push('### Posed geometry read back from the GPU\n');
    out.push(table(['Ship', 'vertices', 'hull-class parts that moved', 'mast', 'spar', 'cloth', 'rope', 'gun', 'length off', 'beam off', 'sinkage off'], results.live.map((l) => [l.id, l.vertices, l.hullMovers || 'none', l.movedM.mast ?? '–', l.movedM.spar ?? '–', l.movedM.cloth ?? '–', l.movedM.rope ?? '–', l.movedM.gun ?? '–', l.lengthOff, l.beamOff, l.sinkageOff])));
    out.push('');
  }
  out.push('### 1a. Balls against ship meshes\n');
  out.push('Share of lines that either the shot or the mesh says struck. *Agree* is within 0.5 m of the first solid surface. *Soft* stopped with nothing solid within 0.5 m, on or near cloth or rope only. *Air* stopped more than 1 m from anything drawn. *Through* passed a solid surface unstopped.\n');
  out.push(table(['Ship', 'lines', 'agree %', 'soft %', 'air: rig %', 'air: hull %', 'median gap m', 'max gap m', 'through hull %', 'through mast/spar %', 'phantom mast %', 'wrong mast %', 'parts missed most'], ships.map((r) => { const c = r.collision; return [r.id, c.struck, c.agreePct, c.softStopPct, c.airRigPct, c.airHullPct, c.airGapMedianM, c.airGapMaxM, c.throughHullPct, c.throughMastPct, c.phantomMastPct, c.wrongMastPct, c.missedGroups]; })));
  out.push('\n### 1b. Balls against trees\n');
  out.push(table(['Tree', 'mode', 'wood lines stopped %', 'agree %', 'soft %', 'air %', 'through %', 'gap m', 'top m', 'reach m'], results.trees.map((t) => [`${t.set}/${t.species}`, t.mode, t.woodStoppedPct, t.agreePct, t.softStopPct, t.airPct, t.throughPct, t.airGapMedianM, t.topM, t.reachM])));
  if (results.world?.length) {
    out.push('\n### 1c. A live port and forest, read from the running game\n');
    out.push(table(['Region', 'ports', 'buildings', 'known by mesh', 'traced by mesh', 'trees drawn', 'trees a ball can strike', 'palms a ball can strike'], results.world.map((w) => [w.region, w.ports, w.instances, w.meshed, w.traced, w.roots, w.treeData, w.palmsShootable])));
  }
  out.push('\n### 1d. Balls against port buildings\n');
  out.push('*Mesh* is an intact building, turned 40°. *Square* and *turned* are the same building once cut into pieces, at 0° and 40°. Each cell is agree / air / through / early, as lines.\n');
  const cell = (b) => `${b.agree} / ${b.air} / ${b.through + b.late} / ${b.early}`;
  out.push(table(['Prefab', 'nominal w×h×l', 'drawn top m', 'mesh half m', 'reach square m', 'reach turned m', 'mesh', 'pieces square', 'pieces turned', 'max air m'], results.buildings.map((b) => [b.id, b.nominal, b.drawnTopM, b.meshHalfM, b.reachSquareM, b.reachTurnedM, cell(b.mesh), cell(b.piecesSquare), cell(b.piecesTurned), A.round(b.piecesTurned.maxAir, 1)])));
  out.push('\n### 2a. Masts\n');
  out.push(table(['Ship', 'mast', 'table z', 'mesh z', 'off', 'deck y', 'foot y', 'top y', 'top break', 'full break', 'break above deck', 'rig top', 'rail', 'struck from', 'struck to', 'dead band'], ships.flatMap((r) => (r.masts.rows.length ? r.masts.rows : [{}]).map((q) => [r.id, q.mast, q.tableZ, q.meshZ, q.offZ, q.deck, q.foot, q.top, q.topBreak, q.fullBreak, q.fullBreakAboveDeck, r.masts.rigTopMeshM, r.masts.railAmidshipsM, r.masts.mastStruckFromM, r.masts.mastStruckToM, r.masts.mastDeadBandM]))));
  out.push('\n### 2b. Guns\n');
  out.push(table(['Ship', 'guns', 'undrawn', 'muzzle off barrel m', 'breech off barrel m', 'lowest muzzle above sea', 'furthest from hull', 'into own ship', 'station off floor'], ships.map((r) => { const g = r.guns.rows, w = (k, l = g) => l.reduce((a, q) => Math.max(a, Math.abs(q[k] ?? 0)), 0); return [r.id, g.length, g.filter((q) => q.abstract).length, w('muzzleOff'), w('breechOff'), g.length ? Math.min(...g.map((q) => q.muzzleAboveSea)) : null, w('hullNear'), g.filter((q) => q.blockedAt !== null).length, w('stationGap', g.filter((q) => q.visibleCrew || q.abstract))]; })));
  out.push('\n### 2c. Crew stations, routes and walkways\n');
  out.push(table(['Ship', 'crew', 'floating', 'under something', 'pressed', 'no hull beside', 'route floating %', 'worst m', 'who', 'walk cells', 'over nothing', 'worst m', 'inside a structure', 'through solid', 'through what'], ships.map((r) => { const s = r.crewStations, q = r.crewRoutes, w = r.walkways; return [r.id, s.crew, s.floating, Math.max(0, s.sunk - s.seated), s.pressed, s.outside, q.floatingPct, q.worstFloatM, q.who, w.clear, w.floating, w.worstFloat, w.inside, w.blocked, w.blockedBy]; })));
  out.push('\n### 2d. Rig and fittings\n');
  out.push(table(['Ship', 'attachment nodes', 'more than 0.25 m from anything', 'worst', 'lines', 'loose ends', 'worst m', 'chainwale samples missed', 'chainwale height off'], ships.map((r) => [r.id, r.nodes.nodes, r.nodes.loose, r.nodes.worst, r.ropes.ropes, r.ropes.looseEnds, r.ropes.worstM, r.chainwales?.missing, r.chainwales?.worstYM])));
  out.push('\n### 3. Waterline and hull\n');
  out.push(table(['Ship', 'draft table', 'draft mesh', 'freeboard table', 'rail mid min', 'at z', 'rail amidships', 'rail formula P90', 'deck formula P75', 'hull width P90', 'beam run', 'beam mesh', 'length run', 'length mesh', 'volume table', 'volume mesh', 'error %'], ships.map((r) => { const h = r.waterline; return [r.id, h.draftTableM, h.draftMeshM, h.freeboardTableM, h.railMidMinM, h.railMidAtZ, h.railAmidshipsM, h.railFormulaP90M, h.deckFormulaP75M, h.hullFormulaP90M, h.beamRuntimeM, h.beamMeshM, h.lengthRuntimeM, h.lengthMeshM, h.volumeTableM3, h.volumeMeshM3, h.volumeErrorPct]; })));
  out.push('\n### 4a. Crew bodies\n');
  out.push(table(['Ship', 'crew', 'body meets a solid', 'through more than 8 cm', 'deepest m', 'soles sunk', 'by m', 'parts', 'worst'], ships.map((r) => { const b = r.crewBodies; return b ? [r.id, b.crew, b.intersecting, b.throughDeep, b.deepestM, b.soleSunk, b.soleSunkMaxM, b.parts, b.worst[0] ? `${b.worst[0].key} (${b.worst[0].role}) through ${b.worst[0].part}` : ''] : [r.id]; })));
  out.push('\n### 4b. Port props\n');
  out.push(table(['Port', 'buildings', 'known by mesh', 'cleats', 'off their deck', 'worst m', 'no mesh under', 'jetties', 'root in rising ground', 'head dry'], results.ports.map((p) => [p.id, p.instances, p.noted, p.cleats, p.cleatOff, p.cleatWorst, p.cleatNoMesh, p.jetties, p.jettyRootHigh, p.jettyHeadDry])));
  out.push('');
  out.push(table(['Jetty model', 'length', 'width', 'height', 'deck claimed', 'deck in mesh', 'above sea', 'wanted'], results.jetties.map((j) => [j.id, j.lengthM, j.widthM, j.heightM, j.deckClaimM, j.deckMeshM, j.deckAboveSeaM, j.wantAboveSeaM])));
  out.push('\n### 5. Surface, in oak repeats per metre (across / along the grain) and shader planks in metres\n');
  const materialNames = [...new Set(ships.flatMap((r) => Object.values(r.surface.materials).filter((m) => m.areaM2 > 5).map((m) => m.name)))].sort();
  out.push(table(['Ship', ...materialNames, 'wall course', 'deck plank', 'hull course'], ships.map((r) => { const by = Object.fromEntries(Object.values(r.surface.materials).map((m) => [m.name, m])); return [r.id, ...materialNames.map((n) => (by[n]?.areaM2 > 5 ? `${by[n].acrossPerM} / ${by[n].alongPerM}` : null)), r.surface.wallCourseM, r.surface.deckPlankM, r.surface.hullCourseM]; })));
  out.push('\n### Every measurement past its limit\n');
  out.push(table(['Check', 'measured', 'limit', 'note'], results.flags.map((f) => [f.key, f.value, f.limit, String(f.note).replaceAll('|', '/')])));
  return out.join('\n');
}

const FAST_BUILDING_FAN = Object.freeze({ bearings: 4, elevations: [0], columns: 12, rows: 8 });
export const KNOWN_FLAGS = new URL('tests/data/model-audit-known.json', root);

// Everything measured. `live` is what readLiveGame returned; without it the rig stands at its rest pose.
export async function runAudit({ fast = false, live = null, log = () => {} } = {}) {
  const lib = await loadAuditModules(), crewMeshes = loadCrewMeshes(lib), ships = [], comparison = [];
  for (const id of A.SHIP_IDS) {
    log(id);
    const ship = A.loadShip(id, live ? live.ships[id] : null);
    if (live) comparison.push(compareLiveToRest(ship, live.ships[id]));
    const pose = live ? { sailState: live.ships[id].sailState, rudder: live.ships[id].rudder, hatchesClosed: live.ships[id].hatchesClosed } : {};
    ships.push(A.auditShip(ship, lib, { fan: fast ? A.FAST_FAN : A.FULL_FAN, crewMeshes, everyNth: fast ? 6 : 2, routeSeconds: fast ? 30 : 90, pose }));
  }
  log('buildings');
  const buildings = Object.keys(lib.PORT_PREFABS).map((id) => A.auditBuildingCollision(id, lib, fast ? FAST_BUILDING_FAN : {}));
  log('trees');
  const trees = auditForestTrees(lib, fast ? { bearings: 6, columns: 16, rows: 24 } : {});
  log('ports');
  const { ports, jetties } = auditPorts(lib, fast ? AUDIT_PORTS.slice(0, 4) : AUDIT_PORTS);
  const results = { date: new Date().toISOString().slice(0, 10), backend: live ? 'metal' : 'none', ships, buildings, trees, ports, jetties, live: comparison, world: live?.world ?? [] };
  results.flags = A.flagsOf(results);
  return results;
}

async function main() {
  const started = Date.now(), fast = flag('fast');
  const useGPU = !flag('no-gpu') && !flag('write-known') && process.env.WEBGPU_BACKEND === 'metal';
  const log = (text) => console.error(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${text}`);
  let live = null;
  if (useGPU) {
    log('reading posed ships from the GPU');
    live = await readLiveGame(A.SHIP_IDS, ['lisbon', 'havana', 'san-juan', 'jamestown']);
  } else if (!flag('no-gpu') && !flag('write-known')) log('WEBGPU_BACKEND is not metal: rig measured at rest');
  const results = await runAudit({ fast: fast || flag('write-known'), live, log });
  if (flag('write-known')) {
    // What tests/model-audit.test.mjs holds the game to: the fast audit, at rest, in Node.
    writeFileSync(KNOWN_FLAGS, JSON.stringify(Object.fromEntries(results.flags.map((f) => [f.key, f.value])), null, 1) + '\n');
    log('wrote ' + fileURLToPath(KNOWN_FLAGS));
    return;
  }
  const json = option('json');
  if (json) writeFileSync(json, JSON.stringify(results, null, 1));
  const report = option('report');
  const tables = renderTables(results);
  if (report) {
    const start = '<!-- audit tables start -->', end = '<!-- audit tables end -->';
    let text = '';
    try { text = readFileSync(report, 'utf8'); } catch { /* A first run writes the tables alone. */ }
    const body = `${start}\n${tables}\n${end}`;
    const a = text.indexOf(start), b = text.indexOf(end);
    writeFileSync(report, a >= 0 && b >= 0 ? text.slice(0, a) + body + text.slice(b + end.length) : `${text}${text ? '\n\n' : ''}${body}\n`);
    log('wrote ' + report);
  } else console.log(tables);
  log(`${results.flags.length} past their limits, done`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
