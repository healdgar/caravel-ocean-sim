// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// GPU pasture herds & road caravans manager: uploads static herd and caravan seeds once per
// coast/update, dispatches closed-form GPU pasture & caravan hitch compute, and draws all 7
// species (sheep, cattle, swine, horses, covered wain, coach, cargo ox-cart) plus Rule-3
// 1-triangle horizon splats via indirect instancing.
import { requestOnce } from './gpu-program-cache.js';
import { getLivestockMeshes, getVehicleMeshes, LIVESTOCK_VERTEX_FLOATS } from './models/livestock-meshes.js';
import {
  HERD_BODY_FLOATS,
  HERD_BUCKETS,
  HERD_DRAW_WORDS,
  HERD_ROUTE_HEADER,
  HERD_SEED_FLOATS,
  HERD_SPECIES,
  HERD_SPLAT_BUCKET,
  HERDS_RENDER_WGSL,
  HERDS_SHADOW_WGSL,
  HERDS_STEP_WGSL,
} from './wgsl/herds.js';

export const MAX_HERDS = 1536;
export const CARAVAN_YOKE_AHEAD_M = 4.05;

const HERDS_VERTEX_LAYOUT = [{
  arrayStride: LIVESTOCK_VERTEX_FLOATS * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
  ],
}];

const HERD_BODY_BYTES = HERD_BODY_FLOATS * 4;
const HERD_ALIGN_BODIES = 16;
// Max downward neck-and-head grazing rotation (radians) per species: sheep, cattle, swine, horse, wain, coach, ox-cart.
const HERD_GRAZE_PITCH = [0.78, 0.62, 0.34, 0.74, 0, 0, 0];
const CARAVAN_CART_GAP_M = 15, CARAVAN_YOKE_SPREAD_M = 0.62, CARAVAN_DROVE_MOST = 16;
const CARAVAN_DROVE_SPECIES = Object.freeze({ sheep: 0, cattle: 1, swine: 2, horses: 3 });
const CARAVAN_COACH_GOODS = new Set([
  'cloth', 'silk', 'spice', 'spices', 'silver', 'gold', 'jewels', 'luxury',
  'tools', 'books', 'glass', 'merchants', 'passenger', 'passengers', 'envoys',
]);
const CARAVAN_OX_CART_GOODS = new Set([
  'timber', 'wood', 'ore', 'iron', 'stone', 'wine', 'oil', 'pottery', 'char', 'hay',
]);
const CARAVAN_CARGO_TINT = Object.freeze({
  grain: 0, wheat: 0, flour: 0, wine: 1, oil: 1, wool: 2, ore: 3, iron: 3, stone: 3,
  salt: 4, cloth: 5, silk: 5, merchants: 5, passenger: 5, timber: 6, wood: 6, pottery: 6, hay: 7, char: 3,
});
const caravanHash = (a, b) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};

export function bridgeDeckYAt(wx, wz, bridges) {
  if (!bridges || !bridges.length) return 0;
  let best = 0;
  for (const b of bridges) {
    if (!b || b.collapsed || !Number.isFinite(b.deckY)) continue;
    const dx = wx - b.x, dz = wz - b.z;
    const halfLen = (b.length || 12) * 0.52;
    const halfW = (b.halfWidth || 2.1) + 0.65;
    if (Math.abs(dx) > halfLen + 14 && Math.abs(dz) > halfLen + 14) continue;
    const along = Math.abs(dx * (b.ux || 0) + dz * (b.uz || 1));
    const across = Math.abs(-dx * (b.uz || 1) + dz * (b.ux || 0));
    if (along <= halfLen + 5.5 && across <= halfW) {
      const ramp = along <= halfLen ? 1 : Math.max(0, 1 - (along - halfLen) / 5.5);
      const y = b.deckY * ramp;
      if (y > best) best = y;
    }
  }
  return best;
}

function segmentNearBridge(ax, az, bx, bz, bridges) {
  if (!bridges || !bridges.length) return false;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
  for (const b of bridges) {
    if (!b || b.collapsed) continue;
    const reach = (b.length || 12) * 0.65 + 12;
    if (b.x >= minX - reach && b.x <= maxX + reach && b.z >= minZ - reach && b.z <= maxZ + reach) return true;
  }
  return false;
}

