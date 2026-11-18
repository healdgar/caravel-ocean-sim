// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A coast's prefabs (its quays, forts, churches, warehouses and huts, js/coastal-world.js buildPortPrefabGeometry) on
// the one continuum (AGENTS.md rule 3), cut and drawn by the city's own programs (js/city-continuum-draw.js) from an
// atlas of their own. Nothing else draws them.
//
// Each prefab is built once more alone, at its own ground height but unmoved and unturned, and taken down to its floor:
// that is its body, as the continuum bakes and draws it, never stretched (js/old-world-buildings.js
// compileContinuumBody). A body's fingerprint is the digest of what it draws, so prefabs that are the same building
// share one. Each is found, in this order, in the atlas shipped for the historical ports on their own ground
// (scripts/prepare-prefab-continuum.mjs), in what this browser has baked before, or baked now by the one simplifier in
// workers (js/continuum-bake-worker.js), nearest the camera first. A port is not drawn until every body it needs has
// landed. Shot, flooding and fracture work on the full assembly the port was built with, as before.
import { buildPortPrefabGeometry } from './coastal-world.js';
import { CITY_TYPED_FLOATS, compileContinuumBody } from './old-world-buildings.js';
import { assembleCityContinuumAtlas, cityContinuumBodyParts, cityContinuumSourceBytes } from './city-continuum.js';
import { CITY_CONTINUUM_AS_BUILT } from './wgsl/city-continuum.js';
import { PREFAB_CONTINUUM_PORT_BODIES } from './prefab-continuum-ports.js';

// The bake worker (built by build.mjs from js/continuum-bake-worker.js) and the receipt of the bodies baked for the
// historical ports, one file a port (js/prefab-continuum-ports.js). Spelled out, because the build publishes only the
// asset paths it finds quoted in the source.
export const PREFAB_CONTINUUM_ASSETS = Object.freeze({
  'bake-worker.js': 'assets/continuum/bake-worker.js',
  'manifest.json': 'assets/prefab-continuum/manifest.json',
});
export const PREFAB_CONTINUUM_FORMAT = 'waterworld.prefab-continuum';

const prefabHex = (bytes) => Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
export async function prefabContinuumDigest(bytes) { return prefabHex(await crypto.subtle.digest('SHA-256', bytes)); }

// Which of a port's instances are its prefabs: not a city's building enrolled when struck, nor a boulder.
export const isPrefabContinuumInstance = (instance) => Boolean(instance) && !instance.city && !instance.boulder && !instance.fractureSource;

// One prefab as a body in its own frame: built alone at its own ground height, unmoved and unturned (so whatever its
// builder decides by how high it stands is decided as it was), then taken down by that height.
export function prefabContinuumBody(instance, build = buildPortPrefabGeometry) {
  const built = build({ singleBuildingPrefab: true, instances: [{ ...instance, x: 0, z: 0, yaw: 0 }] }, null);
  const y = instance.y ?? 0, vertices = built.vertices;
  for (let at = 1; at < vertices.length; at += 8) vertices[at] -= y;
  return { name: instance.prefabId ?? 'prefab', ...compileContinuumBody(built, { width: instance.width, length: instance.length, height: instance.height }) };
}

// A port's prefabs as continuum buildings: each distinct body once (with its fingerprint and the nearest any of its
// prefabs stands to `near`), and every prefab as a building of one, placed and turned, worn as built.
export async function prefabContinuumPlan(port, { near = null, build = buildPortPrefabGeometry } = {}) {
  const instances = (port?.instances ?? []).filter(isPrefabContinuumInstance), count = instances.length;
  const bodies = [], byPrint = new Map(), types = new Uint32Array(count), typed = new Float32Array(Math.max(1, count) * CITY_TYPED_FLOATS);
  for (let i = 0; i < count; i++) {
    const instance = instances[i], body = prefabContinuumBody(instance, build);
    const fingerprint = await prefabContinuumDigest(cityContinuumSourceBytes(body));
    let type = byPrint.get(fingerprint);
    if (type === undefined) { type = bodies.length; byPrint.set(fingerprint, type); bodies.push({ fingerprint, body, away: Infinity }); }
    const away = near ? Math.hypot(instance.x - near.x, instance.z - near.z) : 0;
    bodies[type].away = Math.min(bodies[type].away, away);
    types[i] = type;
    typed.set([instance.x, instance.y ?? 0, instance.z, instance.yaw ?? 0, 1, 1, 1, CITY_CONTINUUM_AS_BUILT], i * CITY_TYPED_FLOATS);
  }
  return { instances, bodies, types, typed, index: new Map(instances.map((instance, i) => [instance, i])) };
}

