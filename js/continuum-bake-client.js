// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The page's side of the one simplifier (AGENTS.md rule 3): the bake worker build.mjs bundles from
// js/continuum-bake-worker.js, run as a thread of the page's own. Every body the page draws is baked offline into its
// family's atlas; what is left to bake here is a struck building's pieces (js/building-fracture.js), whose cut is made
// by the shot and so is known only when it lands.
import { continuumBodyParts } from './continuum-format.js';

// Spelled out, because the build publishes only the asset paths it finds quoted in the source.
export const CONTINUUM_BAKE_ASSETS = Object.freeze({ 'bake-worker.js': 'assets/continuum/bake-worker.js' });

let continuumBakeWorkerText = null;
// The bake worker's text, fetched once for the page.
function continuumBakeWorkerSource(fetchAsset = fetch) {
  return continuumBakeWorkerText ??= (async () => {
    const response = await fetchAsset(CONTINUUM_BAKE_ASSETS['bake-worker.js']);
    if (!response.ok) throw Error(`The continuum's bake worker is missing (${response.status}): run npm run build`);
    return response.text();
  })().catch((error) => { continuumBakeWorkerText = null; throw error; });
}

// Workers running that text, `size` of them: each body sent is baked by the first one free.
function continuumBakers(text, size) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  const waiting = new Map(), workers = [], idle = [], queue = [];
  let next = 1;
  const pump = () => {
    while (idle.length && queue.length) {
      const worker = idle.pop(), job = queue.shift(), id = next++;
      waiting.set(id, { ...job, worker });
      worker.postMessage({ id, body: job.body });
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
    bake(body) {
      const send = { name: body.name, vertices: body.vertices, parts: body.parts, triangles: body.triangles };
      return new Promise((resolve, reject) => { queue.push({ body: send, resolve, reject }); pump(); });
    },
    close() { for (const worker of workers) worker.terminate(); URL.revokeObjectURL(url); },
  };
}

// A struck building's pieces with their coarser levels, baked by one worker kept for the page: { name, vertices
// (8 floats a corner), parts (a piece a triangle), triangles } in, the packed body's words out.
let fracturePiecesBaker = null;
export function bakeFracturePieces(body, fetchAsset = fetch) {
  fracturePiecesBaker ??= continuumBakeWorkerSource(fetchAsset).then((text) => continuumBakers(text, 1)).catch((error) => { fracturePiecesBaker = null; throw error; });
  return fracturePiecesBaker.then(async (bakers) => {
    const { words } = await bakers.bake(body);
    continuumBodyParts(words);
    return words;
  });
}
