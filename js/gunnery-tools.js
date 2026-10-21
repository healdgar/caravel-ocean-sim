// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { ANCHOR_RENDER } from './wgsl/anchor.js';
import { SHADOW_FRAME, SHADOW_SAMPLE, SCENE_SHADOW_SAMPLE } from './wgsl/shadows.js';
import { crewGunneryTool } from './crew-work.js';
import { boatRotate } from './boat.js';

// Crew receives this vessel's shadow layer, while the anchor uses the fleet.
// Replace the exact shared snippet, which remains stable in flattened builds.
export const GUNNERY_TOOL_RENDER=ANCHOR_RENDER.replace(SCENE_SHADOW_SAMPLE,SHADOW_SAMPLE);

export const GUNNERY_TOOL_SHADOW=SHADOW_FRAME+/* wgsl */`
struct GunneryToolPose {right:vec4f,up:vec4f,aft:vec4f,origin:vec4f};
@group(0) @binding(0) var<uniform> S:ShadowFrame;
@group(0) @binding(1) var<uniform> P:GunneryToolPose;
@vertex fn vs(@location(0) position:vec3f)->@builtin(position) vec4f {
  return S.lightView*vec4f(P.right.xyz*position.x+P.up.xyz*position.y+P.aft.xyz*position.z,1);
}
`;

export function buildGunneryToolVertices(company,boat,vertices){
  let cursor=0;
  const put=(point,normal,kind)=>{if(cursor+8>vertices.length)throw Error('Gunnery tools exceed bounded geometry');vertices.set([...point,...normal,kind,1],cursor);cursor+=8;};
  const tube=(a,b,radius,kind,sides=6)=>{
    const direction=b.map((v,i)=>v-a[i]),length=Math.hypot(...direction);if(length<1e-5)return;
    for(let i=0;i<3;i++)direction[i]/=length;
    const seed=Math.abs(direction[1])>.9?[1,0,0]:[0,1,0];
    const u=[direction[1]*seed[2]-direction[2]*seed[1],direction[2]*seed[0]-direction[0]*seed[2],direction[0]*seed[1]-direction[1]*seed[0]],m=Math.hypot(...u);for(let i=0;i<3;i++)u[i]/=m;
    const v=[direction[1]*u[2]-direction[2]*u[1],direction[2]*u[0]-direction[0]*u[2],direction[0]*u[1]-direction[1]*u[0]];
    for(let side=0;side<sides;side++){
      const normal=t=>u.map((x,i)=>x*Math.cos(t)+v[i]*Math.sin(t));
      const n0=normal(side*Math.PI*2/sides),n1=normal((side+1)*Math.PI*2/sides);
      const point=(end,n)=>end.map((x,i)=>x+n[i]*radius),a0=point(a,n0),a1=point(a,n1),b0=point(b,n0),b1=point(b,n1);
      for(const[p,n]of[[a0,n0],[a1,n1],[b0,n0],[b0,n0],[a1,n1],[b1,n1]])put(p,n,kind);
      for(const[p,n]of[[a,direction.map(x=>-x)],[a1,direction.map(x=>-x)],[a0,direction.map(x=>-x)],[b,direction],[b0,direction],[b1,direction]])put(p,n,kind);
    }
  };
  for(const sailor of company.crew){
    const tool=crewGunneryTool(sailor,boat);if(!tool?.a||!tool.b)continue;
    if(tool.kind==='tackle'){tube(tool.a,tool.b,.019,2,5);continue;}
    if(tool.kind==='chamber'){tube(tool.a,tool.b,.055,0,8);continue;}
    tube(tool.a,tool.b,.021,1);
    const d=tool.b.map((x,i)=>x-tool.a[i]),n=Math.hypot(...d),head=tool.b.map((x,i)=>x-d[i]/n*.12);
    tube(head,tool.b,tool.kind==='sponge'?.065:.044,tool.kind==='sponge'?2:1);
  }
  return cursor/8;
}

export async function createGunneryTools({device,frameUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,shader,format,samples,waterOptics,shared=null}){
  const B=GPUBufferUsage,vertices=new Float32Array(4096*8),pose=new Float32Array(16),axis=[0,0,0];let count=0;
  const vertex=device.createBuffer({label:'crew gun tools',size:vertices.byteLength,usage:B.VERTEX|B.COPY_DST});
  const poseBuffer=device.createBuffer({label:'crew gun tool pose',size:64,usage:B.UNIFORM|B.COPY_DST});
  const layout=[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]}];
  const module=shared?null:await shader(GUNNERY_TOOL_RENDER,'gun tools material'),shadowModule=shared?null:await shader(GUNNERY_TOOL_SHADOW,'gun tool shadows');
  const pipeline=shared?.pipeline??await device.createRenderPipelineAsync({label:'crew gun tools',layout:'auto',vertex:{module,entryPoint:'vs',buffers:layout},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const shadowPipeline=shared?.shadowPipeline??await device.createRenderPipelineAsync({label:'crew gun tool shadows',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:layout},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}});
  const resources=[{buffer:frameUBO},transView,skyView,sampClamp,envCubeView,{buffer:sunVisBuf},{buffer:poseBuffer}];
  const bind=(pipe,items)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:items.map((resource,binding)=>({binding,resource}))});
  const group=bind(pipeline,resources),lighting=shadows.bind(pipeline),shadow=bind(shadowPipeline,[{buffer:shadows.uniform},{buffer:poseBuffer}]);
  const submerged=waterOptics?await waterOptics.capture({source:GUNNERY_TOOL_RENDER,pipeline,vertex:{buffers:layout},groups:2}):null;
  const submergedGroup=submerged?.bindGroup(resources),submergedLighting=submerged?shadows.bind(submerged.pipeline):null;
  return {
    assets:{pipeline,shadowPipeline},
    update(company,boat,enabled){
      count=enabled?buildGunneryToolVertices(company,boat,vertices):0;if(!count)return;
      const h=(boat.heading??0)*Math.PI/180;
      for(const[i,vector]of[[0,[1,0,0]],[4,[0,1,0]],[8,[0,0,1]]]){boatRotate(axis,...vector,h,boat.pitch??0,boat.roll??0);pose.set(axis,i);}
      pose.set([boat.x??0,boat.heave??0,boat.z??0,1],12);
      device.queue.writeBuffer(vertex,0,vertices,0,count*8);device.queue.writeBuffer(poseBuffer,0,pose);
    },
    draw(pass){if(!count)return;pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(1,lighting);pass.setVertexBuffer(0,vertex);pass.draw(count);},
    drawShadow(pass){if(!count)return;pass.setPipeline(shadowPipeline);pass.setBindGroup(0,shadow);pass.setVertexBuffer(0,vertex);pass.draw(count);},
    drawSubmerged(pass){if(!count||!submerged)return;submerged.bind(pass);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedLighting);pass.setVertexBuffer(0,vertex);pass.draw(count);},
    destroy(){vertex.destroy();poseBuffer.destroy();},
  };
}