// ---------------------------------------------------------------------------------------------- where bodies come from
let prefabWorkerText = null, prefabShipped = null;
// The bake worker's text and its digest, the bake's version: a body is kept and shipped under it.
export function prefabContinuumBakeVersion(fetchAsset = fetch) {
  return prefabWorkerText ??= (async () => {
    const response = await fetchAsset(PREFAB_CONTINUUM_ASSETS['bake-worker.js']);
    if (!response.ok) throw Error(`The continuum's bake worker is missing (${response.status}): run npm run build`);
    const text = await response.text();
    return { text, version: await prefabContinuumDigest(new TextEncoder().encode(text)) };
  })().catch((error) => { prefabWorkerText = null; throw error; });
}
// The receipt of the bodies shipped for the historical ports, and one port's bodies: fingerprint → words, with the
// version they were baked by. A port with none shipped resolves to null.
let prefabReceipt = null;
const prefabShippedPorts = new Map();
export function prefabContinuumShipped(portId, fetchAsset = fetch) {
  const file = PREFAB_CONTINUUM_PORT_BODIES[portId];
  if (!file) return Promise.resolve(null);
  if (!prefabShippedPorts.has(portId)) prefabShippedPorts.set(portId, (async () => {
    const manifest = await (prefabReceipt ??= (async () => {
      const response = await fetchAsset(PREFAB_CONTINUUM_ASSETS['manifest.json']);
      if (!response.ok) throw Error(`The prefab continuum's receipt is missing (${response.status}): run node scripts/prepare-prefab-continuum.mjs`);
      const receipt = await response.json();
      if (receipt?.format !== PREFAB_CONTINUUM_FORMAT) throw Error('The prefab continuum receipt is of another format');
      return receipt;
    })().catch((error) => { prefabReceipt = null; throw error; }));
    const entry = manifest.ports?.[portId];
    if (!entry) return null;
    const response = await fetchAsset(file);
    if (!response.ok) throw Error(`The prefab continuum's bodies for ${portId} are missing (${response.status}): run node scripts/prepare-prefab-continuum.mjs`);
    const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== entry.bytes || await prefabContinuumDigest(bytes) !== entry.sha256) throw Error(`The prefab continuum bodies for ${portId} failed verification`);
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), bodies = new Map();
    for (const body of entry.bodies) bodies.set(body.fingerprint, words.subarray(body.at, body.at + body.words));
    return { version: manifest.version, bodies };
  })().catch((error) => { prefabShippedPorts.delete(portId); throw error; }));
  return prefabShippedPorts.get(portId);
}

// Workers that bake what is neither shipped nor kept, as many as the machine spares, ended once the port has landed.
function prefabBakers(text, size) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  const waiting = new Map(), workers = [], idle = [], queue = [];
  let next = 1;
  const pump = () => {
    while (idle.length && queue.length) {
      const worker = idle.pop(), job = queue.shift(), id = next++;
      waiting.set(id, { ...job, worker });
      worker.postMessage({ id, fingerprint: job.fingerprint, version: job.version, body: job.body, pieces: job.pieces });
    }
  };
  for (let i = 0; i < size; i++) {
    const worker = new Worker(url, { name: `continuum bake ${i + 1}` });
    worker.onmessage = ({ data }) => {
      if (data.ready) { idle.push(worker); pump(); return; }
      const job = waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      idle.push(worker);
      if (data.error) job.reject(Error(data.error)); else job.resolve(data);
      pump();
    };
    worker.onerror = (event) => { for (const job of waiting.values()) if (job.worker === worker) job.reject(Error(event.message || 'continuum bake worker failed')); };
    workers.push(worker);
  }
  return {
    bake(fingerprint, version, body, pieces = false) {
      const send = { name: body.name, vertices: body.vertices, parts: body.parts, triangles: body.triangles };
      return new Promise((resolve, reject) => { queue.push({ fingerprint, version, body: send, pieces, resolve, reject }); pump(); });
    },
    close() { for (const worker of workers) worker.terminate(); URL.revokeObjectURL(url); },
  };
}

// Every body a plan needs, as packed words in plan order: shipped, kept or baked now, nearest first. Resolves only once
// all have landed. `report` hears each as it lands ({ fingerprint, from: 'shipped'|'kept'|'baked', seconds, words }).
export async function resolvePrefabContinuum(plan, { portId = null, fetchAsset = fetch, report = null, workers = null } = {}) {
  if (!plan.bodies.length) return [];
  const { text, version } = await prefabContinuumBakeVersion(fetchAsset);
  const shipped = await prefabContinuumShipped(portId, fetchAsset);
  const out = new Array(plan.bodies.length), wanted = [];
  plan.bodies.forEach(({ fingerprint }, type) => {
    const words = shipped?.version === version ? shipped.bodies.get(fingerprint) : null;
    if (words) { out[type] = words; report?.({ fingerprint, from: 'shipped', seconds: 0, words }); } else wanted.push(type);
  });
  if (wanted.length) {
    wanted.sort((a, b) => plan.bodies[a].away - plan.bodies[b].away);
    const spare = Math.max(1, Math.min(workers ?? 4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1, wanted.length));
    const bakers = prefabBakers(text, spare);
    try {
      await Promise.all(wanted.map(async (type) => {
        const { fingerprint, body } = plan.bodies[type];
        const landed = await bakers.bake(fingerprint, version, body);
        cityContinuumBodyParts(landed.words);
        out[type] = landed.words;
        report?.({ fingerprint, from: landed.from, seconds: landed.seconds, words: landed.words });
      }));
    } finally { bakers.close(); }
  }
  return out;
}

// A struck building's pieces (js/building-fracture.js) with their coarser levels, baked by one worker kept for the
// page: { name, vertices (8 floats a corner), parts (a piece a triangle), triangles } in, the packed body's words out.
let fracturePiecesBaker = null;
export function bakeFracturePieces(body, fetchAsset = fetch) {
  fracturePiecesBaker ??= prefabContinuumBakeVersion(fetchAsset).then(({ text }) => prefabBakers(text, 1)).catch((error) => { fracturePiecesBaker = null; throw error; });
  return fracturePiecesBaker.then(async (bakers) => {
    const { words } = await bakers.bake(null, null, body, true);
    cityContinuumBodyParts(words);
    return words;
  });
}

// The atlas of a plan's bodies, type i being its i-th body.
export function prefabContinuumAtlas(words) { return assembleCityContinuumAtlas(words); }
