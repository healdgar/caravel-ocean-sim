#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Derives compact mobile continuum packs (assets/mobile-continuum/**) from the verified desktop continuum atlases
// without touching any source pack in assets/forest-scenery/** or assets/ground-cover/**.
//
// Each output pack is a full v3 continuum atlas (AGENTS.md rule 3): the exact same physical 3D tree and meadow-sward
// clusters, half-edge collapse far body, optical moments, wind bones, and octahedral card source, with only the
// sub-centimetre ultra-fine leaf/blade levels (level < minLevel) pruned so each atlas fits cleanly inside a single
// 128 MiB mobile WebGPU page and well inside iOS Safari's Jetsam memory ceiling (~26 MB forest + ~12 MB meadow
// instead of 807 MB + 378 MB).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CONTINUUM_HEADER, CONTINUUM_HEADER_WORDS, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS,
  CONTINUUM_CLUSTER_WORDS, CONTINUUM_VERTEX_WORDS, CONTINUUM_STREAMS,
  checkContinuumAtlas, continuumAtlasTypes,
} from '../js/continuum-format.js';
import { validateForestContinuumManifest } from '../js/forest-continuum.js';
import { validateMeadowGrass } from '../js/meadow-continuum.js';
import { CREW_CONTINUUM_BODIES, validateCrewContinuumManifest } from '../js/crew-continuum.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onlyArg = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice(7) ?? null;
const onlySet = onlyArg ? new Set(onlyArg.split(',').filter(Boolean)) : null;

