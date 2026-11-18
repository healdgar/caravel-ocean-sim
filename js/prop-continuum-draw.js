// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Port props and round shot, cut and drawn through the one continuum (AGENTS.md rule 3; js/prop-continuum.js for the
// atlas, js/wgsl/prop-continuum.js for their view). A scene is a set of instances of the atlas's types: the props of a
// port, or the balls in the air. It is the one cut's scene (js/city-continuum-draw.js), cut by the same programs as a
// city's buildings; only the view, which wears a prop's pigment, is the props' own.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError } from './continuum-core.js';
import { CITY_CONTINUUM_HEADER, CITY_CONTINUUM_TYPE_WORDS, CITY_CONTINUUM_STEP_WORDS, CITY_CONTINUUM_CHUNK_TRIANGLES } from './city-continuum.js';
import { CITY_CONTINUUM_ENTRY_LAYOUT } from './wgsl/city-continuum.js';
import { requestCityContinuumPipelines, createContinuumScene } from './city-continuum-draw.js';
import { PROP_CONTINUUM_TYPE, PROP_CONTINUUM_TYPES, loadPropContinuum } from './prop-continuum.js';
import { propContinuumRenderWGSL } from './wgsl/prop-continuum.js';
import { withNeuralPbrProps } from './wgsl/neural-pbr.js';

// The atlas, fetched and uploaded once a device, with what each type can enter in the lists at most: all its clusters,
// and its far body at the heaviest step it is drawn at, in pieces of 32 triangles.
export function requestPropContinuumAtlas(device, fetchAsset = fetch) {
  return requestOnce(device, 'prop continuum atlas', async () => {
    const { manifest, words } = await loadPropContinuum({ fetchAsset });
    const buffer = device.createBuffer({ label: 'prop continuum atlas', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, words);
    const types = PROP_CONTINUUM_TYPES.map((_, t) => {
      const at = words[CITY_CONTINUUM_HEADER.typesAt] + t * CITY_CONTINUUM_TYPE_WORDS, T = PROP_CONTINUUM_TYPE;
      const heaviest = words[words[at + T.steps] + words[at + T.farFirst] * CITY_CONTINUUM_STEP_WORDS];
      return { clusters: words[at + T.clusterCount], farChunks: Math.ceil(heaviest / CITY_CONTINUUM_CHUNK_TRIANGLES) };
    });
    return { manifest, words, buffer, types };
  });
}

// The cut's programs and the shadow map's (every family's), and the props' own view: one set a device and target.
export function requestPropContinuumPipelines({ device, shader, format, samples, shadowFormat }) {
  return requestOnce(device, `prop continuum ${format} ${samples} ${shadowFormat}`, async () => {
    const [cut, viewModule] = await Promise.all([requestCityContinuumPipelines({ device, shader, shadowFormat }), shader(withNeuralPbrProps(propContinuumRenderWGSL()), 'prop continuum')]);
    const view = await device.createRenderPipelineAsync({
      label: 'prop continuum', layout: 'auto',
      vertex: { module: viewModule, entryPoint: 'propContinuumVS', buffers: CITY_CONTINUUM_ENTRY_LAYOUT },
      fragment: { module: viewModule, entryPoint: 'propContinuumFS', targets: [{ format }] },
      // Planks and cleats are open shells, lit from whichever side is seen.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples },
    });
    return { ...cut, view };
  });
}

// Each list's room in a scene that can hold `counts` instances of each type: all of them at once.
export function propContinuumRoom(atlas, counts) {
  let clusters = 0, far = 0, capacity = 0;
  counts.forEach((n, t) => { capacity += n; clusters += n * atlas.types[t].clusters; far += n * atlas.types[t].farChunks; });
  return { capacity, room: [clusters, clusters, far, capacity, far, clusters] };
}

// One scene. `counts` as for propContinuumRoom; `shards` the buffer of its instances' shard flights (none for shot);
// `frame` and `shadowUniform` the scene's frame and land-shadow uniforms. Its instances are placed with `place`
// (`word` a prop's glow: 1 for hot iron) and sent with `send`; it is cut at the scene's one pixel error.
export function createPropContinuumScene({ device, atlas, pipelines: P, counts, shards = null, frame, shadowUniform, samples = 4, label = 'props' }) {
  const { capacity, room } = propContinuumRoom(atlas, counts);
  const scene = createContinuumScene({ device, atlas, pipelines: P, capacity, room, view: P.view, dataAt: 0, shards, frame, shadowUniform, samples, label });
  const encode = scene.encode;
  return Object.assign(scene, {
    encode(pass) { scene.setPixelError(continuumPixelError()); encode(pass); },
  });
}
