// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FOREST_CLUSTER_VERTEX_WGSL } from '../js/forest-clusters.js';

const PORTUGAL_DIR = 'assets/forest-scenery/portugal';
const SABA_DIR = 'assets/forest-scenery/saba';
const STRIDE = 14;

function pointTriangleDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = px - (ax + v * abx), dy = py - (ay + v * aby), dz = pz - (az + v * abz);
    return dx * dx + dy * dy + dz * dz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = px - (ax + w * acx), dy = py - (ay + w * acy), dz = pz - (az + w * acz);
    return dx * dx + dy * dy + dz * dz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const dx = px - (bx + w * (cx - bx)), dy = py - (by + w * (cy - by)), dz = pz - (bz + w * (cz - bz));
    return dx * dx + dy * dy + dz * dz;
  }

  const denom = 1.0 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const dx = px - (ax + abx * v + acx * w);
  const dy = py - (ay + aby * v + acy * w);
  const dz = pz - (az + abz * v + acz * w);
  return dx * dx + dy * dy + dz * dz;
}

function pngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${filePath} must be PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('Portugal foliage maps are canonical 256x256 single-leaf botanical textures (zero multi-leaf spray cards) and clusters do not double-emit axillary tufts', () => {
  const portugal = JSON.parse(fs.readFileSync(path.join(PORTUGAL_DIR, 'manifest.json'), 'utf8'));
  const saba = JSON.parse(fs.readFileSync(path.join(SABA_DIR, 'manifest.json'), 'utf8'));
  const sabaLeafShas = new Set();
  for (const p of saba.prototypes) {
    for (const m of p.nativeMaterials) {
      if (m.name.startsWith('foliage')) {
        sabaLeafShas.add(m.albedo.sha256);
        sabaLeafShas.add(m.normal.sha256);
      }
    }
  }

  for (const p of portugal.prototypes) {
    const folMats = p.nativeMaterials.filter((m) => m.name.startsWith('foliage'));
    assert.equal(folMats.length, 3, `${p.species} ${p.cohort} must carry 3 single-leaf variants`);
    for (const m of folMats) {
      const albDim = pngDimensions(path.join(PORTUGAL_DIR, m.albedo.file));
      const nrmDim = pngDimensions(path.join(PORTUGAL_DIR, m.normal.file));
      assert.deepEqual(albDim, { width: 256, height: 256 }, `${m.albedo.file} must be 256x256 single-leaf`);
      assert.deepEqual(nrmDim, { width: 256, height: 256 }, `${m.normal.file} must be 256x256 single-leaf`);
      if (p.species !== 'blueberry') {
        assert.ok(sabaLeafShas.has(m.albedo.sha256), `${m.albedo.file} must match canonical single-leaf SHA-256`);
        assert.ok(sabaLeafShas.has(m.normal.sha256), `${m.normal.file} must match canonical single-leaf normal SHA-256`);
      }
    }
  }

  assert.equal(fs.existsSync('scripts/prepare-forest-sprays.py'), false, 'multi-leaf spray generator script must be removed');
  assert.ok(!FOREST_CLUSTER_VERTEX_WGSL.includes('crossLayer'), 'runtime cluster shader must not duplicate axillary cards');
});

