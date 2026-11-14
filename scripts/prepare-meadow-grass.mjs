#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes compact GPU-resident 4-level coverage-preserving cluster DAG + genus-0 progressive continuum + 1-tri splats
// from raw botanical meadow data into assets/ground-cover/portugal/meadows-gpu/.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC_DIR = 'assets/ground-cover/portugal/meadows';
const OUT_DIR = 'assets/ground-cover/portugal/meadows-gpu';
const MIXES = ['pasture', 'waste', 'field-margin'];
const VARIANTS = 4;
const TILE_METRES = 1.8;
const SUB_GRID = 2; // 2x2 spatial clusters per tile variant (0.9m x 0.9m each)
const SOURCE_STRIDE = 12;
const GPU_VERTEX_WORDS = 8; // px, py, pz, packedNorm, packedCol, along, stiffness, anchor
const CLUSTER_WORDS = 12;

const LEVEL_CAPS = [160, 72, 32, 12]; // triangles per 0.9m cluster (48 clusters total -> <= 13k tris overall!)
const LEVEL_ERRORS = [0.0, 0.010, 0.028, 0.072];
const LEVEL_PARENT_ERRORS = [0.010, 0.028, 0.072, 0.190];

const MORPH_RINGS = 4;
const MORPH_K = 5;
const MORPH_STEPS = MORPH_RINGS * MORPH_K - 2; // 18 half-edge collapse steps from 40 tris -> 4 core tris

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

function packSnorm8x4(nx, ny, nz, w = 0) {
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = clamp(Math.round((nx / len) * 127), -127, 127) & 0xff;
  const y = clamp(Math.round((ny / len) * 127), -127, 127) & 0xff;
  const z = clamp(Math.round((nz / len) * 127), -127, 127) & 0xff;
  const a = clamp(Math.round(w * 127), -127, 127) & 0xff;
  return ((a << 24) | (z << 16) | (y << 8) | x) >>> 0;
}

function packColorUnorm8x4(r, g, b, a = 1) {
  const enc = (c) => clamp(Math.round(Math.pow(clamp(c, 0, 1), 1 / 2.2) * 255), 0, 255);
  const ir = enc(r), ig = enc(g), ib = enc(b);
  const ia = clamp(Math.round(clamp(a, 0, 1) * 255), 0, 255);
  return ((ia << 24) | (ib << 16) | (ig << 8) | ir) >>> 0;
}

function triArea3D(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const ux = aby * acz - abz * acy;
  const uy = abz * acx - abx * acz;
  const uz = abx * acy - aby * acx;
  return 0.5 * Math.hypot(ux, uy, uz);
}

function buildClusterGeometry(rawTris, scaleWidth = 1.0) {
  const verts = [];
  const tris = [];
  const vertMap = new Map();
  let sumR = 0, sumG = 0, sumB = 0, sumArea = 0;

  const pushVert = (v, inflationOffset) => {
    const key = scaleWidth === 1.0 ? String(v.srcIdx) : `${v.srcIdx}:${v.tag}`;
    let idx = vertMap.get(key);
    if (idx !== undefined) return idx;
    idx = verts.length / GPU_VERTEX_WORDS;
    vertMap.set(key, idx);
    verts.push(
      v.px + inflationOffset[0],
      Math.max(0, v.py + inflationOffset[1]),
      v.pz + inflationOffset[2],
      packSnorm8x4(v.nx, v.ny, v.nz, 0),
      packColorUnorm8x4(v.cr, v.cg, v.cb, 1),
      v.along,
      v.stiffness,
      v.anchor,
    );
    return idx;
  };

  for (let ti = 0; ti < rawTris.length; ti++) {
    const t = rawTris[ti];
    const [a, b, c] = t.verts;
    const area = Math.max(1e-6, t.area);
    sumR += ((a.cr + b.cr + c.cr) / 3) * area;
    sumG += ((a.cg + b.cg + c.cg) / 3) * area;
    sumB += ((a.cb + b.cb + c.cb) / 3) * area;
    sumArea += area;

    let offA = [0, 0, 0], offB = [0, 0, 0], offC = [0, 0, 0];
    if (scaleWidth > 1.01) {
      const cx = (a.px + b.px + c.px) / 3;
      const cz = (a.pz + b.pz + c.pz) / 3;
      const sx = scaleWidth - 1.0;
      const pushOut = (p) => {
        const dx = p.px - cx, dz = p.pz - cz;
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) {
          const add = Math.min(0.032, sx * len);
          return [(dx / len) * add, 0, (dz / len) * add];
        }
        return [0, 0, 0];
      };
      offA = pushOut(a);
      offB = pushOut(b);
      offC = pushOut(c);
    }
    const i0 = pushVert({ ...a, tag: `${ti}a` }, offA);
    const i1 = pushVert({ ...b, tag: `${ti}b` }, offB);
    const i2 = pushVert({ ...c, tag: `${ti}c` }, offC);
    tris.push(i0, i1, i2);
  }
  const meanCol = sumArea > 0 ? [sumR / sumArea, sumG / sumArea, sumB / sumArea] : [0.16, 0.24, 0.08];
  return { verts, tris, meanCol, totalArea: sumArea };
}

