// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The page's bake worker (AGENTS.md rule 3): the one simplifier (js/continuum-bake.js) in a thread of its own, for the
// one body no atlas can hold ahead of time, a struck building's pieces, cut where the shot fell. build.mjs bundles it
// into assets/continuum/bake-worker.js, and js/continuum-bake-client.js runs that text as a worker. It is no part of
// the page's own bundle.
import { bakeContinuumPiecesBody } from './continuum-bake.js';
import { packCityContinuumPieces } from './city-continuum.js';

// { id, body: { name, vertices, parts, triangles } } in; { id, words, seconds } out: the pieces' clusters, baked now.
self.onmessage = async ({ data }) => {
  const { id, body } = data;
  try {
    const started = performance.now(), words = packCityContinuumPieces({ triangles: body.triangles }, await bakeContinuumPiecesBody(body)).words;
    self.postMessage({ id, words, seconds: (performance.now() - started) / 1000 }, [words.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.stack ?? error) });
  }
};
self.postMessage({ ready: true });
