// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
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

test('the meadow loads nothing: the terrain names its sward and the GPU makes the blades', () => {
  const terrainSrc = fs.readFileSync(new URL('../js/terrain.js', import.meta.url), 'utf8');
  assert.doesNotMatch(terrainSrc, /loadMeadowGrass|MEADOW_GRASS_(?:MOBILE_)?ASSETS/, 'no meadow atlas is fetched');
  assert.match(terrainSrc, /startMeadowLoad=\(\)=>Promise\.resolve\(\{sward:tropicalSward\?'tropical':'portugal'\}\)/);
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

test('forest/meadow continuum performance without visual degradation: GPU block/Hi-Z culling, race-free wind owners, unified profiles & overflow-safe meadow', async () => {
  const { forestContinuumBlocksWGSL, forestContinuumStandWGSL } = await import('../js/wgsl/forest-continuum.js');
  const { meadowBladesComputeWGSL } = await import('../js/wgsl/meadow-blades.js');
  const { CONTINUUM_FAMILY_DEFAULTS } = await import('../js/continuum-profiles.js');

  const blocksWgsl = forestContinuumBlocksWGSL();
  const standWgsl = forestContinuumStandWGSL();
  const meadowSowWgsl = meadowBladesComputeWGSL();
  const terrainSrc = fs.readFileSync(new URL('../js/wgsl/terrain.js', import.meta.url), 'utf8');
  const forestSrc = fs.readFileSync(new URL('../js/wgsl/forest-continuum.js', import.meta.url), 'utf8');

  assert.match(blocksWgsl, /fn forestBuildBlocks\(/, 'blocks module defines forestBuildBlocks');
  assert.match(blocksWgsl, /fn forestStandBlocks\(/, 'blocks module defines forestStandBlocks');
  assert.match(blocksWgsl, /fn forestStandBlockArgs\(/, 'blocks module defines forestStandBlockArgs');
  assert.match(blocksWgsl, /continuumHiZOccluded\(/, 'block cull tests Hi-Z occlusion');
  assert.doesNotMatch(blocksWgsl, /\bforestWind\b/, 'blocks module must not reference unbound forestWind (WebKit Metal safety)');

  assert.match(standWgsl, /forestBlockList/, 'forestStandRoots reads visible blocks from forestBlockList');
  assert.match(standWgsl, /continuumHiZOccluded\(/, 'forestStandRoots tests conservative Hi-Z before ground-lift/record writes');
  assert.match(standWgsl, /atomicOr\(&forestWindOwners\[at\],0x80000000u\)/, 'forestStandOwn uses race-free bit-31 atomicOr lock without atomicCompareExchangeWeak');
  assert.doesNotMatch(standWgsl, /atomicMax\(&forestWindOwners/, 'forestStandOwn never uses destructive atomicMax owner overwrite');
  assert.doesNotMatch(standWgsl, /inShadowRange/, 'forestStandRoots uses shadow-map frustum without hard per-family shadowMaxDistance cutoff');
  assert.match(meadowSowWgsl, /fn meadowBladeInView\(/, 'meadow cells and blades are culled to the view on the GPU');
  assert.match(meadowSowWgsl, /atomicStore\(&bladeDraws\[15\]/, 'meadowBladeFinish broadens short blades when the far list fills, so cells are never dropped');
  assert.match(terrainSrc, /if\(reflStrength>0\.001\)/, 'landFinishShadowed skips dead envCube specular fetch when reflStrength <= 0.001');
  assert.match(forestSrc, /fn forestLeafShadowVis\(/, 'forest leaves use 1-tap hardware-PCF shadow lookup');

  const countStorage = (src) => (src.match(/var<storage\b/g) || []).length;
  assert.ok(countStorage(blocksWgsl) <= 8, `forestBlocks storage buffers (${countStorage(blocksWgsl)}) must stay <= 8`);
  assert.ok(countStorage(standWgsl) <= 8, `forestStand storage buffers (${countStorage(standWgsl)}) must stay <= 8`);

  for (const [family, prof] of Object.entries(CONTINUUM_FAMILY_DEFAULTS)) {
    assert.equal(prof.errorScale, 1.0, `${family} shares unified errorScale=1.0`);
    assert.equal(prof.taperMetres, 0, `${family} shares unified linear perspective taperMetres=0`);
    assert.equal(prof.shadowMaxDistance, 0, `${family} has zero hard shadowMaxDistance cutoff`);
    assert.equal(prof.shadowMinError, 0, `${family} has zero per-family shadowMinError override`);
  }
});

test('universal One-Continuum prefix micro-surfels, tiled 563-type cards, unified cut, verified atlases & dt-scaled vessel separation', async () => {
  const {
    CONTINUUM_HEADER, CONTINUUM_SURFEL_ENTRY, CONTINUUM_SURFEL_HEADER_WORDS, CONTINUUM_SURFEL_WORDS,
    CONTINUUM_SURFEL_ORGANIC_FLAG, CONTINUUM_SURFEL_COUNT_MASK,
    packContinuumBody, assembleContinuumAtlas, continuumFinestClusters, continuumPiecesFar, buildContinuumSurfels, loadContinuumAtlas,
  } = await import('../js/continuum-format.js');
  const { continuumModuleWGSL } = await import('../js/wgsl/continuum-cut.js');
  const { continuumCardViewWGSL } = await import('../js/wgsl/continuum-cards.js');
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
  assert.equal((built.words[1] & CONTINUUM_SURFEL_ORGANIC_FLAG) >>> 0, 0, 'non-foliage surfels stay isotropic discs');
  assert.equal(built.words[1] & CONTINUUM_SURFEL_COUNT_MASK, built.counts[0], 'surfel count masked cleanly in low 24 bits');
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

  // An atlas baked without surfels is given them at upload unless its family opts out: the uploaded header points at them.
  globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };
  const { uploadContinuumAtlas } = await import('../js/continuum-scene.js');
  const uploaded = (options) => {
    const writes = [];
    const device = { limits: {}, createBuffer: ({ size }) => ({ size, destroy() {} }), queue: { writeBuffer: (buffer, at, data) => writes.push([at, data]) } };
    const { pages } = uploadContinuumAtlas(device, atlas, 'test', options);
    return { bytes: pages[0].size, surfelsAt: writes.find(([at, data]) => at === CONTINUUM_HEADER.surfels * 4 && data.length === 1)?.[1][0] ?? 0 };
  };
  const withSurfels = uploaded(), withoutSurfels = uploaded({ surfels: false });
  assert.equal(atlas[CONTINUUM_HEADER.surfels], 0, 'the bake left the surfel slot empty');
  assert.ok(withSurfels.surfelsAt >= atlas.length && withSurfels.bytes > withoutSurfels.bytes, 'an upload appends universal micro-surfels by default and points the header at them');
  assert.equal(withoutSurfels.surfelsAt, 0, 'surfels: false uploads none');

  // A pack whose atlas does not match its manifest's SHA-256 is refused unless the caller opts out.
  const atlasBytes = new Uint8Array(atlas.buffer, atlas.byteOffset, atlas.byteLength), packed = zlib.gzipSync(atlasBytes);
  const pack = (sha256) => ({
    assets: { 'manifest.json': 'manifest.json', 'atlas.bin.gz': 'atlas.bin.gz' }, validate: (manifest) => manifest, label: 'test',
    fetchAsset: async (path) => new Response(path === 'manifest.json' ? JSON.stringify({ atlas: { bytes: atlasBytes.byteLength, sha256 } }) : packed),
  });
  assert.deepEqual((await loadContinuumAtlas(pack(createHash('sha256').update(atlasBytes).digest('hex')))).words, atlas, 'a pack that matches its receipt loads');
  await assert.rejects(loadContinuumAtlas(pack('0'.repeat(64))), /failed verification/, 'SHA-256 asset integrity verification is on by default');
  assert.equal((await loadContinuumAtlas({ ...pack('0'.repeat(64)), verifySha256: false })).words.length, atlas.length, 'verifySha256: false opts out');

  const selectWgsl = continuumModuleWGSL({ pass: 'select' });
  const visWgsl = continuumModuleWGSL({ pass: 'visibility' });
  const cardWgsl = continuumCardViewWGSL();
  const meadowSrc = fs.readFileSync(new URL('../js/wgsl/meadow-blades.js', import.meta.url), 'utf8');
  const forestSrc = fs.readFileSync(new URL('../js/wgsl/forest-continuum.js', import.meta.url), 'utf8');
  const tradeSrc = fs.readFileSync(new URL('../js/trade-vessels.js', import.meta.url), 'utf8');

  assert.match(selectWgsl, /continuumSurfelHeader\(/, 'continuumSelect queries universal surfel header');
  assert.match(selectWgsl, /CONTINUUM_SURFEL_ENTRY/, 'continuumSelect emits CONTINUUM_SURFEL_ENTRY chunks into list 2');
  assert.doesNotMatch(selectWgsl, /\blowGrounded\b/, 'continuumSelect has zero meadow-specific lowGrounded branch');
  assert.match(visWgsl, /continuumSurfelFill\(/, 'continuumVisibility expands universal micro-surfels');
  assert.match(visWgsl, /continuumSurfelMask\(/, 'continuumVisibility applies zero-discard circular MSAA disc mask');
  assert.doesNotMatch(visWgsl, /\bdiscard\b/, 'continuumVisibility never uses discard (TBDR rule 2)');
  assert.match(cardWgsl, /var<storage,read>\s*cardSpheres:array<vec4f>/, 'card view reads tight per-type bounding spheres');
  assert.match(cardWgsl, /mix\(vec3f\(1\.0\),continuumCardCityWash\(tint\),washW\)/, 'city card wash uses linear matFlag blend immune to mip corruption');
  assert.match(tradeSrc, /1\s*-\s*Math\.exp\(-3\.5\s*\*\s*simDt\)/, 'trade vessel separation scales smoothly with frame time dt');
  assert.match(tradeSrc, /maxPush\s*=\s*TRADE_VESSEL_SEPARATION_DRIFT_MPS\s*\*\s*simDt/, 'trade vessel separation is limited to a drift speed times the step, so it is a motion at any step length');
  assert.doesNotMatch(tradeSrc, /maxPush\s*=\s*4\.5\s*\*\s*Math\.min\(1,\s*simDt\s*\*\s*6\)/, 'no fixed-distance shove that lets a hull jump metres in one order step');
  assert.match(forestSrc, /CONTINUUM_SURFEL_ENTRY/, 'forest material shades micro-surfels without FS leaf texture fetches');
  assert.match(meadowSrc, /fn meadowBladeFieldTop\(/, 'a blade drawn larger than it is shows the sward under each of its pixels');
  assert.match(meadowSrc, /if\s*\(dist\s*<\s*220\.0\)/, 'meadow receives tree/building shadows across full shadow frustum');
});
