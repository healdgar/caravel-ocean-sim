// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The page's bake worker (AGENTS.md rule 3): the one simplifier (js/continuum-bake.js) in a thread of its own, for the
// bodies the shipped atlases do not hold (a coast's prefabs stood on real elevation, a port of the player's own).
// build.mjs bundles it into assets/continuum/bake-worker.js, and js/prefab-continuum.js runs that text as a worker; the
// bundle's digest is the bake's version. Every body it bakes is kept in the origin's private file system under its
// fingerprint and that version, so a browser bakes each one once. It is no part of the page's own bundle.
import { bakeContinuumBody, bakeContinuumPiecesBody } from './continuum-bake.js';
import { packCityContinuumBody, packCityContinuumPieces } from './city-continuum.js';

const CONTINUUM_BAKE_CACHE = 'continuum-bakes';
async function continuumBakeShelf(version) {
  const root = await navigator.storage.getDirectory();
  const top = await root.getDirectoryHandle(CONTINUUM_BAKE_CACHE, { create: true });
  return top.getDirectoryHandle(version, { create: true });
}
async function continuumBakeKept(shelf, name) {
  try { return new Uint32Array(await (await (await shelf.getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; }
}
async function continuumBakeKeep(shelf, name, words) {
  const handle = await shelf.getFileHandle(name, { create: true });
  if (handle.createWritable) {
    const out = await handle.createWritable();
    await out.write(words);
    await out.close();
    return;
  }
  const access = await handle.createSyncAccessHandle();
  try { access.truncate(0); access.write(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), { at: 0 }); access.flush(); } finally { access.close(); }
}

// { id, fingerprint, version, body: { name, vertices, parts, triangles } } in; { id, words, from, seconds } out, where
// `from` says whether it was kept already ('kept') or baked now ('baked'), and `seconds` how long the bake took.
// With `pieces`, the body is a struck building's pieces: its clusters alone, baked now and never kept.
self.onmessage = async ({ data }) => {
  const { id, fingerprint, version, body, pieces } = data;
  try {
    if (pieces) {
      const started = performance.now(), words = packCityContinuumPieces({ triangles: body.triangles }, await bakeContinuumPiecesBody(body)).words;
      self.postMessage({ id, words, from: 'baked', seconds: (performance.now() - started) / 1000 }, [words.buffer]);
      return;
    }
    const shelf = await continuumBakeShelf(version).catch(() => null), name = `${fingerprint}.bin`;
    let words = shelf ? await continuumBakeKept(shelf, name) : null, from = 'kept', seconds = 0;
    if (!words) {
      const started = performance.now();
      words = packCityContinuumBody({ triangles: body.triangles }, await bakeContinuumBody(body)).words;
      seconds = (performance.now() - started) / 1000;
      from = 'baked';
      if (shelf) await continuumBakeKeep(shelf, name, words).catch((error) => console.warn('continuum bake not kept', error));
    }
    self.postMessage({ id, words, from, seconds }, [words.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.stack ?? error) });
  }
};
self.postMessage({ ready: true });
