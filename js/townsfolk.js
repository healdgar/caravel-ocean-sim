// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people of whichever town is nearest, drawn entirely from what the GPU works out each frame.
// JavaScript uploads their routes once when a town comes into reach, and touches no one after that. Under fire it
// sends a short list of where shot went, only while there is any, and never learns who that struck. What has
// befallen people lives on the GPU as long as their town stays loaded. It is not saved: after a reload the ruins
// are still there, and the people are all back on their feet.
import { createIndigenousCrewModels } from './crew.js';
import { DRESS_MASK_SCALE, indigenousDress } from './indigenous-dress.js';
import { createDistantCrewLOD } from './crew-lod.js';
import { bakeTownClips } from './town-clips.js';
import { TOWN_SHOTS_WORDS, createTownShots } from './town-shots.js';
import { TOWN_CASUALTY_STAY_S, TOWN_FATE_WORDS, TOWN_SHOT_LIMIT, TOWN_SHOT_WORDS, TOWNSFOLK_BODY_WORDS, TOWNSFOLK_LOOKS, TOWNSFOLK_RENDER, TOWNSFOLK_SHADOW, TOWNSFOLK_TIERS, TOWNSFOLK_WALK } from './wgsl/townsfolk.js';
import { WALKER_WORDS } from './town-streets.js';

const MODELS = 2;
const BODY_BYTES = TOWNSFOLK_BODY_WORDS * 4;
const TOWN_DRAW_WORDS = 5;
const STORAGE_ALIGNMENT_BODIES = 8;
const PORT_REACH_M = 3200;
const PORT_CHECK_FRAMES = 45;
const MOBILE_SHARE = 0.4;
const CROWD_UNIFORM_WORDS = 28;
// One look in this many is someone of rank, or someone dressed for an occasion.
const ELITE_LOOK_EVERY = 16;

const townLinear = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const linearRGB = (rgb) => rgb.map(townLinear);
// Undyed and cheaply dyed cloth: linen, wool, ochre, madder, indigo, and whatever had faded.
const TOWN_SHIRTS = Object.freeze([[.62,.57,.46],[.55,.50,.40],[.46,.40,.30],[.40,.31,.20],[.50,.36,.17],[.42,.14,.09],[.16,.22,.31],[.30,.30,.28],[.58,.52,.36],[.24,.17,.12]]);
const TOWN_LOWER = Object.freeze([[.11,.09,.075],[.09,.10,.12],[.16,.12,.08],[.20,.16,.11],[.07,.07,.08],[.24,.11,.07],[.13,.15,.19]]);
const TOWN_PEOPLE = Object.freeze([
  { skin: [226, 178, 148], hair: [62, 41, 28], face: [.98, 1.02, .003, 1] },
  { skin: [214, 164, 124], hair: [24, 20, 18], face: [1.03, .98, -.004, .96] },
  { skin: [198, 146, 104], hair: [28, 22, 18], face: [1.04, 1, .002, .98] },
  { skin: [168, 112, 78], hair: [20, 16, 14], face: [1.04, 1.02, .004, .94] },
  { skin: [126, 79, 56], hair: [24, 18, 16], face: [1.04, 1.02, -.002, .96] },
  { skin: [92, 56, 40], hair: [20, 16, 14], face: [1.05, 1.04, -.003, 1] },
  { skin: [235, 190, 162], hair: [150, 70, 28], face: [.99, .96, .002, 1.02] },
  { skin: [206, 154, 116], hair: [46, 32, 24], face: [1.01, 1, .004, .98] },
]);

function townLooks(random, indigenous, cultureId) {
  const data = new Float32Array(MODELS * TOWNSFOLK_LOOKS * 20);
  for (let model = 0; model < MODELS; model++) for (let i = 0; i < TOWNSFOLK_LOOKS; i++) {
    const at = (model * TOWNSFOLK_LOOKS + i) * 20;
    if (indigenous) {
      const person = indigenousDress(cultureId, model ? 'female' : 'male', i, { elite: i % ELITE_LOOK_EVERY === 0 });
      data.set(person.shirt, at);
      data.set(person.trousers, at + 4);
      data.set(person.skin, at + 8);
      data[at + 11] = model;
      data.set(person.hair, at + 12);
      data[at + 15] = person.mask / DRESS_MASK_SCALE;
      data.set(person.face, at + 16);
      continue;
    }
    const pick = (list) => list[Math.floor(random() * list.length) % list.length];
    const person = pick(TOWN_PEOPLE);
    data.set(pick(TOWN_SHIRTS), at);
    data.set(pick(TOWN_LOWER), at + 4);
    data.set(linearRGB(person.skin), at + 8);
    data[at + 11] = model;
    data.set(linearRGB(person.hair), at + 12);
    data.set(person.face, at + 16);
  }
  return data;
}

