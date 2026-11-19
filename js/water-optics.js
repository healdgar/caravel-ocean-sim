// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import { CASCADES } from './wgsl/common.js';
import {surfaceWaveSource} from './wgsl/surface-coupling.js';

// Capture the real material and posed geometry. Refraction, extinction and air
// perspective are applied once by the water surface, independent of the object.
function opticsMatching(source,start,open,close){
  let depth=0;
  for(let i=start;i<source.length;i++){
    if(source[i]===open)depth++;
    if(source[i]===close&&!--depth)return i;
  }
  throw new Error('Incomplete water capture shader');
}

// `land` marks ground, which is captured up to WATER_CAPTURE_LAND_MARGIN above the surface so a shore seen
// through a wave has ground behind it; everything else stops at the surface.
export const WATER_CAPTURE_LAND_MARGIN=0.45,WATER_CAPTURE_MARGIN=0.08;
export function createSubmergedShader(source,entry='fs',world='v.world',surfaceWaves=false,land=false){
  // Explicit vessel-material opt-in. Do not guess by material number, rename
  // arbitrary booleans or apply an air/water toggle to unrelated scene shaders.
  const vesselMarker='const vesselWaterCapture=false;';
  if(/\bconst\s+vesselWaterCapture\b/.test(source)){
    if(!source.includes(vesselMarker)||source.indexOf(vesselMarker)!==source.lastIndexOf(vesselMarker))throw new Error('Unrecognized vessel water capture marker');
    source=source.replace(vesselMarker,'const vesselWaterCapture=true;');
  }
  const sharedSurface=/\bfn\s+surfaceWaveAt\s*\(/.test(source);
  if(surfaceWaves&&!sharedSurface)source+=surfaceWaveSource(3,2,3,'captureSeaSampler');
  source=withCapturedAir(source);
  const marker=new RegExp(`@fragment\\s+fn\\s+${entry}\\s*\\(`).exec(source);
  if(!marker)throw new Error(`Missing capture fragment ${entry}`);
  const argsStart=source.indexOf('(',marker.index),argsEnd=opticsMatching(source,argsStart,'(',')');
  const bodyStart=source.indexOf('{',argsEnd);
  const parameters=source.slice(argsStart+1,argsEnd);
  const plain=parameters.replace(/@\w+\([^)]*\)\s*/g,'');
  const argumentsList=plain.split(',').map(parameter=>parameter.trim().split(':')[0]).join(',');
  const originalSignature=source.slice(marker.index,bodyStart).replace(new RegExp(`\\b${entry}\\s*\\(`),'submergedFS(');
  const materialSignature=`fn waterCaptureMaterial(${plain})->vec4f `;
  source=source.slice(0,marker.index)+materialSignature+source.slice(bodyStart);
  return WATER_CAPTURE_DIRECTIVE+source+waterCaptureWGSL({fragment:originalSignature,args:argumentsList,world,surfaceWaves,land});
}