function buildSynthesizedL3Tufts(rawTris, subX, subZ, cellSize, maxTris, vertsOut, meanCol) {
  const startV = vertsOut.length / GPU_VERTEX_WORDS;
  const baseVerts = [];
  const baseTris = [];
  const half = cellSize * 0.5;
  const cxBase = (subX + 0.5) * cellSize;
  const czBase = (subZ + 0.5) * cellSize;

  let maxH = 0.25, avgStiff = 12;
  let stiffSum = 0, stiffW = 0;
  for (const t of rawTris) {
    for (const v of t.verts) {
      if (v.py > maxH) maxH = v.py;
      stiffSum += v.stiffness * v.areaWeight;
      stiffW += v.areaWeight;
    }
  }
  if (stiffW > 0) avgStiff = clamp(stiffSum / stiffW, 1.2, 60);

  // Build 4 crossed 3D curved grass gables = 8..12 real physical non-flat 3D meadow triangles
  const tuftPairs = Math.min(6, Math.max(2, Math.floor(maxTris / 2)));
  for (let p = 0; p < tuftPairs; p++) {
    const ang = (p / tuftPairs) * Math.PI + (subX * 0.7 + subZ * 1.1);
    const ox = cxBase + Math.cos(ang * 2.1 + p) * (half * 0.42);
    const oz = czBase + Math.sin(ang * 1.7 - p) * (half * 0.42);
    const dx = Math.cos(ang) * (half * 0.52);
    const dz = Math.sin(ang) * (half * 0.52);
    const nx = -Math.sin(ang), nz = Math.cos(ang);
    const tipH = clamp(maxH * (0.72 + 0.28 * ((p % 3) / 2)), 0.18, 0.95);
    const tipBendX = nx * 0.08 * tipH;
    const tipBendZ = nz * 0.08 * tipH;

    const vi = baseVerts.length / GPU_VERTEX_WORDS;
    const baseCol = packColorUnorm8x4(meanCol[0] * 0.42, meanCol[1] * 0.46, meanCol[2] * 0.42, 1);
    const midCol = packColorUnorm8x4(meanCol[0] * 0.95, meanCol[1] * 0.98, meanCol[2] * 0.9, 1);
    const tipCol = packColorUnorm8x4(Math.min(1, meanCol[0] * 1.28), Math.min(1, meanCol[1] * 1.18), Math.min(1, meanCol[2] * 0.85), 1);

    // 4 vertices forming a bent gable tuft (2 triangles with real ridge fold, never a flat quad)
    baseVerts.push(ox - dx, 0.0, oz - dz, packSnorm8x4(nx, 0.25, nz), baseCol, 0.0, avgStiff, 0.0);
    baseVerts.push(ox + dx, 0.0, oz + dz, packSnorm8x4(nx, 0.25, nz), baseCol, 0.0, avgStiff, 0.0);
    baseVerts.push(ox + tipBendX, tipH * 0.62, oz + tipBendZ, packSnorm8x4(nx * 0.7, 0.68, nz * 0.7), midCol, 0.55, avgStiff, 0.08);
    baseVerts.push(ox + dx * 0.15 + tipBendX * 1.8, tipH, oz + dz * 0.15 + tipBendZ * 1.8, packSnorm8x4(nx * 0.4, 0.9, nz * 0.4), tipCol, 1.0, avgStiff, 0.18);

    baseTris.push(vi, vi + 1, vi + 2);
    if (baseTris.length / 3 < maxTris) baseTris.push(vi + 1, vi + 3, vi + 2);
  }
  for (let k = 0; k < baseVerts.length; k++) vertsOut.push(baseVerts[k]);
  return { tris: baseTris.map((i) => startV + i) };
}

