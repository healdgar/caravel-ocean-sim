// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people of whichever town is nearest, drawn entirely from what the GPU works out each frame, through the one
// people continuum (AGENTS.md rule 3): the walk pass keeps who is in sight or shadows it and places each, compacted by
// body; the continuum's pose pass gives each their joints from the baked clips, and its cut and draws do the rest.
// JavaScript uploads their routes once when a town comes into reach, and touches no one after that. Under fire it
// sends a short list of where shot went, only while there is any, and never learns who that struck. What has
// befallen people lives on the GPU, for the last few towns visited, and the fallen lie a day by the game's calendar.
// It is not saved: after a reload the ruins are still there, and the people are all back on their feet.
import { requestOnce } from './gpu-program-cache.js';
import { colonialGroomMask, reconcileColonialGroomAndComp, indigenousArchetypeForCulture, CREW_ACTOR_FLOATS } from './crew.js';
import { packCrewFaceW, townComponentMaskForLook } from './crew-components.js';
import { DRESS_MASK_SCALE, indigenousDress } from './indigenous-dress.js';
import { bakeTownClips } from './town-clips.js';
import { buildStreetMountSeeds, getLivestockHerdsForDevice, STREET_MOUNT_FLAG } from './herds.js';
import { TOWN_SHOTS_WORDS, createTownShots } from './town-shots.js';
import {
  TOWN_FATE_WORDS, TOWN_SHOT_LIMIT, TOWN_SHOT_WORDS, TOWNSFOLK_COUNT_WORDS, TOWNSFOLK_DISPATCH_WORDS,
  TOWNSFOLK_LOOKS, TOWNSFOLK_MODELS, TOWNSFOLK_MOISTURE_SLOTS, TOWNSFOLK_RESET, TOWNSFOLK_WALK,
} from './wgsl/townsfolk.js';
import { WALKER_WORDS } from './town-streets.js';
import { continuumGroundView } from './continuum-ground.js';
import { CREW_CONTINUUM_PLACED_WORDS } from './wgsl/crew-continuum.js';
import {
  createCrewContinuumBatch, createCrewContinuumPoser, createCrewContinuumWorldHull, crewContinuumBodyFor, crewContinuumRestPlaces,
  loadCrewContinuumBodies, requestCrewContinuumPipelines, requestCrewContinuumPose,
} from './crew-continuum-draw.js';
import { CREW_JOINT_COUNT } from './crew-skeleton.js';

const MODELS = TOWNSFOLK_MODELS;
const TOWN_JOINT_BYTES = CREW_JOINT_COUNT * 64, TOWN_ACTOR_BYTES = CREW_ACTOR_FLOATS * 4, TOWN_PLACED_BYTES = CREW_CONTINUUM_PLACED_WORDS * 4;
// The second body's people begin at a slot whose joints and actor records a bind group may start at (256 bytes).
const TOWN_SLOT_ALIGNMENT = 16;
const PORT_REACH_M = 3200;
const PORT_OFFSHORE_CULL_M = 3000;
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
    const fullComp = townComponentMaskForLook(model, i, null, i % ELITE_LOOK_EVERY === 0);
    const sex = model ? 'female' : 'male';
    const { dress, compMask } = reconcileColonialGroomAndComp(colonialGroomMask(sex, i), fullComp, sex, { seed: i });
    data[at + 15] = dress / DRESS_MASK_SCALE;
    data.set(person.face, at + 16);
    data[at + 19] = packCrewFaceW(person.face[3], compMask, false);
  }
  return data;
}

// Assigns ~8% of eligible non-pier street walkers in 1550 Old World & Colonial towns to mounted sela à gineta
// riders (`STREET_MOUNT_FLAG`), and strictly clears any mounted flag in pre-contact Indigenous settlements.
export function assignStreetMountsToWalkers(streets, { indigenous = false, maxPeople = Infinity } = {}) {
  if (!streets?.walkers?.length) {
    return { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0, walkerIndices: [] };
  }
  const f = streets.walkers instanceof Float32Array
    ? streets.walkers
    : new Float32Array(streets.walkers.buffer, streets.walkers.byteOffset, Math.floor(streets.walkers.byteLength / 4));
  const w = new Uint32Array(f.buffer, f.byteOffset, f.length);
  const people = Math.min(streets.people ?? Math.floor(f.length / WALKER_WORDS), Math.floor(f.length / WALKER_WORDS), maxPeople);

  if (indigenous) {
    for (let i = 0; i < people; i++) {
      w[i * WALKER_WORDS + 11] &= ~STREET_MOUNT_FLAG;
    }
    return { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0, walkerIndices: [] };
  }

  let existing = 0;
  for (let i = 0; i < people; i++) {
    if ((w[i * WALKER_WORDS + 11] & STREET_MOUNT_FLAG) !== 0) existing++;
  }
  if (existing === 0 && people >= 16 && !streets.folk && streets.samples?.length >= 12) {
    for (let i = 0; i < people; i++) {
      if (((i * 7 + 3) % 12) !== 0) continue;
      const at = i * WALKER_WORDS;
      const count = w[at + 1];
      const flags = w[at + 11];
      const lengthM = f[at + 8];
      if (count < 12 || lengthM < 35 || (flags & 8) !== 0) continue;
      w[at + 11] = flags | STREET_MOUNT_FLAG;
      f[at + 3] = 2.45 + 0.35 * ((i % 5) / 4);
      f[at + 5] = 0;
      f[at + 6] = 0;
    }
  }
  return buildStreetMountSeeds(streets, { indigenous: false, maxPeople: people });
}

