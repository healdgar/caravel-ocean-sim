// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ships the player and her fleet sail, in the one continuum (AGENTS.md rule 3): each body baked by
// scripts/prepare-ship-continuum.mjs, each vessel one scene of one instance cut by the one select and cast by the one
// shadow program (js/continuum-scene.js). Her record is of the RIDER kind (js/wgsl/ship-kinds.js), whose pose data is
// her own posed vertices (js/vessel-pose.js: rig, recoil, parts, shard flight, colours and anchor) with her detail
// layer's lines after them and a header her continuum writes, so what is drawn is what her physics strikes. Her
// material wears her hull's own shading (js/wgsl/caravel.js vesselShade) on her clusters and lines, and lights her far
// body and splat by their own colour; once she is holed, her record carries the DAMAGED flag, the cut draws her
// clusters alone at the finest her error bound allows, and her material's mask keeps no sample of what shot and tearing
// have taken away (her own damage record, group 0 binding 15).
import { requestOnce } from './gpu-program-cache.js';
import { CONTINUUM_KIND, CONTINUUM_IMPORTANT_FLAG, CONTINUUM_DAMAGED, continuumRoom } from './continuum-format.js';
import { requestContinuumPrograms, requestContinuumView, requestContinuumCapture, continuumCaptureDraw, uploadContinuumAtlas, createContinuumScene } from './continuum-scene.js';
import { SHIP_CONTINUUM_MATERIAL, loadShipContinuum, shipContinuumTurn } from './ship-continuum.js';
import { SHIP_RIDER_HEADER } from './wgsl/ship-kinds.js';
import { CANVAS_OPTICS } from './wgsl/vessel.js';
import { vesselShadingWGSL, vesselFarPreludeWGSL } from './wgsl/caravel.js';
import { withNeuralPbrVessel } from './wgsl/neural-pbr.js';
import { VESSEL_COLOURS_MATERIAL } from './wgsl/ship-colours.js';
import { vesselVerticalScale } from './hull.js';

// Group 0: her own resources as her hull program had them (0-14), her damage record (15), the neural material bank
// (16, 17) and her assembly as she now is (18), her scars baked in. Group 1: her shadow's lighting. Group 2: the scene.
const VESSEL_CONTINUUM_ASSEMBLY = 18;
const vesselContinuumShading = [null, null, null];
const vesselContinuumPrelude = (capture, damaged = true) => () => {
  const idx = capture ? 1 : damaged ? 0 : 2;
  return (vesselContinuumShading[idx] ??= (capture ? vesselShadingWGSL(true, damaged) : withNeuralPbrVessel(vesselShadingWGSL(false, damaged)))
    + `@group(0) @binding(${VESSEL_CONTINUUM_ASSEMBLY}) var<storage,read> vesselAssembly:array<f32>;\n`);
};

