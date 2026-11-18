// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How many triangles the scene submits, family by family, against the one budget (AGENTS.md rule 3, item 5).
// Counted on the GPU from the draws' own indirect arguments: after the frame's selections, each family's argument
// records are copied into one buffer and summed by one small compute pass. A read arrives a few frames late and
// never stalls a frame. The game counts whenever the last read has arrived (`idle`) to hold the scene to its budget
// (js/resolution.js observeTriangles). The one cut counts what it would submit at the finest cut it tried (its demand),
// so a scene its lists hold to them still reads as over budget, and the scalar coarsens it.
//
// A family offers its draws as `continuumDraws()`: a list of { buffer, offset, records, stride }, where `buffer`
// holds indirect records (made with COPY_SRC), `offset` is in bytes, and `stride` is the record's length in u32s:
// 5 for drawIndexedIndirect, 4 for drawIndirect, 1 for a count of triangles. The first two begin with the index or
// vertex count and the instance count of a triangle list; they count what is submitted, padding and all. A family whose
// fixed-size entries hide degenerate triangles (the one cut, js/wgsl/continuum-cut.js) counts its real triangles as it
// lists them and offers those words, stride 1. Every family is counted from its draws: nothing is sized on the CPU.
import { CONTINUUM_TRIANGLE_BUDGET, continuumPixelError } from './continuum-core.js';
import { CONTINUUM_LISTS, CONTINUUM_ENTRY_TRIANGLES } from './continuum-format.js';

const CONTINUUM_CENSUS_WGSL = /* wgsl */`
struct CensusRegion { first: u32, records: u32, stride: u32, family: u32 }
@group(0) @binding(0) var<storage, read> regions: array<CensusRegion>;
@group(0) @binding(1) var<storage, read> records: array<u32>;
@group(0) @binding(2) var<storage, read_write> totals: array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&regions)) { return; }
  let r = regions[id.x];
  var sum = 0u;
  for (var k = 0u; k < r.records; k++) {
    let at = r.first + k * r.stride;
    if (r.stride == 1u) { sum += records[at]; } else { sum += (records[at] / 3u) * records[at + 1u]; }
  }
  atomicAdd(&totals[r.family], sum);
}`;