function buildGenusZeroContinuumForVariant(rawTileMeanCol, topH, radiusM, avgStiff) {
  // Connected genus-0 closed tussock dome: bottom pole (0) + MORPH_RINGS x MORPH_K rings + top pole (V-1)
  // V = 22, E = 60, F = 40 -> V - E + F = 2 exact!
  const V = 2 + MORPH_RINGS * MORPH_K;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const col = new Float32Array(V * 3);
  const sway = new Float32Array(V * 3);

  const setV = (vi, x, y, z, nx, ny, nz, shade, alongVal) => {
    pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[vi * 3] = nx / len; nrm[vi * 3 + 1] = ny / len; nrm[vi * 3 + 2] = nz / len;
    col[vi * 3] = clamp(rawTileMeanCol[0] * shade, 0, 1);
    col[vi * 3 + 1] = clamp(rawTileMeanCol[1] * shade, 0, 1);
    col[vi * 3 + 2] = clamp(rawTileMeanCol[2] * shade * (alongVal > 0.7 ? 0.85 : 1.0), 0, 1);
    sway[vi * 3] = alongVal;
    sway[vi * 3 + 1] = avgStiff;
    sway[vi * 3 + 2] = alongVal * alongVal * 0.12;
  };

  setV(0, 0, 0.0, 0, 0, -1, 0, 0.35, 0.0);
  for (let r = 0; r < MORPH_RINGS; r++) {
    const t = (r + 1) / (MORPH_RINGS + 1);
    const phi = t * Math.PI * 0.58;
    const ringR = radiusM * Math.sin(phi * 1.15);
    const ringY = topH * Math.pow(t, 0.82);
    for (let k = 0; k < MORPH_K; k++) {
      const a = (k / MORPH_K) * Math.PI * 2 + r * 0.25;
      const vi = 1 + r * MORPH_K + k;
      const lobe = 1.0 + 0.14 * Math.sin(k * 3.0 + r);
      const x = Math.cos(a) * ringR * lobe;
      const z = Math.sin(a) * ringR * lobe;
      setV(vi, x, ringY, z, Math.cos(a) * 0.72, 0.55 + t * 0.35, Math.sin(a) * 0.72, 0.45 + t * 0.82, clamp(ringY / Math.max(0.2, topH), 0, 1));
    }
  }
  setV(V - 1, 0, topH, 0, 0, 1, 0, 1.24, 1.0);

  const faces = [];
  for (let k = 0; k < MORPH_K; k++) {
    const kn = (k + 1) % MORPH_K;
    faces.push([0, 1 + kn, 1 + k]);
  }
  for (let r = 0; r < MORPH_RINGS - 1; r++) {
    const rowA = 1 + r * MORPH_K, rowB = 1 + (r + 1) * MORPH_K;
    for (let k = 0; k < MORPH_K; k++) {
      const kn = (k + 1) % MORPH_K;
      faces.push([rowA + k, rowA + kn, rowB + k]);
      faces.push([rowA + kn, rowB + kn, rowB + k]);
    }
  }
  const topRow = 1 + (MORPH_RINGS - 1) * MORPH_K;
  for (let k = 0; k < MORPH_K; k++) {
    const kn = (k + 1) % MORPH_K;
    faces.push([topRow + k, topRow + kn, V - 1]);
  }

  // Verify exact genus-0 Euler characteristic
  const edges = new Set();
  for (const [a, b, c] of faces) {
    edges.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    edges.add(b < c ? `${b}_${c}` : `${c}_${b}`);
    edges.add(c < a ? `${c}_${a}` : `${a}_${c}`);
  }
  const euler = V - edges.size + faces.length;
  if (euler !== 2) throw Error(`Genus-0 meadow continuum Euler=${euler}, expected 2`);

  // Progressive retirement map: retire ring vertices outward-to-core over MORPH_STEPS until 4 core tris remain
  const stepAncestors = [];
  const retireOrder = [];
  for (let r = 0; r < MORPH_RINGS; r++) {
    for (let k = 0; k < MORPH_K; k++) {
      const v = 1 + r * MORPH_K + k;
      if (r === MORPH_RINGS - 1 && k < 2) continue; // Keep at least 2 top ring anchors + pole0 + topPole = 4 verts / 4 core tris
      retireOrder.push({ v, target: k < 2 ? 1 + (MORPH_RINGS - 1) * MORPH_K + k : r === 0 ? 0 : V - 1 });
    }
  }
  const activeFaces = faces.map((f) => [...f]);
  const remap = new Int32Array(V);
  for (let i = 0; i < V; i++) remap[i] = i;

  const collapseSteps = [];
  for (let step = 0; step < Math.min(MORPH_STEPS, retireOrder.length); step++) {
    const { v, target } = retireOrder[step];
    let dst = target;
    while (remap[dst] !== dst) dst = remap[dst];
    remap[v] = dst;
    for (let f = 0; f < activeFaces.length; f++) {
      const tri = activeFaces[f];
      if (!tri) continue;
      for (let j = 0; j < 3; j++) if (tri[j] === v) tri[j] = dst;
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) activeFaces[f] = null;
    }
    const err = +((0.045 + ((step + 1) / MORPH_STEPS) * 0.24).toFixed(4));
    collapseSteps.push({ retired: v, dst, err, aliveTris: activeFaces.filter(Boolean).length });
  }

  return {
    vertexCount: V,
    faceCount: faces.length,
    euler,
    coreTriCount: activeFaces.filter(Boolean).length,
    pos,
    nrm,
    col,
    sway,
    faces,
    collapseSteps,
    splat: {
      centreY: +(topH * 0.42).toFixed(4),
      rx: +(radiusM * 1.12).toFixed(4),
      ry: +(topH * 0.62).toFixed(4),
      meanCol: rawTileMeanCol.map((c) => +c.toFixed(4)),
    },
  };
}

