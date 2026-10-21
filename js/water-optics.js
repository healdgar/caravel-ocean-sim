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

export function createSubmergedShader(source,entry='fs',world='v.world',surfaceWaves=false){
  // Explicit vessel-material opt-in. Do not guess by material number, rename
  // arbitrary booleans or apply an air/water toggle to unrelated scene shaders.
  const vesselMarker='const vesselWaterCapture=false;';
  if(/\bconst\s+vesselWaterCapture\b/.test(source)){
    if(!source.includes(vesselMarker)||source.indexOf(vesselMarker)!==source.lastIndexOf(vesselMarker))throw new Error('Unrecognized vessel water capture marker');
    source=source.replace(vesselMarker,'const vesselWaterCapture=true;');
  }
  const sharedSurface=/\bfn\s+surfaceWaveAt\s*\(/.test(source);
  if(surfaceWaves&&!sharedSurface)source+=surfaceWaveSource(3,2,3,'captureSeaSampler');
  const air=/\bfn\s+surfaceAir\s*\([^)]*\)\s*->\s*vec3f\s*\{/m.exec(source);
  if(air){
    const start=source.indexOf('{',air.index);
    const argument=/\(\s*(\w+)\s*:/.exec(air[0])[1];
    // Keep the normal path reachable to WGSL reflection, retaining every
    // original resource binding while valid render dimensions bypass air fog.
    source=source.slice(0,start+1)+`if(F.screen.x>=0.0){return ${argument};}`+source.slice(start+1);
  }
  // Terrain already integrates clouds in its normal material path. The ocean
  // must integrate only the air segment before the surface, not that path twice.
  source=source.replace(/let\s+ray\s*=\s*marchCloudsTo\s*\(/,
    'if(F.screen.x>=0.0){return vec4f(col,1.0);}\n  let ray=marchCloudsTo(');
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
  return source+/* wgsl */ `
@group(3) @binding(0) var captureSea:texture_2d_array<f32>;
@group(3) @binding(1) var captureSeaSampler:sampler;
fn captureDisplacement(p:vec2f)->vec3f{
  var d=vec3f(0);
  for(var c=0u;c<${CASCADES}u;c++){
    d+=textureSampleLevel(captureSea,captureSeaSampler,p*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;
  }
  return d;
}
fn captureHeight(p:vec2f)->f32{
  var q=p;
  for(var i=0;i<3;i++){q=p-captureDisplacement(q).xz;}
  return captureDisplacement(q).y${surfaceWaves?'+surfaceWaveAt(p).x':''};
}
${originalSignature}{
  let material=waterCaptureMaterial(${argumentsList});
  let captureWorld=${world};
  if(captureWorld.y>captureHeight(captureWorld.xz)+0.015){discard;}
  let eyeDepth=dot(captureWorld-F.camPos.xyz,F.camFwd.xyz);
  if(eyeDepth<=0.0){discard;}
  return vec4f(material.rgb,eyeDepth);
}
`;
}

export function createWaterOptics({device,shader,seaView,seaSampler,format='rgba16float',surfaceWaves=null}){
  return {
    async capture({source,pipeline,vertex,entry='fs',world='v.world',groups=1}){
      if(groups>3)throw new Error('Water capture reserves bind group 3');
      const captureNeedsWaves=surfaceWaves&&!/\bfn\s+surfaceWaveAt\s*\(/.test(source);
      const module=await shader(createSubmergedShader(source,entry,world,!!surfaceWaves),'submerged material');
      const captured=await device.createRenderPipelineAsync({label:'submerged opaque material',
        layout:'auto',
        vertex:{entryPoint:'vs',...vertex,module},fragment:{module,entryPoint:'submergedFS',targets:[{format}]},
        primitive:{topology:'triangle-list',cullMode:'none'},
        depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:1}});
      const captureGroups=(captureNeedsWaves?surfaceWaves.views:[null]).map(view=>device.createBindGroup({layout:captured.getBindGroupLayout(3),entries:[{binding:0,resource:seaView},{binding:1,resource:seaSampler},
        ...(view?[{binding:2,resource:{buffer:surfaceWaves.uniform}},{binding:3,resource:view}]:[])]}));
      const emptyGroups=Array.from({length:3-groups},(_,i)=>device.createBindGroup({layout:captured.getBindGroupLayout(i+groups),entries:[]}));
      return {pipeline:captured,entry:'submergedFS',bindGroup(resources,index=0){
        const entries=resources.map((resource,binding)=>resource?.resource!==undefined?resource:{binding,resource});
        return device.createBindGroup({layout:captured.getBindGroupLayout(index),entries});
      },bind(pass){
        pass.setPipeline(captured);
        for(let i=groups;i<3;i++)pass.setBindGroup(i,emptyGroups[i-groups]);
        pass.setBindGroup(3,captureGroups[captureNeedsWaves?surfaceWaves.current:0]);
      }};
    },
  };
}