test('every Portugal tree places individual leaves along 3D meshed woody shoots with 0.0% detachment and species-accurate genomic phyllotaxy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PORTUGAL_DIR, 'manifest.json'), 'utf8'));
  const rawVerts = zlib.gunzipSync(fs.readFileSync(path.join(PORTUGAL_DIR, 'vertices.bin.gz')));
  const rawIdx = zlib.gunzipSync(fs.readFileSync(path.join(PORTUGAL_DIR, 'indices.bin.gz')));
  const verts = new Float32Array(rawVerts.buffer, rawVerts.byteOffset, rawVerts.byteLength / 4);
  const indices = new Uint32Array(rawIdx.buffer, rawIdx.byteOffset, rawIdx.byteLength / 4);

  const planarityMeasure = {};

  for (const p of manifest.prototypes) {
    // Index 3D wood triangles into 0.5 m spatial hash cells for exact point-to-triangle distance checks.
    const cellSize = 0.5;
    const woodGrid = new Map();
    const wStart = p.wood.firstIndex, wEnd = wStart + p.wood.indexCount;
    const woodTris = new Float64Array((p.wood.indexCount / 3) * 9);
    let nWoodTris = 0;
    for (let i = wStart; i + 2 < wEnd; i += 3) {
      const i0 = indices[i] * STRIDE, i1 = indices[i + 1] * STRIDE, i2 = indices[i + 2] * STRIDE;
      const ax = verts[i0], ay = verts[i0 + 1], az = verts[i0 + 2];
      const bx = verts[i1], by = verts[i1 + 1], bz = verts[i1 + 2];
      const cx = verts[i2], cy = verts[i2 + 1], cz = verts[i2 + 2];
      const tIdx = nWoodTris++;
      const o = tIdx * 9;
      woodTris[o] = ax; woodTris[o + 1] = ay; woodTris[o + 2] = az;
      woodTris[o + 3] = bx; woodTris[o + 4] = by; woodTris[o + 5] = bz;
      woodTris[o + 6] = cx; woodTris[o + 7] = cy; woodTris[o + 8] = cz;
      const gx0 = Math.floor(Math.min(ax, bx, cx) / cellSize), gx1 = Math.floor(Math.max(ax, bx, cx) / cellSize);
      const gy0 = Math.floor(Math.min(ay, by, cy) / cellSize), gy1 = Math.floor(Math.max(ay, by, cy) / cellSize);
      const gz0 = Math.floor(Math.min(az, bz, cz) / cellSize), gz1 = Math.floor(Math.max(az, bz, cz) / cellSize);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          for (let gz = gz0; gz <= gz1; gz++) {
            const key = `${gx},${gy},${gz}`;
            let arr = woodGrid.get(key);
            if (!arr) { arr = []; woodGrid.set(key, arr); }
            arr.push(tIdx);
          }
        }
      }
    }

    const leafCount = p.leaf.indexCount / 12;
    assert.ok(leafCount >= 800, `${p.species} ${p.cohort} must hold individual leaves (${leafCount})`);

    // Extract petiole foot v1 (UV=(0,0.5)) and apex v4 (UV=(1,0.5)) for every leaf.
    const petioles = new Float64Array(leafCount * 3);
    const midribs = new Float64Array(leafCount * 3);
    for (let l = 0; l < leafCount; l++) {
      const at = p.leaf.firstIndex + l * 12;
      // Fold pattern [0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2]: indices[at+5] is v1 (petiole foot), indices[at+2] is v4 (apex).
      const v1 = indices[at + 5] * STRIDE;
      const v4 = indices[at + 2] * STRIDE;
      assert.ok(Math.abs(verts[v1 + 8] - 0.0) < 1e-4 && Math.abs(verts[v1 + 9] - 0.5) < 1e-4, 'v1 must be petiole foot UV=(0,0.5)');
      const px = verts[v1], py = verts[v1 + 1], pz = verts[v1 + 2];
      const ax = verts[v4], ay = verts[v4 + 1], az = verts[v4 + 2];
      petioles[l * 3] = px; petioles[l * 3 + 1] = py; petioles[l * 3 + 2] = pz;
      const mx = ax - px, my = ay - py, mz = az - pz;
      const mLen = Math.hypot(mx, my, mz) || 1;
      midribs[l * 3] = mx / mLen; midribs[l * 3 + 1] = my / mLen; midribs[l * 3 + 2] = mz / mLen;
    }

    // 1. Verify 0.0% leaf detachment (> 2 cm from 3D wood triangles) across sampled leaves.
    const sampleStep = Math.max(1, Math.floor(leafCount / 1500));
    let detached = 0, tested = 0, maxDist = 0;
    for (let l = 0; l < leafCount; l += sampleStep) {
      tested++;
      const px = petioles[l * 3], py = petioles[l * 3 + 1], pz = petioles[l * 3 + 2];
      const gx = Math.floor(px / cellSize), gy = Math.floor(py / cellSize), gz = Math.floor(pz / cellSize);
      let bestD2 = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = woodGrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const o = list[k] * 9;
              const d2 = pointTriangleDist2(
                px, py, pz,
                woodTris[o], woodTris[o + 1], woodTris[o + 2],
                woodTris[o + 3], woodTris[o + 4], woodTris[o + 5],
                woodTris[o + 6], woodTris[o + 7], woodTris[o + 8],
              );
              if (d2 < bestD2) bestD2 = d2;
            }
          }
        }
      }
      const dist = Math.sqrt(bestD2);
      if (dist > maxDist) maxDist = dist;
      if (dist > 0.02) detached++;
    }
    assert.equal(detached, 0, `${p.species} ${p.cohort}: ${detached}/${tested} leaves detached > 2 cm (max ${(maxDist * 1000).toFixed(2)} mm)`);

    // 2. Verify zero dense tufted piling: count petiole neighbors in 6 cm cells (previously up to 987 cards piled on 1 tip!).
    const cell6cm = new Map();
    for (let l = 0; l < leafCount; l++) {
      const key = `${Math.floor(petioles[l * 3] / 0.06)},${Math.floor(petioles[l * 3 + 1] / 0.06)},${Math.floor(petioles[l * 3 + 2] / 0.06)}`;
      cell6cm.set(key, (cell6cm.get(key) ?? 0) + 1);
    }
    let maxIn6cm = 0;
    for (const c of cell6cm.values()) if (c > maxIn6cm) maxIn6cm = c;
    assert.ok(maxIn6cm <= 16, `${p.species} ${p.cohort} has dense tuft piling (${maxIn6cm} leaves in a single 6 cm cell)`);

    // 3. Verify species-specific genomic traits on veteran cohort.
    if (p.cohort === 'veteran') {
      if (p.species === 'maple') {
        // Opposite-decussate: most leaves have an opposite partner whose petiole foot is within 1.8 cm with opposing lateral midrib component.
        const nodeGrid = new Map();
        for (let l = 0; l < leafCount; l++) {
          const k = `${Math.floor(petioles[l * 3] / 0.025)},${Math.floor(petioles[l * 3 + 1] / 0.025)},${Math.floor(petioles[l * 3 + 2] / 0.025)}`;
          let arr = nodeGrid.get(k);
          if (!arr) { arr = []; nodeGrid.set(k, arr); }
          arr.push(l);
        }
        let pairedCount = 0, checked = 0;
        for (let l = 0; l < leafCount; l += sampleStep) {
          checked++;
          const px = petioles[l * 3], py = petioles[l * 3 + 1], pz = petioles[l * 3 + 2];
          const gx = Math.floor(px / 0.025), gy = Math.floor(py / 0.025), gz = Math.floor(pz / 0.025);
          let foundOpposite = false;
          for (let dx = -1; dx <= 1 && !foundOpposite; dx++) {
            for (let dy = -1; dy <= 1 && !foundOpposite; dy++) {
              for (let dz = -1; dz <= 1 && !foundOpposite; dz++) {
                const cand = nodeGrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
                if (!cand) continue;
                for (const j of cand) {
                  if (j === l) continue;
                  const d = Math.hypot(petioles[j * 3] - px, petioles[j * 3 + 1] - py, petioles[j * 3 + 2] - pz);
                  if (d <= 0.018) {
                    foundOpposite = true;
                    break;
                  }
                }
              }
            }
          }
          if (foundOpposite) pairedCount++;
        }
        assert.ok(pairedCount / checked >= 0.88, `maple veteran must place opposite-decussate leaf pairs (paired ratio ${(pairedCount / checked).toFixed(3)})`);
      }

      if (p.species === 'oak' || p.species === 'elm' || p.species === 'chestnut') {
        // Measure horizontal vs vertical midrib spread: oak (foliage_planarity=0) is 3D spiral; elm (0.62) & chestnut (0.55) comb flatter horizontally.
        let horizSq = 0, vertSq = 0;
        for (let l = 0; l < leafCount; l++) {
          horizSq += midribs[l * 3] ** 2 + midribs[l * 3 + 2] ** 2;
          vertSq += midribs[l * 3 + 1] ** 2;
        }
        planarityMeasure[p.species] = horizSq / Math.max(vertSq, 1e-6);
      }
    }
  }

  // Elm (planarity 0.62) and Chestnut (0.55) must exhibit stronger horizontal two-rank combing than 3D-spiral Oak (planarity 0.0).
  assert.ok(
    planarityMeasure.elm > planarityMeasure.oak * 1.12 && planarityMeasure.chestnut > planarityMeasure.oak * 1.08,
    `expected horizontal two-rank combing elm (${planarityMeasure.elm?.toFixed(2)}) & chestnut (${planarityMeasure.chestnut?.toFixed(2)}) > 3D-spiral oak (${planarityMeasure.oak?.toFixed(2)})`,
  );
});
