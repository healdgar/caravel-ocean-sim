// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people of whichever town is nearest, drawn entirely from what the GPU works out each frame.
// JavaScript uploads their routes once when a town comes into reach, and touches no one after that. Under fire it
// sends a short list of where shot went, only while there is any, and never learns who that struck. What has
// befallen people lives on the GPU, for the last few towns visited, and the fallen lie a day by the game's calendar.
// It is not saved: after a reload the ruins are still there, and the people are all back on their feet.
import { requestOnce } from './gpu-program-cache.js';
import { createIndigenousCrewModels } from './crew.js';
import { DRESS_MASK_SCALE, indigenousDress } from './indigenous-dress.js';
import { createDistantCrewLOD } from './crew-lod.js';
import { bakeTownClips } from './town-clips.js';
import { TOWN_SHOTS_WORDS, createTownShots } from './town-shots.js';
import { TOWN_FATE_WORDS, TOWN_SHOT_LIMIT, TOWN_SHOT_WORDS, TOWNSFOLK_BODY_WORDS, TOWNSFOLK_BUCKETS, TOWNSFOLK_LOOKS, TOWNSFOLK_MODELS, TOWNSFOLK_RENDER, TOWNSFOLK_SHADOW, TOWNSFOLK_SHADOW_BUCKET, TOWNSFOLK_TIERS, TOWNSFOLK_WALK } from './wgsl/townsfolk.js';
import { WALKER_WORDS } from './town-streets.js';

const MODELS = TOWNSFOLK_MODELS;
const BODY_BYTES = TOWNSFOLK_BODY_WORDS * 4;
const TOWN_DRAW_WORDS = 5;
const STORAGE_ALIGNMENT_BODIES = 8;
const PORT_REACH_M = 3200;
const PORT_CHECK_FRAMES = 45;
const MOBILE_SHARE = 0.4;
const CROWD_UNIFORM_WORDS = 28;
// Where in that block the pass reads the date, in hours, and how far it must move on before it is sent again.
const CROWD_HOURS_WORD = 26;
const TOWN_CALENDAR_STEP_HOURS = 0.25;
// How many towns' people are remembered as they were left.
const TOWN_FATES_KEPT = 8;
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