const vesselContinuumWGSL = (damaged = true, fnName = 'vesselContinuum') => () => /* wgsl */`
fn vesselAir(colour:vec3f,world:vec3f)->vec3f { return continuumAir(colour,world); }
// What a corner hands her fragments. A cluster corner is a vertex of her assembly as she now is (her rest place, normal,
// material, UV and wetness) or a line vertex of her detail layer as her pose pass laid it; her colours' cloth wears the
// colours her pose pass flies. A far-body corner or her splat carries its own colour (sqrt-encoded rgb8).
fn ${fnName}Varying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let data=continuumKindData(s.record);
  let head=continuumPoses[data];
  let scale=max(continuumPoses[data+1u].xyz,vec3f(1e-4));
  var local=s.local/scale;var normalLocal=vec3f(0.0,1.0,0.0);var uv=vec2f(0.5);var wet=vec2f(0.0);var damage=s.wear;var material=0u;
  let word=select(0u,shipRiderWord(s.vertex),s.vertex!=CONTINUUM_NO_VERTEX);
  if(s.what==CONTINUUM_CLUSTER_ENTRY&&(word&SHIP_RIDER_LINE)!=0u){
    let at=u32(head.z)+(word&0x3fffffffu)*3u;
    let r0=continuumPoses[at];let r1=continuumPoses[at+1u];let r2=continuumPoses[at+2u];
    local=r0.xyz;normalLocal=normalize(r1.xyz+vec3f(0.0,1e-6,0.0));uv=vec2f(r0.w,r1.w);
    wet=moisture[wetLookup[u32(max(r2.y,0.0))]];material=u32(max(r2.x,0.0));damage=0.0;
  }else if(s.what==CONTINUUM_CLUSTER_ENTRY){
    let o=word*9u;
    local=vec3f(vesselAssembly[o],vesselAssembly[o+1u],vesselAssembly[o+2u]);
    let n=vec3f(vesselAssembly[o+3u],vesselAssembly[o+4u],vesselAssembly[o+5u]);
    normalLocal=normalize(n+vec3f(0.0,1e-6,0.0));
    uv=vec2f(vesselAssembly[o+7u],vesselAssembly[o+8u]);
    wet=moisture[wetLookup[word]];
    material=u32(max(vesselAssembly[o+6u],0.0));
    damage=max(damage,shipDamageOf(n));
    let colours=continuumPoses[u32(head.x)+word*u32(head.y)].w;
    if(colours>0.5){material=${VESSEL_COLOURS_MATERIAL}u+u32(round(colours));}
  }
  (*v).local=local;(*v).normalLocal=normalLocal;(*v).uv=uv;(*v).wet=wet;(*v).damage=damage;(*v).material=material;
  let colourWord=select(continuumType(s.model,${SHIP_CONTINUUM_MATERIAL.splat}u),s.word,s.what==CONTINUUM_FAR_ENTRY);
  let colour=unpack4x8unorm(colourWord).rgb;
  (*v).colour=colour*colour;
}
fn vesselContinuumBoat(v:ContinuumVarying)->BoatVertex {
  var b:BoatVertex;
  b.pos=v.position;b.world=v.world;b.normal=v.normal;b.local=v.local;b.material=v.material;
  b.normalLocal=v.normalLocal;b.uv=v.uv;b.wet=v.wet;b.damage=v.damage;
  return b;
}
// Her far body and splat, lit by their own colour as her timber is lit. A splat faces the eye however it is wound.
// Her coarse far body already carries baked directional occlusion and backlit sail transmission in v.optics; do not
// self-shadow it against its own voxelized solidShadow map (matching trade-vessels.js tvFarShade).
fn vesselContinuumFarShade(v:ContinuumVarying,front:bool)->vec4f {
  let n=normalize(v.normal)*select(select(-1.0,1.0,front),1.0,v.coverage.x==CONTINUUM_SPLAT_ENTRY);
  let toSun=normalize(F.sunDir.xyz);
  let eye=normalize(continuumEye()-v.world);
  // The sun and sky her optical moments say reach what is seen of her: her canvas lets some through.
  let reach=continuumOpticLight(n,toSun,v.optics);
  let sunLight=sunIlluminance()*sunVis[0]*step(0.0,toSun.y);
  let lit=max(dot(n,toSun),0.0)*reach.x+reach.y;
  let skyLight=skyAtmo(normalize(vec3f(n.x*0.35,max(n.y,0.14),n.z*0.35)))*reach.z;
  let seaLight=(skyAtmo(vec3f(0.0,0.25,0.0))*0.45+F.waterCol.rgb*0.65)*reach.z;
  let f0=vec3f(0.04);
  var col=v.colour*vesselAmbient(n,skyLight,seaLight)*0.82+(v.colour/PI)*sunLight*lit+vesselSpecular(n,eye,toSun,0.86,f0)*sunLight*max(dot(n,toSun),0.0)*reach.x;
  col+=lunarSurface(n,eye,v.colour,0.86,f0,vec3f(sunVis[1]));
  if(F.screen.x< -1.0){col+=vesselShadow(v.world,n);}
  return vec4f(continuumAir(col,v.world),1.0);
}
// Both shades in uniform control flow (her timber's takes derivatives), the one drawn chosen. Under water the capture
// keeps her samples by her mask as her view does (js/wgsl/continuum-cut.js), so her holes read from below as above.
fn ${fnName}Shade(v:ContinuumVarying,front:bool)->vec4f {
  let near=vesselShade(vesselContinuumBoat(v),front);
  ${damaged ? 'if(v.coverage.x==CONTINUUM_CLUSTER_ENTRY){return near;}\n  return vesselContinuumFarShade(v,front);' : 'if(F.screen.x< -1.0){return near+vec4f(hullDamage.scale.xxx,0.0);}\n  return near;'}
}
${damaged ? `// The samples a holed vessel's clusters keep: none where shot has holed her timber, parted her rope or torn her canvas.
fn ${fnName}Mask(v:ContinuumVarying,front:bool)->u32 {
  let holed=v.coverage.x==CONTINUUM_CLUSTER_ENTRY&&continuumFlagged(continuumRecords[v.coverage.z],CONTINUUM_DAMAGED);
  return select(0xffffffffu,select(0u,0xffffffffu,vesselSurvives(vesselContinuumBoat(v))),holed);
}` : ''}
`;

