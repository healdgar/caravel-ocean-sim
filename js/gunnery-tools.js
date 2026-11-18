// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a crew works its guns, keeps watch and fights with, and the arrows stuck in its people, drawn through the one
// continuum (AGENTS.md rule 3) as props and shot are. Every piece (a rammer's staff and head, a spyglass's tube and
// cell, a swivel's chamber, a cutlass, a fall of tackle, an arrow's shaft and fletching) is a type of the prop atlas at
// its own size (js/prop-continuum.js PROP_CONTINUUM_TOOLS), cut by the one cut (js/continuum-scene.js) and worn by the
// props' material. JavaScript writes each piece's two ends a frame in the vessel's frame, as a compact record; the
// arrow pass fills an arrow's two from the joints its body is drawn with (js/wgsl/crew-solve.js). Then a compute pass
// stands each record as a record of the one format (a rigid instance of its type, turned along it in the world, a
// hauled piece STRETCHED to its length), and the cut does the rest.
import { requestOnce } from './gpu-program-cache.js';
import { crewGunneryTool } from './crew-work.js';
import { boatRotate } from './boat.js';
import { sharedNeuralPbrBank } from './neural-pbr.js';
import { LAND_SHADOW_FORMAT } from './shadows.js';
import { PROP_CONTINUUM_TOOLS, PROP_CONTINUUM_TOOL_FIRST, PROP_CONTINUUM_TYPES, propContinuumTool, loadPropContinuum } from './prop-continuum.js';
import { PROP_CONTINUUM_MATERIAL_SPEC } from './wgsl/prop-continuum.js';
import { continuumRoom } from './continuum-format.js';
import { CONTINUUM_RECORD_WGSL } from './wgsl/continuum-cut.js';
import { requestContinuumAtlas, requestContinuumPrograms, requestContinuumView, requestContinuumCapture, continuumCaptureDraw, createContinuumScene } from './continuum-scene.js';

// A record: one end and the piece (its place in PROP_CONTINUUM_TOOLS, -1 for none), then the other end. A piece runs
// from its type's origin at the first end towards the second.
export const GUNNERY_TOOL_RECORD_FLOATS = 8;
// How many pieces a company draws at most: the arrows' pairs among them.
export const GUNNERY_TOOL_RECORDS = 68;
export const GUNNERY_TOOL_ARROWS = 34;
export const GUNNERY_TOOL_PIECE = Object.freeze(Object.fromEntries(PROP_CONTINUUM_TOOLS.map((tool) => [tool.name, propContinuumTool(tool.name)])));

// Each record stood as a turned instance of its piece's type. Its pose: the vessel's axes and where she lies, in the
// world, and (origin.w) how many records there are. A hauled piece's stretch is its record's pose data, one vec4f in
// the scene's own pose buffer at the record's index.
export const GUNNERY_TOOL_PLACE_WGSL = CONTINUUM_RECORD_WGSL + /* wgsl */`
struct GunneryToolRecord { a:vec4f, b:vec4f };
struct GunneryToolPose { right:vec4f, up:vec4f, aft:vec4f, origin:vec4f };
@group(0) @binding(0) var<storage,read> gunneryTools:array<GunneryToolRecord>;
@group(0) @binding(1) var<uniform> gunneryToolPose:GunneryToolPose;
@group(0) @binding(2) var<storage,read_write> gunneryToolInstances:array<ContinuumRecord>;
@group(0) @binding(3) var<storage,read_write> gunneryToolStretch:array<vec4f>;
const GUNNERY_TOOL_LENGTHS=array<f32,${PROP_CONTINUUM_TOOLS.length}>(${PROP_CONTINUUM_TOOLS.map((tool) => tool.length.toFixed(4)).join(',')});
// The pieces drawn out to the length they are hauled to, one bit each.
const GUNNERY_TOOL_HAULED:u32=${PROP_CONTINUUM_TOOLS.reduce((bits, tool, i) => bits | (tool.hauled ? 1 << i : 0), 0)}u;
fn gunneryToolWorld(p:vec3f)->vec3f { let P=gunneryToolPose;return P.origin.xyz+P.right.xyz*p.x+P.up.xyz*p.y+P.aft.xyz*p.z; }
@compute @workgroup_size(64) fn gunneryToolPlace(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=u32(gunneryToolPose.origin.w)){return;}
  let record=gunneryTools[id.x];
  let a=gunneryToolWorld(record.a.xyz);let d=gunneryToolWorld(record.b.xyz)-a;let reach=length(d);
  let piece=i32(round(record.a.w));
  var out:ContinuumRecord;
  out.place=vec4f(a,1.0);out.turn=vec4f(0.0,0.0,0.0,1.0);out.spare=vec4u(0u);
  // A record with no piece, or one whose ends meet (an arrow whose bone is gone), stands nothing.
  if(piece<0||piece>=${PROP_CONTINUUM_TOOLS.length}||reach<1e-5){
    out.tag=vec4u(${PROP_CONTINUUM_TOOL_FIRST}u|CONTINUUM_GONE,id.x,id.x,0u);
    gunneryToolInstances[id.x]=out;return;
  }
  // The shortest turn from the piece's own up (+y) onto its line: about the axis +y x along. Straight down is half a
  // turn about +x.
  let along=d/reach;let w=1.0+along.y;
  out.turn=select(normalize(vec4f(along.z,0.0,-along.x,w)),vec4f(1.0,0.0,0.0,0.0),w<1e-6);
  var flags=0u;
  if(((GUNNERY_TOOL_HAULED>>u32(piece))&1u)!=0u){flags=CONTINUUM_STRETCHED;gunneryToolStretch[id.x]=vec4f(1.0,reach/GUNNERY_TOOL_LENGTHS[piece],1.0,0.0);}
  out.tag=vec4u((${PROP_CONTINUUM_TOOL_FIRST}u+u32(piece))|flags,id.x,id.x,0u);
  gunneryToolInstances[id.x]=out;
}
`;

