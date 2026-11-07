// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes a crew body's lighter levels into its own file, as index lists into its vertices, so the skin
// weights stay where they are. The crew loader takes them instead of reducing at load.
//   node scripts/bake-crew-levels.mjs assets/crew/sailor.glb [mid far distant]
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';
import { ASSET_TYPES, createDecimator, sourceIndices } from './safe-decimate.mjs';

const args = process.argv.slice(2);
let baseBudget = null;
const baseIdx = args.indexOf('--base');
if (baseIdx !== -1) {
  baseBudget = Number(args[baseIdx + 1]);
  args.splice(baseIdx, 2);
}
const [path, ...counts] = args;
if (!path) { console.log('Usage: node scripts/bake-crew-levels.mjs [--base near] body.glb [mid far distant]'); process.exit(2); }
// The classic body's levels, and the townsfolk's distant one.
const budgets = counts.length ? counts.map(Number) : [4400, 1570, 320];
await MeshoptSimplifier.ready;
const bytes = readFileSync(path), jsonLength = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
const binStart = 20 + jsonLength + 8;
let bin = Buffer.from(bytes.subarray(binStart, binStart + doc.buffers[0].byteLength));
const primitive = doc.meshes[0].primitives[0];
if (primitive.extras?.crewLevels) throw Error('This body already has levels. Fit it again first');
const options = doc.images?.length ? { ...ASSET_TYPES.character, ignoreUvs: false } : ASSET_TYPES.character;
const decimator = createDecimator(bytes, options), diagonal = decimator.diagonal;
if (baseBudget) {
  const row = decimator.finish(decimator.atBudget(baseBudget)), indices = Uint32Array.from(sourceIndices(row)[0].indices), data = Buffer.from(indices.buffer);
  console.log(`base ${baseBudget}: ${row.triangles} triangles, surface ${(row.distance / diagonal * 100).toFixed(2)}%, outline moved ${(row.drift / diagonal * 100).toFixed(2)}%, overlap ${(row.overlap * 100).toFixed(1)}%`);
  const acc = doc.accessors[primitive.indices], view = doc.bufferViews[acc.bufferView];
  const oldStart = view.byteOffset ?? 0, oldLen = view.byteLength, delta = data.length - oldLen;
  bin = Buffer.concat([bin.subarray(0, oldStart), data, bin.subarray(oldStart + oldLen)]);
  view.byteLength = data.length;
  acc.count = indices.length;
  for (const v of doc.bufferViews) if ((v.byteOffset ?? 0) > oldStart) v.byteOffset += delta;
}
const chunks = [bin];
let offset = bin.length;
primitive.extras = { crewLevels: budgets.map((budget) => {
  const row = decimator.finish(decimator.atBudget(budget)), indices = Uint32Array.from(sourceIndices(row)[0].indices), data = Buffer.from(indices.buffer);
  console.log(`${budget}: ${row.triangles} triangles, surface ${(row.distance / diagonal * 100).toFixed(2)}%, outline moved ${(row.drift / diagonal * 100).toFixed(2)}%, overlap ${(row.overlap * 100).toFixed(1)}%`);
  const pad = (4 - offset % 4) % 4;
  chunks.push(Buffer.alloc(pad), data);
  offset += pad;
  doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target: 34963 });
  offset += data.length;
  doc.accessors.push({ bufferView: doc.bufferViews.length - 1, componentType: 5125, count: indices.length, type: 'SCALAR' });
  return doc.accessors.length - 1;
}) };
chunks.push(Buffer.alloc((4 - offset % 4) % 4));
const body = Buffer.concat(chunks);
doc.buffers[0].byteLength = body.length;
let json = Buffer.from(JSON.stringify(doc));
json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const head = Buffer.alloc(20), binHead = Buffer.alloc(8);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + json.length + body.length, 8); head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
binHead.writeUInt32LE(body.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
writeFileSync(path, Buffer.concat([head, json, binHead, body]));
console.log(`wrote ${path}: ${(28 + json.length + body.length) / 1024 | 0} KB`);
