// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Tier 2 + Tier 3 Hybrid Fluid System:
//   - Live 2D GPU Shallow Water Equations (Saint-Venant) solver running on Layer 2 of surfaceWaveTex
//     (bridge pier bow-pileup, arch Venturi speed-up, Kármán vortex eddies, coastal refraction & beach swash)
//   - GPU ballistic breaking-surf & pier-impact spray/mist pass driven directly from GPU SWE detections.
import { SHALLOW_WATER_LIMITS, SHALLOW_WATER_ENV_WGSL, SHALLOW_WATER_STEP_WGSL } from './wgsl/shallow-water.js';
import { SURF_SPRAY_COUNT, SURF_SPRAY_STRIDE, SURF_SPRAY_UPDATE_WGSL, SURF_SPRAY_RENDER_WGSL } from './wgsl/surf-spray.js';
import { WORKS_BRIDGE } from './old-world-works.js';
import { COASTAL_FIELD_SPAN_M } from './wgsl/terrain.js';

const SWE_CLAMP = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SWE_FINITE = (v, fb = 0) => (Number.isFinite(v) ? v : fb);

/**
 * Extracts metric-accurate physical water obstructions (stone bridge piers with pointed cutwaters,
 * timber bridge pile bents, collapsed rubble, and harbor pier pilings) and river channel segments
 * directly from the world's procedural country/port data. Pure function (no GPU required).
 */