// The pose the records are stood by: the vessel's right, up and aft in the world, where she lies, and how many records
// there are, as sixteen floats.
export function gunneryToolPose(boat, count, pose = new Float32Array(16)) {
  const h = ((boat.heading ?? 0) * Math.PI) / 180, axis = [0, 0, 0];
  for (const [i, vector] of [[0, [1, 0, 0]], [4, [0, 1, 0]], [8, [0, 0, 1]]]) { boatRotate(axis, ...vector, h, boat.pitch ?? 0, boat.roll ?? 0); pose.set(axis, i); pose[i + 3] = 0; }
  pose.set([boat.x ?? 0, boat.heave ?? 0, boat.z ?? 0, count], 12);
  return pose;
}

// 'placed', if given, takes the arrows of bodies posed on the GPU: each is given two records here, a shaft and its
// fletching, which the arrow pass fills from the body's joints (js/crew-solve.js).
export function writeGunneryToolInstances(company, boat, target, placed = null) {
  const records = Math.floor(target.length / GUNNERY_TOOL_RECORD_FLOATS), P = GUNNERY_TOOL_PIECE;
  let count = 0;
  const room = (n = 1) => count + n <= records;
  const piece = (a, b, which) => {
    if (!room() || Math.hypot(...b.map((v, i) => v - a[i])) < 1e-5) return;
    target.set([...a, which, ...b, 0], count * GUNNERY_TOOL_RECORD_FLOATS);
    count++;
  };
  // A head on the far end of a staff: its last `length` metres.
  const end = (a, b, length) => { const d = b.map((x, i) => x - a[i]), n = Math.hypot(...d); return n < 1e-5 ? null : b.map((x, i) => x - (d[i] / n) * length); };
  let arrows = 0;
  for (const sailor of company.crew) {
    // Arrows that struck this body, fletched at the tail. They yield to a working crew's tools.
    if (sailor.stuckArrowPoses) for (const arrow of sailor.stuckArrowPoses) {
      if (!room(2)) break;
      piece(arrow.tip, arrow.tail, P['arrow-shaft']);
      const from = end(arrow.tip, arrow.tail, PROP_CONTINUUM_TOOLS[P['arrow-fletching']].length);
      if (from) piece(from, arrow.tail, P['arrow-fletching']);
    } else if (placed) for (const arrow of sailor.stuckArrows ?? []) {
      if (!room(2) || arrows >= GUNNERY_TOOL_ARROWS) break;
      // Nothing until the arrow pass names their pieces.
      placed.push({ sailor, arrow, record: count });
      target.set([0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0], count * GUNNERY_TOOL_RECORD_FLOATS);
      count += 2; arrows++;
    }
    const tool = crewGunneryTool(sailor, boat);
    if (!tool?.a || !tool.b) continue;
    if (tool.kind === 'blade' || tool.kind === 'club') { piece(tool.a, tool.b, tool.kind === 'blade' ? P.cutlass : P.macana); continue; }
    if (tool.kind === 'tackle') { piece(tool.a, tool.b, P['tackle-fall']); continue; }
    if (tool.kind === 'chamber') { piece(tool.a, tool.b, P['swivel-chamber']); continue; }
    if (tool.kind === 'spyglass') {
      piece(tool.a, tool.b, P['spyglass-tube']);
      const from = end(tool.a, tool.b, PROP_CONTINUUM_TOOLS[P['spyglass-cell']].length);
      if (from) piece(from, tool.b, P['spyglass-cell']);
      continue;
    }
    piece(tool.a, tool.b, P['rammer-staff']);
    const head = tool.kind === 'sponge' ? P['sponge-head'] : P['rammer-head'], from = end(tool.a, tool.b, PROP_CONTINUUM_TOOLS[head].length);
    if (from) piece(from, tool.b, head);
  }
  return { count };
}