const TOWNSFOLK_VERTICES = [{
  arrayStride: 60,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' },
    { shaderLocation: 3, offset: 36, format: 'uint16x4' },
    { shaderLocation: 4, offset: 44, format: 'float32x4' },
  ],
}];
// The people of a port, drawn, shadowed and walked: asked for once a device.
export function requestTownsfolkPipelines({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `townsfolk ${format} ${samples}`, async () => {
    const [renderModule, shadowModule, walkModule] = await Promise.all([
      shader(TOWNSFOLK_RENDER, 'townsfolk'),
      shader(TOWNSFOLK_SHADOW, 'townsfolk shadow'),
      shader(TOWNSFOLK_WALK, 'townsfolk walk'),
    ]);
    return Promise.all([
      device.createRenderPipelineAsync({
        label: 'townsfolk', layout: 'auto',
        vertex: { module: renderModule, entryPoint: 'townsfolkVS', buffers: TOWNSFOLK_VERTICES },
        fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }),
      device.createRenderPipelineAsync({
        label: 'townsfolk shadow', layout: 'auto',
        vertex: { module: shadowModule, entryPoint: 'townsfolkShadowVS', buffers: TOWNSFOLK_VERTICES },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
      device.createComputePipelineAsync({ label: 'townsfolk walk', layout: 'auto', compute: { module: walkModule, entryPoint: 'main' } }),
    ]);
  });
}
export async function createTownsfolk({ device, frameUBO, transView, skyView, sampClamp, envCubeView, sunVisBuf, shadows, shader, format = 'rgba16float', samples = 4, shared = null, isMobile = false }) {
  const B = GPUBufferUsage;
  const buffer = (label, data, usage) => {
    const b = device.createBuffer({ label, size: data.byteLength, usage: usage | B.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const models = shared.models;
  const layout = TOWNSFOLK_VERTICES;
  const [pipeline, shadowPipeline, walkPipeline] = await requestTownsfolkPipelines({ device, shader, format, samples });
  const lighting = shadows.bind(pipeline);
  // The shader they share with sailors looks up a ship for its gun flashes. There is none ashore.
  const hullData = new Float32Array(52);
  hullData.set([1, 0, 0, 1], 0); hullData.set([0, 1, 0, 0], 4); hullData.set([0, 0, -1, 0], 8); hullData.set([3.6, 12, 1, 1], 12);  const hull = buffer('townsfolk ship stand-in', hullData, B.UNIFORM);
  // Each body's geometry and clips, made when a town first wants them. Those made here are let go here; the
  // sailors' own, where they are shared, are not.
  const geometryFor = new Map(), ownGeometry = [];
  const own = (made) => { ownGeometry.push(made); return made; };
  const geometry = (model, index, indigenous) => {
    if (geometryFor.has(model)) return geometryFor.get(model);
    const given = indigenous ? null : shared?.geometry?.[index];
    const vertex = given?.vertex ?? own(buffer('townsfolk vertices', model.vertices, B.VERTEX));
    const lods = given?.lods ?? (model.lods ?? [{ indices: model.indices, indexCount: model.indices.length }]).map((tier) => ({
      indexCount: tier.indexCount ?? tier.indices.length,
      buffer: own(buffer('townsfolk indices', tier.indices, B.INDEX)),
    }));
    const distant = createDistantCrewLOD(model);
    const tiers = [...lods.slice(0, TOWNSFOLK_TIERS - 1), { indexCount: distant.length, buffer: own(buffer('townsfolk distant indices', distant, B.INDEX)) }];
    const { palettes, layout: clips } = bakeTownClips(model.animator);
    const entry = { vertex, lods: tiers, clips, palette: own(buffer('townsfolk clips', palettes, B.STORAGE)) };
    geometryFor.set(model, entry);
    return entry;
  };
  let indigenousModels = null;

  let activePort = null, crowd = null, frameCount = 0;
  // What has befallen each town's people, kept while the town is out of reach so that the fallen are still lying there
  // on coming back. Each is a buffer on the GPU, so only the last few towns are remembered.
  const fatesOfTowns = new Map();
  const townKeyOf = (port) => String(port?.regionId ?? port?.id ?? port?.name ?? '') || port;
  function fatesFor(port, people) {
    const key = townKeyOf(port);
    let record = fatesOfTowns.get(key);
    if (record && record.people !== people) { record.buffer.destroy(); record = null; }
    record ??= { buffer: device.createBuffer({ label: 'townsfolk fates', size: people * TOWN_FATE_WORDS * 4, usage: B.STORAGE | B.COPY_DST }), people, epochMs: null };
    // Most lately used last, and the oldest let go.
    fatesOfTowns.delete(key);
    fatesOfTowns.set(key, record);
    for (const [old, stale] of fatesOfTowns) {
      if (fatesOfTowns.size <= TOWN_FATES_KEPT) break;
      fatesOfTowns.delete(old);
      stale.buffer.destroy();
    }
    return record;
  }
  function dispose() {
    if (!crowd) return;
    for (const b of [crowd.walkers, crowd.route, crowd.bodies, crowd.draws, crowd.uniform, crowd.looks, crowd.shots]) b.destroy();
    delete crowd.port.townsfolkWatch;
    crowd = null;
  }
  function buildCrowd(port) {
    dispose();
    const streets = port?.streets;
    if (!streets?.people) return;
    const indigenous = Boolean(port.hasIndigenousSettlement && !port.hasColonialPort);
    const set = indigenous ? (indigenousModels ??= createIndigenousCrewModels(models)) : models;
    const geometries = set.slice(0, MODELS).map((model, i) => geometry(model, i, indigenous));
    const people = Math.max(1, Math.round(streets.people * (isMobile ? MOBILE_SHARE : 1)));
    const bucketSpan = Math.ceil(people / STORAGE_ALIGNMENT_BODIES) * STORAGE_ALIGNMENT_BODIES;
    const drawArguments = new Uint32Array(TOWNSFOLK_BUCKETS * TOWN_DRAW_WORDS);
    for (let m = 0; m < MODELS; m++) {
      for (let t = 0; t < TOWNSFOLK_TIERS; t++) drawArguments[(m * TOWNSFOLK_TIERS + t) * TOWN_DRAW_WORDS] = (geometries[m].lods[t] ?? geometries[m].lods.at(-1)).indexCount;
      drawArguments[(TOWNSFOLK_SHADOW_BUCKET + m) * TOWN_DRAW_WORDS] = geometries[m].lods.at(-1).indexCount;
    }
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const walkers = buffer('townsfolk walkers', streets.walkers.subarray(0, people * WALKER_WORDS), B.STORAGE);
    const route = buffer('townsfolk routes', streets.samples, B.STORAGE);
    const looks = buffer('townsfolk looks', townLooks(random, indigenous, port.indigenousSettlement?.cultureId), B.STORAGE);
    const bodies = device.createBuffer({ label: 'townsfolk bodies', size: TOWNSFOLK_BUCKETS * bucketSpan * BODY_BYTES, usage: B.STORAGE });
    const draws = buffer('townsfolk draws', drawArguments, B.STORAGE | B.INDIRECT);
    const crowdWords = new Uint32Array(CROWD_UNIFORM_WORDS);
    for (let m = 0; m < MODELS; m++) crowdWords.set(geometries[m].clips, m * geometries[m].clips.length);
    crowdWords[24] = bucketSpan; crowdWords[25] = TOWNSFOLK_LOOKS;
    const uniform = buffer('townsfolk crowd', crowdWords, B.UNIFORM);
    const shots = device.createBuffer({ label: 'townsfolk shots', size: TOWN_SHOTS_WORDS * 4, usage: B.UNIFORM | B.COPY_DST });
    const fateRecord = fatesFor(port, people), fates = fateRecord.buffer;
    const shotLog = createTownShots(streets), shotBytes = new ArrayBuffer(TOWN_SHOTS_WORDS * 4);
    port.townsfolkWatch = shotLog.note;
    const walkGroup = device.createBindGroup({
      label: 'townsfolk walk', layout: walkPipeline.getBindGroupLayout(0),
      entries: [frameUBO, walkers, route, bodies, draws, uniform, shots, fates].map((b, binding) => ({ binding, resource: { buffer: b } })),
    });
    const bodySlice = (bucket) => ({ buffer: bodies, offset: bucket * bucketSpan * BODY_BYTES, size: bucketSpan * BODY_BYTES });
    const groups = [];
    const shadowGroups = [];
    for (let m = 0; m < MODELS; m++) {
      for (let t = 0; t < TOWNSFOLK_TIERS; t++) groups.push(device.createBindGroup({
        label: 'townsfolk', layout: pipeline.getBindGroupLayout(0),
        entries: [
          [0, { buffer: frameUBO }], [1, { buffer: hull }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
          [10, bodySlice(m * TOWNSFOLK_TIERS + t)],
          [11, { buffer: geometries[m].palette }], [12, { buffer: looks }],
        ].map(([binding, resource]) => ({ binding, resource })),
      }));
      shadowGroups.push(device.createBindGroup({
        label: 'townsfolk shadow', layout: shadowPipeline.getBindGroupLayout(0),
        entries: [
          [0, { buffer: shadows.uniform }],
          [1, bodySlice(TOWNSFOLK_SHADOW_BUCKET + m)],
          [2, { buffer: geometries[m].palette }],
          [3, { buffer: looks }],
        ].map(([binding, resource]) => ({ binding, resource })),
      }));
    }
    crowd = { port, people, walkers, route, looks, bodies, draws, uniform, crowdWords, crowdHours: new Float32Array(crowdWords.buffer), hours: NaN, shots, fates, fateRecord, shotLog, shotWords: new Uint32Array(shotBytes), shotFloats: new Float32Array(shotBytes), shotsSent: 0, drawArguments, walkGroup, groups, shadowGroups, geometries };
  }

  return {
    get people() { return crowd?.people ?? 0; },
    // The town whose people are drawn, and its people laid again when its streets are given new walkers (a board's
    // people as its model plans their day, js/board-folk.js).
    get port() { return activePort; },
    refresh(port) { if (port && port === activePort) buildCrowd(port); },
    // Whichever town with ways is nearest the eye, once in a while.
    // The share of each town's people that is drawn, for whoever must agree with the picture: their footsteps.
    share: isMobile ? MOBILE_SHARE : 1,
    follow(ports, camera) {
      if (frameCount++ % PORT_CHECK_FRAMES) return;
      let best = null, bestDistance = PORT_REACH_M;
      for (const port of ports ?? []) {
        if (!port?.streets?.people) continue;
        const d = Math.hypot(port.center.x - camera.x, port.center.z - camera.z);
        if (d < bestDistance) { bestDistance = d; best = port; }
      }
      if (best !== activePort) { activePort = best; buildCrowd(best); }
    },
    // `dateMs` is the game's date. The fallen lie a day by it, each from when they fell, and the pass that lays them
    // out is what counts the day: it is told the hour, measured from when this town's record began so that a
    // 32-bit float holds it, and only when the hour has moved on.
    encode(pass, dateMs = Date.now()) {
      if (!crowd) return;
      device.queue.writeBuffer(crowd.draws, 0, crowd.drawArguments);
      if (Number.isFinite(dateMs)) {
        const hours = (dateMs - (crowd.fateRecord.epochMs ??= dateMs)) / 3600000;
        if (!(Math.abs(hours - crowd.hours) < TOWN_CALENDAR_STEP_HOURS)) {
          crowd.crowdHours[CROWD_HOURS_WORD] = crowd.hours = hours;
          device.queue.writeBuffer(crowd.uniform, 0, crowd.crowdWords);
        }
      }
      // Nothing while nothing flies, and once more after the last of it to say so.
      const shotCount = crowd.shotLog.collect(crowd.shotWords, crowd.shotFloats);
      if (shotCount || crowd.shotsSent) {
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
    // One draw for each model, of everyone the pass kept for it, from the coarsest body.
    drawShadow(pass) {
      if (!crowd) return;
      pass.setPipeline(shadowPipeline);
      for (let m = 0; m < MODELS; m++) {
        pass.setVertexBuffer(0, crowd.geometries[m].vertex);
        pass.setBindGroup(0, crowd.shadowGroups[m]);
        pass.setIndexBuffer(crowd.geometries[m].lods.at(-1).buffer, 'uint32');
        pass.drawIndexedIndirect(crowd.draws, (TOWNSFOLK_SHADOW_BUCKET + m) * TOWN_DRAW_WORDS * 4);
      }
    },
    destroy() {
      dispose();
      for (const record of fatesOfTowns.values()) record.buffer.destroy();
      fatesOfTowns.clear();
      for (const made of ownGeometry) made.destroy();
      ownGeometry.length = 0;
      geometryFor.clear();
      hull.destroy();
    },
  };
}
