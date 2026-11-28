// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People drawn through the one continuum (AGENTS.md rule 3). js/crew-continuum.js holds the baked format and
// js/wgsl/crew-continuum.js the GPU side; this fetches bodies, and keeps each batch's scene of the one cut.
//
// A body is fetched once a device, whole: its atlas (one type of the one format), its picture in the codec the device
// reads, its rig and the light mesh the pose code measures footing from. Nothing is drawn until all of it is on the GPU.
// A batch of people who share a body and a joint buffer is one scene of the one cut: each frame its stand writes every
// person's record and joints from the crew's own, then the one select cuts them, and the one view, shadow and capture
// draw them. The CPU writes only each person's orders and the batch's few words.
import { loadCrewGLB } from './gltf.js';
import { requestOnce } from './gpu-program-cache.js';
import { continuumAtlasMetaWords, continuumAtlasTypes, continuumRoom, loadContinuumAtlas } from './continuum-format.js';
import { requestContinuumPrograms, requestContinuumView, requestContinuumCapture, continuumCaptureDraw, uploadContinuumAtlas, createContinuumScene } from './continuum-scene.js';
import { continuumGroundView } from './continuum-ground.js';
import { transcodeBC7Texture } from './bc7-transcode.js';
import { LAND_SHADOW_FORMAT } from './shadows.js';
import {
  CREW_CONTINUUM_ASSETS, CREW_CONTINUUM_BODIES, CREW_CONTINUUM_MOBILE_ASSETS, crewContinuumMissingMessage, crewContinuumRig, crewContinuumWear,
  validateCrewContinuumManifest,
} from './crew-continuum.js';
import { hairContinuumShiftsFor, loadHairContinuum } from './hair-continuum.js';
import {
  CREW_CONTINUUM_MATERIAL, CREW_CONTINUUM_POSE_VEC4S, HAIR_CONTINUUM_MATERIAL,
  crewContinuumHairStandWGSL, crewContinuumPoseWGSL, crewContinuumStandWGSL,
} from './wgsl/crew-continuum.js';
import { CREW_JOINT_COUNT } from './crew-skeleton.js';

// What the GPU is told of a person, beside their joints and actor record (the batch's orders).
export { CREW_CONTINUUM_AGE_SHIFT, CREW_CONTINUUM_ORDER_IMPORTANT } from './wgsl/crew-continuum.js';

// Which body each person wears (the owner's choice of 2026-11-17): hands by sex, captains, soldiers, and each
// indigenous culture its own pair.
export function crewContinuumBodyFor({ sex = 'male', role = 'hand', culture = null } = {}) {
  const female = sex === 'female';
  if (culture) return `${culture}-${female ? 'female' : 'male'}`;
  if (role === 'captain') return 'captain';
  if (role === 'soldier') return female ? 'villager-female' : 'soldier';
  return female ? 'villager-female' : 'sailor-male';
}

// The picture in the first codec the device reads; a device that reads neither has the BC7 picture decoded on the GPU
// at load into rgba8 (js/bc7-transcode.js), the same texels, so every device draws a person's own picture.
const crewContinuumCodecs = Object.freeze([
  Object.freeze({ feature: 'texture-compression-bc', format: 'bc7-rgba-unorm-srgb', stream: 'albedo.bc7.bin' }),
  Object.freeze({ feature: 'texture-compression-astc', format: 'astc-4x4-unorm-srgb', stream: 'albedo.astc.bin' }),
  Object.freeze({ feature: null, format: 'rgba8unorm-srgb', stream: 'albedo.bc7.bin', transcode: true }),
]);

function crewContinuumVerifyEnabled(verifySha256) {
  if (verifySha256 === false) return false;
  if (verifySha256 === true) return true;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('verifyAssets') === '0') return false;
  return true;
}

const CREW_CONTINUUM_FULL_PACK_BYTES = 128 * 1024 * 1024;
function crewContinuumIsMobile(device, mobile) {
  if (typeof mobile === 'boolean') return mobile;
  const mobileUA = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  // A body's full atlas is under 100 MiB, so a device that binds WebGPU's least storage buffer (128 MiB) holds it: only
  // one that binds less (a compatibility adapter) takes the compact pack for want of room.
  const lowBind = (device?.limits?.maxStorageBufferBindingSize ?? Infinity) < CREW_CONTINUUM_FULL_PACK_BYTES;
  const lowBuf = (device?.limits?.maxBufferSize ?? Infinity) < CREW_CONTINUUM_FULL_PACK_BYTES;
  return mobileUA || lowBind || lowBuf;
}