export async function createTownsfolk({ device, frameUBO, transView, skyView, sampClamp, envCubeView, sunVisBuf, shadows, shader, format = 'rgba16float', samples = 4, shared = null, isMobile = false }) {
  const B = GPUBufferUsage;
  const buffer = (label, data, usage) => {
    const b = device.createBuffer({ label, size: data.byteLength, usage: usage | B.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const models = shared.models;
  const layout = [{
    arrayStride: 60,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x3' },
      { shaderLocation: 3, offset: 36, format: 'uint16x4' },
      { shaderLocation: 4, offset: 44, format: 'float32x4' },
    ],
  }];
  const [renderModule, shadowModule, walkModule] = await Promise.all([
    shader(TOWNSFOLK_RENDER, 'townsfolk'),
    shader(TOWNSFOLK_SHADOW, 'townsfolk shadow'),
    shader(TOWNSFOLK_WALK, 'townsfolk walk'),
  ]);
  const [pipeline, shadowPipeline, walkPipeline] = await Promise.all([
    device.createRenderPipelineAsync({
      label: 'townsfolk', layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'townsfolkVS', buffers: layout },
      fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    }),
    device.createRenderPipelineAsync({
      label: 'townsfolk shadow', layout: 'auto',
      vertex: { module: shadowModule, entryPoint: 'townsfolkShadowVS', buffers: layout },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
    }),
    device.createComputePipelineAsync({ label: 'townsfolk walk', layout: 'auto', compute: { module: walkModule, entryPoint: 'main' } }),
  ]);
  const lighting = shadows.bind(pipeline);
  // The shader they share with sailors looks up a ship for its gun flashes. There is none ashore.
  const hullData = new Float32Array(52);
  hullData.set([1, 0, 0, 1], 0); hullData.set([0, 1, 0, 0], 4); hullData.set([0, 0, -1, 0], 8); hullData.set([3.6, 12, 1, 1], 12);
  const hull = buffer('townsfolk ship stand-in', hullData, B.UNIFORM);
  const geometryFor = new Map();
  const geometry = (model, index, indigenous) => {
    if (geometryFor.has(model)) return geometryFor.get(model);
    const given = indigenous ? null : shared?.geometry?.[index];
    const vertex = given?.vertex ?? buffer('townsfolk vertices', model.vertices, B.VERTEX);
    const lods = given?.lods ?? (model.lods ?? [{ indices: model.indices, indexCount: model.indices.length }]).map((tier) => ({
      indexCount: tier.indexCount ?? tier.indices.length,
      buffer: buffer('townsfolk indices', tier.indices, B.INDEX),
    }));
    const distant = createDistantCrewLOD(model);
    const tiers = [...lods.slice(0, TOWNSFOLK_TIERS - 1), { indexCount: distant.length, buffer: buffer('townsfolk distant indices', distant, B.INDEX) }];
    const { palettes, layout: clips } = bakeTownClips(model.animator);
    const entry = { vertex, lods: tiers, clips, palette: buffer('townsfolk clips', palettes, B.STORAGE) };
    geometryFor.set(model, entry);
    return entry;
  };
  let indigenousModels = null;

  let activePort = null, crowd = null, frameCount = 0;
  // Each town's people as they were left, kept for a full day (TOWN_CASUALTY_STAY_S = 86,400s) so fallen bodies stay on the ground for a day.
  const fatesOfTown = new WeakMap();
  const fatesByKey = new Map();
  const townKeyOf = (port) => String(port?.regionId ?? port?.id ?? port?.name ?? '');
  function dispose() {
    if (!crowd) return;
    for (const b of [crowd.walkers, crowd.route, crowd.bodies, crowd.draws, crowd.uniform, crowd.looks, crowd.shots]) b.destroy();
    delete crowd.port.townsfolkWatch;
    crowd = null;
  }
  function buildCrowd(port, nowMs = Date.now()) {
    dispose();
    const streets = port?.streets;
    if (!streets?.people) return;
    const indigenous = Boolean(port.hasIndigenousSettlement && !port.hasColonialPort);
    const set = indigenous ? (indigenousModels ??= createIndigenousCrewModels(models)) : models;
    const geometries = set.slice(0, MODELS).map((model, i) => geometry(model, i, indigenous));
    const people = Math.max(1, Math.round(streets.people * (isMobile ? MOBILE_SHARE : 1)));
    const bucketSpan = Math.ceil(people / STORAGE_ALIGNMENT_BODIES) * STORAGE_ALIGNMENT_BODIES;
    const buckets = MODELS * TOWNSFOLK_TIERS;
    const drawArguments = new Uint32Array(buckets * TOWN_DRAW_WORDS);
    for (let m = 0; m < MODELS; m++) for (let t = 0; t < TOWNSFOLK_TIERS; t++) {
      const lod = geometries[m].lods[t] ?? geometries[m].lods.at(-1);
      drawArguments[(m * TOWNSFOLK_TIERS + t) * TOWN_DRAW_WORDS] = lod.indexCount ?? lod.indices.length;
    }
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const walkers = buffer('townsfolk walkers', streets.walkers.subarray(0, people * WALKER_WORDS), B.STORAGE);
    const route = buffer('townsfolk routes', streets.samples, B.STORAGE);
    const looks = buffer('townsfolk looks', townLooks(random, indigenous, port.indigenousSettlement?.cultureId), B.STORAGE);
    const bodies = device.createBuffer({ label: 'townsfolk bodies', size: buckets * bucketSpan * BODY_BYTES, usage: B.STORAGE });
    const draws = buffer('townsfolk draws', drawArguments, B.STORAGE | B.INDIRECT);
    const crowdWords = new Uint32Array(CROWD_UNIFORM_WORDS);
    for (let m = 0; m < MODELS; m++) crowdWords.set(geometries[m].clips, m * geometries[m].clips.length);
    crowdWords[24] = bucketSpan; crowdWords[25] = TOWNSFOLK_LOOKS;
    const uniform = buffer('townsfolk crowd', crowdWords, B.UNIFORM);
    const shots = device.createBuffer({ label: 'townsfolk shots', size: TOWN_SHOTS_WORDS * 4, usage: B.UNIFORM | B.COPY_DST });
    const key = townKeyOf(port);
    let fateRecord = fatesOfTown.get(port) ?? (key ? fatesByKey.get(key) : null);
    if (fateRecord && fateRecord.people !== people) fateRecord = null;
    if (fateRecord && fateRecord.struckAtMs !== null && nowMs - fateRecord.struckAtMs >= TOWN_CASUALTY_STAY_S * 1000) {
      device.queue.writeBuffer(fateRecord.buffer, 0, new Uint32Array(people * TOWN_FATE_WORDS));
      fateRecord.struckAtMs = null;
    }
    if (!fateRecord) {
      const fatesBuf = device.createBuffer({ label: 'townsfolk fates', size: people * TOWN_FATE_WORDS * 4, usage: B.STORAGE | B.COPY_DST });
      fateRecord = { buffer: fatesBuf, people, struckAtMs: null };
    }
    fatesOfTown.set(port, fateRecord);
    if (key) fatesByKey.set(key, fateRecord);
    const fates = fateRecord.buffer;
    const shotLog = createTownShots(streets), shotBytes = new ArrayBuffer(TOWN_SHOTS_WORDS * 4);
    port.townsfolkWatch = shotLog.note;
    const walkGroup = device.createBindGroup({
      label: 'townsfolk walk', layout: walkPipeline.getBindGroupLayout(0),
      entries: [frameUBO, walkers, route, bodies, draws, uniform, shots, fates].map((b, binding) => ({ binding, resource: { buffer: b } })),
    });
    const groups = [];
    const shadowGroups = [];
    for (let m = 0; m < MODELS; m++) for (let t = 0; t < TOWNSFOLK_TIERS; t++) {
      const bodySlice = { buffer: bodies, offset: (m * TOWNSFOLK_TIERS + t) * bucketSpan * BODY_BYTES, size: bucketSpan * BODY_BYTES };
      groups.push(device.createBindGroup({
        label: 'townsfolk', layout: pipeline.getBindGroupLayout(0),
        entries: [
          [0, { buffer: frameUBO }], [1, { buffer: hull }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
          [10, bodySlice],
          [11, { buffer: geometries[m].palette }], [12, { buffer: looks }],
        ].map(([binding, resource]) => ({ binding, resource })),
      }));
      shadowGroups.push(device.createBindGroup({
        label: 'townsfolk shadow', layout: shadowPipeline.getBindGroupLayout(0),
        entries: [
          [0, { buffer: shadows.uniform }],
          [1, bodySlice],
          [2, { buffer: geometries[m].palette }],
          [3, { buffer: looks }],
        ].map(([binding, resource]) => ({ binding, resource })),
      }));
    }
    crowd = { port, people, walkers, route, looks, bodies, draws, uniform, shots, fates, fateRecord, shotLog, shotWords: new Uint32Array(shotBytes), shotFloats: new Float32Array(shotBytes), shotsSent: 0, drawArguments, walkGroup, groups, shadowGroups, geometries };
  }

  return {
    get people() { return crowd?.people ?? 0; },
    // Whichever town with ways is nearest the eye, once in a while.
    follow(ports, camera, nowMs = Date.now()) {
      if (frameCount++ % PORT_CHECK_FRAMES) return;
      let best = null, bestDistance = PORT_REACH_M;
      for (const port of ports ?? []) {
        if (!port?.streets?.people) continue;
        const d = Math.hypot(port.center.x - camera.x, port.center.z - camera.z);
        if (d < bestDistance) { bestDistance = d; best = port; }
      }
      if (best !== activePort) { activePort = best; buildCrowd(best, nowMs); }
      else if (crowd?.fateRecord?.struckAtMs !== null && crowd?.fateRecord?.struckAtMs !== undefined && nowMs - crowd.fateRecord.struckAtMs >= TOWN_CASUALTY_STAY_S * 1000) {
        device.queue.writeBuffer(crowd.fates, 0, new Uint32Array(crowd.people * TOWN_FATE_WORDS));
        crowd.fateRecord.struckAtMs = null;
      }
    },
    encode(pass, nowMs = Date.now()) {
      if (!crowd) return;
      device.queue.writeBuffer(crowd.draws, 0, crowd.drawArguments);
      // Nothing while nothing flies, and once more after the last of it to say so.
      const shotCount = crowd.shotLog.collect(crowd.shotWords, crowd.shotFloats);
      if (shotCount || crowd.shotsSent) {
        if (shotCount && crowd.fateRecord) crowd.fateRecord.struckAtMs = nowMs;
        device.queue.writeBuffer(crowd.shots, 0, crowd.shotWords, 0, TOWN_SHOTS_WORDS - TOWN_SHOT_WORDS * (TOWN_SHOT_LIMIT - shotCount));
        crowd.shotsSent = shotCount;
      }
      pass.setPipeline(walkPipeline);
      pass.setBindGroup(0, crowd.walkGroup);
      pass.dispatchWorkgroups(Math.ceil(crowd.people / 64));
    },
    // With the other opaque bodies: no discard, so the GPU shades only what shows.
    draw(pass) {
      if (!crowd) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, lighting);
      for (let m = 0; m < MODELS; m++) {
        pass.setVertexBuffer(0, crowd.geometries[m].vertex);
        for (let t = 0; t < TOWNSFOLK_TIERS; t++) {
          const lod = crowd.geometries[m].lods[t] ?? crowd.geometries[m].lods.at(-1);
          const bucket = m * TOWNSFOLK_TIERS + t;
          pass.setBindGroup(0, crowd.groups[bucket]);
          pass.setIndexBuffer(lod.buffer, 'uint32');
          pass.drawIndexedIndirect(crowd.draws, bucket * TOWN_DRAW_WORDS * 4);
        }
      }
    },
    drawShadow(pass) {
      if (!crowd) return;
      pass.setPipeline(shadowPipeline);
      const shadowTiers = Math.min(2, TOWNSFOLK_TIERS);
      for (let m = 0; m < MODELS; m++) {
        pass.setVertexBuffer(0, crowd.geometries[m].vertex);
        for (let t = 0; t < shadowTiers; t++) {
          const lod = crowd.geometries[m].lods[t] ?? crowd.geometries[m].lods.at(-1);
          const bucket = m * TOWNSFOLK_TIERS + t;
          pass.setBindGroup(0, crowd.shadowGroups[bucket]);
          pass.setIndexBuffer(lod.buffer, 'uint32');
          pass.drawIndexedIndirect(crowd.draws, bucket * TOWN_DRAW_WORDS * 4);
        }
      }
    },
    destroy() { crowd?.fates.destroy(); dispose(); hull.destroy(); },
  };
}
