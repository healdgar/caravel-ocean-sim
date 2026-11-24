// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { waterworldChannel, waterworldApiBase, getWaterworldBuild, formatBuildLabel } from '../js/version.js';

test('waterworldChannel and waterworldApiBase distinguish prod, test, and local mounts', () => {
  assert.equal(waterworldChannel({ pathname: '/waterworld/' }), 'prod');
  assert.equal(waterworldChannel({ pathname: '/waterworld' }), 'prod');
  assert.equal(waterworldChannel({ pathname: '/waterworld-test/' }), 'test');
  assert.equal(waterworldChannel({ pathname: '/waterworld-test' }), 'test');
  assert.equal(waterworldChannel({ pathname: '/waterworld-test/index.html' }), 'test');
  assert.equal(waterworldChannel({ pathname: '/' }), 'local');

  assert.equal(waterworldApiBase({ pathname: '/waterworld/' }), '/waterworld/api');
  assert.equal(waterworldApiBase({ pathname: '/waterworld-test/' }), '/waterworld-test/api');
  assert.equal(waterworldApiBase({ pathname: '/' }), '/waterworld/api');
});

test('getWaterworldBuild and formatBuildLabel format stamped build metadata cleanly', () => {
  const prev = globalThis.__WATERWORLD_BUILD__;
  try {
    globalThis.__WATERWORLD_BUILD__ = { version: '1.0.953', build: 953, commit: '1446384', branch: 'career-foundation', dirty: false, builtAt: '2026-11-22T03:40:00.000Z' };
    const info = getWaterworldBuild({ pathname: '/waterworld-test/' });
    assert.equal(info.channel, 'test');
    assert.equal(info.build, 953);
    assert.equal(formatBuildLabel(info), 'Build #953 · v1.0.953 (1446384)');
  } finally {
    if (prev === undefined) delete globalThis.__WATERWORLD_BUILD__;
    else globalThis.__WATERWORLD_BUILD__ = prev;
  }
});

test('createMeadowGrass never dereferences pack after clearing pack = null', () => {
  const src = fs.readFileSync(new URL('../js/meadow-grass.js', import.meta.url), 'utf8');
  const start = src.indexOf('export async function createMeadowGrass');
  const clearAt = src.indexOf('pack = null;', start);
  const end = src.indexOf('export async function createSectionMeadowGrass', clearAt);
  assert.ok(start >= 0 && clearAt > start && end > clearAt, 'found createMeadowGrass bounds');
  const afterClear = src.slice(clearAt + 'pack = null;'.length, end);
  assert.doesNotMatch(afterClear, /\bpack\./, 'pack.* must not be referenced after pack = null');
});