async function crewContinuumFetch(path, fetchAsset) {
  const response = await fetchAsset(path);
  if (!response.ok) throw Error(`Crew continuum unavailable (${response.status}): ${path}`);
  return response;
}
// One stream, unpacked and checked against its receipt (SHA-256 verified by default; opt out via ?verifyAssets=0 or false).
async function crewContinuumStream(manifest, name, fetchAsset, paths = CREW_CONTINUUM_ASSETS[manifest.id], verifySha256 = undefined) {
  const receipt = manifest.files[name], response = await crewContinuumFetch(paths[receipt.gzip.file], fetchAsset);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== receipt.bytes) throw Error(`Crew continuum stream has the wrong size: ${manifest.id} ${name}`);
  if (crewContinuumVerifyEnabled(verifySha256) && globalThis.crypto?.subtle?.digest) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error(`Crew continuum stream failed verification: ${manifest.id} ${name}`);
  }
  return bytes;
}

// A load that found bodies unbaked: the message names every missing file and how it is made; `missing` lists them.
const crewContinuumMissingError = (missing, cause) => Object.assign(Error(crewContinuumMissingMessage(missing), cause ? { cause } : undefined), { missing });
// Which of the files a body is drawn from are not there: its manifest, atlas, light mesh and the picture this device
// reads. Asked beside the load, so a body missing any of them fails at load, naming every one.
function crewContinuumAbsent(paths, codec, fetchAsset) {
  const wanted = ['manifest.json', 'body.glb', 'atlas.bin.gz', ...(codec ? [`${codec.stream}.gz`] : [])].map((name) => paths[name]);
  return Promise.all(wanted.map((path) => Promise.resolve().then(() => fetchAsset(path, { method: 'HEAD' })).then((r) => r.ok, () => false)))
    .then((present) => wanted.filter((_, i) => !present[i]));
}