export function extractShallowWaterGeometry({ bridges = [], riverReaches = [], waterfront = [], worldOffset = null } = {}) {
  const ox = SWE_FINITE(worldOffset?.x ?? worldOffset?.[0], 0);
  const oz = SWE_FINITE(worldOffset?.z ?? worldOffset?.[1], 0);
  const obstacles = [];
  const reaches = [];

  // 1. River reach segments (world-space polylines with metric half-width, depth, velocity, and surface Y)
  for (const reach of Array.isArray(riverReaches) ? riverReaches : []) {
    const pts = reach?.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!a || !b || a.length < 7 || b.length < 7) continue;
      const ax = a[0] + ox, az = a[1] + oz;
      const bx = b[0] + ox, bz = b[1] + oz;
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 0.25) continue;
      const hw = Math.max(1.2, (a[2] + b[2]) * 0.5);
      const wy0 = SWE_FINITE(a[3], 0), wy1 = SWE_FINITE(b[3], 0);
      const depth = Math.max(0.35, (SWE_FINITE(a[4], 1.2) + SWE_FINITE(b[4], 1.2)) * 0.5);
      let vx = (SWE_FINITE(a[5], 0) + SWE_FINITE(b[5], 0)) * 0.5;
      let vz = (SWE_FINITE(a[6], 0) + SWE_FINITE(b[6], 0)) * 0.5;
      const spd = Math.hypot(vx, vz);
      // Ensure gentle positive downstream flow even on slow canals so piers still build subtle wakes
      if (spd < 0.25) {
        const tx = (bx - ax) / segLen, tz = (bz - az) / segLen;
        const boost = reach.isCanal ? 0.35 : 0.75;
        vx = tx * boost;
        vz = tz * boost;
      }
      const estuaryT = ((SWE_FINITE(a[8], 0) + SWE_FINITE(b[8], 0)) * 0.5);
      reaches.push({
        ax, az, bx, bz,
        cx: (ax + bx) * 0.5,
        cz: (az + bz) * 0.5,
        radius: segLen * 0.5 + hw + 2.0,
        hw, depth, vx, vz, wy0, wy1, estuaryT,
      });
    }
  }

  // 2. Physical bridge piers, stone cutwaters, timber pile bents & collapsed rubble
  for (const br of Array.isArray(bridges) ? bridges : []) {
    if (!br) continue;
    const bx = SWE_FINITE(br.x) + ox;
    const bz = SWE_FINITE(br.z) + oz;
    const ux = SWE_FINITE(br.ux, 1);
    const uz = SWE_FINITE(br.uz, 0);
    const uLen = Math.hypot(ux, uz) || 1;
    const dx = ux / uLen, dz = uz / uLen;
    const px = -dz, pz = dx; // across bridge (aligned with river current!)
    const totalLen = Math.max(4.0, SWE_FINITE(br.length, 10));
    const halfW = Math.max(1.2, SWE_FINITE(br.halfWidth, 2.2));
    const waterY = SWE_FINITE(br.deckY, 2.5) - 2.2;

    if (br.collapsed) {
      // Destroyed bridge drops masonry rubble mounds into the river channel
      const pieces = Math.max(2, Math.min(6, Math.round(totalLen / 5)));
      for (let k = 0; k < pieces; k++) {
        const along = ((k + 0.5) / pieces - 0.5) * (totalLen * 0.78);
        obstacles.push({
          cx: bx + dx * along,
          cz: bz + dz * along,
          ux: dx, uz: dz,
          halfLen: 1.4,
          halfWid: halfW * 0.85,
          kind: 2, // rounded rubble mound
          waterY,
        });
      }
      continue;
    }

    if (br.isStone) {
      // Match WORKS_BRIDGE.arches ([7, 9, 11]) stone arch spacing & cutwater dimensions from js/old-world-works.js
      const arches = WORKS_BRIDGE.arches;
      let bestArch = arches[1], bestErr = Infinity, bestPieces = 1;
      for (const a of arches) {
        const pieces = Math.max(1, Math.round(totalLen / a));
        const err = Math.abs(pieces * a - totalLen);
        if (err < bestErr) { bestErr = err; bestArch = a; bestPieces = pieces; }
      }
      const each = totalLen / bestPieces;
      // Place piers at every arch junction inside the channel (including near-bank abutments)
      for (let a = 0; a <= bestPieces; a++) {
        const along = a * each - totalLen * 0.5;
        // Skip outer ramp tips slightly inside bank; keep all interior piers + inner abutment faces
        const isInterior = a > 0 && a < bestPieces;
        const pierHalfLen = isInterior ? 0.62 : 0.48; // along bridge (0.95–1.24 m thick masonry pier)
        const cutwaterHalfWid = halfW + (isInterior ? 0.85 : 0.45); // pointed cutwaters jutting upstream & downstream
        obstacles.push({
          cx: bx + dx * along,
          cz: bz + dz * along,
          ux: dx, uz: dz,
          halfLen: pierHalfLen,
          halfWid: cutwaterHalfWid,
          kind: isInterior ? 1 : 0, // 1 = pointed stone cutwater pier, 0 = rectangular abutment
          waterY,
        });
      }
    } else {
      // Timber footbridge (Pontão): pairs of round timber piles every WORKS_BRIDGE.bent (2.8 m)
      const bentStep = WORKS_BRIDGE.bent || 2.8;
      const bents = Math.max(2, Math.min(14, Math.round((totalLen - 2.2) / bentStep) + 1));
      const spanLen = (bents - 1) * bentStep;
      for (let k = 0; k < bents; k++) {
        const along = -spanLen * 0.5 + k * bentStep;
        for (const side of [-1.15, 1.15]) {
          obstacles.push({
            cx: bx + dx * along + px * side,
            cz: bz + dz * along + pz * side,
            ux: dx, uz: dz,
            halfLen: 0.34, // slightly padded for 0.5 m grid resolvability
            halfWid: 0.34,
            kind: 2, // cylinder pile
            waterY,
          });
        }
      }
    }
  }

  // 3. Harbor waterfront jetties / pier pilings (for coastal swell diffraction & bow-slap around piers)
  for (const wf of Array.isArray(waterfront) ? waterfront : []) {
    if (!wf || !Number.isFinite(wf.x) || !Number.isFinite(wf.z)) continue;
    const isJetty = wf.kind === 'jetty' || wf.kind === 'pier' || wf.kind === 'mole' || wf.kind === 'breakwater';
    if (!isJetty) continue;
    const wx = wf.x + ox, wz = wf.z + oz;
    const yaw = SWE_FINITE(wf.yaw, 0);
    const ux = Math.sin(yaw), uz = Math.cos(yaw);
    const halfLen = Math.max(1.2, SWE_FINITE(wf.length, 10) * 0.5);
    const halfWid = Math.max(0.8, SWE_FINITE(wf.width, 3) * 0.5);
    obstacles.push({
      cx: wx, cz: wz, ux, uz,
      halfLen, halfWid,
      kind: 0,
      waterY: 0,
    });
  }

  return { obstacles, reaches };
}