const JOBS = [
  {
    name: 'portugal-forest',
    kind: 'forest',
    srcDir: 'assets/forest-scenery/portugal/continuum',
    outDir: 'assets/mobile-continuum/portugal-forest',
    minLevel: 5,
    validate: validateForestContinuumManifest,
  },
  {
    name: 'northern-forest',
    kind: 'forest',
    srcDir: 'assets/forest-scenery/northern/continuum',
    outDir: 'assets/mobile-continuum/northern-forest',
    minLevel: 5,
    validate: validateForestContinuumManifest,
  },
  {
    name: 'saba-forest',
    kind: 'forest',
    srcDir: 'assets/forest-scenery/saba/continuum',
    outDir: 'assets/mobile-continuum/saba-forest',
    minLevel: 5,
    validate: validateForestContinuumManifest,
  },
  {
    name: 'portugal-meadow',
    kind: 'meadow',
    srcDir: 'assets/ground-cover/portugal/meadows-gpu',
    outDir: 'assets/mobile-continuum/portugal-meadow',
    minLevel: 4,
    validate: validateMeadowGrass,
  },
  {
    name: 'tropical-meadow',
    kind: 'meadow',
    srcDir: 'assets/ground-cover/tropical/meadows-gpu',
    outDir: 'assets/mobile-continuum/tropical-meadow',
    minLevel: 4,
    validate: validateMeadowGrass,
  },
  ...CREW_CONTINUUM_BODIES.map(({ id }) => ({
    name: `crew-${id}`,
    kind: 'crew',
    srcDir: `assets/crew/continuum/${id}`,
    outDir: `assets/mobile-continuum/crew/${id}`,
    minLevel: 6,
    keepRootsBelow: true,
    maxTextureSize: 1024,
    validate: validateCrewContinuumManifest,
  })),
];

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function pruneContinuumAtlas(srcWords, minLevel, label, { keepRootsBelow = false } = {}) {
  checkContinuumAtlas(srcWords, label);
  const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE;
  const srcF = new Float32Array(srcWords.buffer, srcWords.byteOffset, srcWords.length);
  const typeCount = srcWords[H.typeCount];
  const typesAt = srcWords[H.typesAt];
  const clustersAt = srcWords[H.clustersAt];
  const verticesAt = srcWords[H.verticesAt];
  const indicesAt = srcWords[H.indicesAt];
  const chainsAt = srcWords[H.chainsAt];
  const streamsMask = srcWords[H.streams];
  const activeStreams = CONTINUUM_STREAMS.filter((s) => (streamsMask & s.bit) !== 0);
  // The group parts (a word a cluster, after the streams), where the atlas carries them.
  const srcGroupPartsAt = srcWords[H.groupParts];
  const firstStreamAt = activeStreams.length
    ? Math.min(...activeStreams.map((s) => srcWords[H[s.name]]))
    : srcGroupPartsAt || srcWords[H.words];

  // Pass 1: per-type kept clusters, watertight check, compacted vertex maps, and far-body spans.
  const perType = [];
  let totalClusters = 0, totalVertices = 0, totalIndices = 0, totalFarWords = 0;

  for (let t = 0; t < typeCount; t++) {
    const tb = typesAt + t * CONTINUUM_TYPE_WORDS;
    const cFirst = srcWords[tb + T.clusterFirst];
    const cCount = srcWords[tb + T.clusterCount];
    const oldChainVertStart = srcWords[tb + T.chainVertices];
    const chainVertCount = srcWords[tb + T.chainVertexCount];
    const oldRecAt = srcWords[tb + T.records];
    const oldTriAt = srcWords[tb + T.triangles];
    const oldStepsAt = srcWords[tb + T.steps];
    const nextRecAt = (t + 1 < typeCount)
      ? srcWords[typesAt + (t + 1) * CONTINUUM_TYPE_WORDS + T.records]
      : firstStreamAt;
    const farWords = nextRecAt - oldRecAt;
    if (!(farWords > 0)) throw Error(`${label} type ${t}: invalid far body span`);

    const keptClusters = [];
    const usedVertMap = new Map(); // oldGlobalVert -> localClusterVert
    const keptOldVerts = [];
    const minLevelParentErrors = new Set();
    let finestTriangles = 0;
    let maxKeptLevel = 0;

    for (let i = 0; i < cCount; i++) {
      const cIdx = cFirst + i;
      const cb = clustersAt + cIdx * CONTINUUM_CLUSTER_WORDS;
      const packed = srcWords[cb + 15];
      const tris = packed & 255;
      const lvl = (packed >>> 8) & 255;
      const ownErr = srcF[cb + 12];
      const pErr = srcF[cb + 13];
      const isRoot = !Number.isFinite(pErr) || pErr > 1e20;
      if (lvl < minLevel) {
        if (isRoot) {
          if (!keepRootsBelow) {
            throw Error(`${label} type ${t}: cluster ${cIdx} at L${lvl} is a root below minLevel=${minLevel}`);
          }
          // Preserve small-piece roots below minLevel as standalone leaf-roots (newLvl=0, ownErr=0) so every piece
          // remains 100% watertight at every cut threshold.
        } else {
          continue;
        }
      }
      const newLvl = lvl <= minLevel ? 0 : lvl - minLevel;
      if (newLvl > maxKeptLevel) maxKeptLevel = newLvl;
      if (newLvl === 0) {
        minLevelParentErrors.add(pErr);
        finestTriangles += tris;
      }
      const oldIdxFirst = srcWords[cb + 14];
      const remappedIndices = new Uint32Array(tris * 3);
      for (let k = 0; k < tris * 3; k++) {
        const oldV = srcWords[indicesAt + oldIdxFirst + k];
        let localV = usedVertMap.get(oldV);
        if (localV === undefined) {
          localV = keptOldVerts.length;
          usedVertMap.set(oldV, localV);
          keptOldVerts.push(oldV);
        }
        remappedIndices[k] = localV;
      }
      keptClusters.push({ cb, cIdx, packed, tris, newLvl, ownErr: newLvl === 0 ? 0 : ownErr, remappedIndices });
    }

    // Watertight check: every kept L1 cluster with non-zero error must match a kept L0 parentError.
    for (const kc of keptClusters) {
      if (kc.newLvl === 1 && kc.ownErr > 0 && !minLevelParentErrors.has(kc.ownErr)) {
        throw Error(`${label} type ${t}: L1 cluster ownErr=${kc.ownErr} has no child at L0`);
      }
    }

    const typeClusterFirst = totalClusters;
    const typeClusterVertStart = totalVertices;
    const typeChainVertStart = typeClusterVertStart + keptOldVerts.length;
    const typeIndexStart = totalIndices;
    const typeFarOffset = totalFarWords;

    const clusterIndices = keptClusters.reduce((s, kc) => s + kc.remappedIndices.length, 0);
    totalClusters += keptClusters.length;
    totalVertices += keptOldVerts.length + chainVertCount;
    totalIndices += clusterIndices;
    totalFarWords += farWords;

    perType.push({
      tb,
      keptClusters,
      keptOldVerts,
      oldChainVertStart,
      chainVertCount,
      oldRecAt,
      oldTriAt,
      oldStepsAt,
      farWords,
      typeClusterFirst,
      typeClusterVertStart,
      typeChainVertStart,
      typeIndexStart,
      typeFarOffset,
      finestTriangles,
      levels: maxKeptLevel + 1,
    });
  }

  // Pass 2: compute section offsets and assemble the new v3 atlas.
  const outTypesAt = CONTINUUM_HEADER_WORDS;
  const outClustersAt = outTypesAt + typeCount * CONTINUUM_TYPE_WORDS;
  const outVerticesAt = outClustersAt + totalClusters * CONTINUUM_CLUSTER_WORDS;
  const outIndicesAt = outVerticesAt + totalVertices * CONTINUUM_VERTEX_WORDS;
  const outChainsAt = outIndicesAt + totalIndices;
  const outStreamsAt = outChainsAt + totalFarWords;

  let totalStreamWords = 0;
  const streamOffsets = new Map();
  for (const s of activeStreams) {
    streamOffsets.set(s.name, outStreamsAt + totalStreamWords);
    totalStreamWords += totalVertices * s.words;
  }
  const outGroupPartsAt = srcGroupPartsAt ? outStreamsAt + totalStreamWords : 0;
  const outTotalWords = outStreamsAt + totalStreamWords + (srcGroupPartsAt ? totalClusters : 0);

  const out = new Uint32Array(outTotalWords);
  const outF = new Float32Array(out.buffer);

  // Copy header and patch offsets/counts (keep cones = 0 so uploadContinuumAtlas builds exact cones on upload).
  out.set(srcWords.subarray(0, CONTINUUM_HEADER_WORDS), 0);
  out[H.typesAt] = outTypesAt;
  out[H.clustersAt] = outClustersAt;
  out[H.clusterCount] = totalClusters;
  out[H.verticesAt] = outVerticesAt;
  out[H.vertexCount] = totalVertices;
  out[H.indicesAt] = outIndicesAt;
  out[H.indexCount] = totalIndices;
  out[H.chainsAt] = outChainsAt;
  out[H.words] = outTotalWords;
  out[H.cones] = 0;
  out[H.groupParts] = outGroupPartsAt;
  for (const s of CONTINUUM_STREAMS) {
    out[H[s.name]] = streamOffsets.get(s.name) ?? 0;
  }

  // Write types, clusters, vertices, indices, far bodies, and side streams.
  let idxCursor = 0;
  for (let t = 0; t < typeCount; t++) {
    const pt = perType[t];
    const outTb = outTypesAt + t * CONTINUUM_TYPE_WORDS;
    out.set(srcWords.subarray(pt.tb, pt.tb + CONTINUUM_TYPE_WORDS), outTb);
    const farDelta = (outChainsAt + pt.typeFarOffset) - pt.oldRecAt;
    out[outTb + T.clusterFirst] = pt.typeClusterFirst;
    out[outTb + T.clusterCount] = pt.keptClusters.length;
    out[outTb + T.chainVertices] = pt.typeChainVertStart;
    out[outTb + T.records] = pt.oldRecAt + farDelta;
    out[outTb + T.triangles] = pt.oldTriAt + farDelta;
    out[outTb + T.steps] = pt.oldStepsAt + farDelta;

    // Clusters + indices
    for (let i = 0; i < pt.keptClusters.length; i++) {
      const kc = pt.keptClusters[i];
      const dstCb = outClustersAt + (pt.typeClusterFirst + i) * CONTINUUM_CLUSTER_WORDS;
      out.set(srcWords.subarray(kc.cb, kc.cb + CONTINUUM_CLUSTER_WORDS), dstCb);
      outF[dstCb + 12] = kc.ownErr;
      out[dstCb + 14] = idxCursor;
      out[dstCb + 15] = ((kc.packed & 0xffff00ff) | ((kc.newLvl & 255) << 8)) >>> 0;
      if (outGroupPartsAt) out[outGroupPartsAt + pt.typeClusterFirst + i] = srcWords[srcGroupPartsAt + kc.cIdx];
      for (let k = 0; k < kc.remappedIndices.length; k++) {
        out[outIndicesAt + idxCursor + k] = pt.typeClusterVertStart + kc.remappedIndices[k];
      }
      idxCursor += kc.remappedIndices.length;
    }

    // Compacted cluster vertices
    for (let v = 0; v < pt.keptOldVerts.length; v++) {
      const oldV = pt.keptOldVerts[v];
      const newV = pt.typeClusterVertStart + v;
      out.set(
        srcWords.subarray(verticesAt + oldV * CONTINUUM_VERTEX_WORDS, verticesAt + (oldV + 1) * CONTINUUM_VERTEX_WORDS),
        outVerticesAt + newV * CONTINUUM_VERTEX_WORDS,
      );
      for (const s of activeStreams) {
        const srcS = srcWords[H[s.name]] + oldV * s.words;
        const dstS = streamOffsets.get(s.name) + newV * s.words;
        for (let k = 0; k < s.words; k++) out[dstS + k] = srcWords[srcS + k];
      }
    }

    // Far-body vertices (copied verbatim)
    const farVertSrc = verticesAt + pt.oldChainVertStart * CONTINUUM_VERTEX_WORDS;
    const farVertDst = outVerticesAt + pt.typeChainVertStart * CONTINUUM_VERTEX_WORDS;
    out.set(srcWords.subarray(farVertSrc, farVertSrc + pt.chainVertCount * CONTINUUM_VERTEX_WORDS), farVertDst);
    for (const s of activeStreams) {
      const srcS = srcWords[H[s.name]] + pt.oldChainVertStart * s.words;
      const dstS = streamOffsets.get(s.name) + pt.typeChainVertStart * s.words;
      out.set(srcWords.subarray(srcS, srcS + pt.chainVertCount * s.words), dstS);
    }

    // Far-body records, triangles, steps, and optical moments (copied verbatim)
    out.set(srcWords.subarray(pt.oldRecAt, pt.oldRecAt + pt.farWords), outChainsAt + pt.typeFarOffset);
  }

  if (idxCursor !== totalIndices) throw Error(`${label}: index count mismatch (${idxCursor} !== ${totalIndices})`);
  checkContinuumAtlas(out, `${label} mobile`);
  const checkedTypes = continuumAtlasTypes(out);
  if (checkedTypes.length !== typeCount) throw Error(`${label}: type count mismatch after prune`);
  return { out, perType, totalClusters, totalVertices, totalIndices };
}