async function openCrewContinuumBody(device, id, fetchAsset, { mobile, verifySha256 } = {}) {
  if (!CREW_CONTINUUM_BODIES.some((b) => b.id === id)) throw Error(`Unknown crew continuum body: ${id}`);
  const useMobile = crewContinuumIsMobile(device, mobile);
  let paths = CREW_CONTINUUM_ASSETS[id];
  if (useMobile && CREW_CONTINUUM_MOBILE_ASSETS[id]) {
    const mobilePaths = CREW_CONTINUUM_MOBILE_ASSETS[id];
    const hasMobile = await Promise.resolve()
      .then(() => fetchAsset(mobilePaths['manifest.json'], { method: 'HEAD' }))
      .then((r) => r.ok, () => false);
    if (hasMobile) {
      paths = mobilePaths;
    } else {
      console.warn(`[crew-continuum] Compact mobile pack unavailable for ${id}; falling back to desktop pack`);
    }
  }
  const verify = Boolean(crewContinuumVerifyEnabled(verifySha256) && globalThis.crypto?.subtle?.digest);
  const codec = crewContinuumCodecs.find((c) => !c.feature || device.features.has(c.feature));
  const absent = crewContinuumAbsent(paths, codec, fetchAsset);
  let atlas, picture, standIn;
  try {
    atlas = await loadContinuumAtlas({ assets: paths, validate: validateCrewContinuumManifest, label: `crew ${id}`, fetchAsset, verifySha256: verify });
    [picture, standIn] = await Promise.all([
      crewContinuumStream(atlas.manifest, codec.stream, fetchAsset, paths, verify),
      crewContinuumFetch(paths['body.glb'], fetchAsset).then((r) => r.arrayBuffer()).then(loadCrewGLB),
    ]);
  } catch (error) {
    const missing = await absent;
    throw missing.length ? crewContinuumMissingError(missing, error) : error;
  }
  const missing = await absent;
  if (missing.length) throw crewContinuumMissingError(missing);
  const { manifest, words } = atlas, B = GPUBufferUsage;
  const uniform = (label, data) => {
    const buffer = device.createBuffer({ label, size: data.byteLength, usage: B.UNIFORM | B.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const { width, height, levels } = manifest.texture;
  const label = `crew continuum ${id} picture`;
  const isMobileCrew = useMobile;
  const dropTopMip = isMobileCrew && !codec.transcode && levels.length > 1 && width >= 2048 && height >= 2048;
  const texLevels = dropTopMip ? levels.slice(1) : levels;
  const texW = texLevels[0].width, texH = texLevels[0].height;
  const texture = codec.transcode
    ? await transcodeBC7Texture(device, { bytes: picture, width, height, levels, format: codec.format, label })
    : device.createTexture({ label, size: [texW, texH], mipLevelCount: texLevels.length, format: codec.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  if (!codec.transcode) {
    texLevels.forEach((level, mipLevel) => {
      const across = Math.ceil(level.width / 4), down = Math.ceil(level.height / 4);
      device.queue.writeTexture({ texture, mipLevel }, picture, { offset: level.offset, bytesPerRow: across * 16, rowsPerImage: down }, [across * 4, down * 4]);
    });
  }
  // Past the handoff a person wears the far body: a closed skin, each triangle its region's dye.
  const uploadedAtlas = uploadContinuumAtlas(device, words, `crew ${id}`);
  return {
    id, manifest, standIn, words: continuumAtlasMetaWords(words), types: uploadedAtlas.types, atlas: uploadedAtlas,
    rig: uniform(`crew continuum ${id} rig`, crewContinuumRig(manifest)), wear: uniform(`crew continuum ${id} wear`, crewContinuumWear(manifest)),
    texture, albedo: texture.createView(),
    sampler: device.createSampler({ label: `crew continuum ${id} picture`, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 8 }),
    triangles: manifest.source.triangles,
    mobile: paths === CREW_CONTINUUM_MOBILE_ASSETS[id],
  };
}

const crewContinuumBodyCache = new WeakMap();
// A body on this device, fetched once. Resolves when it is wholly on the GPU. A body that is not baked rejects, naming
// its missing files: nothing stands in for it.
export function loadCrewContinuumBody(device, id, { fetchAsset = fetch, mobile, verifySha256 } = {}) {
  let bodies = crewContinuumBodyCache.get(device);
  if (!bodies) crewContinuumBodyCache.set(device, (bodies = new Map()));
  const key = `${id}:${crewContinuumIsMobile(device, mobile) ? 'm' : 'd'}`;
  if (!bodies.has(key)) {
    const pending = openCrewContinuumBody(device, id, fetchAsset, { mobile, verifySha256 });
    pending.catch(() => { if (bodies.get(key) === pending) bodies.delete(key); });
    bodies.set(key, pending);
  }
  return bodies.get(key);
}
// Several bodies on this device. Those not baked fail the load together, in one error that names every missing file.
export async function loadCrewContinuumBodies(device, ids, options) {
  const settled = await Promise.allSettled(ids.map((id) => loadCrewContinuumBody(device, id, options)));
  const failed = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (!failed.length) return settled.map((r) => r.value);
  const other = failed.find((error) => !error?.missing);
  if (other) throw other;
  throw crewContinuumMissingError([...new Set(failed.flatMap((error) => error.missing))]);
}

function crewContinuumRecordAssetError(asset, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[crew-continuum] Failed to load ${asset}: ${message}`, error);
  if (typeof globalThis !== 'undefined') {
    (globalThis.__waterworldAssetErrors ??= []).push({ asset, message, error });
  }
  return { value: null, error };
}

// Every program people are stood, cut and drawn with, once a device and target: the one cut's programs, the crew's
// view of them, the stand afloat and ashore, and (by whoever has the water's optics) the capture under water.
export function requestCrewContinuumPipelines({ device, shader, format = 'rgba16float', samples = 4, waterOptics = null, fetchAsset = typeof fetch === 'function' ? fetch : null }) {
  const stand = (ground) => requestOnce(device, `crew continuum stand${ground ? ' ashore' : ''}`, async () => device.createComputePipelineAsync({
    label: `crew continuum stand${ground ? ' ashore' : ''}`, layout: 'auto',
    compute: { module: await shader(crewContinuumStandWGSL(ground), `crew continuum stand${ground ? ' ashore' : ''}`), entryPoint: 'crewContinuumStand' },
  }));
  const hairStand = requestOnce(device, 'crew continuum hair stand', async () => device.createComputePipelineAsync({
    label: 'crew continuum hair stand', layout: 'auto',
    compute: { module: await shader(crewContinuumHairStandWGSL(), 'crew continuum hair stand'), entryPoint: 'crewContinuumHairStand' },
  }));
  const loadAux = (asset, promise) => promise
    .then((value) => ({ value, error: null }))
    .catch((error) => crewContinuumRecordAssetError(asset, error));
  return Promise.all([
    requestContinuumPrograms({ device, shader, shadowFormat: LAND_SHADOW_FORMAT }),
    requestContinuumView({ device, shader, material: CREW_CONTINUUM_MATERIAL, format, samples }),
    waterOptics ? requestOnce(device, `crew continuum capture ${format} ${samples}`, () => requestContinuumCapture(waterOptics, CREW_CONTINUUM_MATERIAL)) : null,
    stand(false), stand(true),
    requestContinuumView({ device, shader, material: HAIR_CONTINUUM_MATERIAL, format, samples }),
    waterOptics ? requestOnce(device, `hair continuum capture ${format} ${samples}`, () => requestContinuumCapture(waterOptics, HAIR_CONTINUUM_MATERIAL)) : null,
    hairStand,
    fetchAsset ? loadAux('hair continuum', loadHairContinuum(device, { fetchAsset })) : { value: null, error: null },
  ]).then(([programs, view, capture, afloat, ashore, hairView, hairCapture, hairStandPipe, hairRes]) => ({
    programs, view, capture, stand: { afloat, ashore },
    hair: hairRes.value, hairError: hairRes.error, hairView, hairCapture, hairStand: hairStandPipe,
  }));
}

// The pass that poses people placed on the GPU (crewContinuumPoseWGSL), once a device.
export function requestCrewContinuumPose({ device, shader }) {
  return requestOnce(device, 'crew continuum pose', async () => device.createComputePipelineAsync({
    label: 'crew continuum pose', layout: 'auto', compute: { module: await shader(crewContinuumPoseWGSL(), 'crew continuum pose'), entryPoint: 'crewContinuumPose' },
  }));
}
// Where each joint of a rig stands at rest, in its bind space: what each inverse bind matrix undoes (vec4 a joint).
// The pose pass blends each joint about its own, and draws a parted limb in to its stump there.
export function crewContinuumRestPlaces(animator) {
  const places = new Float32Array(CREW_JOINT_COUNT * 4);
  for (let j = 0; j < CREW_JOINT_COUNT; j++) {
    const m = animator.inverseBinds.subarray(j * 16, j * 16 + 16);
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C || 1;
    const inverse = [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det);
    const t = [-m[12], -m[13], -m[14]];
    for (let r = 0; r < 3; r++) places[j * 4 + r] = inverse[r * 3] * t[0] + inverse[r * 3 + 1] * t[1] + inverse[r * 3 + 2] * t[2];
    places[j * 4 + 3] = 1;
  }
  return places;
}
// The frame people a GPU pass places in the world are drawn in. The shaders they share with sailors place a body in a
// ship's frame and look it up for gun flashes; for these that frame is the world's own, and no gun flashes.
export function createCrewContinuumWorldHull(device, label = 'crew continuum world frame') {
  const data = new Float32Array(52);
  data.set([1, 0, 0, 1], 0); data.set([0, 1, 0, 0], 4); data.set([0, 0, -1, 0], 8); data.set([3.6, 12, 1, 1], 12);
  const hull = device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(hull, 0, data);
  return hull;
}
// One run of placed people posed into a joint and actor buffer from `first` on, each with their batch's orders.
//   placed    the CrewPlaced records, indexed by slot as the joints are
//   palettes  the clips' skin matrices, CREW_JOINT_COUNT a frame; looks the CrewLook table; rest a body's rest places
//   counted   { buffer, offset } of the indirect dispatch (count, 1, 1) the placing pass wrote
export function createCrewContinuumPoser({ device, pipeline, placed, palettes, looks, rest, joints, actors, orders, first = 0, counted }) {
  const run = device.createBuffer({ label: 'crew continuum pose run', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(run, 0, new Uint32Array([first, 0, 0, 0]));
  const group = device.createBindGroup({
    label: 'crew continuum pose', layout: pipeline.getBindGroupLayout(0),
    entries: [placed, palettes, looks, rest, joints, actors, orders, run].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  return {
    // In a compute pass, after the placing pass and before the batch's stand.
    encode(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroupsIndirect(counted.buffer, counted.offset);
    },
    destroy() { run.destroy(); },
  };
}

// One batch: people `first`..`first + capacity` of a joint and actor buffer, all wearing `body`, one scene of the cut.
//   frame, hull, bones, actor   the crew's own buffers (the stand's, and the material's group 0)
//   main                        the crew's group-0 resources for drawing, in binding order (bindings 13 and 14 as entries)
//   shadows                     the shadow set: its `uniform` and `bind(pipeline)` for the lighting group
//   counted                     for people a GPU pass keeps: { buffer, offset } of the indirect dispatch (count, 1, 1)
//                               that says how many there are; the orders are then the pose pass's to write
//   ground                      they stand on the land, on the ground the land draws; else `sea`: they are afloat
export function createCrewContinuumBatch({ device, pipelines: P, body, capacity, first = 0, samples = 4, frame, hull, bones, actor, main, shadows, counted = null, ground = false, sea = !ground }) {
  const B = GPUBufferUsage;
  const room = continuumRoom(body.types, [capacity]).room;
  const scene = createContinuumScene({
    device, atlas: body.atlas, programs: P.programs, capacity, room, view: P.view, poseRoom: capacity * CREW_CONTINUUM_POSE_VEC4S,
    frame, shadowUniform: shadows.uniform, samples, label: `crew ${body.id}`, profile: 'people',
  });
  const orders = device.createBuffer({ label: `crew continuum ${body.id} orders`, size: Math.max(16, capacity * 4), usage: B.STORAGE | B.COPY_DST });
  device.queue.writeBuffer(orders, 0, new Uint32Array(Math.max(4, capacity)));
  const run = device.createBuffer({ label: `crew continuum ${body.id} stand`, size: 16, usage: B.UNIFORM | B.COPY_DST });
  const orderWords = new Uint32Array(Math.max(4, capacity)), runWords = new Uint32Array(4);
  const stand = ground ? P.stand.ashore : P.stand.afloat;
  const standGroup = device.createBindGroup({
    label: `crew continuum ${body.id} stand`, layout: stand.getBindGroupLayout(0),
    entries: [
      // Afloat, the stand reads nothing of the frame: the eye's place never decides who is drawn.
      ...[frame, hull, bones, actor, orders, run, scene.records, scene.poses, body.rig, counted?.buffer ?? orders].map((buffer, binding) => ({ binding, resource: { buffer } }))
        .filter(({ binding }) => ground || binding > 0),
      ...(ground ? [{ binding: 10, resource: continuumGroundView(device) }] : []),
    ],
  });
  // The material's group 0: the crew's own, then the body's picture, its sampler and its wear. Bound when first drawn.
  const entries = [...main, { binding: 15, resource: body.albedo }, { binding: 16, resource: body.sampler }, { binding: 17, resource: { buffer: body.wear } }]
    .map((resource, binding) => (resource?.resource !== undefined && resource?.binding !== undefined ? resource : { binding, resource }));
  const hairEntries = main.map((resource, binding) => (resource?.resource !== undefined && resource?.binding !== undefined ? resource : { binding, resource }));
  let view = null, under;
  const viewGroups = () => (view ??= [device.createBindGroup({ label: `crew continuum ${body.id}`, layout: P.view.pipeline.getBindGroupLayout(0), entries }), shadows.bind(P.view.pipeline)]);
  const capture = () => (under === undefined ? (under = continuumCaptureDraw(P.capture, entries, shadows)) : under);

  // Paired algorithmic strand hair & beard scene sharing `scene.poses`.
  let hairScene = null, hairInfo = null, hairStandGroup = null, hairView = null, hairUnder;
  const hairInfoWords = new Uint32Array(12), hairInfoFloats = new Float32Array(hairInfoWords.buffer);
  if (P.hair && P.hairView && P.hairStand) {
    const hairCapacity = Math.max(2, capacity * 2);
    const perType = Math.max(1, Math.ceil(capacity * 0.35));
    const hairRoom = continuumRoom(P.hair.types, Array(P.hair.types.length).fill(perType)).room;
    hairScene = createContinuumScene({
      device, atlas: P.hair.atlas, programs: P.programs, capacity: hairCapacity, room: hairRoom, view: P.hairView,
      poses: scene.poses, frame, shadowUniform: shadows.uniform, samples, label: `hair ${body.id}`, profile: 'hair',
    });
    hairInfoFloats.set(hairContinuumShiftsFor(body.id, body.manifest?.sex === 'female'), 0);
    hairInfo = device.createBuffer({ label: `hair continuum ${body.id} info`, size: 48, usage: B.UNIFORM | B.COPY_DST });
    device.queue.writeBuffer(hairInfo, 0, hairInfoWords);
    hairStandGroup = device.createBindGroup({
      label: `hair continuum ${body.id} stand`,
      layout: P.hairStand.getBindGroupLayout(0),
      entries: [scene.records, scene.poses, actor, hairInfo, hairScene.records].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }
  const hairViewGroups = () => (hairView ??= [
    device.createBindGroup({ label: `hair continuum ${body.id}`, layout: P.hairView.pipeline.getBindGroupLayout(0), entries: hairEntries }),
    shadows.bind(P.hairView.pipeline),
  ]);
  const hairCapture = () => (hairUnder === undefined ? (hairUnder = continuumCaptureDraw(P.hairCapture, hairEntries, shadows)) : hairUnder);

  let count = 0, armed = false;
  return {
    body, scene, hairScene, orders,
    get count() { return count; },
    // Before the frame's passes: who is drawn, with what orders. `at` moves the batch's first slot, where a garrison's
    // captains follow however many soldiers a port has. A counted batch is given how many it may hold (a number), and
    // the GPU says how many there are.
    update(people, orderOf = () => 0, castShadows = true, at = first) {
      count = Math.min(typeof people === 'number' ? people : people.length, capacity);
      if (!counted) for (let i = 0; i < count; i++) orderWords[i] = orderOf(people[i], i) >>> 0;
      if (count && !counted) device.queue.writeBuffer(orders, 0, orderWords, 0, Math.max(4, count));
      runWords.set([at, count, counted ? counted.offset / 4 : 0, (counted ? 1 : 0) | (sea ? 2 : 0)]);
      device.queue.writeBuffer(run, 0, runWords);
      scene.setCount(count);
      scene.setShadows(castShadows);
      if (hairScene) {
        hairInfoWords[8] = count >>> 0;
        device.queue.writeBuffer(hairInfo, 32, hairInfoWords, 8, 4);
        hairScene.setCount(count * 2);
        hairScene.setShadows(castShadows);
      }
      armed = true;
    },
    // In a compute pass, after every joint of the batch is final for the frame: each person stood, then the one cut.
    encodeSelect(pass) {
      if (!armed) return;
      armed = false;
      if (count) {
        pass.setPipeline(stand);
        pass.setBindGroup(0, standGroup);
        pass.dispatchWorkgroups(count);
        if (hairScene) {
          pass.setPipeline(P.hairStand);
          pass.setBindGroup(0, hairStandGroup);
          pass.dispatchWorkgroups(Math.ceil(count / 64));
        }
      }
      scene.encode(pass);
      if (hairScene) hairScene.encode(pass);
    },
    drawOpaque(pass) {
      if (!count) return;
      scene.draw(pass, ...viewGroups());
      if (hairScene) hairScene.draw(pass, ...hairViewGroups());
    },
    drawShadow(pass) {
      if (!count) return;
      scene.drawShadow(pass);
      if (hairScene) hairScene.drawShadow(pass);
    },
    // Under water, single-sampled, through the water's own capture: the coarse cut the shadow's lists hold.
    drawSubmerged(pass, above = false) {
      if (!count) return;
      capture()?.draw(pass, [scene], above);
      if (hairScene) hairCapture()?.draw(pass, [hairScene], above);
    },
    // For the continuum census: the one cut's triangle counts, with how many people the batch stands (for a counted
    // batch, how many it may hold).
    continuumDraws() {
      if (!count) return [];
      const bodyDraws = scene.continuumDraws().map((draw) => ({ ...draw, people: count }));
      const strandDraws = hairScene ? hairScene.continuumDraws().map((draw) => ({ ...draw, hair: true, people: count })) : [];
      return [...bodyDraws, ...strandDraws];
    },
    destroy() {
      for (const resource of [orders, run, hairInfo]) resource?.destroy();
      scene.destroy();
      hairScene?.destroy();
    },
  };
}