// Her shadow (js/wgsl/continuum-cut.js, a material's shadow): her canvas apart from the rest, its depth into her canvas
// map with what it lets through of the sun, by its weave, seams and hems and how wet it is (js/wgsl/vessel.js
// CANVAS_OPTICS), and all else into her solid map. Her canvas is told by her assembly's material, which her atlas
// vertex's word is (js/wgsl/ship-kinds.js); her lines and her far body cast solid. Her surface moisture and its lookup
// are its group 2 (js/shadows.js createVesselShadows wetness).
const VESSEL_CONTINUUM_SHADOW = Object.freeze({
  prelude: () => CANVAS_OPTICS + `@group(2) @binding(0) var<storage,read> vesselShadowMoisture:array<vec2f>;
@group(2) @binding(1) var<storage,read> vesselShadowWet:array<u32>;
`,
  own: true, canvas: true,
  varyings: [['uv', 'vec2f'], ['wet', 'f32'], ['material', 'u32', true]],
  wgsl: () => /* wgsl */`
fn vesselContinuumShadowVarying(s:ContinuumSurface,v:ptr<function,ContinuumShadowVarying>) {
  (*v).uv=vec2f(0.5);(*v).wet=0.0;(*v).material=0u;
  if(s.what!=CONTINUUM_CLUSTER_ENTRY){
    if(s.what==CONTINUUM_FAR_ENTRY&&(s.word>>24u)==1u){(*v).material=9u;}
    return;
  }
  let word=shipRiderWord(s.vertex);
  if((word&SHIP_RIDER_LINE)!=0u){return;}
  (*v).material=u32(max(bitcast<f32>(s.word),0.0));
  (*v).uv=continuumUV(s.vertex);
  (*v).wet=vesselShadowMoisture[vesselShadowWet[word]].x;
}
fn vesselContinuumShadowCanvas(v:ContinuumShadowVarying)->bool { return v.material==9u||v.material==13u; }
fn vesselContinuumShadowTransmit(v:ContinuumShadowVarying)->vec3f {
  return canvasTransmission(canvasThickness(v.uv,v.material)*canvasWetDepth(v.wet),abs(dot(normalize(v.normal),SH.sun.xyz)));
}
`,
});

const vesselContinuumMaterial = (capture, damaged = true) => {
  const fnName = damaged ? 'vesselContinuum' : 'vesselContinuumIntact';
  return Object.freeze({
    name: fnName, prelude: vesselContinuumPrelude(capture, damaged), core: false, data: Object.freeze({ group: 2, binding: 0 }),
    varyings: [['local', 'vec3f'], ['normalLocal', 'vec3f'], ['uv', 'vec2f'], ['wet', 'vec2f'], ['damage', 'f32'], ['colour', 'vec3f'], ['material', 'u32', true]],
    wgsl: vesselContinuumWGSL(damaged, fnName),
    salt: 7,
    // Sails, planking and her lines are open shells, lit from whichever side is seen.
    cullMode: 'none', air: true, capture: true, mask: damaged, visibility: !capture, shadow: capture ? null : (damaged ? VESSEL_CONTINUUM_SHADOW : null),
  });
};
const VESSEL_CONTINUUM_FAR_MATERIAL = Object.freeze({
  name: 'vesselContinuumFar',
  prelude: vesselFarPreludeWGSL,
  core: false,
  data: Object.freeze({ group: 2, binding: 0 }),
  varyings: [['colour', 'vec3f']],
  wgsl: () => /* wgsl */`
fn vesselContinuumFarVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let colourWord=select(continuumType(s.model,${SHIP_CONTINUUM_MATERIAL.splat}u),s.word,s.what==CONTINUUM_FAR_ENTRY);
  let colour=unpack4x8unorm(colourWord).rgb;
  (*v).colour=colour*colour;
}
fn vesselContinuumFarShade(v:ContinuumVarying,front:bool)->vec4f {
  let n=normalize(v.normal)*select(select(-1.0,1.0,front),1.0,v.coverage.x==CONTINUUM_SPLAT_ENTRY);
  let toSun=normalize(F.sunDir.xyz);
  let eye=normalize(continuumEye()-v.world);
  let reach=continuumOpticLight(n,toSun,v.optics);
  let sunLight=sunIlluminance()*sunVis[0]*step(0.0,toSun.y);
  let lit=max(dot(n,toSun),0.0)*reach.x+reach.y;
  let skyLight=skyAtmo(normalize(vec3f(n.x*0.35,max(n.y,0.14),n.z*0.35)))*reach.z;
  let seaLight=(skyAtmo(vec3f(0.0,0.25,0.0))*0.45+F.waterCol.rgb*0.65)*reach.z;
  let f0=vec3f(0.04);
  var col=v.colour*vesselAmbient(n,skyLight,seaLight)*0.82+(v.colour/PI)*sunLight*lit+vesselSpecular(n,eye,toSun,0.86,f0)*sunLight*max(dot(n,toSun),0.0)*reach.x;
  col+=lunarSurface(n,eye,v.colour,0.86,f0,vec3f(sunVis[1]));
  if(F.screen.x< -1.0){col+=vesselShadow(v.world,n);}
  return vec4f(continuumAir(col,v.world),1.0);
}
`,
  salt: 7,
  cullMode: 'none', air: true, capture: false, mask: false, visibility: true, shadow: null,
});