function pointOnCollapsedBridge(wx, wz, bridges) {
  if (!bridges || !bridges.length) return false;
  for (const b of bridges) {
    if (!b?.collapsed) continue;
    const reach = Math.max(7, (b.length || 12) * 0.48);
    if (Math.hypot(wx - b.x, wz - b.z) <= reach) return true;
  }
  return false;
}

function chooseRoadVehicleArchetype(good, key, cartIndex) {
  const roll = caravanHash(key, cartIndex * 17 + 5);
  if ((CARAVAN_COACH_GOODS.has(good) && roll < 0.88) || (!CARAVAN_OX_CART_GOODS.has(good) && roll < 0.16)) {
    return { vehicleSpecies: 5, draftSpecies: 3 }; // 4-wheel passenger/merchant coach (`coche`) + 2 harnessed horses
  }
  if (CARAVAN_OX_CART_GOODS.has(good) ? roll < 0.52 : roll < 0.44) {
    return { vehicleSpecies: 6, draftSpecies: 1 }; // 2-wheel heavy cargo ox-cart (`carro de bois`) + 2 yoked oxen
  }
  return { vehicleSpecies: 4, draftSpecies: 1 };   // 4-wheel covered freight wain (`carreta`) + 2 yoked oxen
}

// Travelling seeds and route buffer for the country model's road caravans (`BOARD_MODEL.caravans`).
// Genuine droves (`qty >= 6 && !c.carts`) walk loose as herds of 6–16 head; every other road consignment
// spawns a physical 1550 vehicle (`species = 4` wain, `5` coach, or `6` ox-cart) atomically coupled to
// its paired draft beasts (`species = 1` oxen or `species = 3` horses) via shared `behind` progress.
export function caravanHerdSeeds(list, origin, bridges = null) {
  const routes = [], seeds = [];
  const hasBridges = Boolean(bridges && bridges.length);
  for (const c of list ?? []) {
    if (c.mode !== 'cart' || !(c.points?.length >= 4) || !(c.arrive > c.depart)) continue;
    const header = routes.length / 4, n = c.points.length / 2;
    let along = 0;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const x = origin.x + c.points[k * 2], z = origin.z + c.points[k * 2 + 1];
      if (hasBridges && pointOnCollapsedBridge(x, z, bridges)) break;
      if (pts.length) {
        const p = pts[pts.length - 1];
        const step = Math.hypot(x - p[0], z - p[1]);
        if (step < 0.05) continue;
        if (hasBridges && step > 4.5 && segmentNearBridge(p[0], p[1], x, z, bridges)) {
          const steps = Math.ceil(step / 4.0);
          let truncated = false;
          for (let s = 1; s < steps; s++) {
            const u = s / steps;
            const ix = p[0] + (x - p[0]) * u;
            const iz = p[1] + (z - p[1]) * u;
            if (pointOnCollapsedBridge(ix, iz, bridges)) { truncated = true; break; }
            pts.push([ix, iz, along + step * u, bridgeDeckYAt(ix, iz, bridges)]);
          }
          if (truncated) break;
        }
        along += step;
      }
      pts.push([x, z, along, hasBridges ? bridgeDeckYAt(x, z, bridges) : 0]);
    }
    if (pts.length < 2 || along < 1) continue;
    routes.push(c.depart, c.arrive, pts.length, along);
    for (const p of pts) routes.push(p[0], p[1], p[2], p[3]);
    const key = [...String(c.key)].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
    const rawPhase = Number(c.phaseOffset);
    const phaseOffset = Number.isFinite(rawPhase) ? (((rawPhase % 1) + 1) % 1) : 0;
    const roamSentinel = -1 - phaseOffset * 0.9999;

    const drove = CARAVAN_DROVE_SPECIES[c.good];
    const isGenuineDrove = drove !== undefined && (c.drove === true || (c.drove !== false && (c.qty ?? 0) >= 6 && !c.carts));
    if (isGenuineDrove) {
      const head = Math.max(6, Math.min(CARAVAN_DROVE_MOST, Math.round(c.qty || 6)));
      for (let k = 0; k < head; k++) {
        const u = caravanHash(key, k * 3 + 1), w = caravanHash(key, k * 3 + 2);
        seeds.push(header, 1.2 + k * 1.5 + u * 1.2, roamSentinel, caravanHash(key, k * 3 + 3), 1 + w, 0.9 + u * 0.2, drove, (w - 0.5) * 4.2);
      }
      continue;
    }

    const tint = ((CARAVAN_CARGO_TINT[c.good] ?? Math.floor(caravanHash(key, 99) * 8)) + 0.5) / 8;
    const vehicleCount = Math.max(1, c.carts | 0);
    for (let k = 0; k < vehicleCount; k++) {
      const { vehicleSpecies, draftSpecies } = chooseRoadVehicleArchetype(String(c.good ?? ''), key, k);
      const behind = k * CARAVAN_CART_GAP_M + caravanHash(key, k) * 3;
      // Vehicle seed and both paired draft beasts share identical `behind` (`anchor.y`) so `HERDS_STEP_WGSL`
      // advances and culls the entire hitch atomically (`yokeRolled = anchorRolled + CARAVAN_YOKE_AHEAD_M`).
      seeds.push(header, behind, roamSentinel, caravanHash(key, k + 40), tint, 1, vehicleSpecies, 0);
      for (const side of [-1, 1]) {
        seeds.push(
          header,
          behind,
          roamSentinel,
          caravanHash(key, k * 2 + (side > 0 ? 61 : 60)),
          caravanHash(key, k + 80 + (side > 0 ? 1 : 0)) * 0.98,
          0.96,
          draftSpecies,
          side * CARAVAN_YOKE_SPREAD_M,
        );
      }
    }
  }
  return { routes: new Float32Array(routes.length ? routes : [0, 1, 0, 0]), seeds: new Float32Array(seeds), header: HERD_ROUTE_HEADER };
}