export function createContinuumCensus(device, { maxFamilies = 32 } = {}) {
  const STORAGE = GPUBufferUsage.STORAGE, COPY_DST = GPUBufferUsage.COPY_DST, COPY_SRC = GPUBufferUsage.COPY_SRC;
  const names = [];
  const totals = device.createBuffer({ label: 'continuum census totals', size: maxFamilies * 4, usage: STORAGE | COPY_SRC | COPY_DST });
  let stagingWordsCap = Math.max(maxFamilies, 256);
  let staging = device.createBuffer({ label: 'continuum census read', size: stagingWordsCap * 4, usage: GPUBufferUsage.MAP_READ | COPY_DST });
  const pipeline = device.createComputePipeline({ label: 'continuum census', layout: 'auto', compute: { module: device.createShaderModule({ label: 'continuum census', code: CONTINUUM_CENSUS_WGSL }), entryPoint: 'main' } });
  let gather = null, regionBuffer = null, group = null, shape = '', regionCount = 0;
  let copies = [], sceneCopies = [], sceneWordsTotal = 0;
  let reading = false, copiedThisFrame = false, latest = null, copiedPixels = 0, copiedScenes = [], copiedWords = maxFamilies, copiedAux = null;

  const familyOf = (name) => {
    let at = names.indexOf(name);
    if (at < 0) { if (names.length >= maxFamilies) throw Error(`continuum census holds ${maxFamilies} families`); at = names.push(name) - 1; }
    return at;
  };
  // Lays the frame's draws out in the gather buffer; rebuilt only when the families' draws change shape.
  function layout(sources) {
    const regions = [];
    copies = [];
    sceneCopies = [];
    const seenScene = new Set();
    let words = 0, sceneWords = 0;
    for (const { name, draws } of sources) {
      const family = familyOf(name);
      for (const d of draws || []) {
        if (!d?.buffer || !(d.records > 0)) continue;
        const stride = d.stride === 4 || d.stride === 1 ? d.stride : 5;
        regions.push(words, d.records, stride, family);
        copies.push({ buffer: d.buffer, offset: d.offset | 0, at: words * 4, bytes: d.records * stride * 4 });
        words += d.records * stride;
        const cs = d.continuumScene;
        if (cs?.buffer && cs.words >= 24 && !seenScene.has(cs.buffer)) {
          seenScene.add(cs.buffer);
          sceneCopies.push({
            family, name, buffer: cs.buffer, words: cs.words | 0, wordOffset: sceneWords,
            capacity: cs.capacity | 0, lists: cs.lists ?? [], label: cs.label ?? name, people: d.people ?? 0,
          });
          sceneWords += cs.words | 0;
        }
      }
    }
    sceneWordsTotal = sceneWords;
    const key = copies.map((c) => `${c.at}:${c.bytes}`).join(',') + '|' + regions.join(',');
    regionCount = regions.length / 4;
    if (key === shape && gather) return;
    shape = key;
    gather?.destroy(); regionBuffer?.destroy();
    gather = device.createBuffer({ label: 'continuum census records', size: Math.max(16, words * 4), usage: STORAGE | COPY_DST });
    regionBuffer = device.createBuffer({ label: 'continuum census regions', size: Math.max(16, regions.length * 4), usage: STORAGE | COPY_DST });
    if (regions.length) device.queue.writeBuffer(regionBuffer, 0, new Uint32Array(regions));
    group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: regionBuffer } }, { binding: 1, resource: { buffer: gather } }, { binding: 2, resource: { buffer: totals } }] });
  }

  return {
    get budget() { return CONTINUUM_TRIANGLE_BUDGET; },
    // No read is in flight: a count encoded now is read back.
    get idle() { return !reading; },
    // The last count read: { families: { name: triangles }, total, submittedTotal, shadowTotal, breakdown, budget, pixels },
    // or null before the first arrives; `pixels` is the scene's pixel error the count was taken at.
    get latest() { return latest; },
    // After the frame's selections: copy each family's records and sum them. sources: [{ name, draws }].
    encode(encoder, sources, aux = null) {
      copiedThisFrame = false;
      layout(sources);
      encoder.clearBuffer(totals);
      if (regionCount) {
        for (const c of copies) encoder.copyBufferToBuffer(c.buffer, c.offset, gather, c.at, c.bytes);
        const pass = encoder.beginComputePass({ label: 'continuum census' });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(regionCount / 64));
        pass.end();
      }
      if (!reading) {
        const neededWords = maxFamilies + sceneWordsTotal;
        if (neededWords > stagingWordsCap) {
          staging.destroy();
          stagingWordsCap = Math.max(neededWords * 2, 256);
          staging = device.createBuffer({ label: 'continuum census read', size: stagingWordsCap * 4, usage: GPUBufferUsage.MAP_READ | COPY_DST });
        }
        encoder.copyBufferToBuffer(totals, 0, staging, 0, maxFamilies * 4);
        for (const sc of sceneCopies) {
          encoder.copyBufferToBuffer(sc.buffer, 0, staging, (maxFamilies + sc.wordOffset) * 4, sc.words * 4);
        }
        copiedScenes = sceneCopies.slice();
        copiedWords = neededWords;
        copiedAux = aux ? { ...aux } : null;
        copiedThisFrame = true;
        copiedPixels = continuumPixelError();
      }
    },
    // After the frame is submitted: start reading this frame's count if it was copied out.
    afterSubmit() {
      if (!copiedThisFrame || reading) return;
      reading = true; copiedThisFrame = false;
      const pixels = copiedPixels, scenesSnap = copiedScenes, wordsCount = copiedWords, auxSnap = copiedAux;
      staging.mapAsync(GPUMapMode.READ, 0, wordsCount * 4).then(() => {
        const words = new Uint32Array(staging.getMappedRange(0, wordsCount * 4).slice(0));
        staging.unmap();
        const families = {}, breakdown = {};
        let total = 0;
        names.forEach((name, i) => {
          const demanded = words[i];
          families[name] = demanded;
          total += demanded;
          breakdown[name] = {
            demanded,
            submitted: demanded,
            shadowSubmitted: 0,
            liveInstances: 0,
            capacity: 0,
            scenes: 0,
            entries: [0, 0, 0, 0, 0, 0],
            room: [0, 0, 0, 0, 0, 0],
            maxFill: 0,
            clamped: [],
          };
        });
        const hasScene = new Set(scenesSnap.map((s) => s.name));
        for (const name of hasScene) if (breakdown[name]) breakdown[name].submitted = 0;
        for (const sc of scenesSnap) {
          const b = breakdown[sc.name];
          if (!b) continue;
          const base = maxFamilies + sc.wordOffset;
          b.scenes++;
          b.capacity += sc.capacity;
          if (sc.words > 28) b.liveInstances += words[base + 28];
          for (let list = 0; list < CONTINUUM_LISTS.length; list++) {
            const count = words[base + list * 4 + 1] ?? 0;
            const room = sc.lists?.[list]?.[1] ?? 0;
            const tris = count * CONTINUUM_ENTRY_TRIANGLES[list];
            b.entries[list] += count;
            b.room[list] += room;
            if (list < 4) b.submitted += tris;
            else b.shadowSubmitted += tris;
            if (room > 0) {
              const fill = count / room;
              if (fill > b.maxFill) b.maxFill = fill;
              if (count >= room && !b.clamped.includes(CONTINUUM_LISTS[list])) b.clamped.push(CONTINUUM_LISTS[list]);
            }
          }
        }
        let submittedTotal = 0, shadowTotal = 0;
        const clampedFamilies = [];
        for (const [name, b] of Object.entries(breakdown)) {
          submittedTotal += b.submitted;
          shadowTotal += b.shadowSubmitted;
          if (b.clamped.length) clampedFamilies.push(`${name}(${b.clamped.join(',')})`);
        }
        latest = { families, total, submittedTotal, shadowTotal, clampedFamilies, breakdown, aux: auxSnap, budget: CONTINUUM_TRIANGLE_BUDGET, pixels };
      }).catch(() => {}).finally(() => { reading = false; });
    },
    destroy() { gather?.destroy(); regionBuffer?.destroy(); totals.destroy(); staging.destroy(); },
  };
}