test('inland-water WGSL avoids world-coordinate lever-arm phase moire with rotating flow/shore vectors', () => {
  const src = fs.readFileSync(new URL('../js/wgsl/inland-water.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /dot\(\s*p\s*,\s*kAxis\s*\)/, 'riverBarWave must not dot worldXZ with rotating kAxis');
  assert.doesNotMatch(src, /dot\(\s*p\s*,\s*kSide\s*\)/, 'riverBarWave must not dot worldXZ with rotating kSide');
  assert.doesNotMatch(src, /dot\(\s*pos[AB]\s*,\s*(?:across|dir)\s*\)/, 'fluvial UV/undulation must use intrinsic channel coords, not dot(worldXZ, rotatingFlow)');
  assert.match(src, /fn riverBarWave\(p:\s*vec2f,\s*chCoord:\s*vec2f/, 'riverBarWave takes intrinsic curvilinear channel coordinates');
  assert.match(src, /let\s+overSea\s*=\s*smoothstep\(/, 'estuary wings feather laterally whenever overlapping submerged sea bed');
});

test('boulder continuum binds and evaluates Shared Neural PBR for close-up rock texture', () => {
  const jsSrc = fs.readFileSync(new URL('../js/boulder-continuum.js', import.meta.url), 'utf8');
  const wgslSrc = fs.readFileSync(new URL('../js/wgsl/boulder-continuum.js', import.meta.url), 'utf8');
  assert.match(jsSrc, /BOULDER_CONTINUUM_BINDINGS\s*=\s*Object\.freeze\(\[[^\]]*22\s*,\s*23/, 'BOULDER_CONTINUUM_BINDINGS must include Neural PBR bindings 22 and 23');
  assert.match(wgslSrc, /createNeuralPbrWGSL\(\{\s*group:\s*0,\s*latentBinding:\s*22,\s*weightBinding:\s*23\s*\}\)/, 'boulder prelude includes Neural PBR bindings 22/23');
  assert.match(wgslSrc, /evalNeuralPbr\(/, 'boulder shade evaluates Neural PBR');
  assert.match(wgslSrc, /applyNeuralPbrNormal\(/, 'boulder shade applies Neural PBR normal relief');
});

test('tree vs grass wind physics: calm wood branches, twisting leaves, quivering grass without 5.2 m/s floor', () => {
  const forestSrc = fs.readFileSync(new URL('../js/wgsl/forest-continuum.js', import.meta.url), 'utf8');
  const windSrc = fs.readFileSync(new URL('../js/wgsl/continuum-wind.js', import.meta.url), 'utf8');
  const meadowSrc = fs.readFileSync(new URL('../js/wgsl/meadow-continuum.js', import.meta.url), 'utf8');
  const groundSrc = fs.readFileSync(new URL('../js/wgsl/ground-detail.js', import.meta.url), 'utf8');

  assert.doesNotMatch(forestSrc, /if\(group>=1u\)/, 'primary wooden limbs must not receive synthetic high-frequency flutter');
  assert.match(forestSrc, /twigWind=smoothstep\(5\.5,16\.0,blown\)/, 'only outer twigs flex above moderate breeze');
  assert.match(windSrc, /let twistAng=/, 'leaves twist torsionally around their petiole in light air');
  assert.match(windSrc, /let qCross=/, 'grass blades quiver cross-wind and downwind at high frequency');
  assert.doesNotMatch(windSrc, /max\(F\.windP\[0\]\.z\s*,\s*5\.2\)/, 'continuum-wind must not clamp grass wind to 5.2 m/s');
  assert.doesNotMatch(meadowSrc, /max\((?:F\.windP\[0\]\.z|windParam\.z|speed)\s*,\s*5\.2\)/, 'meadow-continuum must not clamp grass wind to 5.2 m/s');
  assert.doesNotMatch(groundSrc, /max\(windParam\.z\s*,\s*4\.8\)/, 'grassWindWave must not clamp grass wind to 4.8 m/s');
});

test('forest/meadow continuum performance without visual degradation: GPU block/Hi-Z culling, dead-work elimination, full-fidelity profiles', async () => {
  const { forestContinuumBlocksWGSL, forestContinuumStandWGSL } = await import('../js/wgsl/forest-continuum.js');
  const { meadowContinuumStandWGSL } = await import('../js/wgsl/meadow-continuum.js');
  const { CONTINUUM_FAMILY_DEFAULTS } = await import('../js/continuum-profiles.js');

  const blocksWgsl = forestContinuumBlocksWGSL();
  const standWgsl = forestContinuumStandWGSL();
  const meadowStandWgsl = meadowContinuumStandWGSL();
  const terrainSrc = fs.readFileSync(new URL('../js/wgsl/terrain.js', import.meta.url), 'utf8');
  const forestSrc = fs.readFileSync(new URL('../js/wgsl/forest-continuum.js', import.meta.url), 'utf8');

  assert.match(blocksWgsl, /fn forestBuildBlocks\(/, 'blocks module defines forestBuildBlocks');
  assert.match(blocksWgsl, /fn forestStandBlocks\(/, 'blocks module defines forestStandBlocks');
  assert.match(blocksWgsl, /fn forestStandBlockArgs\(/, 'blocks module defines forestStandBlockArgs');
  assert.match(blocksWgsl, /continuumHiZOccluded\(/, 'block cull tests Hi-Z occlusion');
  assert.doesNotMatch(blocksWgsl, /\bforestWind\b/, 'blocks module must not reference unbound forestWind (WebKit Metal safety)');

  assert.match(standWgsl, /forestBlockList/, 'forestStandRoots reads visible blocks from forestBlockList');
  assert.match(standWgsl, /continuumHiZOccluded\(/, 'forestStandRoots tests conservative Hi-Z before ground-lift/record writes');
  assert.match(standWgsl, /inShadowRange/, 'forestStandRoots gates shadow-box checks by shadowMaxDistance');
  assert.match(meadowStandWgsl, /continuumHiZOccluded\(/, 'meadowBlocksInView tests conservative Hi-Z occlusion');
  assert.match(terrainSrc, /if\(reflStrength>0\.001\)/, 'landFinishShadowed skips dead envCube specular fetch when reflStrength <= 0.001');
  assert.match(forestSrc, /fn forestLeafShadowVis\(/, 'forest leaves use 1-tap hardware-PCF shadow lookup');

  const countStorage = (src) => (src.match(/var<storage\b/g) || []).length;
  assert.ok(countStorage(blocksWgsl) <= 8, `forestBlocks storage buffers (${countStorage(blocksWgsl)}) must stay <= 8`);
  assert.ok(countStorage(standWgsl) <= 8, `forestStand storage buffers (${countStorage(standWgsl)}) must stay <= 8`);

  const f = CONTINUUM_FAMILY_DEFAULTS.forest;
  const m = CONTINUUM_FAMILY_DEFAULTS.meadow;
  assert.equal(f.errorScale, 0.44, 'forest preserves sharp 3D leaf fidelity without coarse mid-range banana leaves');
  assert.equal(f.splatScale, 6.5, 'forest keeps cards at far pixel-perfect range, never premature floppy cards');
  assert.equal(m.errorScale, 2.5, 'meadow preserves full flyover grass fidelity without chunky squares');
  assert.equal(m.taperMetres, 0, 'meadow preserves full flyover visibility range');
});

test('universal One-Continuum prefix micro-surfels and Beer-Lambert grazing meadow continuity', async () => {
  const {
    CONTINUUM_HEADER, CONTINUUM_SURFEL_ENTRY, CONTINUUM_SURFEL_HEADER_WORDS, CONTINUUM_SURFEL_WORDS,
    packContinuumBody, assembleContinuumAtlas, continuumFinestClusters, continuumPiecesFar, buildContinuumSurfels,
  } = await import('../js/continuum-format.js');
  const { continuumModuleWGSL } = await import('../js/wgsl/continuum-cut.js');
  await import('../js/wgsl/continuum-wind.js');

  assert.equal(CONTINUUM_HEADER.surfels, 22, 'atlas header reserves slot 22 for universal surfels');
  assert.equal(CONTINUUM_SURFEL_ENTRY, 4, 'CONTINUUM_SURFEL_ENTRY uses distinct 4-bit list tag 4');

  // Synthesize a 600-triangle 3D cube-grid test mesh and verify blue-noise prefix surfel packing.
  const positions = [];
  const normals = [];
  const indices = [];
  const parts = [];
  const side = 10;
  for (let iz = 0; iz <= side; iz++) {
    for (let ix = 0; ix <= side; ix++) {
      for (let face = 0; face < 3; face++) {
        const u = ix / side, v = iz / side;
        const p = face === 0 ? [u * 4, v * 4, 0] : face === 1 ? [u * 4, 0, v * 4] : [0, u * 4, v * 4];
        const n = face === 0 ? [0, 0, 1] : face === 1 ? [0, 1, 0] : [1, 0, 0];
        positions.push(...p); normals.push(...n); parts.push(face);
      }
    }
  }
  const strideX = 3, strideZ = (side + 1) * 3;
  for (let iz = 0; iz < side; iz++) {
    for (let ix = 0; ix < side; ix++) {
      for (let face = 0; face < 3; face++) {
        const a = iz * strideZ + ix * strideX + face;
        const b = a + strideX, c = a + strideZ, d = c + strideX;
        indices.push(a, b, d, a, d, c);
      }
    }
  }
  const welded = {
    position: new Float32Array(positions),
    normal: new Float32Array(normals),
    index: new Uint32Array(indices),
    part: new Uint32Array(parts),
    count: positions.length / 3,
  };
  const clusters = continuumFinestClusters(welded);
  const far = { ...continuumPiecesFar(), splat: { rx: 2.2, ry: 2.2, centre: [2, 2, 2] } };
  const body = packContinuumBody({ triangles: indices.length / 3 }, { welded, clusters, far });
  const atlas = assembleContinuumAtlas([body.words]);
  const built = buildContinuumSurfels(atlas, { maxSurfels: 512, minLevel0Tris: 256 });
  assert.ok(built.counts[0] >= 256 && built.counts[0] <= 512, `built ${built.counts[0]} surfels for generic 3D body`);
  const f32 = new Float32Array(built.words.buffer);
  const areaR = f32[2], handoffErr = f32[3];
  assert.ok(areaR > 1.5 && areaR < 5.0, `physically plausible projected areaRadius=${areaR}`);
  assert.ok(handoffErr >= 0.71 * areaR / Math.sqrt(built.counts[0]), 'handoffError enforces sub-2px surfel guarantee');
  assert.equal(built.words.length, CONTINUUM_SURFEL_HEADER_WORDS + built.counts[0] * CONTINUUM_SURFEL_WORDS);
  // First 32 surfels (tiny prefix) must span all 3 orthogonal faces (blue-noise Morton bit-reversal stratification).
  const prefixParts = new Set();
  for (let i = 0; i < 32; i++) {
    const meta = built.words[CONTINUUM_SURFEL_HEADER_WORDS + i * CONTINUUM_SURFEL_WORDS + 1];
    prefixParts.add(meta >>> 16);
  }
  assert.equal(prefixParts.size, 3, 'even a 32-surfel prefix spans all 3 spatial faces uniformly');

  const selectWgsl = continuumModuleWGSL({ pass: 'select' });
  const visWgsl = continuumModuleWGSL({ pass: 'visibility' });
  const meadowSrc = fs.readFileSync(new URL('../js/wgsl/meadow-continuum.js', import.meta.url), 'utf8');
  const forestSrc = fs.readFileSync(new URL('../js/wgsl/forest-continuum.js', import.meta.url), 'utf8');
  const forestScenerySrc = fs.readFileSync(new URL('../js/forest-scenery.js', import.meta.url), 'utf8');
  const hairSrc = fs.readFileSync(new URL('../js/hair-continuum.js', import.meta.url), 'utf8');

  assert.match(selectWgsl, /continuumSurfelHeader\(/, 'continuumSelect queries universal surfel header');
  assert.match(selectWgsl, /CONTINUUM_SURFEL_ENTRY/, 'continuumSelect emits CONTINUUM_SURFEL_ENTRY chunks into list 2');
  assert.match(selectWgsl, /farError\*0\.44,lowGrounded/, 'lowGrounded meadow hands off before bloated Level 7 squares');
  assert.match(visWgsl, /continuumSurfelFill\(/, 'continuumVisibility expands universal micro-surfels');
  assert.match(visWgsl, /continuumSurfelMask\(/, 'continuumVisibility applies zero-discard circular MSAA disc mask');
  assert.doesNotMatch(visWgsl, /\bdiscard\b/, 'continuumVisibility never uses discard (TBDR rule 2)');
  assert.match(forestSrc, /CONTINUUM_SURFEL_ENTRY/, 'forest material shades micro-surfels without FS leaf texture fetches');
  assert.match(forestScenerySrc, /surfels:\s*\{\s*foliage:\s*true/, 'forest enables foliage micro-surfel prefix stream');
  assert.match(hairSrc, /surfels:\s*\{\s*maxSurfels:/, 'hair enables micro-surfel prefix stream');
  assert.match(meadowSrc, /blIntercept\s*=\s*1\.0\s*-\s*\(cV\s*\/\s*2\.2\)/, 'meadowParallaxSward uses Beer-Lambert grazing canopy interception');
  assert.match(meadowSrc, /if\s*\(dist\s*<\s*220\.0\)/, 'meadow receives tree/building shadows across full shadow frustum');
});