// Her material in the scene (intact cluster fast-path + lean far-body/splat pipeline + damaged variant), and capture.
export const VESSEL_CONTINUUM_MATERIAL = vesselContinuumMaterial(false, true);
export const VESSEL_CONTINUUM_INTACT_MATERIAL = vesselContinuumMaterial(false, false);
export const VESSEL_CONTINUUM_CAPTURE_MATERIAL = vesselContinuumMaterial(true, true);

// The one select and shadow program, her material's intact, far and damaged views and, under water, its capture; once a device.
export function requestVesselContinuumPrograms({ device, shader, format, samples, waterOptics = null }) {
  return requestOnce(device, `vessel continuum ${format} ${samples}`, async () => {
    const [programs, view, viewIntact, viewFar] = await Promise.all([
      requestContinuumPrograms({ device, shader, shadowFormat: 'depth32float' }),
      requestContinuumView({ device, shader, material: VESSEL_CONTINUUM_MATERIAL, format, samples }),
      requestContinuumView({ device, shader, material: VESSEL_CONTINUUM_INTACT_MATERIAL, format, samples }),
      requestContinuumView({ device, shader, material: VESSEL_CONTINUUM_FAR_MATERIAL, format, samples }),
    ]);
    const capture = await requestContinuumCapture(waterOptics, VESSEL_CONTINUUM_CAPTURE_MATERIAL).catch((error) => {
      console.error('Vessel continuum capture:', error);
      return null;
    });
    return { programs, view, viewIntact, viewFar, capture };
  });
}

// Each model's body, once a device: the bake checked against the ship as built here (js/ship-mesh.js), her riders
// renumbered onto her assembly as built.
export function loadVesselContinuumBody(device, asset, { fetchAsset = fetch } = {}) {
  return requestOnce(device, `vessel continuum body ${asset.model.id}`, async () => {
    const { manifest, words } = await loadShipContinuum({ ids: [`player-${asset.model.id}`], sources: [asset], label: `${asset.model.id} continuum`, fetchAsset });
    return { manifest: manifest[0], words, ...uploadContinuumAtlas(device, words, `${asset.model.id} vessel`) };
  });
}

/**
 * One vessel in the continuum: a scene of her one record over her own posed vertices. `pose` is her pose pass
 * (js/vessel-pose.js), `frame` the frame's uniform buffer, `shadows` her own shadow (js/shadows.js createVesselShadows),
 * whose frame her coarse cut is cut to and cast by.
 */
