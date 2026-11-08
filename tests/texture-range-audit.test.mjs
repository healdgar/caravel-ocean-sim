import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TERRAIN as TERRAIN_RENDER } from '../js/wgsl/terrain.js';
import { CARAVEL as CARAVEL_RENDER } from '../js/wgsl/caravel.js';
import { SHIP_COLORS_RENDER } from '../js/ship-colors.js';
import { TOWN_CASUALTY_STAY_S } from '../js/wgsl/townsfolk.js';
import { GARRISON_CASUALTY_STAY_S } from '../js/crew.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function fract(x) {
  return x - Math.floor(x);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Evaluates 1D/2D spatial-frequency interference metrics on a rendered scanline patch
function computeRangePatchMetrics(grid, width, height) {
  let lapSum = 0;
  let lapCount = 0;
  let signFlips = 0;
  let flipPairs = 0;
  let dxEnergy = 0;
  let dyEnergy = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const c = grid[idx];
      const l = grid[idx - 1];
      const r = grid[idx + 1];
      const u = grid[idx - width];
      const d = grid[idx + width];
      const lap = Math.abs(4 * c - l - r - u - d);
      lapSum += lap;
      lapCount++;

      const d0 = c - l;
      const d1 = r - c;
      if (Math.abs(d0) > 0.012 && Math.abs(d1) > 0.012 && d0 * d1 < 0) {
        signFlips++;
      }
      flipPairs++;

      dxEnergy += Math.abs(r - l) * 0.5;
      dyEnergy += Math.abs(d - u) * 0.5;
    }
  }

  return {
    hfLaplacian: lapSum / Math.max(1, lapCount),
    signFlipRate: signFlips / Math.max(1, flipPairs),
    anisotropy: Math.max(dxEnergy / Math.max(1e-6, dyEnergy), dyEnergy / Math.max(1e-6, dxEnergy)),
  };
}

test('casualty persistence constants keep blasted townsfolk and garrison bodies on the ground for 1 full day (86,400s)', () => {
  assert.equal(TOWN_CASUALTY_STAY_S, 86400, 'Townsfolk casualties must remain on the ground for 86,400s (1 day)');
  assert.equal(GARRISON_CASUALTY_STAY_S, 86400, 'Garrison casualties must remain on the ground for 86,400s (1 day)');
});

test('shader source audit: cobblestone, shoreline, and rope shaders enforce derivative footprint & grazing-angle band-limiting', () => {
  // 1. Cobblestone Kind 16 & town street cobblestones in terrain.js
  assert.ok(
    TERRAIN_RENDER.includes('cobbleFade') && TERRAIN_RENDER.includes('stoneFade'),
    'TERRAIN_RENDER must include cobbleFade and stoneFade derivative + grazing-angle filters'
  );
  assert.ok(
    TERRAIN_RENDER.includes('rippleW=landDetailWeight') && TERRAIN_RENDER.includes('rippled=landDetailWeight(cycles)'),
    'TERRAIN_RENDER must include landDetailWeight derivative filtering on beach & shoreline ripples'
  );

  // 2. 3-strand laid hemp hawser in caravel.js and ship-colors.js
  assert.ok(
    CARAVEL_RENDER.includes('ropeLayFade') &&
      CARAVEL_RENDER.includes('ropeYarnFade') &&
      CARAVEL_RENDER.includes('strandValleyAO'),
    'CARAVEL_RENDER must include 3-strand cylindrical hawser lay (strandValleyAO) and derivative band-limiting (ropeLayFade, ropeYarnFade)'
  );
  assert.ok(
    SHIP_COLORS_RENDER.includes('strandCrown') && SHIP_COLORS_RENDER.includes('layFade'),
    'SHIP_COLORS_RENDER must include 3-strand cylindrical hawser lay and layFade derivative filtering'
  );
});

