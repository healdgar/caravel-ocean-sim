// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The generated, textured models about the nearest port, and the iron in the air, drawn through the one continuum
// (js/continuum-scene.js), worn by the props' material (js/wgsl/prop-continuum.js): every frame the GPU cuts each by
// projected error, from its own mesh, cluster by cluster, through its far body to a single splat. JavaScript uploads a port's props once when it comes into reach.
// After that it sends only what changes: a prop when what it stood on has gone, and a prop's shard flights when a shot
// breaks it and again as each shard comes to rest. A broken prop is drawn as its shards (the SHARDED pose kind,
// js/wgsl/continuum-kinds.js), each a cut of its own clusters riding its flight. The balls are placed each update by the gunnery effects (js/gunnery-effects.js shot).
// The models' physics (js/port-props.js) is read from the same files the atlas was baked from, and their textures,
// decoded by the browser, are loaded only once a port needs them.
import { PROP_MODELS, preparePortJetties, propDrawRadius, readPropModel, stepJettyFracture } from './port-props.js';
import { SIM_CLOCK_LOOP_S } from './wgsl/common.js';
import { LAND_SHADOW_FORMAT } from './shadows.js';
import { GUNNERY_FX_LIMITS } from './gunnery-effects.js';
import { sharedNeuralPbrBank } from './neural-pbr.js';
import { PROP_CONTINUUM_SHOT, PROP_CONTINUUM_TYPES, PROP_CONTINUUM_PIGMENT_SIZE, loadPropContinuum } from './prop-continuum.js';
import { PROP_CONTINUUM_MATERIAL_SPEC } from './wgsl/prop-continuum.js';
import { CONTINUUM_BROKEN, CONTINUUM_GONE, CONTINUUM_KIND, continuumRoom } from './continuum-format.js';
import { requestContinuumAtlas, requestContinuumPrograms, requestContinuumView, requestContinuumCapture, continuumCaptureDraw, createContinuumScene } from './continuum-scene.js';

const PROP_REACH_M = 3000;
const PROP_CHECK_FRAMES = 30;
// A prop's block in the shard records, as the SHARDED kind reads it: one vec4f for its clock and its shard count, then
// each shard's flight (four vec4f), then a float of wear a shard.
const BLOCK_HEAD_FLOATS = 4;
const SHARD_FLOATS = 16;
const propBlockFloats = (records) => { const shards = records.length / SHARD_FLOATS; return BLOCK_HEAD_FLOATS + records.length + Math.ceil(shards / 4) * 4; };

