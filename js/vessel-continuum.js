// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ships the player and her fleet sail, drawn through the ship continuum (AGENTS.md rule 3): the same bake as the
// trade vessels (scripts/prepare-ship-continuum.mjs), the same cut (js/wgsl/ship-continuum.js), one per vessel. Each
// list entry reads that vessel's own posed vertices (js/vessel-pose.js: rig, recoil, parts and shard flight) and her
// own copy of the assembly (her scars baked in), so what is drawn is what her physics strikes. Her clusters, her far
// body and her splat share each pixel's samples across the handoff; a damaged vessel draws her clusters only, the
// finest her error bound allows, depth first and then shaded where it is equal. Her shadows and what is seen of her
// from under the water are the cut's coarse lists: her far body at the shadow map's step (or, for a shadow near the
// eye, her clusters cut to the map's texel), or her damaged clusters.
import { CONTINUUM_CORE_WGSL } from './continuum-core.js';
import { requestOnce } from './gpu-program-cache.js';
import { withPosedVesselVertices } from './vessel-pose.js';
import { CARAVEL, CARAVEL_DAMAGED } from './wgsl/caravel.js';
import { SHADOW_CAST } from './wgsl/shadows.js';
import { withNeuralPbrVessel } from './wgsl/neural-pbr.js';
import { SHIP_CONTINUUM_ENTRY_LAYOUT, SHIP_CONTINUUM_SHADOW_LIST, SHIP_CONTINUUM_SHADOW_CLUSTER_LIST, SHIP_CONTINUUM_BODY_LIMIT, SHIP_CONTINUUM_INSTANCE_FLOATS, shipContinuumDataWGSL, shipContinuumOrders } from './wgsl/ship-continuum.js';
import { loadShipContinuum, requestShipContinuumCut, createShipContinuumCut } from './ship-continuum-draw.js';

// The continuum's data and the vessel's posed vertices sit at this group of a hull program (after its own resources
// and its lighting) and of a shadow program (after its own).
const VESSEL_CONTINUUM_GROUP = 2, VESSEL_SHADOW_CONTINUUM_GROUP = 1;
// The binding of the posed vertices in that group, after the continuum's seven.
const VESSEL_CONTINUUM_POSED = 7;

