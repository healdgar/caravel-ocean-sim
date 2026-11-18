// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The page's continuum bake worker (js/continuum-bake-worker.js and the one simplifier it runs, js/continuum-bake.js)
// bundled into one classic worker script, as build.mjs writes it to assets/continuum/bake-worker.js. Its digest is the
// bake's version: scripts/prepare-prefab-continuum.mjs ships bodies under it and the page keeps bodies under it.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function bundleContinuumBakeWorker(root) {
  const esbuild = createRequire(path.join(root, 'build.mjs'))('esbuild');
  const bundled = await esbuild.build({
    entryPoints: [path.join(root, 'js/continuum-bake-worker.js')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'none', charset: 'utf8', write: false, logLevel: 'silent',
  });
  const text = Buffer.from(bundled.outputFiles[0].contents);
  return { text, version: createHash('sha256').update(text).digest('hex') };
}