// The town's own passes, once a device: the walk that places everyone, the reset of its counts, and the continuum's
// pose pass that gives each person kept their joints.
export function requestTownsfolkPipelines({ device, shader }) {
  return requestOnce(device, 'townsfolk v4', async () => {
    const [walkModule, resetModule] = await Promise.all([shader(TOWNSFOLK_WALK, 'townsfolk walk'), shader(TOWNSFOLK_RESET, 'townsfolk reset')]);
    const [walk, reset, pose] = await Promise.all([
      device.createComputePipelineAsync({ label: 'townsfolk walk', layout: 'auto', compute: { module: walkModule, entryPoint: 'main' } }),
      device.createComputePipelineAsync({ label: 'townsfolk reset', layout: 'auto', compute: { module: resetModule, entryPoint: 'main' } }),
      requestCrewContinuumPose({ device, shader }),
    ]);
    return { walk, reset, pose };
  });
}

// The pair of continuum bodies a town wears, a man's and a woman's: its culture's (js/crew.js,
// indigenousArchetypeForCulture), or with none named a colonial town's.
export function townsfolkBodiesFor(culture = null) {
  return ['male', 'female'].map((sex) => crewContinuumBodyFor({ sex, role: 'townsfolk', culture }));
}

// `shared` is the crew's shared assets: the captain's picture its group 0 names. `fetchAsset` fetches the bodies' files.
export async function createTownsfolk({ device, frameUBO, transView, skyView, sampClamp, envCubeView, sunVisBuf, shadows, shader, format = 'rgba16float', samples = 4, shared = null, herds = null, isMobile = false, fetchAsset }) {
  const B = GPUBufferUsage;
  const buffer = (label, data, usage) => {
    const b = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  // People are drawn through the continuum alone. A colonial town's pair is had now, so that a body that is not baked
  // fails the load, naming its missing files; each culture's is fetched when a town of it first comes into reach.
  const bodyLoad = { fetchAsset };
  const [{ walk: walkPipeline, reset: resetPipeline, pose: posePipeline }, continuum, colonial] = await Promise.all([
    requestTownsfolkPipelines({ device, shader }),
    requestCrewContinuumPipelines({ device, shader, format, samples }),
    loadCrewContinuumBodies(device, townsfolkBodiesFor(), bodyLoad),
  ]);
  // Ashore the frame people are drawn in is the world's own.
  const hull = createCrewContinuumWorldHull(device, 'townsfolk ship stand-in');
  // Dry but for the rain, and in the sea: the walk pass writes both each frame.
  const moisture = device.createBuffer({ label: 'townsfolk moisture', size: TOWNSFOLK_MOISTURE_SLOTS * 8, usage: B.STORAGE });

  // Each body's clips and rest places, baked from its own rig when a town first wants them.
  const rigs = new Map();
  const rigOf = (animator) => {
    if (rigs.has(animator)) return rigs.get(animator);
    const { palettes, layout: clips, rideFrames } = bakeTownClips(animator, { includeRide: true });
    const rig = { clips, rideFrames, palette: buffer('townsfolk clips', palettes, B.STORAGE), rest: buffer('townsfolk rest places', crewContinuumRestPlaces(animator), B.STORAGE) };
    rigs.set(animator, rig);
    return rig;
  };
  // Each culture's pair of continuum bodies, fetched once. A town of it is not drawn until its pair has come, and is
  // laid then. A pair that is not baked is an error that names its files, and that town's people are not drawn.
  const pairs = new Map([['', { bodies: colonial, error: null }]]);
  const cultureOf = (port) => (port?.hasIndigenousSettlement && !port.hasColonialPort ? indigenousArchetypeForCulture(port.indigenousSettlement?.cultureId) : null);
  const pairFor = (culture) => {
    const key = culture ?? '';
    if (!pairs.has(key)) {
      const entry = { bodies: null, error: null };
      pairs.set(key, entry);
      loadCrewContinuumBodies(device, townsfolkBodiesFor(culture), bodyLoad)
        .then((bodies) => { entry.bodies = bodies; if (activePort && cultureOf(activePort) === culture && !crowd) buildCrowd(activePort); })
        .catch((error) => { entry.error = error; console.error(`Townsfolk: the ${culture} town's people cannot be drawn.`, error); });
    }
    return pairs.get(key).bodies;
  };

  let activePort = null, crowd = null, frameCount = 0, lastCameraX = NaN, lastCameraZ = NaN;
  const withinPortReach = () => {
    if (!crowd) return false;
    const c = crowd.port?.center;
    if (!c || !Number.isFinite(lastCameraX) || !Number.isFinite(lastCameraZ)) return true;
    return Math.hypot(c.x - lastCameraX, c.z - lastCameraZ) <= PORT_OFFSHORE_CULL_M;
  };
  const linkedHerds = () => herds ?? getLivestockHerdsForDevice(device);
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
    for (const b of [crowd.walkers, crowd.route, crowd.looks, crowd.placed, crowd.counts, crowd.joints, crowd.actors, crowd.uniform, crowd.shots]) b.destroy();
    for (const made of [...crowd.posers, ...crowd.batches]) made.destroy();
    delete crowd.port.townsfolkWatch;
    linkedHerds()?.setStreetMounts?.(null);
    crowd = null;
  }
  function buildCrowd(port) {
    dispose();
    const streets = port?.streets;
    if (!streets?.people) return;
    const indigenous = Boolean(port.hasIndigenousSettlement && !port.hasColonialPort);
    // Laid when its pair comes.
    const bodies = pairFor(cultureOf(port));
    if (!bodies) return;
    const rigsOfTown = bodies.map((body) => rigOf(body.standIn.animator));
    const people = Math.max(1, Math.round(streets.people * (isMobile ? MOBILE_SHARE : 1)));
    const mountSeeds = assignStreetMountsToWalkers(streets, { indigenous, maxPeople: people });
    port.streetMounts = mountSeeds;
    linkedHerds()?.setStreetMounts?.(indigenous ? null : mountSeeds);
    // How many wear each body, once a town: each body's run of slots holds all of its people, so no count overflows.
    const walkerFloats = streets.walkers.subarray(0, people * WALKER_WORDS);
    const walkerWords = new Uint32Array(walkerFloats.buffer, walkerFloats.byteOffset, walkerFloats.length);
    const capacity = [0, 0];
    for (let i = 0; i < people; i++) capacity[walkerWords[i * WALKER_WORDS + 11] & 1]++;
    const firsts = [0, Math.ceil(Math.max(1, capacity[0]) / TOWN_SLOT_ALIGNMENT) * TOWN_SLOT_ALIGNMENT];
    const slots = firsts[1] + Math.max(1, capacity[1]);
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const walkers = buffer('townsfolk walkers', walkerFloats, B.STORAGE);
    const route = buffer('townsfolk routes', streets.samples, B.STORAGE);
    const looks = buffer('townsfolk looks', townLooks(random, indigenous, port.indigenousSettlement?.cultureId), B.STORAGE);
    const placed = device.createBuffer({ label: 'townsfolk placed', size: slots * TOWN_PLACED_BYTES, usage: B.STORAGE });
    const joints = device.createBuffer({ label: 'townsfolk joints', size: slots * TOWN_JOINT_BYTES, usage: B.STORAGE });
    const actors = device.createBuffer({ label: 'townsfolk actors', size: slots * TOWN_ACTOR_BYTES, usage: B.STORAGE });
    // Each body's indirect dispatch, sizing its pose pass and its cut. The walk pass counts into it; the reset empties it.
    const countWords = new Uint32Array(TOWNSFOLK_COUNT_WORDS);
    for (let m = 0; m < MODELS; m++) countWords.set([0, 1, 1, 0], m * TOWNSFOLK_DISPATCH_WORDS);
    const counts = buffer('townsfolk counts', countWords, B.STORAGE | B.INDIRECT);
    const crowdWords = new Uint32Array(CROWD_UNIFORM_WORDS);
    for (let m = 0; m < MODELS; m++) crowdWords.set(rigsOfTown[m].clips.subarray(0, 12), m * 12);
    crowdWords[24] = firsts[1]; crowdWords[25] = TOWNSFOLK_LOOKS;
    crowdWords[27] = ((rigsOfTown[0]?.rideFrames ?? 0) & 0xffff) | (((rigsOfTown[1]?.rideFrames ?? 0) & 0xffff) << 16);
    const uniform = buffer('townsfolk crowd', crowdWords, B.UNIFORM);
    const shots = device.createBuffer({ label: 'townsfolk shots', size: TOWN_SHOTS_WORDS * 4, usage: B.UNIFORM | B.COPY_DST });
    const fateRecord = fatesFor(port, people), fates = fateRecord.buffer;
    const shotLog = createTownShots(streets), shotBytes = new ArrayBuffer(TOWN_SHOTS_WORDS * 4);
    port.townsfolkWatch = shotLog.note;
    const resetGroup = device.createBindGroup({ label: 'townsfolk reset', layout: resetPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: counts } }] });
    const walkGroup = device.createBindGroup({
      label: 'townsfolk walk', layout: walkPipeline.getBindGroupLayout(0),
      entries: [...[frameUBO, walkers, route, placed, counts, uniform, shots, fates, moisture].map((b, binding) => ({ binding, resource: { buffer: b } })),
        // The ground the land draws, which they are drawn walking on (js/continuum-ground.js).
        { binding: 9, resource: continuumGroundView(device) }],
    });
    const countedOf = (m) => ({ buffer: counts, offset: m * TOWNSFOLK_DISPATCH_WORDS * 4 });
    const main = [{ buffer: frameUBO }, { buffer: hull }, { buffer: joints }, { buffer: actors }, transView, sampClamp, envCubeView, { buffer: sunVisBuf }, { buffer: moisture }, skyView, { binding: 13, resource: shared.captainTexView }, { binding: 14, resource: shared.captainSampler }];
    // One batch for each body, cut and drawn through the continuum from the slots its people were posed into. They are
    // ashore, on the ground the walk already set them on.
    const batches = bodies.map((body, m) => createCrewContinuumBatch({ device, pipelines: continuum, body, capacity: Math.max(1, capacity[m]), first: firsts[m], samples, frame: frameUBO, hull, bones: joints, actor: actors, main, shadows, counted: countedOf(m), sea: false }));
    const posers = rigsOfTown.map((rig, m) => createCrewContinuumPoser({ device, pipeline: posePipeline, placed, palettes: rig.palette, looks, rest: rig.rest, joints, actors, orders: batches[m].orders, first: firsts[m], counted: countedOf(m) }));
    crowd = {
      port, people, capacity, walkers, route, looks, placed, counts, joints, actors, uniform, crowdWords, crowdHours: new Float32Array(crowdWords.buffer), hours: NaN,
      shots, fates, fateRecord, shotLog, shotWords: new Uint32Array(shotBytes), shotFloats: new Float32Array(shotBytes), shotsSent: 0, resetGroup, walkGroup, batches, posers,
    };
  }

  return {
    get people() { return crowd?.people ?? 0; },
    // Why a town's people are not drawn: the error that its pair of bodies is not baked, naming the missing files.
    get error() { return pairs.get(activePort ? cultureOf(activePort) ?? '' : '')?.error ?? null; },
    // The town whose people are drawn, and its people laid again when its streets are given new walkers (a board's
    // people as its model plans their day, js/board-folk.js).
    get port() { return activePort; },
    refresh(port) { if (port && port === activePort) buildCrowd(port); },
    // Whichever town with ways is nearest the eye, once in a while.
    // The share of each town's people that is drawn, for whoever must agree with the picture: their footsteps.
    share: isMobile ? MOBILE_SHARE : 1,
    follow(ports, camera) {
      if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
        lastCameraX = camera.x;
        lastCameraZ = camera.z;
      }
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
      if (!withinPortReach()) return;
      crowd.batches.forEach((batch, m) => batch.update(crowd.capacity[m]));
      pass.setPipeline(resetPipeline);
      pass.setBindGroup(0, crowd.resetGroup);
      pass.dispatchWorkgroups(1);
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
      // Everyone kept, posed; then each body's cut, as many workgroups as the walk kept people.
      for (const poser of crowd.posers) poser.encode(pass);
      for (const batch of crowd.batches) batch.encodeSelect(pass);
    },
    // With the other opaque bodies: no discard, so the GPU shades only what shows.
    draw(pass) {
      if (!withinPortReach()) return;
      for (const batch of crowd.batches) batch.drawOpaque(pass);
    },
    drawShadow(pass) {
      if (!withinPortReach()) return;
      for (const batch of crowd.batches) batch.drawShadow(pass);
    },
    // For the continuum census: each body's indirect draws.
    continuumDraws() { return withinPortReach() ? crowd.batches.flatMap((batch) => batch.continuumDraws()) : []; },
    destroy() {
      dispose();
      // A pair that comes after this lays no town.
      activePort = null;
      for (const record of fatesOfTowns.values()) record.buffer.destroy();
      fatesOfTowns.clear();
      for (const rig of rigs.values()) { rig.palette.destroy(); rig.rest.destroy(); }
      rigs.clear();
      hull.destroy();
      moisture.destroy();
    },
  };
}