// The tools' tessellated surfaces, for checking their bounds and reach offline. Nothing draws them: the continuum
// draws the baked pieces.
export function buildGunneryToolVertices(company, boat, vertices) {
  const records = new Float32Array(GUNNERY_TOOL_RECORDS * GUNNERY_TOOL_RECORD_FLOATS), { count } = writeGunneryToolInstances(company, boat, records);
  let cursor = 0;
  const put = (point, normal, kind) => { if (cursor + 8 > vertices.length) throw Error('Gunnery tools exceed bounded geometry'); vertices.set([...point, ...normal, kind, 1], cursor); cursor += 8; };
  for (let r = 0; r < count; r++) {
    const at = r * GUNNERY_TOOL_RECORD_FLOATS, a = Array.from(records.subarray(at, at + 3)), b = Array.from(records.subarray(at + 4, at + 7)), tool = PROP_CONTINUUM_TOOLS[records[at + 3]];
    const direction = b.map((v, i) => v - a[i]), length = Math.hypot(...direction), sides = 6;
    if (!tool || length < 1e-5) continue;
    for (let i = 0; i < 3; i++) direction[i] /= length;
    const seed = Math.abs(direction[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [direction[1] * seed[2] - direction[2] * seed[1], direction[2] * seed[0] - direction[0] * seed[2], direction[0] * seed[1] - direction[1] * seed[0]], m = Math.hypot(...u);
    for (let i = 0; i < 3; i++) u[i] /= m;
    const v = [direction[1] * u[2] - direction[2] * u[1], direction[2] * u[0] - direction[0] * u[2], direction[0] * u[1] - direction[1] * u[0]];
    const reach = tool.hauled ? length : tool.length, tip = a.map((x, i) => x + direction[i] * reach);
    for (let side = 0; side < sides; side++) {
      const normal = (t) => u.map((x, i) => x * Math.cos(t) + v[i] * Math.sin(t));
      const n0 = normal((side * Math.PI * 2) / sides), n1 = normal(((side + 1) * Math.PI * 2) / sides);
      const point = (e, n) => e.map((x, i) => x + n[i] * tool.radius), a0 = point(a, n0), a1 = point(a, n1), b0 = point(tip, n0), b1 = point(tip, n1);
      for (const [p, n] of [[a0, n0], [a1, n1], [b0, n0], [b0, n0], [a1, n1], [b1, n1]]) put(p, n, tool.material);
    }
  }
  return cursor / 8;
}

// The pass that stands the records, asked for once a device; and with it the prop atlas, the one cut's programs and
// the props' view, which the tools are cut and drawn with.
export function requestGunneryToolPrograms({ device, shader, format, samples }) {
  return requestOnce(device, `gun tools ${format} ${samples}`, async () => {
    const [atlas, programs, view, place] = await Promise.all([
      requestContinuumAtlas(device, 'prop', () => loadPropContinuum()),
      requestContinuumPrograms({ device, shader, shadowFormat: LAND_SHADOW_FORMAT }),
      requestContinuumView({ device, shader, material: PROP_CONTINUUM_MATERIAL_SPEC, format, samples }),
      shader(GUNNERY_TOOL_PLACE_WGSL, 'gun tools placed').then((module) => device.createComputePipelineAsync({ label: 'gun tools placed', layout: 'auto', compute: { module, entryPoint: 'gunneryToolPlace' } })),
    ]);
    return { atlas, programs, view, place };
  });
}

// One company's tools: its records and pose, the pass that stands them, and its scene of the one cut, lit by its own
// vessel (`hullUBO`, and `shadows`, her shadow set) as her people are, and under water through `waterOptics`.
export async function createGunneryTools({ device, frameUBO, hullUBO, transView, skyView, sampClamp, envCubeView, sunVisBuf, shadows, shader, format, samples, waterOptics = null }) {
  const B = GPUBufferUsage, [{ atlas, programs, view, place }, submerged] = await Promise.all([requestGunneryToolPrograms({ device, shader, format, samples }), requestContinuumCapture(waterOptics, PROP_CONTINUUM_MATERIAL_SPEC)]);
  const records = new Float32Array(GUNNERY_TOOL_RECORDS * GUNNERY_TOOL_RECORD_FLOATS), pose = new Float32Array(16), placed = [];
  const tubes = device.createBuffer({ label: 'crew gun tool records', size: records.byteLength, usage: B.STORAGE | B.COPY_DST });
  const poseBuffer = device.createBuffer({ label: 'crew gun tool pose', size: 64, usage: B.UNIFORM | B.COPY_DST });
  // Room for every record to be any piece.
  const counts = PROP_CONTINUUM_TYPES.map((_, t) => (t >= PROP_CONTINUUM_TOOL_FIRST ? GUNNERY_TOOL_RECORDS : 0));
  const { capacity, room } = continuumRoom(atlas.types, counts);
  const scene = createContinuumScene({ device, atlas, programs, capacity, room, view, poseRoom: GUNNERY_TOOL_RECORDS, frame: frameUBO, shadowUniform: shadows.uniform, samples, label: 'gun tools', profile: 'props' });
  const placeGroup = device.createBindGroup({ label: 'gun tools placed', layout: place.getBindGroupLayout(0), entries: [tubes, poseBuffer, scene.records, scene.poses].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  // The props' view, lit by this vessel. Every piece is plain: the pigments are one texel no piece reads.
  const pigment = device.createTexture({ label: 'gun tool pigments (none)', size: [1, 1, 1], format: 'rgba8unorm-srgb', usage: globalThis.GPUTextureUsage?.TEXTURE_BINDING ?? 4 });
  const sampler = device.createSampler({ label: 'gun tool pigment', magFilter: 'linear', minFilter: 'linear' });
  const main = [
    [0, { buffer: frameUBO }], [1, { buffer: hullUBO }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
    [11, pigment.createView({ dimension: '2d-array' })], [12, sampler], ...sharedNeuralPbrBank(device).propResources,
  ].map(([binding, resource]) => ({ binding, resource }));
  const sceneGroup = device.createBindGroup({ label: 'gun tools', layout: view.pipeline.getBindGroupLayout(0), entries: main });
  const lighting = shadows.bind(view.pipeline), under = continuumCaptureDraw(submerged, main, shadows);
  let count = 0;
  return {
    // The records, and which of them are arrows still to be placed from their bodies' joints this frame.
    tubes, placed,
    update(company, boat, enabled) {
      placed.length = 0;
      count = enabled ? writeGunneryToolInstances(company, boat, records, placed).count : 0;
      scene.setCount(count);
      if (!count) return;
      device.queue.writeBuffer(tubes, 0, records, 0, count * GUNNERY_TOOL_RECORD_FLOATS);
      device.queue.writeBuffer(poseBuffer, 0, gunneryToolPose(boat, count, pose));
    },
    // After the arrow pass, before anything draws: each record stood, then every piece cut.
    encode(pass) {
      if (count) { pass.setPipeline(place); pass.setBindGroup(0, placeGroup); pass.dispatchWorkgroups(Math.ceil(count / 64)); }
      scene.encode(pass);
    },
    draw(pass) { if (count) scene.draw(pass, sceneGroup, lighting); },
    drawShadow(pass) { if (count) scene.drawShadow(pass); },
    // Under water: the coarse cut the shadow map's lists hold, as the crew's own bodies are drawn there.
    drawSubmerged(pass, above = false) { if (count) under?.draw(pass, [scene], above); },
    continuumDraws() { return count ? scene.continuumDraws() : []; },
    destroy() { scene.destroy(); tubes.destroy(); poseBuffer.destroy(); pigment.destroy(); },
  };
}