export function requestHerdsPipelines({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `livestock herds v2 ${format} ${samples}`, async () => {
    const [renderMod, shadowMod, stepMod] = await Promise.all([
      shader(HERDS_RENDER_WGSL, 'livestock herds'),
      shader(HERDS_SHADOW_WGSL, 'livestock herds shadow'),
      shader(HERDS_STEP_WGSL, 'livestock herds step'),
    ]);
    return Promise.all([
      device.createRenderPipelineAsync({
        label: 'livestock herds',
        layout: 'auto',
        vertex: { module: renderMod, entryPoint: 'herdsVS', buffers: HERDS_VERTEX_LAYOUT },
        fragment: { module: renderMod, entryPoint: 'herdsFS', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }),
      device.createRenderPipelineAsync({
        label: 'livestock herds splat',
        layout: 'auto',
        vertex: { module: renderMod, entryPoint: 'herdsSplatVS' },
        fragment: { module: renderMod, entryPoint: 'herdsSplatFS', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }),
      device.createRenderPipelineAsync({
        label: 'livestock herds shadow',
        layout: 'auto',
        vertex: { module: shadowMod, entryPoint: 'herdsShadowVS', buffers: HERDS_VERTEX_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
      device.createComputePipelineAsync({
        label: 'livestock herds step',
        layout: 'auto',
        compute: { module: stepMod, entryPoint: 'main' },
      }),
    ]);
  });
}

export async function createLivestockHerds({
  device,
  shader,
  format = 'rgba16float',
  samples = 4,
  frameUBO,
  landUniform,
  nearDomain,
  elevation,
  landShadowUniform,
  resources,
  clouds,
  initialHerds = null,
  initialBridges = null,
  isMobile = false,
}) {
  const B = GPUBufferUsage;
  const mkBuf = (label, data, usage) => {
    const buf = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST });
    if (data.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };
  const [pipeline, splatPipeline, shadowPipeline, stepPipeline] = await requestHerdsPipelines({ device, shader, format, samples });
  const cloudGroup = clouds.bindVolume(pipeline);
  const splatCloudGroup = clouds.bindVolume(splatPipeline);
  const speciesMeshes = [...getLivestockMeshes(), ...getVehicleMeshes()].map((sp, idx) => {
    const rigData = new Float32Array([
      sp.neckPivot[0], sp.neckPivot[1], sp.neckPivot[2], HERD_GRAZE_PITCH[idx] ?? 0.65,
      sp.legY, sp.frontZ, sp.backZ, sp.height,
    ]);
    return {
      indexCount: sp.indexCount,
      vertex: mkBuf(`livestock ${sp.name} vertices`, sp.vertices, B.VERTEX),
      index: mkBuf(`livestock ${sp.name} indices`, sp.indices, B.INDEX),
      rig: mkBuf(`livestock ${sp.name} rig`, rigData, B.UNIFORM),
    };
  });

  const wantedBindings = new Set([0, 1, 2, 3, 4, 12, 19, 20, 21]);
  let activeResources = resources;
  let state = null;
  let pastureHerds = initialHerds, activeBridges = initialBridges, lastCaravans = null, travellers = { routes: new Float32Array([0, 1, 0, 0]), seeds: new Float32Array(0) };
  const clock = new ArrayBuffer(16), clockU = new Uint32Array(clock), clockF = new Float32Array(clock);

  function releaseState(immediate = false) {
    if (!state) return;
    const old = state;
    state = null;
    const drop = () => {
      old.seeds.destroy();
      old.routes.destroy();
      old.bodies.destroy();
      old.draws.destroy();
      old.cfg.destroy();
    };
    if (!immediate && typeof device.queue?.onSubmittedWorkDone === 'function') {
      device.queue.onSubmittedWorkDone().then(drop).catch(() => {});
    } else {
      drop();
    }
  }

  function rebuildGroups() {
    if (!state) return;
    const baseEntries = activeResources.filter(([id]) => wantedBindings.has(id));
    const slice = (bucket) => ({
      buffer: state.bodies,
      offset: bucket * state.bucketSpan * HERD_BODY_BYTES,
      size: state.bucketSpan * HERD_BODY_BYTES,
    });
    state.renderGroups = speciesMeshes.map((sp, m) => device.createBindGroup({
      label: `livestock render ${m}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...baseEntries,
        [16, slice(m)],
        [17, { buffer: sp.rig }],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
    state.splatGroup = device.createBindGroup({
      label: 'livestock splat render',
      layout: splatPipeline.getBindGroupLayout(0),
      entries: [
        ...baseEntries,
        [16, slice(HERD_SPLAT_BUCKET)],
      ].map(([binding, resource]) => ({ binding, resource })),
    });
    state.shadowGroups = speciesMeshes.map((sp, m) => device.createBindGroup({
      label: `livestock shadow ${m}`,
      layout: shadowPipeline.getBindGroupLayout(0),
      entries: [
        [0, { buffer: landShadowUniform }],
        [1, { buffer: nearDomain }],
        [2, slice(m + HERD_SPECIES)],
        [3, { buffer: sp.rig }],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
  }

  function setHerds(herdData) {
    pastureHerds = herdData;
    install();
  }
  function setCaravans(list, origin, bridges = activeBridges) {
    lastCaravans = list ? { list, origin } : null;
    if (bridges !== undefined && bridges !== null) activeBridges = bridges;
    travellers = caravanHerdSeeds(list, origin, activeBridges);
    install();
  }
  function setBridges(bridges) {
    activeBridges = bridges || null;
    if (lastCaravans) {
      travellers = caravanHerdSeeds(lastCaravans.list, lastCaravans.origin, activeBridges);
      install();
    }
  }
  function install() {
    releaseState();
    const herdData = pastureHerds;
    const rawCount = herdData?.length ? Math.floor(herdData.length / HERD_SEED_FLOATS) : 0;
    const rawTravelCount = travellers.seeds.length / HERD_SEED_FLOATS;
    const travelCount = Math.min(MAX_HERDS, rawTravelCount);
    const rawPasture = isMobile ? Math.round(rawCount * 0.55) : rawCount;
    const pastureCount = Math.min(rawPasture, Math.max(0, MAX_HERDS - travelCount));
    const count = pastureCount + travelCount;
    if (!count) return;
    const sliceData = new Float32Array(count * HERD_SEED_FLOATS);
    if (pastureCount) sliceData.set(herdData.subarray(0, pastureCount * HERD_SEED_FLOATS));
    if (travelCount) sliceData.set(travellers.seeds.subarray(0, travelCount * HERD_SEED_FLOATS), pastureCount * HERD_SEED_FLOATS);
    const bucketSpan = Math.ceil(count / HERD_ALIGN_BODIES) * HERD_ALIGN_BODIES;

    const drawTemplate = new Uint32Array(HERD_BUCKETS * HERD_DRAW_WORDS);
    for (let m = 0; m < HERD_SPECIES; m++) {
      drawTemplate[m * HERD_DRAW_WORDS] = speciesMeshes[m].indexCount;
      drawTemplate[(m + HERD_SPECIES) * HERD_DRAW_WORDS] = speciesMeshes[m].indexCount;
    }
    // 1-triangle view-facing horizon splat (`drawIndirect`: 3 vertices per distant instance).
    drawTemplate[HERD_SPLAT_BUCKET * HERD_DRAW_WORDS] = 3;

    const seeds = mkBuf('livestock seeds', sliceData, B.STORAGE);
    const routes = mkBuf('caravan routes', travellers.routes, B.STORAGE);
    const bodies = device.createBuffer({
      label: 'livestock bodies',
      size: HERD_BUCKETS * bucketSpan * HERD_BODY_BYTES,
      usage: B.STORAGE,
    });
    const draws = mkBuf('livestock indirect draws', drawTemplate, B.STORAGE | B.INDIRECT);
    clockU[0] = count; clockU[1] = bucketSpan;
    const cfg = mkBuf('livestock config', clock, B.UNIFORM);

    const stepGroup = device.createBindGroup({
      label: 'livestock step',
      layout: stepPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: frameUBO } },
        { binding: 1, resource: { buffer: landUniform } },
        { binding: 2, resource: { buffer: nearDomain } },
        { binding: 3, resource: elevation.createView() },
        { binding: 4, resource: { buffer: cfg } },
        { binding: 5, resource: { buffer: seeds } },
        { binding: 6, resource: { buffer: bodies } },
        { binding: 7, resource: { buffer: draws } },
        { binding: 8, resource: { buffer: landShadowUniform } },
        { binding: 9, resource: { buffer: routes } },
      ],
    });

    state = { count, bucketSpan, seeds, routes, bodies, draws, cfg, drawTemplate, stepGroup, renderGroups: [], splatGroup: null, shadowGroups: [] };
    rebuildGroups();
  }

  setHerds(initialHerds);

  return {
    get count() { return state?.count ?? 0; },
    get travellers() { return travellers.seeds.length / HERD_SEED_FLOATS; },
    get activeCaravans() { return lastCaravans?.list ?? []; },
    get caravanOrigin() { return lastCaravans?.origin ?? null; },
    setHerds,
    setCaravans,
    setBridges,
    setBoardClock(day, daysPerSecond) {
      clockF[2] = Number.isFinite(day) ? day : 0;
      clockF[3] = Number.isFinite(daysPerSecond) ? Math.max(0, daysPerSecond) : 0;
    },
    rebind(nextResources) {
      activeResources = nextResources;
      rebuildGroups();
    },
    encode(pass) {
      if (!state) return;
      device.queue.writeBuffer(state.draws, 0, state.drawTemplate);
      if (travellers.seeds.length) device.queue.writeBuffer(state.cfg, 8, clock, 8, 8);
      pass.setPipeline(stepPipeline);
      pass.setBindGroup(0, state.stepGroup);
      pass.dispatchWorkgroups(Math.ceil(state.count / 64));
    },
    draw(pass) {
      if (!state) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, cloudGroup);
      for (let m = 0; m < HERD_SPECIES; m++) {
        pass.setBindGroup(0, state.renderGroups[m]);
        pass.setVertexBuffer(0, speciesMeshes[m].vertex);
        pass.setIndexBuffer(speciesMeshes[m].index, 'uint32');
        pass.drawIndexedIndirect(state.draws, m * HERD_DRAW_WORDS * 4);
      }
      if (state.splatGroup) {
        pass.setPipeline(splatPipeline);
        pass.setBindGroup(1, splatCloudGroup);
        pass.setBindGroup(0, state.splatGroup);
        pass.drawIndirect(state.draws, HERD_SPLAT_BUCKET * HERD_DRAW_WORDS * 4);
      }
    },
    drawShadow(pass) {
      if (!state) return;
      pass.setPipeline(shadowPipeline);
      for (let m = 0; m < HERD_SPECIES; m++) {
        pass.setBindGroup(0, state.shadowGroups[m]);
        pass.setVertexBuffer(0, speciesMeshes[m].vertex);
        pass.setIndexBuffer(speciesMeshes[m].index, 'uint32');
        pass.drawIndexedIndirect(state.draws, (m + HERD_SPECIES) * HERD_DRAW_WORDS * 4);
      }
    },
    destroy() {
      releaseState(true);
      for (const sp of speciesMeshes) {
        sp.vertex.destroy();
        sp.index.destroy();
        sp.rig.destroy();
      }
    },
  };
}
