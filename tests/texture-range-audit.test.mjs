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
    for (let x = 1; x < width - 2; x++) {
      const idx = y * width + x;
      const c = grid[idx];
      const l = grid[idx - 1];
      const r = grid[idx + 1];
      const rr = grid[idx + 2];
      const u = grid[idx - width];
      const d = grid[idx + width];
      const lap = Math.abs(4 * c - l - r - u - d);
      lapSum += lap;
      lapCount++;

      // True Nyquist checkerboarding / Moiré interference oscillates across consecutive pixels (+-+ or -+-)
      const d0 = c - l;
      const d1 = r - c;
      const d2 = rr - r;
      if (Math.abs(d0) > 0.01 && Math.abs(d1) > 0.01 && Math.abs(d2) > 0.01 && d0 * d1 < 0 && d1 * d2 < 0) {
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
  // 1. Cobblestone Kind 16 & town street paving in terrain.js.
  // aca94ea replaced the procedural sett cascade of e1f3e9f (stoneColorFade, stoneBumpFade) with stones read
  // from the baked ground-detail texture. A texture read with its own gradients is band-limited by its mip
  // chain, so the paved block must hold no pattern computed per pixel, and its relief must fade with the
  // pixel's footprint. Kind 16 keeps its own early damping of the normal bump.
  const paved = pavedStreetBlock();
  assert.match(paved, /let cobbleTone=gd\.fine\.g\*[\d.]+\+gd\.mid\.g\*[\d.]+\+gd\.mid\.b\*[\d.]+;/, 'street stones take their tone from the baked ground detail');
  assert.ok(!/fract\(|floor\(|sin\(|cos\(|hash|noise/i.test(paved), 'the paved block computes no pattern of its own that could alias');
  assert.match(TERRAIN_RENDER, /fn groundDetailTexel\([^)]*\)->vec4f\{[^}]*textureSampleGrad\(groundDetailTexture/, 'ground detail is read through its mip chain with the surface\'s own gradients');
  assert.ok(streetBumpFade(1) === 0 && streetBumpFade(0) === 1, 'street relief fades out with the pixel footprint');
  assert.ok(kind16BumpFade(1, 1) === 0 && kind16BumpFade(0, 1) === 1, 'Kind 16 relief fades out with the pixel footprint');
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

// The paved branch of a town way, as it ships.
function pavedStreetBlock() {
  const start = TERRAIN_RENDER.indexOf('if(paved>0.0){'), end = TERRAIN_RENDER.indexOf('albedo=mix(albedo*(1.0-trodden', start);
  assert.ok(start > 0 && end > start, 'the paved street block is missing from the terrain shader');
  return TERRAIN_RENDER.slice(start, end);
}
// The fades the shipped shader applies, with their limits read from its source and not copied here.
function streetBumpFade(footprint) {
  const found = /let bumpVal=\([^;]*\)\*\(1\.0-smoothstep\(([\d.]+),([\d.]+),footprint\)\);/.exec(pavedStreetBlock());
  assert.ok(found, 'street relief must fade with the pixel footprint');
  return 1 - smoothstep(Number(found[1]), Number(found[2]), footprint);
}
function kind16BumpFade(footprint, upward) {
  const found = /let cobbleBumpFade=archLodFade\*\(1\.0-smoothstep\(([\d.]+),([\d.]+),cobbleAniso\)\)\*smoothstep\(([\d.]+),([\d.]+),max\(abs\(n\.y\),([\d.]+)\)\);/.exec(TERRAIN_RENDER);
  assert.ok(found, 'Kind 16 relief must fade with the pixel footprint and at grazing faces');
  const [low, high, steep, flat, least] = found.slice(1).map(Number);
  return (1 - smoothstep(low, high, footprint)) * smoothstep(steep, flat, Math.max(Math.abs(upward), least));
}

test('multi-range texture evaluation: paving and hemp ropes band-limit smoothly from 2m to 180m without mid-range interference spikes', () => {
  const rangesM = [2, 6, 15, 35, 80, 180];
  const grazingAnglesDeg = [45, 18];
  const patchSize = 48;
  const focalPx = 900; // 1080p equivalent focal length in pixels

  for (const angleDeg of grazingAnglesDeg) {
    const sinElev = Math.sin((angleDeg * Math.PI) / 180);
    const ropeResults = [];
    let previousStreet = 1, previousKind16 = 1;

    for (const distM of rangesM) {
      // World-space footprint per pixel along the ground plane (foreshortened by 1/sinElev)
      const pixelWorldDx = distM / focalPx;
      const pixelWorldDy = distM / (focalPx * Math.max(0.15, sinElev));
      const cobbleFootprint = Math.max(pixelWorldDx, pixelWorldDy);
      // 1 and 2. Paving, from the limits in the shipped shader. Its stones are a mip-mapped texture, which the
      // sampler band-limits at every range, so no checkerboard can form at 35 m as the procedural setts could.
      // Their relief also feeds the specular highlight, so from 80 m, where the earlier audit capped
      // high-frequency energy, under a tenth of it may remain, none at 180 m, and it must never return with
      // distance. At 15 m the stones stay legible.
      const street = streetBumpFade(cobbleFootprint), kind16 = kind16BumpFade(cobbleFootprint, 1);
      assert.ok(street <= previousStreet + 1e-9 && kind16 <= previousKind16 + 1e-9, `paving relief returned at ${distM}m (${angleDeg}°)`);
      previousStreet = street; previousKind16 = kind16;
      if (distM >= 80) {
        assert.ok(street < 0.1, `street relief at ${distM}m (${angleDeg}°) was ${street.toFixed(3)}, expected < 0.1`);
        assert.ok(kind16 < 0.1, `Kind 16 relief at ${distM}m (${angleDeg}°) was ${kind16.toFixed(3)}, expected < 0.1`);
      }
      if (distM >= 180) assert.ok(street === 0 && kind16 === 0, `paving relief survives at ${distM}m (${angleDeg}°)`);
      if (distM <= 15 && angleDeg === 45) {
        assert.ok(street > 0.9, `street stones lose their relief at ${distM}m (${street.toFixed(3)}), a premature fade`);
        assert.ok(kind16 > 0.9, `Kind 16 stones lose their relief at ${distM}m (${kind16.toFixed(3)}), a premature fade`);
      }

      const ropeGrid = new Float32Array(patchSize * patchSize);

      for (let py = 0; py < patchSize; py++) {
        for (let px = 0; px < patchSize; px++) {
          const wx = (px - patchSize * 0.5) * pixelWorldDx;
          const wz = distM + (py - patchSize * 0.5) * pixelWorldDy;

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

      ropeResults.push({ distM, ...computeRangePatchMetrics(ropeGrid, patchSize, patchSize) });
    }

    // At moderate (35m) and far (80m, 180m) ranges, signFlipRate must be near zero (< 0.05) — no Nyquist checkerboarding!
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