// Every model's image in its own layer of one array, each fitted to the same square, in half-size steps to one texel.
async function uploadPigments(device, models) {
  const size = PROP_CONTINUUM_PIGMENT_SIZE, levels = Math.log2(size) + 1;
  const texture = device.createTexture({ label: 'prop pigments', size: [size, size, models.length], mipLevelCount: levels, format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  for (const [layer, model] of models.entries()) {
    const bitmap = await createImageBitmap(new Blob([model.image], { type: model.mime }), { colorSpaceConversion: 'none' });
    for (let level = 0; level < levels; level++) {
      const side = Math.max(1, size >> level);
      const source = await createImageBitmap(bitmap, { resizeWidth: side, resizeHeight: side, resizeQuality: 'high', colorSpaceConversion: 'none' });
      device.queue.copyExternalImageToTexture({ source }, { texture, mipLevel: level, origin: [0, 0, layer] }, [side, side, 1]);
      source.close();
    }
    bitmap.close();
  }
  return texture;
}

export function createProps({ device, frameUBO, transView, skyView, sampClamp, envCubeView, sunVisBuf, shadows, shader, format = 'rgba16float', samples = 4, waterOptics = null }) {
  const B = GPUBufferUsage;
  const neuralPbr = sharedNeuralPbrBank(device);
  const buffer = (label, data, usage) => { const b = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | B.COPY_DST }); device.queue.writeBuffer(b, 0, data); return b; };
  // The shader shared with hulls looks up a ship for its gun flashes. There is none ashore.
  const hullData = new Float32Array(52);
  hullData.set([1, 0, 0, 1], 0); hullData.set([0, 1, 0, 0], 4); hullData.set([0, 0, -1, 0], 8); hullData.set([3.6, 12, 1, 1], 12);
  const hull = buffer('prop ship stand-in', hullData, B.UNIFORM);
  const sampler = device.createSampler({ label: 'prop pigment', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
  // Shot is plain iron and reads no pigment: until a port's are loaded the array is one empty texel.
  let pigment = device.createTexture({ label: 'prop pigments (none yet)', size: [1, 1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING });
  let ready = null, sceneGroup = null, kit = null, kitLoading = null, unavailable = false, activePort = null, scene = null, shot = null, frameCount = 0, destroyed = false;
  let shotPlaced = null, submerged = null, under = null;

  function makeSceneGroup() {
    if (!ready) return;
    const entries = [
      [0, { buffer: frameUBO }], [1, { buffer: hull }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
      [11, pigment.createView({ dimension: '2d-array' })], [12, sampler], ...neuralPbr.propResources,
    ].map(([binding, resource]) => ({ binding, resource }));
    sceneGroup = device.createBindGroup({ label: 'prop continuum', layout: ready.view.pipeline.getBindGroupLayout(0), entries });
    under = continuumCaptureDraw(submerged, entries, shadows);
  }
  // Under water, a jetty's pilings and whatever else stands in the sea, through the water's own capture.
  requestContinuumCapture(waterOptics, PROP_CONTINUUM_MATERIAL_SPEC).then((capture) => { if (destroyed || !capture) return; submerged = capture; makeSceneGroup(); }, (error) => console.warn('props under water', error));

  // One scene of the one cut, of `counts` instances of each type at most.
  const propScene = (counts, label, poses = null) => {
    const { capacity, room } = continuumRoom(ready.atlas.types, counts);
    return createContinuumScene({ device, atlas: ready.atlas, programs: ready.programs, capacity, room, view: ready.view, poses, frame: frameUBO, shadowUniform: shadows.uniform, samples, label });
  };
  // The atlas and the programs are wanted from the start: a ball may be fired anywhere.
  Promise.all([
    requestContinuumAtlas(device, 'prop', () => loadPropContinuum()),
    requestContinuumPrograms({ device, shader, shadowFormat: LAND_SHADOW_FORMAT }),
    requestContinuumView({ device, shader, material: PROP_CONTINUUM_MATERIAL_SPEC, format, samples }),
  ]).then(([atlas, programs, view]) => {
    if (destroyed) return;
    ready = { atlas, programs, view, lighting: shadows.bind(view.pipeline) };
    makeSceneGroup();
    shot = propScene(PROP_CONTINUUM_TYPES.map((_, t) => (t === PROP_CONTINUUM_SHOT ? GUNNERY_FX_LIMITS.projectiles : 0)), 'shot');
    if (shotPlaced) placeShot(...shotPlaced);
  }).catch((error) => { unavailable = true; console.warn(error.message); });

  // Nothing of a port's costs anything until a port is near, and a failed download only leaves the port as it was.
  function loadKit() {
    kitLoading ??= (async () => {
      const models = await Promise.all(PROP_MODELS.map(async (spec) => {
        const response = await fetch(spec.file);
        if (!response.ok) throw Error(`Prop asset unavailable: ${spec.file}`);
        return readPropModel(new Uint8Array(await response.arrayBuffer()), spec);
      }));
      const pigments = await uploadPigments(device, models);
      if (destroyed) { pigments.destroy(); return; }
      pigment.destroy();
      pigment = pigments;
      kit = { models };
      makeSceneGroup();
    })().catch((error) => { unavailable = true; console.warn(error.message); });
    return kitLoading;
  }

  function dispose() {
    if (!scene) return;
    for (const item of scene.entries) if (item.prop.fracture?.onStruck === item.struck) item.prop.fracture.onStruck = null;
    scene.continuum.destroy();
    scene.records.destroy();
    scene = null;
  }

  const ownerGone = (inst) => { const state = inst?.damageState?.state; return state === 'ruined' || state === 'breached'; };
  const ownerStateOf = (item) => item.inst?.damageState?.state ?? null;
  // A prop as it now stands: gone with what it stood on or when nothing of it is left; broken, its shards flying on
  // their own records, once a shot has moved any; and how far past its model's sphere its timber may lie.
  function placeProp(item) {
    const { prop, at } = item, model = kit.models[prop.model], radius = propDrawRadius(prop, model, ownerStateOf(item)), broken = Boolean(prop.fracture?.damaged);
    scene.continuum.place(at, {
      position: [prop.x, prop.y ?? model.standsAt, prop.z], yaw: prop.yaw ?? 0, type: prop.model,
      kind: broken ? CONTINUUM_KIND.SHARDED : CONTINUUM_KIND.RIGID,
      flags: (radius > 0 ? 0 : CONTINUUM_GONE) | (broken ? CONTINUUM_BROKEN : 0),
      pose: item.block / 4, reach: Math.max(0, radius - model.radius), seed: at,
    });
  }

  function buildScene(port) {
    dispose();
    const placed = port?.props;
    if (!placed?.length || !kit || !ready) return;
    // Every prop has its shards and its flight records from here on, as saved damage left them if there was any.
    preparePortJetties(port, kit.models);
    let recordFloats = 0;
    const entries = placed.map((prop, at) => {
      const item = { at, prop, inst: prop.owner >= 0 ? port.instances[prop.owner] : null, block: recordFloats, struck: null };
      recordFloats += propBlockFloats(prop.fracture.flight.records);
      return item;
    });
    const recordData = new Float32Array(recordFloats), struck = new Set(), owners = new Map();
    const records = buffer('prop shard records', recordData, B.STORAGE);
    const continuum = propScene(PROP_CONTINUUM_TYPES.map((_, t) => placed.filter((p) => p.model === t).length), 'props', records);
    scene = { count: placed.length, continuum, records, recordData, entries, owners, struck, flying: new Set() };
    for (const item of entries) {
      const state = item.prop.fracture;
      recordData[item.block + 1] = state.flight.records.length / SHARD_FLOATS;
      recordData.set(state.flight.records, item.block + BLOCK_HEAD_FLOATS);
      state.flight.dirty.clear();
      item.struck = () => struck.add(item);
      state.onStruck = item.struck;
      // Timber still in the air from before this port was last out of reach: the first frame sets its clock.
      if (state.flight.flying.size) struck.add(item);
      if (item.inst) { if (!owners.has(item.inst)) owners.set(item.inst, { gone: ownerGone(item.inst), items: [] }); owners.get(item.inst).items.push(item); }
      placeProp(item);
    }
    device.queue.writeBuffer(records, 0, recordData);
    continuum.send(0, placed.length);
    continuum.setCount(placed.length);
  }

  function sendProp(item) { placeProp(item); scene.continuum.send(item.at, 1); }
  // A prop's flights as they now stand, with the frame time at which its debris clock read zero.
  function sendFlights(item, simTime) {
    const state = item.prop.fracture, flight = state.flight, data = scene.recordData, length = BLOCK_HEAD_FLOATS + flight.records.length;
    if (simTime !== null) data[item.block] = (((simTime - (state.now - flight.epoch)) % SIM_CLOCK_LOOP_S) + SIM_CLOCK_LOOP_S) % SIM_CLOCK_LOOP_S;
    data.set(flight.records, item.block + BLOCK_HEAD_FLOATS);
    flight.dirty.clear();
    device.queue.writeBuffer(scene.records, item.block * 4, data, item.block, length);
  }
  // What stood on a pier goes when the pier does. A pier is asked, not each thing on it.
  function followOwners() {
    for (const [inst, owner] of scene.owners) {
      const gone = ownerGone(inst);
      if (gone === owner.gone) continue;
      owner.gone = gone;
      for (const item of owner.items) sendProp(item);
    }
  }
  // Only props a shot has broken are visited, and only while their timber is in the air or going under.
  function stepDebris(dt, simTime) {
    if (dt > 0) for (const item of scene.flying) {
      const flight = item.prop.fracture.flight, flying = stepJettyFracture(item.prop, dt);
      if (flight.dirty.size) sendFlights(item, null);
      if (!flying) { scene.flying.delete(item); sendProp(item); }
    }
    if (!scene.struck.size) return;
    for (const item of scene.struck) {
      scene.flying.add(item);
      sendFlights(item, simTime);
      sendProp(item);
    }
    scene.struck.clear();
  }

  // Each ball an iron sphere at its own radius (hot shot, a negative one, glows), on its own seed.
  function placeShot(balls, seeds, n) {
    shotPlaced = [balls, seeds, n];
    if (!shot) return;
    const count = Math.min(n, shot.capacity);
    for (let i = 0; i < count; i++) {
      const r = balls[i * 4 + 3], size = Math.abs(r);
      shot.place(i, { position: [balls[i * 4], balls[i * 4 + 1], balls[i * 4 + 2]], scale: size, identity: r < 0 ? 1 : 0, type: PROP_CONTINUUM_SHOT, seed: seeds[i] });
    }
    shot.send(0, count);
    shot.setCount(count);
  }

  return {
    get count() { return scene?.count ?? 0; },
    get placed() { return activePort?.props ?? []; },
    get port() { return activePort; },
    get models() { return kit?.models ?? []; },
    // Where the gunnery effects place the balls in the air (js/gunnery-effects.js shot).
    shot: { place: placeShot },
    // The continuum's scenes, for reading back: the port's props and the shot.
    get continuum() { return { props: scene?.continuum ?? null, shot }; },
    follow(ports, camera) {
      if (frameCount++ % PROP_CHECK_FRAMES || unavailable) return;
      let best = null, bestDistance = PROP_REACH_M;
      for (const port of ports ?? []) {
        if (!port?.props?.length) continue;
        const d = Math.hypot(port.center.x - camera.x, port.center.z - camera.z);
        if (d < bestDistance) { bestDistance = d; best = port; }
      }
      if (best && !kit) { loadKit(); return; }
      if (best !== activePort || (best && !scene && ready)) { activePort = best; buildScene(best); }
      if (scene) followOwners();
    },
    // `dt` and `simTime` are the simulation's: paused, debris hangs where it is, as the sea does. In the frame's
    // compute pass, before any pass draws.
    encode(pass, dt = 0, simTime = 0) {
      if (scene && (scene.struck.size || scene.flying.size)) stepDebris(dt, simTime);
      scene?.continuum.encode(pass);
      shot?.encode(pass);
    },
    draw(pass) {
      if (!ready || !sceneGroup) return;
      scene?.continuum.draw(pass, sceneGroup, ready.lighting);
      shot?.draw(pass, sceneGroup, ready.lighting);
    },
    drawShadow(pass) {
      scene?.continuum.drawShadow(pass);
      shot?.drawShadow(pass);
    },
    // Under water, single-sampled through the water's own capture: the coarse cut the shadow map's lists hold.
    drawSubmerged(pass, above = false) { under?.draw(pass, [scene?.continuum, shot], above); },
    // For the continuum census (js/continuum-census.js).
    continuumSources() {
      return [['props', scene?.continuum], ['shot', shot]].map(([name, family]) => ({ name, draws: family?.continuumDraws() ?? [] })).filter((source) => source.draws.length);
    },
    destroy() { destroyed = true; dispose(); shot?.destroy(); shot = null; hull.destroy(); pigment.destroy(); },
  };
}