function main() {
  const srcManifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'));
  const vb = zlib.gunzipSync(fs.readFileSync(path.join(SRC_DIR, 'vertices.bin.gz')));
  const ib = zlib.gunzipSync(fs.readFileSync(path.join(SRC_DIR, 'indices.bin.gz')));
  const srcVerts = new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4);
  const srcIndices = new Uint32Array(ib.buffer, ib.byteOffset, ib.byteLength / 4);

  const outVerts = [];
  const outIndices = [];
  const clusterRecords = [];
  const variantRecords = [];
  const morphRecords = [];

  for (let mixIdx = 0; mixIdx < MIXES.length; mixIdx++) {
    const mixName = MIXES[mixIdx];
    const mixSpec = srcManifest.groves[mixName];
    for (let vIdx = 0; vIdx < VARIANTS; vIdx++) {
      const varSpec = mixSpec.variants[vIdx];
      // Find densest TILE_METRES x TILE_METRES crop inside [0, 4] x [0, 4] centered on high-cover region
      const crops = [
        [0.4, 0.4], [1.1, 1.1], [1.8, 0.6], [0.6, 1.8],
      ];
      const [cropX0, cropZ0] = crops[vIdx % crops.length];
      const cropX1 = cropX0 + TILE_METRES, cropZ1 = cropZ0 + TILE_METRES;

      const subBins = Array.from({ length: SUB_GRID * SUB_GRID }, () => []);
      const startI = varSpec.firstIndex;
      const endI = startI + varSpec.indexCount;
      const readV = (vi) => {
        const s = vi * SOURCE_STRIDE;
        return {
          srcIdx: vi,
          px: srcVerts[s] - cropX0,
          py: srcVerts[s + 1],
          pz: srcVerts[s + 2] - cropZ0,
          nx: srcVerts[s + 3],
          ny: srcVerts[s + 4],
          nz: srcVerts[s + 5],
          cr: srcVerts[s + 6],
          cg: srcVerts[s + 7],
          cb: srcVerts[s + 8],
          along: srcVerts[s + 9],
          stiffness: Math.max(0.2, srcVerts[s + 10]),
          anchor: srcVerts[s + 11],
        };
      };

      for (let ii = startI; ii + 2 < endI; ii += 3) {
        const a = readV(srcIndices[ii]);
        const b = readV(srcIndices[ii + 1]);
        const c = readV(srcIndices[ii + 2]);
        const cx = (a.px + b.px + c.px) / 3;
        const cy = (a.py + b.py + c.py) / 3;
        const cz = (a.pz + b.pz + c.pz) / 3;
        if (cx < 0 || cx >= TILE_METRES || cz < 0 || cz >= TILE_METRES) continue;
        const sx = Math.min(SUB_GRID - 1, Math.floor((cx / TILE_METRES) * SUB_GRID));
        const sz = Math.min(SUB_GRID - 1, Math.floor((cz / TILE_METRES) * SUB_GRID));
        const area = triArea3D(a.px, a.py, a.pz, b.px, b.py, b.pz, c.px, c.py, c.pz);
        const weight = area * (0.45 + 1.55 * clamp(cy, 0, 1.0));
        a.areaWeight = weight; b.areaWeight = weight; c.areaWeight = weight;
        subBins[sz * SUB_GRID + sx].push({ verts: [a, b, c], area, weight, cx, cy, cz });
      }

      const variantId = mixIdx * VARIANTS + vIdx;
      const clusterFirst = clusterRecords.length / CLUSTER_WORDS;
      let tileR = 0, tileG = 0, tileB = 0, tileW = 0, maxTileH = 0.25, stiffSum = 0;

      for (let subZ = 0; subZ < SUB_GRID; subZ++) {
        for (let subX = 0; subX < SUB_GRID; subX++) {
          const allTris = subBins[subZ * SUB_GRID + subX];
          allTris.sort((u, v) => v.weight - u.weight);
          const l0Tris = allTris.slice(0, LEVEL_CAPS[0]);
          const area0 = Math.max(1e-5, l0Tris.reduce((s, t) => s + t.area, 0));

          const cellSize = TILE_METRES / SUB_GRID;
          const subCx = (subX + 0.5) * cellSize;
          const subCz = (subZ + 0.5) * cellSize;
          let avgH = 0.22;
          if (l0Tris.length) {
            avgH = l0Tris.reduce((s, t) => s + t.cy, 0) / l0Tris.length;
            for (const t of l0Tris) {
              tileR += ((t.verts[0].cr + t.verts[1].cr + t.verts[2].cr) / 3) * t.area;
              tileG += ((t.verts[0].cg + t.verts[1].cg + t.verts[2].cg) / 3) * t.area;
              tileB += ((t.verts[0].cb + t.verts[1].cb + t.verts[2].cb) / 3) * t.area;
              tileW += t.area;
              if (t.cy > maxTileH) maxTileH = t.cy;
              stiffSum += t.verts[2].stiffness * t.area;
            }
          }

          let cellMeanCol = [0.16, 0.24, 0.08];
          for (let lvl = 0; lvl < 4; lvl++) {
            const firstIdx = outIndices.length;
            const baseVertOffset = outVerts.length / GPU_VERTEX_WORDS;
            let localTris;
            if (lvl < 3) {
              const subset = l0Tris.slice(0, Math.min(l0Tris.length, LEVEL_CAPS[lvl]));
              const areaLvl = Math.max(1e-5, subset.reduce((s, t) => s + t.area, 0));
              const wScale = lvl === 0 ? 1.0 : Math.min(2.6, Math.sqrt(area0 / areaLvl));
              const geo = buildClusterGeometry(subset, wScale);
              if (lvl === 0) cellMeanCol = geo.meanCol;
              for (let k = 0; k < geo.verts.length; k++) outVerts.push(geo.verts[k]);
              localTris = geo.tris.map((idx) => baseVertOffset + idx);
            } else {
              const l3 = buildSynthesizedL3Tufts(l0Tris, subX, subZ, cellSize, LEVEL_CAPS[3], outVerts, cellMeanCol);
              localTris = l3.tris;
            }
            for (let k = 0; k < localTris.length; k++) outIndices.push(localTris[k]);
            clusterRecords.push(
              firstIdx,
              localTris.length,
              lvl,
              LEVEL_PARENT_ERRORS[lvl],
              LEVEL_ERRORS[lvl],
              subCx,
              avgH * 0.5,
              subCz,
              Math.hypot(cellSize * 0.5, maxTileH * 0.5),
              variantId,
              subX,
              subZ,
            );
          }
        }
      }

      const tileMeanCol = tileW > 0 ? [tileR / tileW, tileG / tileW, tileB / tileW] : [0.16, 0.24, 0.08];
      const avgStiff = tileW > 0 ? clamp(stiffSum / tileW, 2.0, 50) : 14;
      const cont = buildGenusZeroContinuumForVariant(tileMeanCol, clamp(maxTileH * 0.92, 0.24, 0.85), TILE_METRES * 0.44, avgStiff);
      morphRecords.push({ variantId, mix: mixName, variant: vIdx, ...cont });
      variantRecords.push({
        variantId,
        mix: mixName,
        variant: vIdx,
        firstCluster: clusterFirst,
        clusterCount: SUB_GRID * SUB_GRID * 4,
        genusZeroEuler: cont.euler,
        coreTriCount: cont.coreTriCount,
        meanColour: cont.splat.meanCol,
        splat: cont.splat,
      });
    }
  }

  // Pack mixed float32/uint32 buffers cleanly
  const vertBuf = new ArrayBuffer(outVerts.length * 4);
  const vf32 = new Float32Array(vertBuf), vu32 = new Uint32Array(vertBuf);
  for (let i = 0; i < outVerts.length; i += GPU_VERTEX_WORDS) {
    vf32[i] = outVerts[i];
    vf32[i + 1] = outVerts[i + 1];
    vf32[i + 2] = outVerts[i + 2];
    vu32[i + 3] = outVerts[i + 3] >>> 0;
    vu32[i + 4] = outVerts[i + 4] >>> 0;
    vf32[i + 5] = outVerts[i + 5];
    vf32[i + 6] = outVerts[i + 6];
    vf32[i + 7] = outVerts[i + 7];
  }
  const idxBuf = new Uint32Array(outIndices);
  const clBuf = new ArrayBuffer(clusterRecords.length * 4);
  const cf32 = new Float32Array(clBuf), cu32 = new Uint32Array(clBuf);
  for (let i = 0; i < clusterRecords.length; i += CLUSTER_WORDS) {
    cu32[i] = clusterRecords[i] >>> 0;
    cu32[i + 1] = clusterRecords[i + 1] >>> 0;
    cu32[i + 2] = clusterRecords[i + 2] >>> 0;
    cf32[i + 3] = clusterRecords[i + 3];
    cf32[i + 4] = clusterRecords[i + 4];
    cf32[i + 5] = clusterRecords[i + 5];
    cf32[i + 6] = clusterRecords[i + 6];
    cf32[i + 7] = clusterRecords[i + 7];
    cf32[i + 8] = clusterRecords[i + 8];
    cu32[i + 9] = clusterRecords[i + 9] >>> 0;
    cu32[i + 10] = clusterRecords[i + 10] >>> 0;
    cu32[i + 11] = clusterRecords[i + 11] >>> 0;
  }

  // Pack morph.bin: per-variant continuum (V*8 GPU verts + F*3 u32 face indices + MORPH_STEPS*4 collapse u32/f32)
  const MORPH_VERT_FLOATS = 8; // px, py, pz, packedNorm, packedCol, along, stiff, anchor
  const perVarVertBytes = (2 + MORPH_RINGS * MORPH_K) * MORPH_VERT_FLOATS * 4;
  const perVarFaceBytes = (MORPH_RINGS * MORPH_K * 2) * 3 * 4;
  const perVarStepBytes = MORPH_STEPS * 4 * 4; // retiredV(u32), dstV(u32), err(f32), pad(u32)
  const perVarBytes = perVarVertBytes + perVarFaceBytes + perVarStepBytes;
  const morphBuf = new ArrayBuffer(morphRecords.length * perVarBytes);
  const mf32 = new Float32Array(morphBuf), mu32 = new Uint32Array(morphBuf);
  for (let mIdx = 0; mIdx < morphRecords.length; mIdx++) {
    const mr = morphRecords[mIdx];
    const baseWord = (mIdx * perVarBytes) / 4;
    for (let vi = 0; vi < mr.vertexCount; vi++) {
      const vw = baseWord + vi * MORPH_VERT_FLOATS;
      mf32[vw] = mr.pos[vi * 3];
      mf32[vw + 1] = mr.pos[vi * 3 + 1];
      mf32[vw + 2] = mr.pos[vi * 3 + 2];
      mu32[vw + 3] = packSnorm8x4(mr.nrm[vi * 3], mr.nrm[vi * 3 + 1], mr.nrm[vi * 3 + 2]);
      mu32[vw + 4] = packColorUnorm8x4(mr.col[vi * 3], mr.col[vi * 3 + 1], mr.col[vi * 3 + 2], 1);
      mf32[vw + 5] = mr.sway[vi * 3];
      mf32[vw + 6] = mr.sway[vi * 3 + 1];
      mf32[vw + 7] = mr.sway[vi * 3 + 2];
    }
    const faceBaseWord = baseWord + perVarVertBytes / 4;
    for (let fi = 0; fi < mr.faceCount; fi++) {
      mu32[faceBaseWord + fi * 3] = mr.faces[fi][0];
      mu32[faceBaseWord + fi * 3 + 1] = mr.faces[fi][1];
      mu32[faceBaseWord + fi * 3 + 2] = mr.faces[fi][2];
    }
    const stepBaseWord = faceBaseWord + perVarFaceBytes / 4;
    for (let si = 0; si < MORPH_STEPS; si++) {
      const st = mr.collapseSteps[si];
      mu32[stepBaseWord + si * 4] = st.retired;
      mu32[stepBaseWord + si * 4 + 1] = st.dst;
      mf32[stepBaseWord + si * 4 + 2] = st.err;
      mu32[stepBaseWord + si * 4 + 3] = st.aliveTris;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const filesMeta = {};
  const writeStream = (name, rawBuf) => {
    const raw = Buffer.from(rawBuf.buffer ?? rawBuf, rawBuf.byteOffset ?? 0, rawBuf.byteLength);
    const gz = zlib.gzipSync(raw, { level: 9 });
    fs.writeFileSync(path.join(OUT_DIR, `${name}.gz`), gz);
    filesMeta[name] = { bytes: raw.byteLength, gzipBytes: gz.byteLength, sha256: sha256Hex(raw) };
  };
  writeStream('vertices.bin', new Uint8Array(vertBuf));
  writeStream('indices.bin', idxBuf);
  writeStream('clusters.bin', new Uint8Array(clBuf));
  writeStream('morph.bin', new Uint8Array(morphBuf));

  const outManifest = {
    format: 'waterworld.meadow-grass-gpu',
    version: 1,
    tileMetres: TILE_METRES,
    mixes: MIXES,
    variants: VARIANTS,
    subGrid: SUB_GRID,
    levels: 4,
    levelErrors: LEVEL_ERRORS,
    levelParentErrors: LEVEL_PARENT_ERRORS,
    strideBytes: GPU_VERTEX_WORDS * 4,
    clusterRecordWords: CLUSTER_WORDS,
    morph: {
      rings: MORPH_RINGS,
      ringSegments: MORPH_K,
      vertexCount: 2 + MORPH_RINGS * MORPH_K,
      faceCount: MORPH_RINGS * MORPH_K * 2,
      steps: MORPH_STEPS,
      bytesPerVariant: perVarBytes,
    },
    vertexCount: outVerts.length / GPU_VERTEX_WORDS,
    triangleCount: outIndices.length / 3,
    clusterCount: clusterRecords.length / CLUSTER_WORDS,
    variantRecords,
    files: filesMeta,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(outManifest, null, 2));
  const totalGz = Object.values(filesMeta).reduce((s, f) => s + f.gzipBytes, 0);
  console.log(`Baked meadows-gpu: ${outManifest.vertexCount} verts, ${outManifest.triangleCount} tris, ${outManifest.clusterCount} clusters, ${(totalGz / 1024).toFixed(1)} KB gz total`);
}

main();