// The vertex stage of a hull or shadow program, taken from its storage: `vs` becomes vesselVertex(...), fed one
// vertex of the vessel's own assembly and its posed place, and list-reading entry points are added.
function vesselContinuumVertex(source) {
  const posed = withPosedVesselVertices(source);
  const signature = /@vertex\s+fn\s+vs\s*\(([\s\S]*?)\)\s*->\s*(\w+)\s*\{/;
  const found = signature.exec(posed);
  if (!found) throw Error('Unrecognized vessel vertex shader');
  const args = found[1].replace(/@(?:location\(\d+\)|builtin\(\w+\))\s*/g, '');
  const names = args.split(',').map((arg) => arg.split(':')[0].trim());
  if (names.join() !== 'position,normal,material,uv,index,posedPosition,posedNormal') throw Error(`Unrecognized vessel vertex inputs: ${names.join()}`);
  const out = found[2];
  const struct = new RegExp(`struct\\s+${out}\\s*\\{[^}]*@builtin\\(position\\)\\s*(\\w+)`).exec(posed);
  if (!struct) throw Error(`Unrecognized vessel vertex output ${out}`);
  return { source: posed.replace(signature, `fn vesselVertex(${args}) -> ${out} {`), out, position: struct[1] };
}

// What every vessel program reads of the continuum: its bodies, her lists and instance, and her posed vertices.
// `shipVertices` is bound to her own copy of the assembly (js/ship-continuum-draw.js dataGroup), the vertices her
// pose pass reads, so a cluster corner, her pose and her wetness all name one vertex. Her cut holds her one body.
function vesselContinuumReaders(group, out, position) {
  return /* wgsl */`
@group(${group}) @binding(${VESSEL_CONTINUUM_POSED}) var<storage,read> vesselPosed:array<vec4f>;
fn vesselBodyOf(ship:u32)->ShipContinuumBody { return shipBodies[min(u32(max(round(shipInstances[ship].attitude.w),0.0)),${SHIP_CONTINUUM_BODY_LIMIT - 1}u)]; }
fn vesselHidden()->${out} { var o:${out}; o.${position}=vec4f(2.0,2.0,0.0,1.0); return o; }
// Vertex v of her assembly, posed as her pose pass left it.
fn vesselListedVertex(v:u32)->${out} {
  let o=v*9u;
  return vesselVertex(vec3f(shipVertices[o],shipVertices[o+1u],shipVertices[o+2u]),vec3f(shipVertices[o+3u],shipVertices[o+4u],shipVertices[o+5u]),
    shipVertices[o+6u],vec2f(shipVertices[o+7u],shipVertices[o+8u]),v,vesselPosed[v*2u].xyz,vesselPosed[v*2u+1u].xyz);
}
// A far-body point, grown 'grow' metres along its normal, carried as the vertex of her assembly it rides is posed
// (canvas, yards, oars and helm move it with them).
fn vesselFarPoint(p:ShipContinuumPoint,grow:f32,body:ShipContinuumBody)->${out} {
  let s=p.source;let o=s*9u;
  let rest=vec3f(shipVertices[o],shipVertices[o+1u],shipVertices[o+2u]);
  let point=p.position+normalize(p.normal/body.scale.xyz)*grow/body.scale.xyz;
  return vesselVertex(p.position,p.normal,shipVertices[o+6u],vec2f(shipVertices[o+7u],shipVertices[o+8u]),s,vesselPosed[s*2u].xyz+point-rest,p.normal);
}
// Every program reads every binding of the group (shipContinuumBindings, and her pose and wetness here), on a path
// never taken, so each pipeline's layout holds all of them and one set of resources binds them all.
fn vesselTouched()->f32 {
  var touched=shipContinuumBindings();
  if(shipCut.counts.w==0xffffffffu){touched+=vesselListedVertex(0u).${position}.x;}
  return touched;
}
`;
}

// The hull program (js/wgsl/caravel.js) drawn from the ship continuum's lists. The whole program's clusters keep the
// samples that are their own across the handoff (shipContinuumMask); its far body and splat are lit by their own
// colour. The damaged program draws a damaged vessel's clusters, its surviving surface laid first.
export function vesselContinuumSource({ damaged = false, samples = 4 } = {}) {
  const { source: vertexSource, out, position } = vesselContinuumVertex(withNeuralPbrVessel(damaged ? CARAVEL_DAMAGED : CARAVEL));
  // Read without regard to whitespace: the minified bundle (build.mjs) strips it from WGSL, this text's too.
  let source = vertexSource.replace(/(struct\s+BoatVertex\s*\{[\s\S]*?),?(\s*\};)/, `$1,
  @location(8) @interpolate(flat) coverage: vec2u,
  @location(9) colour: vec3f,$2`);
  if (!/@location\(8\)\s*@interpolate\(flat\)\s*coverage/.test(source)) throw Error('Unrecognized vessel vertex output');
  if (!damaged) {
    const fragment = /@fragment\s+fn\s+fs\s*\(\s*in\s*:\s*BoatVertex\s*,\s*@builtin\(front_facing\)\s*front\s*:\s*bool\s*\)\s*->\s*@location\(0\)\s*vec4f\s*\{/;
    if (!fragment.test(source)) throw Error('Unrecognized vessel fragment shader');
    source = source.replace(fragment, 'fn vesselShade(in: BoatVertex, front: bool) -> vec4f {');
  }
  return CONTINUUM_CORE_WGSL + source + shipContinuumDataWGSL(VESSEL_CONTINUUM_GROUP) + vesselContinuumReaders(VESSEL_CONTINUUM_GROUP, out, position) + /* wgsl */`
// Her clusters: whole ones from the clusters list, a damaged one's from her own list.
@vertex fn vesselClusterVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->BoatVertex {
  let touched=vesselTouched();
  let entry=listed.entry;
  let v=shipContinuumClusterVertex(vesselBodyOf(entry.x),entry.y,vertex);
  if(v==0xffffffffu){return vesselHidden();}
  var o=vesselListedVertex(v);
  o.world+=vec3f(touched);
  // The clusters give up the samples the far body takes across the handoff.
  o.coverage=shipContinuumCoverage(1u,shipContinuumState(entry.x).x);
  return o;
}
` + (damaged ? '' : /* wgsl */`
const VESSEL_CONTINUUM_SAMPLES:u32=${samples}u;
// One far-body vertex at 'step', on its way to where the next collapse takes it.
fn vesselFarVertex(ship:u32,chunk:u32,vertex:u32,step:u32,morph:f32)->BoatVertex {
  let body=vesselBodyOf(ship);
  let triangle=chunk*128u+vertex/3u;
  if(triangle>=shipContinuumStepWord(body,step,0u)){return vesselHidden();}
  let corner=shipShape[body.chain.x+body.chain.z+triangle*3u+vertex%3u];
  let next=min(step+1u,u32(body.far.y));
  let a=shipContinuumAncestor(body,corner,step);
  let b=shipContinuumAncestor(body,a,next);
  let grow=mix(bitcast<f32>(shipContinuumStepWord(body,step,2u)),bitcast<f32>(shipContinuumStepWord(body,next,2u)),morph);
  let pa=shipContinuumFarPoint(body.chain.x,a);
  var o=vesselFarPoint(pa,grow,body);
  o.colour=pa.colour;
  if(morph>0.0&&b!=a){
    let pb=shipContinuumFarPoint(body.chain.x,b);
    let ob=vesselFarPoint(pb,grow,body);
    o.pos=mix(o.pos,ob.pos,morph);
    o.world=mix(o.world,ob.world,morph);
    o.normal=normalize(mix(o.normal,ob.normal,morph));
    o.local=mix(o.local,ob.local,morph);
    o.colour=mix(o.colour,pb.colour,morph);
  }
  return o;
}
@vertex fn vesselFarVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->BoatVertex {
  let touched=vesselTouched();
  let entry=listed.entry;
  let state=shipContinuumState(entry.x);
  var o=vesselFarVertex(entry.x,entry.y,vertex,state.y&65535u,bitcast<f32>(state.z));
  o.world+=vec3f(touched);
  // The far body takes the handoff's share from the clusters and gives the splat its own.
  o.coverage=shipContinuumCoverage(2u,state.x);
  return o;
}
// The far body at the shadow map's step, unmorphed: her coarse cut, seen from under the water.
@vertex fn vesselFarCaptureVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->BoatVertex {
  let touched=vesselTouched();
  let entry=listed.entry;
  var o=vesselFarVertex(entry.x,entry.y,vertex,shipContinuumState(entry.x).y>>16u,0.0);
  o.world+=vec3f(touched);
  o.coverage=vec2u(2u,0u);
  return o;
}
// The splat: the triangle that circumscribes her outline's ellipse, shrunk to the ellipse's own area, facing the eye,
// as wide as she shows from where she is seen (side on or end on).
@vertex fn vesselSplatVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->BoatVertex {
  let touched=vesselTouched();
  let entry=listed.entry;
  let state=shipContinuumState(entry.x);
  let body=vesselBodyOf(entry.x);
  let scale=max(shipInstances[entry.x].attitude.z,1e-3);
  let centre=hull.origin.xyz+rotateHull(body.splat.xyz*scale);
  let toward=normalize(F.camPos.xyz-centre);
  var up=rotateHull(vec3f(0.0,1.0,0.0));
  up=normalize(up-toward*dot(up,toward)+vec3f(0.0,1e-4,0.0));
  let right=normalize(cross(up,toward));
  let beam=rotateHull(vec3f(1.0,0.0,0.0));
  let level=toward-up*dot(toward,up);
  let sideOn=abs(dot(level/max(length(level),1e-4),beam));
  let rx=mix(body.splat.w,body.far.w,sideOn);
  let k=0.7776*scale*bitcast<f32>(state.w);
  let corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  let world=centre+right*(corner.x*rx*k)+up*(corner.y*body.far.z*k);
  var o:BoatVertex;
  o.pos=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  o.world=world+vec3f(touched);
  o.normal=toward;
  o.normalLocal=vec3f(0.0,1.0,0.0);
  o.colour=body.colour.xyz;
  o.coverage=shipContinuumCoverage(3u,state.x);
  return o;
}
// Her far body and splat, lit by their own colour as her timber is lit.
fn vesselFarShade(in:BoatVertex,front:bool)->vec4f {
  // Never taken: it holds every resource her whole shade binds in this program's layout too.
  if(F.screen.x<0.0){return vesselShade(in,front);}
  let n=normalize(in.normal)*select(-1.0,1.0,front);
  let toSun=normalize(F.sunDir.xyz);
  let eye=normalize(F.camPos.xyz-in.world);
  let shadowed=vesselShadow(in.world,n);
  let sunLight=sunIlluminance()*sunVis[0]*step(0.0,toSun.y)*solarShadowVisibility(shadowed);
  let lit=max(dot(n,toSun),0.0);
  let skyLight=skyAtmo(normalize(vec3f(n.x*0.35,max(n.y,0.14),n.z*0.35)));
  let seaLight=skyAtmo(vec3f(0.0,0.25,0.0))*0.45+F.waterCol.rgb*0.65;
  let f0=vec3f(0.04);
  var col=in.colour*vesselAmbient(n,skyLight,seaLight)*0.82+(in.colour/PI)*sunLight*lit+vesselSpecular(n,eye,toSun,0.86,f0)*sunLight*lit;
  col+=lunarSurface(n,eye,in.colour,0.86,f0,sunVis[1]*lunarShadowVisibility(shadowed));
  return vec4f(surfaceAir(col,in.world),1.0);
}
// Each continuum draw keeps only the samples of the pixel that are its own (shipContinuumMask).
struct VesselContinuumFragment { @location(0) color:vec4f, @builtin(sample_mask) mask:u32 };
@fragment fn fs(in:BoatVertex,@builtin(front_facing) front:bool)->VesselContinuumFragment {
  var o:VesselContinuumFragment;
  o.color=vesselShade(in,front);
  o.mask=shipContinuumMask(in.coverage,in.pos.xy,VESSEL_CONTINUUM_SAMPLES);
  return o;
}
@fragment fn vesselFarFS(in:BoatVertex,@builtin(front_facing) front:bool)->VesselContinuumFragment {
  var o:VesselContinuumFragment;
  o.color=vesselFarShade(in,front);
  o.mask=shipContinuumMask(in.coverage,in.pos.xy,VESSEL_CONTINUUM_SAMPLES);
  return o;
}
// What the water captures (js/water-optics.js): her far body by its colour, a damaged vessel's clusters whole.
@fragment fn vesselFarCaptureFS(in:BoatVertex,@builtin(front_facing) front:bool)->@location(0) vec4f { return vesselFarShade(in,front); }
@fragment fn vesselCaptureFS(in:BoatVertex,@builtin(front_facing) front:bool)->@location(0) vec4f { return vesselShade(in,front); }
`);
}

// The shadow program (js/wgsl/shadows.js) cast from the same lists: her far body at the shadow map's step, her clusters
// cut to the map's texel, or a damaged vessel's clusters. Solid and canvas are cast into separate maps, each triangle
// by what its first corner is.
export function vesselContinuumShadowSource() {
  const { source, out, position } = vesselContinuumVertex(SHADOW_CAST);
  return CONTINUUM_CORE_WGSL + source + shipContinuumDataWGSL(VESSEL_SHADOW_CONTINUUM_GROUP) + vesselContinuumReaders(VESSEL_SHADOW_CONTINUUM_GROUP, out, position) + /* wgsl */`
fn vesselCastsCanvas(material:f32)->bool { let m=u32(max(floor(material),0.0)); return m==9u||m==13u; }
fn vesselShadowCluster(vertex:u32,listed:ShipContinuumEntry,cloth:bool)->ShadowVertex {
  let touched=vesselTouched();
  let entry=listed.entry;
  let body=vesselBodyOf(entry.x);
  let first=shipContinuumClusterVertex(body,entry.y,vertex-vertex%3u);
  if(first==0xffffffffu||vesselCastsCanvas(shipVertices[first*9u+6u])!=cloth){return vesselHidden();}
  var o=vesselListedVertex(shipContinuumClusterVertex(body,entry.y,vertex));
  o.position.x+=touched;
  return o;
}
fn vesselShadowFar(vertex:u32,listed:ShipContinuumEntry,cloth:bool)->ShadowVertex {
  let touched=vesselTouched();
  let entry=listed.entry;
  let body=vesselBodyOf(entry.x);
  let state=shipContinuumState(entry.x);
  // Near the eye her clusters cast her shadow (SHIP_CONTINUUM_SHADOW_CLUSTER_LIST), and her far body none.
  if(shipContinuumClustersCast(state)){return vesselHidden();}
  let step=state.y>>16u;
  let triangle=entry.y*128u+vertex/3u;
  if(triangle>=shipContinuumStepWord(body,step,0u)){return vesselHidden();}
  let at=body.chain.x+body.chain.z+triangle*3u;
  if((shipContinuumFarPoint(body.chain.x,shipContinuumAncestor(body,shipShape[at],step)).kind==1u)!=cloth){return vesselHidden();}
  var o=vesselFarPoint(shipContinuumFarPoint(body.chain.x,shipContinuumAncestor(body,shipShape[at+vertex%3u],step)),bitcast<f32>(shipContinuumStepWord(body,step,2u)),body);
  o.position.x+=touched;
  return o;
}
@vertex fn vesselSolidClusterVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->ShadowVertex { return vesselShadowCluster(vertex,listed,false); }
@vertex fn vesselCanvasClusterVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->ShadowVertex { return vesselShadowCluster(vertex,listed,true); }
@vertex fn vesselSolidFarVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->ShadowVertex { return vesselShadowFar(vertex,listed,false); }
@vertex fn vesselCanvasFarVS(@builtin(vertex_index) vertex:u32,listed:ShipContinuumEntry)->ShadowVertex { return vesselShadowFar(vertex,listed,true); }
`;
}

// Every program a vessel is drawn with, asked for once a device and shared by the fleet: her cut, her clusters, far
// body and splat in the scene, her two shadow casts each from her far body and from her clusters, and what the water
// captures of her. The damaged programs are asked for apart (requestDamaged), once the game is running.
export function requestVesselContinuumPrograms({ device, shader, format, samples, waterOptics = null }) {
  return requestOnce(device, `vessel continuum ${format} ${samples}`, async () => {
    const source = vesselContinuumSource({ samples });
    const [module, shadowModule] = await Promise.all([shader(source, 'vessel continuum'), shader(vesselContinuumShadowSource(), 'vessel continuum shadows')]);
    const seen = (label, entryPoint, fragment) => device.createRenderPipelineAsync({
      label, layout: 'auto',
      vertex: { module, entryPoint, buffers: SHIP_CONTINUUM_ENTRY_LAYOUT },
      fragment: { module, entryPoint: fragment, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    });
    const cast = (label, entryPoint, cloth) => device.createRenderPipelineAsync({
      label, layout: 'auto',
      vertex: { module: shadowModule, entryPoint, buffers: SHIP_CONTINUUM_ENTRY_LAYOUT },
      fragment: { module: shadowModule, entryPoint: cloth ? 'canvasFS' : 'solidFS', targets: cloth ? [{ format: 'rgba16float' }] : [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
    });
    const optics = await waterOptics;
    const capture = (entry, entryPoint) => optics?.capture({ source, entry, world: 'in.world', vertex: { entryPoint, buffers: SHIP_CONTINUUM_ENTRY_LAYOUT }, groups: 3 }) ?? null;
    const [cut, clusters, far, splat, solidFar, canvasFar, solidClusters, canvasClusters, farCapture, clusterCapture] = await Promise.all([
      requestShipContinuumCut({ device, shader }),
      seen('vessel clusters', 'vesselClusterVS', 'fs'),
      seen('vessel far bodies', 'vesselFarVS', 'vesselFarFS'),
      seen('vessel splats', 'vesselSplatVS', 'vesselFarFS'),
      cast('solid shadows of far bodies', 'vesselSolidFarVS', false),
      cast('canvas shadows of far bodies', 'vesselCanvasFarVS', true),
      cast('solid shadows of clusters', 'vesselSolidClusterVS', false),
      cast('canvas shadows of clusters', 'vesselCanvasClusterVS', true),
      capture('vesselFarCaptureFS', 'vesselFarCaptureVS'),
      capture('vesselCaptureFS', 'vesselClusterVS'),
    ]);
    let damaged = null;
    return {
      cut, clusters, far, splat, shadows: { far: [solidFar, canvasFar], clusters: [solidClusters, canvasClusters] }, farCapture, clusterCapture,
      // The damaged vessel's programs: her surviving surface's depth (holed timber, parted rope and ripped canvas cut
      // away), then her shade where that depth is equal.
      requestDamaged() {
        damaged ??= shader(vesselContinuumSource({ damaged: true, samples }), 'damaged vessel continuum').then((damagedModule) => {
          const base = { layout: 'auto', vertex: { module: damagedModule, entryPoint: 'vesselClusterVS', buffers: SHIP_CONTINUUM_ENTRY_LAYOUT }, primitive: { topology: 'triangle-list', cullMode: 'none' }, multisample: { count: samples } };
          return Promise.all([
            device.createRenderPipelineAsync({ ...base, label: 'damaged vessel surviving surface', fragment: { module: damagedModule, entryPoint: 'surviving', targets: [{ format, writeMask: 0 }] },
              depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } }),
            device.createRenderPipelineAsync({ ...base, label: 'damaged vessel', fragment: { module: damagedModule, entryPoint: 'fs', targets: [{ format }] },
              depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' } }),
          ]).then(([surviving, shade]) => ({ surviving, shade }));
        });
        damaged.catch(() => { damaged = null; });
        return damaged;
      },
    };
  });
}

// Each model's body, loaded once a device: the bake checked against the ship as built here (js/ship-mesh.js).
export function loadVesselContinuumBody(device, asset, { fetchAsset = fetch } = {}) {
  return requestOnce(device, `vessel continuum body ${asset.model.id}`, () => loadShipContinuum(device, [`player-${asset.model.id}`], [asset], { label: `${asset.model.id} continuum`, fetchAsset }));
}

// One vessel on the continuum: her cut, her instance record and the bind groups of every program she is drawn with.
// `vertices` is her own copy of the assembly and `pose` her pose pass (js/vessel-pose.js); `frame` the scene's Frame,
// `shadowFrame` her own shadow map's frame (whose texel her shadow's step is cut to).
export function createVesselContinuum({ device, programs, data, asset, vertices, pose, frame, offset, shadowFrame, identity, samples = 4, label = 'vessel' }) {
  if (data.manifests.length !== 1 || data.assemblies[0].vertexCount !== asset.vertices.length / 9) throw Error(`${label} continuum holds another assembly`);
  const B = GPUBufferUsage;
  const instances = device.createBuffer({ label: `${label} continuum instance`, size: SHIP_CONTINUUM_INSTANCE_FLOATS * 4, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
  const record = new Float32Array(SHIP_CONTINUUM_INSTANCE_FLOATS);
  const cut = createShipContinuumCut({ device, pipeline: programs.cut, data, instances, capacity: 1, frame, offset, shadowFrame, samples, label: `${label} continuum` });
  const posed = [{ binding: VESSEL_CONTINUUM_POSED, resource: { buffer: pose.buffer } }];
  const dataGroup = (pipeline, group) => cut.dataGroup(pipeline, group, posed, { vertices });
  const length = asset.model.runtime.length;
  let damagedSlot = -1, drawn = false;
  const shadowGroups = new Map(), captureData = {
    far: programs.farCapture ? dataGroup(programs.farCapture.pipeline, VESSEL_CONTINUUM_GROUP) : null,
    clusters: programs.clusterCapture ? dataGroup(programs.clusterCapture.pipeline, VESSEL_CONTINUUM_GROUP) : null,
  };
  const scene = { clusters: dataGroup(programs.clusters, VESSEL_CONTINUUM_GROUP), far: dataGroup(programs.far, VESSEL_CONTINUUM_GROUP), splat: dataGroup(programs.splat, VESSEL_CONTINUUM_GROUP) };
  let damagedData = null;
  return {
    cut, instances, programs,
    // Her place this frame, from her boat state: where she floats and how she lies (as her hull uniform has it), at her
    // scale over the model's; cut finer when she is the player's own or aimed at; her damaged list when she is holed.
    place(boat, { important = false, damaged = false } = {}) {
      damagedSlot = damaged ? 0 : -1;
      record.set([boat.x, boat.heave ?? 0, boat.z, (boat.heading * Math.PI) / 180, boat.pitch ?? 0, boat.roll ?? 0, (boat.length ?? length) / length, 0, 0, 0,
        shipContinuumOrders({ important, damagedSlot, identity }), 0]);
      device.queue.writeBuffer(instances, 0, record);
    },
    // Her cut, in the frame's compute pass; when she is not shown her lists stay empty.
    encode(pass, shown) { drawn = Boolean(shown); cut.encode(pass, drawn ? 1 : 0); },
    get damaged() { return damagedSlot >= 0; },
    // The scene pass: a whole vessel's clusters, far body and splat, opaque, each keeping its own samples.
    // `groups(pipeline)` gives her own resources and lighting at groups 0 and 1 for a program.
    draw(pass, groups) {
      if (!drawn || damagedSlot >= 0) return;
      for (const [index, pipeline, data] of [[0, programs.clusters, scene.clusters], [1, programs.far, scene.far], [2, programs.splat, scene.splat]]) {
        pass.setPipeline(pipeline);
        const [own, lighting] = groups(pipeline);
        pass.setBindGroup(0, own); pass.setBindGroup(1, lighting); pass.setBindGroup(VESSEL_CONTINUUM_GROUP, data);
        cut.draw(pass, index);
      }
    },
    // A damaged vessel: her surviving depth, then her shade where it is equal, both from her damaged list. `groups()`
    // gives her own resources for each ({ surviving, shade }), the shade's lighting and the depth's empty group 1.
    drawDamaged(pass, damagedPrograms, groups) {
      if (!drawn || damagedSlot < 0 || !damagedPrograms) return;
      damagedData ??= { surviving: dataGroup(damagedPrograms.surviving, VESSEL_CONTINUUM_GROUP), shade: dataGroup(damagedPrograms.shade, VESSEL_CONTINUUM_GROUP) };
      const own = groups();
      pass.setPipeline(damagedPrograms.surviving); pass.setBindGroup(0, own.surviving); pass.setBindGroup(1, own.empty); pass.setBindGroup(VESSEL_CONTINUUM_GROUP, damagedData.surviving);
      cut.draw(pass, cut.damagedList(damagedSlot));
      pass.setPipeline(damagedPrograms.shade); pass.setBindGroup(0, own.shade); pass.setBindGroup(1, own.lighting); pass.setBindGroup(VESSEL_CONTINUUM_GROUP, damagedData.shade);
      cut.draw(pass, cut.damagedList(damagedSlot));
    },
    // Seen from under (or just over) the water: her far body at the shadow map's step, or a damaged vessel's clusters.
    // `groups(capture)` gives her own resources and lighting at groups 0 and 1 for a capture program.
    drawCapture(pass, above, groups) {
      if (!drawn) return;
      const holed = damagedSlot >= 0, capture = holed ? programs.clusterCapture : programs.farCapture, data = holed ? captureData.clusters : captureData.far;
      if (!capture || !data) return;
      capture.bind(pass, above);
      const [own, lighting] = groups(capture);
      pass.setBindGroup(0, own); pass.setBindGroup(1, lighting); pass.setBindGroup(VESSEL_CONTINUUM_GROUP, data);
      cut.draw(pass, holed ? cut.damagedList(damagedSlot) : SHIP_CONTINUUM_SHADOW_LIST);
    },
    // Her shadow (js/shadows.js createVesselShadows casts through this), into the solid or the canvas map: her far body
    // at the shadow map's step, or near the eye her clusters cut to its texel; a damaged vessel's own clusters.
    // `own(pipeline)` is the shadow's own group 0.
    cast(pass, cloth, own) {
      if (!drawn) return;
      const lists = damagedSlot >= 0 ? [[programs.shadows.clusters, cut.damagedList(damagedSlot)]]
        : [[programs.shadows.far, SHIP_CONTINUUM_SHADOW_LIST], [programs.shadows.clusters, SHIP_CONTINUUM_SHADOW_CLUSTER_LIST]];
      for (const [pipelines, list] of lists) {
        const pipeline = pipelines[cloth ? 1 : 0];
        if (!shadowGroups.has(pipeline)) shadowGroups.set(pipeline, dataGroup(pipeline, VESSEL_SHADOW_CONTINUUM_GROUP));
        pass.setPipeline(pipeline); pass.setBindGroup(0, own(pipeline)); pass.setBindGroup(VESSEL_SHADOW_CONTINUUM_GROUP, shadowGroups.get(pipeline));
        cut.draw(pass, list);
      }
    },
    // What the census reads of the scene pass (js/continuum-census.js).
    continuumDraws: () => cut.continuumDraws(),
    destroy() { cut.destroy(); instances.destroy(); },
  };
}