test('multi-range texture evaluation: cobblestones, roof tiles, and hemp ropes band-limit smoothly from 2m to 180m without mid-range interference spikes', () => {
  const rangesM = [2, 6, 15, 35, 80, 180];
  const grazingAnglesDeg = [45, 18];
  const patchSize = 48;
  const focalPx = 900; // 1080p equivalent focal length in pixels

  for (const angleDeg of grazingAnglesDeg) {
    const sinElev = Math.sin((angleDeg * Math.PI) / 180);
    const cobbleResults = [];
    const streetResults = [];
    const ropeResults = [];

    for (const distM of rangesM) {
      // World-space footprint per pixel along the ground plane (foreshortened by 1/sinElev)
      const pixelWorldDx = distM / focalPx;
      const pixelWorldDy = distM / (focalPx * Math.max(0.15, sinElev));
      const cobbleFootprint = Math.max(pixelWorldDx, pixelWorldDy);
      const cobbleGrazing = smoothstep(0.08, 0.38, sinElev);
      const cobbleFade = (1.0 - smoothstep(0.035, 0.16, cobbleFootprint)) * cobbleGrazing;
      const stoneFade = (1.0 - smoothstep(0.03, 0.14, cobbleFootprint)) * smoothstep(0.08, 0.36, sinElev);

      const cobbleGrid = new Float32Array(patchSize * patchSize);
      const streetGrid = new Float32Array(patchSize * patchSize);
      const ropeGrid = new Float32Array(patchSize * patchSize);

      for (let py = 0; py < patchSize; py++) {
        for (let px = 0; px < patchSize; px++) {
          const wx = (px - patchSize * 0.5) * pixelWorldDx;
          const wz = distM + (py - patchSize * 0.5) * pixelWorldDy;

          // 1. Kind 16 Architectural Cobblestone response
          const cFreq = 0.34;
          const cu = wx * cFreq;
          const cv = wz * cFreq;
          const cellX = Math.abs(fract(cu) - 0.5);
          const cellZ = Math.abs(fract(cv) - 0.5);
          const mortar = smoothstep(0.32, 0.47, Math.max(cellX, cellZ));
          const stoneBase = 0.52;
          const mortarColor = 0.38;
          cobbleGrid[py * patchSize + px] = mix(stoneBase, mix(stoneBase, mortarColor, mortar * 0.42), cobbleFade);

          // 2. Town Street Cobblestone response
          const su = wx * 3.1;
          const sv = wz * 3.1;
          const sCell = Math.max(Math.abs(fract(su) - 0.5), Math.abs(fract(sv) - 0.5));
          const sMortar = 1.0 - smoothstep(0.38, 0.48, sCell);
          const landStones = 0.72 + 0.28 * sMortar;
          streetGrid[py * patchSize + px] = mix(0.24, 0.24 * (0.86 + 0.22 * landStones), stoneFade);

          // 3. 3-Strand Hemp Rope Hawser response
          const layPhase = wx * 52.0 + (py / patchSize) * 6.2831853 * 3.0;
          const layFootprint = Math.max(pixelWorldDx * 52.0, cobbleFootprint * 48.0);
          const ropeLayFade = 1.0 - smoothstep(0.55, 2.6, layFootprint);
          const ropeYarnFade = 1.0 - smoothstep(0.18, 0.95, layFootprint);
          const strandU = fract(layPhase * 0.15915494) - 0.5;
          const strandCrown = Math.sqrt(Math.max(0.06, 1.0 - 3.55 * strandU * strandU));
          const strandValleyAO = smoothstep(0.48, 0.18, Math.abs(strandU));
          const yarnTwist = Math.sin(wx * 240.0) * ropeYarnFade;
          const laidLum = mix(0.11, 0.34 * (1.0 + 0.08 * yarnTwist), 0.22 + 0.78 * strandCrown * strandValleyAO);
          ropeGrid[py * patchSize + px] = mix(0.26, laidLum, ropeLayFade);
        }
      }

      cobbleResults.push({ distM, ...computeRangePatchMetrics(cobbleGrid, patchSize, patchSize) });
      streetResults.push({ distM, ...computeRangePatchMetrics(streetGrid, patchSize, patchSize) });
      ropeResults.push({ distM, ...computeRangePatchMetrics(ropeGrid, patchSize, patchSize) });
    }

    // At moderate (35m) and far (80m, 180m) ranges, signFlipRate must be near zero (< 0.05) — no Nyquist checkerboarding!
    for (const r of cobbleResults.filter((x) => x.distM >= 35)) {
      assert.ok(
        r.signFlipRate < 0.05,
        `Kind 16 cobblestone signFlipRate at ${r.distM}m (${angleDeg}°) was ${r.signFlipRate.toFixed(4)}, expected < 0.05`
      );
    }
    for (const r of streetResults.filter((x) => x.distM >= 35)) {
      assert.ok(
        r.signFlipRate < 0.05,
        `Street cobblestone signFlipRate at ${r.distM}m (${angleDeg}°) was ${r.signFlipRate.toFixed(4)}, expected < 0.05`
      );
      assert.ok(
        r.hfLaplacian < 0.015,
        `Street cobblestone hfLaplacian at ${r.distM}m (${angleDeg}°) was ${r.hfLaplacian.toFixed(4)}, expected < 0.015`
      );
    }
    for (const r of ropeResults.filter((x) => x.distM >= 35)) {
      assert.ok(
        r.signFlipRate < 0.05,
        `Hemp rope hawser signFlipRate at ${r.distM}m (${angleDeg}°) was ${r.signFlipRate.toFixed(4)}, expected < 0.05`
      );
    }
    // Close range (2m) must preserve rich 3-strand relief on ropes
    assert.ok(
      ropeResults[0].hfLaplacian > 0.008,
      `Hemp rope hawser at 2m close-up must exhibit clear 3-strand relief (got ${ropeResults[0].hfLaplacian.toFixed(4)})`
    );
  }
});