for (const job of JOBS) {
  if (onlySet && !onlySet.has(job.name) && !onlySet.has(job.kind)) continue;
  const srcManifestPath = path.join(root, job.srcDir, 'manifest.json');
  const srcAtlasPath = path.join(root, job.srcDir, 'atlas.bin.gz');
  const manifest = JSON.parse(fs.readFileSync(srcManifestPath, 'utf8'));
  const srcBuf = zlib.gunzipSync(fs.readFileSync(srcAtlasPath));
  const srcWords = new Uint32Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength / 4);

  const { out, perType, totalClusters, totalVertices, totalIndices } = pruneContinuumAtlas(
    srcWords,
    job.minLevel,
    job.name,
    { keepRootsBelow: Boolean(job.keepRootsBelow) },
  );
  const rawBytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  const gzBytes = zlib.gzipSync(rawBytes, { level: 9 });
  const rawSha = sha256Hex(rawBytes);
  const gzSha = sha256Hex(gzBytes);

  const nextManifest = structuredClone(manifest);
  nextManifest.mobilePrunedFromLevel = job.minLevel;
  nextManifest.atlas = {
    ...nextManifest.atlas,
    words: out.length,
    bytes: rawBytes.length,
    sha256: rawSha,
    gzip: {
      file: 'atlas.bin.gz',
      bytes: gzBytes.length,
      sha256: gzSha,
    },
  };
  const outDir = path.join(root, job.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  let extraLog = '';
  if (job.kind === 'forest') {
    nextManifest.types.forEach((t, i) => {
      const pt = perType[i];
      if (t.clusters && typeof t.clusters === 'object') {
        t.clusters = {
          ...t.clusters,
          count: pt.keptClusters.length,
          levels: pt.levels,
          finestTriangles: pt.finestTriangles,
        };
      }
    });
    if (nextManifest.totals) {
      nextManifest.totals = {
        ...nextManifest.totals,
        clusters: totalClusters,
        vertices: totalVertices,
        indices: totalIndices,
      };
    }
  } else if (job.kind === 'meadow') {
    nextManifest.types.forEach((t, i) => {
      const pt = perType[i];
      t.clusters = pt.keptClusters.length;
    });
  } else if (job.kind === 'crew') {
    const pt = perType[0];
    nextManifest.clusters = {
      ...nextManifest.clusters,
      count: pt.keptClusters.length,
      levels: pt.levels,
      finestTriangles: pt.finestTriangles,
    };
    nextManifest.files['atlas.bin'] = {
      bytes: rawBytes.length,
      sha256: rawSha,
      gzip: { file: 'atlas.bin.gz', bytes: gzBytes.length, sha256: gzSha },
    };
    // Slice desktop 4K mip chain down to maxTextureSize (1024x1024 -> 1x1, 1.33 MiB raw / ~0.5 MiB gz per codec).
    const maxTex = job.maxTextureSize ?? 1024;
    const startMip = Math.max(0, manifest.texture.levels.findIndex((l) => l.width <= maxTex && l.height <= maxTex));
    const baseOffset = manifest.texture.levels[startMip].offset;
    const slicedLevels = manifest.texture.levels.slice(startMip).map((l) => ({ ...l, offset: l.offset - baseOffset }));
    const expectedTexBytes = slicedLevels.reduce((s, l) => s + l.bytes, 0);
    nextManifest.texture = {
      ...nextManifest.texture,
      width: slicedLevels[0].width,
      height: slicedLevels[0].height,
      levels: slicedLevels,
    };
    let texGzSum = 0;
    for (const codecStream of ['albedo.bc7.bin', 'albedo.astc.bin']) {
      const srcTex = zlib.gunzipSync(fs.readFileSync(path.join(root, job.srcDir, `${codecStream}.gz`)));
      const sliced = srcTex.subarray(baseOffset);
      if (sliced.byteLength !== expectedTexBytes) {
        throw Error(`${job.name} ${codecStream}: sliced ${sliced.byteLength} !== expected ${expectedTexBytes}`);
      }
      const texGz = zlib.gzipSync(sliced, { level: 9 });
      fs.writeFileSync(path.join(outDir, `${codecStream}.gz`), texGz);
      nextManifest.files[codecStream] = {
        bytes: sliced.byteLength,
        sha256: sha256Hex(sliced),
        gzip: { file: `${codecStream}.gz`, bytes: texGz.length, sha256: sha256Hex(texGz) },
      };
      texGzSum += texGz.length;
    }
    extraLog = ` | ${pt.finestTriangles} tris, ${slicedLevels[0].width}px tex (${(expectedTexBytes / 1048576).toFixed(2)} MB raw, ${(texGzSum / 2 / 1048576).toFixed(2)} MB gz/codec)`;
  }

  // Validate against the exact runtime validator before writing to disk.
  job.validate(nextManifest);

  fs.writeFileSync(path.join(outDir, 'atlas.bin.gz'), gzBytes);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(nextManifest, null, 2) + '\n');

  console.log(
    `[mobile-continuum] ${job.name}: ` +
    `${(srcBuf.byteLength / 1048576).toFixed(1)} MB -> ${(rawBytes.length / 1048576).toFixed(2)} MB raw ` +
    `(${(gzBytes.length / 1048576).toFixed(2)} MB gz) | ${totalClusters} clusters, ${totalVertices} verts${extraLog}`
  );
}