export async function createShallowWater({
  device,
  shader,
  computePipe,
  surfaceWaves,
  frameUBO,
  transView,
  skyView,
  sampClamp,
  sunVisBuf,
  format = 'rgba16float',
  samples = 4,
  size = 512,
}) {
  const B = GPUBufferUsage, T = GPUTextureUsage;
  const maxObs = SHALLOW_WATER_LIMITS.obstacles;
  const maxReaches = SHALLOW_WATER_LIMITS.reaches;
  const maxHulls = SHALLOW_WATER_LIMITS.hulls;
  const maxSpawns = SHALLOW_WATER_LIMITS.spraySpawns;

  // Compile compute & render pipelines in parallel
  const sprayRenderPromise = (async () => {
    const mod = await shader(SURF_SPRAY_RENDER_WGSL, 'shallow water surf spray render');
    return device.createRenderPipelineAsync({
      label: 'shallow water surf spray render',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: {
        module: mod,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
      multisample: { count: samples },
    });
  })();

  const [envPipe, stepPipe, sprayUpdatePipe, sprayRenderPipe] = await Promise.all([
    computePipe(SHALLOW_WATER_ENV_WGSL, 'shallow water env'),
    computePipe(SHALLOW_WATER_STEP_WGSL, 'shallow water step'),
    computePipe(SURF_SPRAY_UPDATE_WGSL, 'shallow water spray update'),
    sprayRenderPromise,
  ]);

  // Uniform buffers (1 for env + 3 for up to 3 substeps + 1 for spray update)
  const envUniform = device.createBuffer({ label: 'swe env uniform', size: 80, usage: B.UNIFORM | B.COPY_DST });
  const stepUniforms = Array.from({ length: 3 }, (_, i) =>
    device.createBuffer({ label: 'swe step uniform ' + i, size: 80, usage: B.UNIFORM | B.COPY_DST })
  );
  const sprayControlBuf = device.createBuffer({ label: 'swe spray control', size: 16, usage: B.UNIFORM | B.COPY_DST });

  // Storage buffers
  const obstacleBuf = device.createBuffer({ label: 'swe obstacles', size: maxObs * 32, usage: B.STORAGE | B.COPY_DST });
  const reachBuf = device.createBuffer({ label: 'swe reaches', size: maxReaches * 48, usage: B.STORAGE | B.COPY_DST });
  const hullBuf = device.createBuffer({ label: 'swe hulls', size: maxHulls * 32, usage: B.STORAGE | B.COPY_DST });
  const sprayCountBuf = device.createBuffer({ label: 'swe spray spawn count', size: 4, usage: B.STORAGE | B.COPY_DST });
  const spraySpawnBuf = device.createBuffer({ label: 'swe spray spawns', size: maxSpawns * 32, usage: B.STORAGE | B.COPY_DST });
  const sprayParticleBuf = device.createBuffer({
    label: 'swe spray particles',
    size: SURF_SPRAY_COUNT * SURF_SPRAY_STRIDE,
    usage: B.STORAGE | B.COPY_DST,
  });

  // Environment textures: sweEnv (h0, u0, v0, obs) + sweWaterY (rest surface elevation in metres)
  const sweEnvTex = device.createTexture({
    label: 'swe env',
    size: [size, size],
    format: 'rgba16float',
    usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
  });
  const sweWaterYTex = device.createTexture({
    label: 'swe waterY',
    size: [size, size],
    format: 'r32float',
    usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
  });
  const sweEnvView = sweEnvTex.createView();
  const sweWaterYView = sweWaterYTex.createView();

  // Fallback 1x1 deep-water coastalShelter when no coast is active
  const fbCoastTex = device.createTexture({
    label: 'swe fallback coastal shelter',
    size: [1, 1],
    format: 'rgba16float',
    usage: T.TEXTURE_BINDING | T.COPY_DST,
  });
  // Half-float for (1.0, 1.0, -40.0, -40.0): 1.0 = 0x3c00, -40.0 = 0xd100
  device.queue.writeTexture({ texture: fbCoastTex }, new Uint16Array([0x3c00, 0x3c00, 0xd100, 0xd100]), { bytesPerRow: 8 }, [1, 1]);
  const fbCoastSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

  // 2D write views directly into Layer 2 of surfaceWaves's ping-pong 2d-array textures!
  const layer2Views = [0, 1].map((i) =>
    surfaceWaves.textures[i].createView({ dimension: '2d', baseArrayLayer: 2, arrayLayerCount: 1 })
  );

  // Bind groups
  let coastalShelterView = fbCoastTex.createView();
  let coastalSampler = fbCoastSamp;
  const buildEnvGroup = () => device.createBindGroup({
    label: 'swe env group',
    layout: envPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: envUniform } },
      { binding: 1, resource: coastalShelterView },
      { binding: 2, resource: coastalSampler },
      { binding: 3, resource: { buffer: obstacleBuf } },
      { binding: 4, resource: { buffer: reachBuf } },
      { binding: 5, resource: { buffer: hullBuf } },
      { binding: 6, resource: sweEnvView },
      { binding: 7, resource: sweWaterYView },
    ],
  });
  let envGroup = buildEnvGroup();

  const stepGroups = stepUniforms.map((u) => [0, 1].map((srcIdx) => device.createBindGroup({
    label: `swe step g[${srcIdx}]`,
    layout: stepPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: u } },
      { binding: 1, resource: surfaceWaves.views[srcIdx] },
      { binding: 2, resource: layer2Views[1 - srcIdx] },
      { binding: 3, resource: sweEnvView },
      { binding: 4, resource: sweWaterYView },
      { binding: 5, resource: { buffer: sprayCountBuf } },
      { binding: 6, resource: { buffer: spraySpawnBuf } },
    ],
  })));

  const sprayUpdateGroup = device.createBindGroup({
    label: 'swe spray update group',
    layout: sprayUpdatePipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUBO } },
      { binding: 1, resource: { buffer: sprayControlBuf } },
      { binding: 2, resource: { buffer: sprayCountBuf } },
      { binding: 3, resource: { buffer: spraySpawnBuf } },
      { binding: 4, resource: { buffer: sprayParticleBuf } },
    ],
  });

  const sprayRenderGroup = device.createBindGroup({
    label: 'swe spray render group',
    layout: sprayRenderPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUBO } },
      { binding: 1, resource: transView },
      { binding: 2, resource: skyView },
      { binding: 3, resource: sampClamp },
      { binding: 4, resource: { buffer: sunVisBuf } },
      { binding: 5, resource: { buffer: sprayParticleBuf } },
    ],
  });

  // Scratch CPU arrays (reused every update, zero GC!)
  const uData = new Float32Array(20);
  const sprayCtrl = new Float32Array(4);
  const obsData = new Float32Array(maxObs * 8);
  const reachData = new Float32Array(maxReaches * 12);
  const hullData = new Float32Array(maxHulls * 8);
  const zeroU32 = new Uint32Array([0]);

  let allObstacles = [];
  let allReaches = [];
  let hasCoast = false;
  let coastalWin = [0, 0, 2048, COASTAL_FIELD_SPAN_M];
  let worldDirty = true;
  let lastGridCx = NaN, lastGridCz = NaN;
  let activeObsCount = 0, activeReachCount = 0, activeHullCount = 0;
  let needEnvDispatch = false;
  let needsClear = true;
  let active = false;
  let frameCounter = 0;
  let destroyed = false;

  const stats = {
    get active() { return active; },
    get obstacles() { return activeObsCount; },
    get reaches() { return activeReachCount; },
    get hulls() { return activeHullCount; },
    get totalObstacles() { return allObstacles.length; },
    get totalReaches() { return allReaches.length; },
    dispatches: 0,
  };

  function setWorld({ bridges = [], riverReaches = [], waterfront = [], coastalField = null, worldOffset = null } = {}) {
    if (destroyed) return;
    const extracted = extractShallowWaterGeometry({ bridges, riverReaches, waterfront, worldOffset });
    allObstacles = extracted.obstacles;
    allReaches = extracted.reaches;
    const nextShelterView = coastalField?.shelterView ?? coastalField?.shelterTex?.createView?.() ?? null;
    const nextSamp = coastalField?.sampler ?? fbCoastSamp;
    hasCoast = Boolean(nextShelterView);
    if (nextShelterView !== coastalShelterView || nextSamp !== coastalSampler) {
      coastalShelterView = nextShelterView ?? fbCoastTex.createView();
      coastalSampler = nextSamp;
      envGroup = buildEnvGroup();
    }
    if (coastalField?.window) {
      coastalWin = [
        SWE_FINITE(coastalField.window[0], 0),
        SWE_FINITE(coastalField.window[1], 0),
        SWE_FINITE(coastalField.window[2], 2048),
        COASTAL_FIELD_SPAN_M,
      ];
    }
    worldDirty = true;
    needsClear = true;
  }

  function reset() {
    needsClear = true;
    worldDirty = true;
    lastGridCx = NaN;
    lastGridCz = NaN;
  }

  /**
   * Prepares uniforms & culled obstacle/reach lists for the current frame.
   * Returns true if the 2D SWE solver should step this frame (false in deep open sea -> 0.00 ms GPU cost).
   */
  function update({
    domains,
    committed,
    dt,
    steps,
    time,
    hulls = [],
    coastalWindow = null,
    swellDir = [1, 0],
    swellHs = 0.8,
    swellLen = 90,
    windSpeed = 6,
    resetField = false,
  }) {
    if (destroyed) return false;
    if (resetField) reset();
    if (coastalWindow && coastalWindow.length >= 3) {
      coastalWin[0] = SWE_FINITE(coastalWindow[0], 0);
      coastalWin[1] = SWE_FINITE(coastalWindow[1], 0);
      coastalWin[2] = SWE_FINITE(coastalWindow[2], 2048);
    }

    const cx = domains[0], cz = domains[1], extent = domains[2], dx = domains[3];
    const gridShifted = !Number.isFinite(lastGridCx) || cx !== lastGridCx || cz !== lastGridCz;
    const margin = extent * 0.5 + 32.0;

    // Re-cull static obstacles & river reaches into the 256 m scrolling window ONLY when the grid shifts or world changes
    if (worldDirty || gridShifted) {
      let oc = 0;
      for (let i = 0; i < allObstacles.length && oc < maxObs; i++) {
        const o = allObstacles[i];
        const pad = Math.max(o.halfLen, o.halfWid) + margin;
        if (Math.abs(o.cx - cx) > pad || Math.abs(o.cz - cz) > pad) continue;
        obsData.set([o.cx, o.cz, o.ux, o.uz, o.halfLen, o.halfWid, o.kind, o.waterY], oc * 8);
        oc++;
      }
      activeObsCount = oc;
      if (oc > 0) device.queue.writeBuffer(obstacleBuf, 0, obsData, 0, oc * 8);

      let rc = 0;
      for (let i = 0; i < allReaches.length && rc < maxReaches; i++) {
        const r = allReaches[i];
        const pad = r.radius + margin;
        if (Math.abs(r.cx - cx) > pad || Math.abs(r.cz - cz) > pad) continue;
        reachData.set([r.ax, r.az, r.bx, r.bz, r.hw, r.depth, r.vx, r.vz, r.wy0, r.wy1, r.estuaryT, 0], rc * 12);
        rc++;
      }
      activeReachCount = rc;
      if (rc > 0) device.queue.writeBuffer(reachBuf, 0, reachData, 0, rc * 12);
    }

    // Dynamic hulls inside the 256 m SWE window
    let hc = 0;
    for (let i = 0; i < hulls.length && hc < maxHulls; i++) {
      const h = hulls[i];
      if (!h) continue;
      const hx = Number(h.x), hz = Number(h.z);
      if (!Number.isFinite(hx) || !Number.isFinite(hz)) continue;
      const len = SWE_CLAMP(SWE_FINITE(h.length, 14), 4, 60);
      if (Math.abs(hx - cx) > margin + len || Math.abs(hz - cz) > margin + len) continue;
      hullData.set([
        hx, hz, SWE_FINITE(h.vx, 0), SWE_FINITE(h.vz, 0),
        len, SWE_CLAMP(SWE_FINITE(h.beam, len * 0.28), 1.4, 18),
        SWE_CLAMP(SWE_FINITE(h.draft, 0.9), 0.2, 5.0),
        h.isRiver ? -1 : 1,
      ], hc * 8);
      hc++;
    }
    activeHullCount = hc;
    if (hc > 0) device.queue.writeBuffer(hullBuf, 0, hullData, 0, hc * 8);

    // Check if camera is near a coast, river, or bridge pier — skip completely in deep open ocean!
    const nearCoast = hasCoast && Math.max(Math.abs(cx - coastalWin[0]), Math.abs(cz - coastalWin[1])) < coastalWin[2] + 180;
    active = activeReachCount > 0 || activeObsCount > 0 || nearCoast;
    if (!active) {
      needEnvDispatch = false;
      return false;
    }

    needEnvDispatch = worldDirty || gridShifted || activeHullCount > 0;
    lastGridCx = cx;
    lastGridCz = cz;
    worldDirty = false;

    const packedCounts = (activeObsCount & 1023) | ((activeReachCount & 1023) << 10) | ((activeHullCount & 1023) << 20);
    const baseFlags = (nearCoast ? 2 : 0) | (activeReachCount > 0 ? 4 : 0);
    const k0 = SWE_CLAMP((2 * Math.PI) / Math.max(30, swellLen), 0.045, 0.14);
    const omega = SWE_CLAMP(Math.sqrt(9.81 * k0) * 1.45, 1.1, 2.2);
    const sdLen = Math.hypot(swellDir[0], swellDir[1]) || 1;
    const sdx = swellDir[0] / sdLen, sdz = swellDir[1] / sdLen;

    // Upload env uniform
    uData.set([
      cx, cz, extent, dx,
      committed[0], committed[1], packedCounts, baseFlags,
      coastalWin[0], coastalWin[1], coastalWin[2], coastalWin[3],
      dt, time, sdx, sdz,
      SWE_CLAMP(swellHs, 0, 3.5), k0, omega, SWE_CLAMP(windSpeed, 0, 24),
    ]);
    if (needEnvDispatch) {
      device.queue.writeBuffer(envUniform, 0, uData);
    }

    // Upload per-substep SWE uniforms (emit spray only on the final substep)
    const nSteps = Math.max(1, Math.min(3, steps | 0));
    const subDt = dt / nSteps;
    for (let i = 0; i < nSteps; i++) {
      const clearBit = (i === 0 && needsClear) ? 1 : 0;
      const emitBit = (i === nSteps - 1) ? 8 : 0;
      uData[4] = i ? cx : committed[0];
      uData[5] = i ? cz : committed[1];
      uData[7] = baseFlags | clearBit | emitBit;
      uData[12] = subDt;
      uData[13] = time + i * subDt;
      device.queue.writeBuffer(stepUniforms[i], 0, uData);
    }

    // Reset GPU atomic spawn counter to 0 before the compute pass runs
    device.queue.writeBuffer(sprayCountBuf, 0, zeroU32);

    // Upload Tier 3 ballistic spray control uniform
    frameCounter++;
    sprayCtrl.set([dt, needsClear ? 1 : 0, frameCounter, active ? 1 : 0]);
    device.queue.writeBuffer(sprayControlBuf, 0, sprayCtrl);

    return true;
  }

  function encodeEnv(pass) {
    if (destroyed || !active || !needEnvDispatch) return;
    pass.setPipeline(envPipe);
    pass.setBindGroup(0, envGroup);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 1);
    needEnvDispatch = false;
  }

  function encodeSubstep(pass, substepIndex, srcIdx) {
    if (destroyed || !active) return;
    pass.setPipeline(stepPipe);
    pass.setBindGroup(0, stepGroups[substepIndex][srcIdx]);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 1);
    stats.dispatches++;
  }

  function encodeSprayUpdate(pass) {
    if (destroyed || !active) return;
    pass.setPipeline(sprayUpdatePipe);
    pass.setBindGroup(0, sprayUpdateGroup);
    pass.dispatchWorkgroups(Math.ceil(SURF_SPRAY_COUNT / 64), 1, 1);
    needsClear = false;
  }

  function drawSpray(pass) {
    if (destroyed || !active) return;
    pass.setPipeline(sprayRenderPipe);
    pass.setBindGroup(0, sprayRenderGroup);
    pass.draw(6, SURF_SPRAY_COUNT, 0, 0);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const b of [envUniform, ...stepUniforms, sprayControlBuf, obstacleBuf, reachBuf, hullBuf, sprayCountBuf, spraySpawnBuf, sprayParticleBuf]) b.destroy();
    for (const t of [sweEnvTex, sweWaterYTex, fbCoastTex]) t.destroy();
  }

  return {
    stats,
    setWorld,
    reset,
    update,
    encodeEnv,
    encodeSubstep,
    encodeSprayUpdate,
    drawSpray,
    destroy,
  };
}