export function createVesselContinuum({ device, programs, body, asset, pose, frame, shadows, identity, samples = 4, label = 'vessel' }) {
  const { runtime } = asset.model, types = body.types;
  if (types.length !== 1 || body.manifest.source.indices !== asset.indices.length) throw Error(`${label} continuum holds another assembly`);
  const { room } = continuumRoom(types, [1]);
  const scene = createContinuumScene({
    device, atlas: body, programs: programs.programs, capacity: 1, room, view: programs.view, poses: pose.buffer,
    frame, shadowUniform: shadows.uniform, samples, label, profile: 'ships',
  });
  // Her RIDER header (js/wgsl/ship-kinds.js): her posed vertices from vec4f 0, two a vertex; her lines after them; and
  // design units to her type's metres, as her hull program scales her (js/wgsl/caravel.js rigVertex), over her record's scale.
  const header = new Float32Array(SHIP_RIDER_HEADER * 4);
  header.set([0, 2, pose.vertexCount * 2, pose.lineVertexCount], 0);
  let sent = '';
  let shown = false;
  const shadowOwn = [{ binding: 0, resource: { buffer: shadows.wetness.moisture } }, { binding: 1, resource: { buffer: shadows.wetness.lookup } }];
  const capture = { draw: null, key: null };
  let intactData = null;
  let farData = null;
  return {
    scene,
    // Her place this frame, from her boat state: where she floats and how she lies, at her scale over the model's; cut
    // finer when she is the player's own or aimed at; her clusters alone, masked by her damage, once she is holed;
    // `reach` how far past her hull her detail reaches (her let-go iron, her mooring lines).
    place(boat, { important = false, damaged = false, reach = 0 } = {}) {
      const scale = (boat.length ?? runtime.length) / runtime.length;
      header.set([(boat.beam ?? runtime.beam) / 3.6 / scale, vesselVerticalScale(boat) / scale, (boat.length ?? runtime.length) / 12 / scale], 4);
      const key = `${header[4]},${header[5]},${header[6]}`;
      if (key !== sent) { sent = key; device.queue.writeBuffer(pose.buffer, pose.headerAt * 16, header); }
      scene.place(0, {
        position: [boat.x ?? 0, boat.heave ?? 0, boat.z ?? 0], scale, turn: shipContinuumTurn(((boat.heading ?? 0) * Math.PI) / 180, boat.pitch ?? 0, boat.roll ?? 0),
        type: 0, kind: CONTINUUM_KIND.RIDER, flags: (important ? CONTINUUM_IMPORTANT_FLAG : 0) | (damaged ? CONTINUUM_DAMAGED : 0),
        pose: pose.headerAt, seed: identity, reach, identity,
      });
      scene.send(0, 1);
    },
    // Her cut, in the frame's compute pass; when she is not shown, nothing of her is listed. Her shadow frame is fitted
    // every frame, so her coarse cut is always made: the water captures it whether or not she casts.
    encode(pass, visible) {
      shown = Boolean(visible);
      scene.setCount(shown ? 1 : 0);
      scene.setShadows(true);
      scene.encode(pass);
    },
    get damaged() { return scene.flagged(0, CONTINUUM_DAMAGED); },
    // The scene pass: her clusters, lines, far body and splat, each keeping its own samples. `groups(pipeline)` gives
    // her own resources and lighting, groups 0 and 1. Intact ships use the lean pureEqual intact pipeline without
    // crater/shatter register overhead; damaged ships switch seamlessly to the masked damaged pipeline.
    draw(pass, groups) {
      if (!shown) return;
      if (!this.damaged && programs.viewIntact?.pipeline && programs.viewFar?.pipeline) {
        scene.drawVisibility(pass);
        const intactPipe = programs.viewIntact.pipeline;
        intactData ??= scene.dataGroup(intactPipe, programs.viewIntact.material);
        const [own, lighting] = groups(intactPipe, false);
        pass.setPipeline(intactPipe);
        pass.setBindGroup(0, own); pass.setBindGroup(1, lighting); pass.setBindGroup(2, intactData);
        for (let index = 0; index < 2; index++) {
          const [at, n] = scene.lists[index];
          pass.setVertexBuffer(0, scene.list, at * 8, n * 8);
          pass.drawIndirect(scene.draws, index * 16);
        }
        const farPipe = programs.viewFar.pipeline;
        farData ??= scene.dataGroup(farPipe, programs.viewFar.material);
        const [farOwn, farLighting] = groups(farPipe, true);
        pass.setPipeline(farPipe);
        pass.setBindGroup(0, farOwn); pass.setBindGroup(1, farLighting); pass.setBindGroup(2, farData);
        for (let index = 2; index < 4; index++) {
          const [at, n] = scene.lists[index];
          pass.setVertexBuffer(0, scene.list, at * 8, n * 8);
          pass.drawIndirect(scene.draws, index * 16);
        }
        return;
      }
      const [own, lighting] = groups(programs.view.pipeline, false);
      scene.draw(pass, own, lighting);
    },
    // Her shadow (js/shadows.js castWith): her coarse cut, all but her canvas into her solid map and her canvas, with
    // what it lets through, into her canvas map.
    cast(pass, cloth) { if (shown) scene.drawShadow(pass, { part: cloth ? 'canvas' : 'solid', own: shadowOwn }); },
    // Seen from under (or just over) the water: her coarse cut. `entries` her group 0's entries for the capture, made
    // anew when `key` changes (a resize).
    drawCapture(pass, above, entries, key) {
      if (!shown || !programs.capture) return;
      if (capture.key !== key || !capture.draw) { capture.key = key; capture.draw = continuumCaptureDraw(programs.capture, entries(), shadows); }
      capture.draw.draw(pass, [scene], above);
    },
    // What the census reads of the scene pass (js/continuum-census.js).
    continuumDraws: () => (shown ? scene.continuumDraws() : []),
    destroy() { scene.destroy(); },
  };
}