// A capture's source whose `surfaceAir` (if it holds one) leaves its colour as it is under water, where the water's
// surface applies the air once. The normal path stays reachable, so WGSL reflection keeps every binding it reads.
export function withCapturedAir(source){
  const air=/\bfn\s+surfaceAir\s*\([^)]*\)\s*->\s*vec3f\s*\{/m.exec(source);
  if(!air)return source;
  const start=source.indexOf('{',air.index);
  const argument=/\(\s*(\w+)\s*:/.exec(air[0])[1];
  return source.slice(0,start+1)+`if(F.screen.x>=0.0&&captureMode.x<.5){return ${argument};}`+source.slice(start+1);
}

// The early exit in a capture's fragment is not uniform control flow. Fragments beside a surviving one stay alive as
// helpers, so the derivatives a surviving fragment reads are those of a whole quad. A capture module begins with this.
export const WATER_CAPTURE_DIRECTIVE='diagnostic(off,derivative_uniformity);\n';
// The capture's own WGSL, after a material that defines `fn waterCaptureMaterial(<args>)->vec4f`: the sea it is cut by
// (group 3), and `fragment` (a whole fragment signature returning @location(0) vec4f), which leaves out whatever lies
// past the surface and shades the rest by that material, called with `args`. `world` is the fragment's world position.
export function waterCaptureWGSL({fragment,args,world,surfaceWaves=false,land=false}){
  const shoreMargin=land?WATER_CAPTURE_LAND_MARGIN:WATER_CAPTURE_MARGIN;
  return /* wgsl */ `
@group(3) @binding(0) var captureSea:texture_2d_array<f32>;
@group(3) @binding(1) var captureSeaSampler:sampler;
@group(3) @binding(4) var<uniform> captureMode:vec4f;
fn captureDisplacement(p:vec2f,footprint:f32)->vec3f{
  var d=vec3f(0);
  let seaSize=f32(textureDimensions(captureSea).x);
  for(var c=0u;c<${CASCADES}u;c++){
    let invL=F.cascInvL[c>>2u][c&3u];
    let texel=max(1.0/(max(invL,1e-4)*max(seaSize,1.0)),1e-4);
    let lod=select(0.0,clamp(log2(max(footprint/texel,1.0))+0.75,0.0,8.0),seaSize>1.5);
    let w=select(1.0,clamp(1.0-smoothstep(1.5,4.0,footprint*invL),0.0,1.0),seaSize>1.5);
    d+=textureSampleLevel(captureSea,captureSeaSampler,p*invL,i32(c),lod).xyz*w;
  }
  return d;
}
fn captureHeight(p:vec2f,footprint:f32)->f32{
  var q=p;
  for(var i=0;i<3;i++){q=p-captureDisplacement(q,footprint).xz;}
  return captureDisplacement(q,footprint).y${surfaceWaves?'+surfaceWaveAt(p).x':''};
}
${fragment}{
  // Most of a ship is on the wrong side of the surface here. Leave before lighting any of it.
  let captureWorld=${world};
  if(select((captureWorld.y > 14.0), (captureWorld.y < -14.0), (captureMode.x > 0.5))){discard;return vec4f(0);}
  let eyeDist=length(captureWorld-F.camPos.xyz);
  let pxSpan=max(length(F.camRight.xyz)/max(F.screen.x,1.0),length(F.camUp.xyz)/max(F.screen.y,1.0));
  let footprint=2.0*eyeDist*pxSpan*4.0;
  let surfaceY=captureHeight(captureWorld.xz,footprint);
  // How far past the cut this fragment lies, and how far that changes across its pixel quad.
  let past=select(captureWorld.y-surfaceY-${shoreMargin},surfaceY-0.015-captureWorld.y,captureMode.x>.5);
  let quad=2.0*fwidth(past);
  if(past>0.0){
    // Discarded, but a neighbour in the quad may be kept and will difference against this one: shade on as a helper.
    discard;
    if(past>quad){return vec4f(0);}
  }
  let eyeDepth=dot(captureWorld-F.camPos.xyz,F.camFwd.xyz);
  if(eyeDepth<=0.0){discard;return vec4f(0);}
  let material=waterCaptureMaterial(${args});
  let rgbOk=(material.rgb==material.rgb)&((bitcast<vec3u>(material.rgb)&vec3u(0x7fffffffu))<vec3u(0x7f800000u));
  let safeRgb=clamp(select(vec3f(0.0),material.rgb,rgbOk),vec3f(0.0),vec3f(6.0e4));
  let depthOk=(eyeDepth==eyeDepth)&&((bitcast<u32>(eyeDepth)&0x7fffffffu)<0x7f800000u);
  let safeDepth=select(0.0,clamp(eyeDepth,0.0,6.0e4),depthOk);
  return vec4f(safeRgb,safeDepth);
}
`;
}

export function createWaterOptics({device,shader,seaView,seaSampler,format='rgba16float',surfaceWaves=null}){
  // Material pipelines and their scene-only groups are immutable. Vessel
  // resources still receive separate bind groups through bindGroup below.
  const captures=new Map();
  const usage=(globalThis.GPUBufferUsage?.UNIFORM??64)|(globalThis.GPUBufferUsage?.COPY_DST??8);
  const modeBuffers=[0,1].map(above=>{
    const b=device.createBuffer({size:16,usage});
    device.queue.writeBuffer(b,0,new Float32Array([above,0,0,0]));
    return b;
  });
  // One capture pipeline a module, with its groups: `code` the module's whole source, `needsWaves` whether its tail
  // reads the surface's waves (group 3 then binds them too).
  function build({key,vertex,groups,needsWaves,code}){
    if(groups>3)throw new Error('Water capture reserves bind group 3');
    const vertexState={entryPoint:'vs',...vertex};
    // The module is always generated here; a caller-supplied surface pipeline
    // or module does not affect this capture's state.
    delete vertexState.module;
    const id=JSON.stringify([key,vertexState,groups]);
    if(captures.has(id))return captures.get(id);
    const pending=(async()=>{
      const module=await shader(code(),'submerged material');
      const captured=await device.createRenderPipelineAsync({label:'submerged opaque material',
        layout:'auto',
        vertex:{...vertexState,module},fragment:{module,entryPoint:'submergedFS',targets:[{format}]},
        primitive:{topology:'triangle-list',cullMode:'none'},
        depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:1}});
      const makeGroups=modeBuffer=>(needsWaves?surfaceWaves.views:[null]).map(view=>device.createBindGroup({layout:captured.getBindGroupLayout(3),entries:[{binding:0,resource:seaView},{binding:1,resource:seaSampler},
        ...(view?[{binding:2,resource:{buffer:surfaceWaves.uniform}},{binding:3,resource:view}]:[]),{binding:4,resource:{buffer:modeBuffer}}]}));
      const captureGroups=makeGroups(modeBuffers[0]),aboveCaptureGroups=makeGroups(modeBuffers[1]);
      const emptyGroups=Array.from({length:3-groups},(_,i)=>device.createBindGroup({layout:captured.getBindGroupLayout(i+groups),entries:[]}));
      return {pipeline:captured,entry:'submergedFS',bindGroup(resources,index=0){
        const entries=resources.map((resource,binding)=>resource?.resource!==undefined?resource:{binding,resource});
        return device.createBindGroup({layout:captured.getBindGroupLayout(index),entries});
      },bind(pass,above=false){
        pass.setPipeline(captured);
        for(let i=groups;i<3;i++)pass.setBindGroup(i,emptyGroups[i-groups]);
        const set=above?aboveCaptureGroups:captureGroups;
        pass.setBindGroup(3,set[needsWaves?surfaceWaves.current:0]);
      }};
    })();
    captures.set(id,pending);
    pending.catch(()=>{if(captures.get(id)===pending)captures.delete(id);});
    return pending;
  }
  return {
    // The device the captures are made on (js/continuum-scene.js reads how it binds an atlas).
    device,
    // A material's capture, made from its view's source (createSubmergedShader).
    capture({source,pipeline,vertex,entry='fs',world='v.world',groups=1,land=false}){
      return build({key:['rewritten',source,entry,world,land],vertex,groups,needsWaves:!!surfaceWaves&&!/\bfn\s+surfaceWaveAt\s*\(/.test(source),
        code:()=>createSubmergedShader(source,entry,world,!!surfaceWaves,land)});
    },
    // What a module composed as a capture from the first (js/wgsl/continuum-cut.js) begins with, and its tail: the
    // water's own sea, with the surface's waves when the optics carry them, and the fragment that cuts by it.
    captureDirective:WATER_CAPTURE_DIRECTIVE,
    captureTail({fragment,args,world,land=false}){
      return (surfaceWaves?surfaceWaveSource(3,2,3,'captureSeaSampler'):'')+waterCaptureWGSL({fragment,args,world,surfaceWaves:!!surfaceWaves,land});
    },
    // A capture of a module composed whole, its tail from captureTail: nothing in it is rewritten.
    captureComposed({source,vertex,groups=1}){
      return build({key:['composed',source],vertex,groups,needsWaves:!!surfaceWaves,code:()=>source});
    },
  };
}
