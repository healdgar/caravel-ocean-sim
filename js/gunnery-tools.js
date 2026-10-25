// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { ANCHOR_RENDER } from './wgsl/anchor.js';
import { SHADOW_FRAME, SHADOW_SAMPLE, SCENE_SHADOW_SAMPLE } from './wgsl/shadows.js';
import { crewGunneryTool } from './crew-work.js';
import { boatRotate } from './boat.js';

// Crew receives this vessel's shadow layer, while the anchor uses the fleet.
// Replace the exact shared snippet, which remains stable in flattened builds.
export const GUNNERY_TOOL_GPU_GEOMETRY=/* wgsl */`
struct GunneryToolShape {a:vec4f,b:vec4f};
struct GunneryToolVertex {position:vec3f,normal:vec3f,kind:vec2f};
fn gunneryToolVertex(p:vec3f,n:vec3f,index:u32)->GunneryToolVertex {
  let shape=gunneryToolShapes[index];
  let d=normalize(shape.b.xyz-shape.a.xyz);
  let seed=select(vec3f(0,1,0),vec3f(1,0,0),abs(d.y)>.9);
  let u=normalize(cross(d,seed));let v=cross(d,u);
  let point=mix(shape.a.xyz,shape.b.xyz,p.x)+(u*p.y+v*p.z)*shape.a.w;
  let normal=select(u*n.x+v*n.y,d*n.z,abs(n.z)>.5);
  return GunneryToolVertex(point,normal,vec2f(shape.b.w,1));
}
`;
export const GUNNERY_TOOL_RENDER=ANCHOR_RENDER.replace(SCENE_SHADOW_SAMPLE,SHADOW_SAMPLE)
  .replace(/@vertex\s+fn\s+vs\s*\([\s\S]*?\)\s*->\s*AnchorVertex\s*\{/,
    '@vertex fn vs(@location(0) templatePosition:vec3f,@location(1) templateNormal:vec3f,@location(2) templateKind:vec2f,@builtin(instance_index) toolIndex:u32)->AnchorVertex {\nlet tool=gunneryToolVertex(templatePosition,templateNormal,toolIndex);let position=tool.position;let normal=tool.normal;let kind=tool.kind;')
  +GUNNERY_TOOL_GPU_GEOMETRY+'\n@group(0) @binding(7) var<storage,read> gunneryToolShapes:array<GunneryToolShape>;';

export const GUNNERY_TOOL_SHADOW=SHADOW_FRAME+GUNNERY_TOOL_GPU_GEOMETRY+/* wgsl */`
struct GunneryToolPose {right:vec4f,up:vec4f,aft:vec4f,origin:vec4f};
@group(0) @binding(0) var<uniform> S:ShadowFrame;
@group(0) @binding(1) var<uniform> P:GunneryToolPose;
@group(0) @binding(2) var<storage,read> gunneryToolShapes:array<GunneryToolShape>;
@vertex fn vs(@location(0) templatePosition:vec3f,@location(1) templateNormal:vec3f,@builtin(instance_index) toolIndex:u32)->@builtin(position) vec4f {
  let position=gunneryToolVertex(templatePosition,templateNormal,toolIndex).position;
  return S.lightView*vec4f(P.right.xyz*position.x+P.up.xyz*position.y+P.aft.xyz*position.z,1);
}
`;

// Immutable unit tubes. Endpoint/radius/kind records are the only live upload;
// the visible, submerged and shadow vertex stages expand these same records.
export function createGunneryToolTemplate(){
  const values=[],ranges=[];
  const put=(t,c,s,nc,ns,cap)=>values.push(t,c,s,nc,ns,cap,0,1);
  for(const sides of [5,6,8]){
    const first=values.length/8;
    for(let j=0;j<sides;j++){
      const a=j*Math.PI*2/sides,b=(j+1)*Math.PI*2/sides,c=Math.cos(a),s=Math.sin(a),cc=Math.cos(b),ss=Math.sin(b);
      for(const[t,x,y]of[[0,c,s],[0,cc,ss],[1,c,s],[1,c,s],[0,cc,ss],[1,cc,ss]])put(t,x,y,x,y,0);
      for(const[t,x,y,n]of[[0,0,0,-1],[0,cc,ss,-1],[0,c,s,-1],[1,0,0,1],[1,c,s,1],[1,cc,ss,1]])put(t,x,y,0,0,n);
    }
    ranges.push({sides,first,count:values.length/8-first});
  }
  return {vertices:new Float32Array(values),ranges};
}

export function writeGunneryToolInstances(company,boat,target){
  const buckets=[[],[],[]];let vertices=0;
  const tube=(a,b,radius,kind,sides=6)=>{
    if(Math.hypot(...b.map((v,i)=>v-a[i]))<1e-5)return;
    vertices+=sides*12;if(vertices>4096)throw Error('Gunnery tools exceed bounded geometry');
    buckets[sides===5?0:sides===6?1:2].push(...a,radius,...b,kind);
  };
  for(const sailor of company.crew){
    const tool=crewGunneryTool(sailor,boat);if(!tool?.a||!tool.b)continue;
    if(tool.kind==='tackle'){tube(tool.a,tool.b,.019,2,5);continue;}
    if(tool.kind==='chamber'){tube(tool.a,tool.b,.055,0,8);continue;}
    tube(tool.a,tool.b,.021,1);
    const d=tool.b.map((x,i)=>x-tool.a[i]),n=Math.hypot(...d);if(n<1e-5)continue;
    tube(tool.b.map((x,i)=>x-d[i]/n*.12),tool.b,tool.kind==='sponge'?.065:.044,tool.kind==='sponge'?2:1);
  }
  let at=0;const ranges=[];
  for(const bucket of buckets){if(at+bucket.length>target.length)throw Error('Gunnery tool instance budget exceeded');ranges.push({first:at/8,count:bucket.length/8});target.set(bucket,at);at+=bucket.length;}
  return {ranges,count:at/8,vertices};
}

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
  const B=GPUBufferUsage,template=createGunneryToolTemplate(),instances=new Float32Array(68*8),pose=new Float32Array(16),axis=[0,0,0];let count=0,ranges=[];
  const vertex=device.createBuffer({label:'immutable crew gun tool tubes',size:template.vertices.byteLength,usage:B.VERTEX|B.COPY_DST});
  device.queue.writeBuffer(vertex,0,template.vertices);
  const shapeBuffer=device.createBuffer({label:'crew gun tool endpoints',size:instances.byteLength,usage:B.STORAGE|B.COPY_DST});
  const poseBuffer=device.createBuffer({label:'crew gun tool pose',size:64,usage:B.UNIFORM|B.COPY_DST});
  const layout=[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]}];
  const module=shared?null:await shader(GUNNERY_TOOL_RENDER,'gun tools material'),shadowModule=shared?null:await shader(GUNNERY_TOOL_SHADOW,'gun tool shadows');
  const pipeline=shared?.pipeline??await device.createRenderPipelineAsync({label:'crew gun tools',layout:'auto',vertex:{module,entryPoint:'vs',buffers:layout},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const shadowPipeline=shared?.shadowPipeline??await device.createRenderPipelineAsync({label:'crew gun tool shadows',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:layout},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}});
  const resources=[{buffer:frameUBO},transView,skyView,sampClamp,envCubeView,{buffer:sunVisBuf},{buffer:poseBuffer},{buffer:shapeBuffer}];
  const bind=(pipe,items)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:items.map((resource,binding)=>({binding,resource}))});
  const group=bind(pipeline,resources),lighting=shadows.bind(pipeline),shadow=bind(shadowPipeline,[{buffer:shadows.uniform},{buffer:poseBuffer},{buffer:shapeBuffer}]);
  const submerged=waterOptics?await waterOptics.capture({source:GUNNERY_TOOL_RENDER,pipeline,vertex:{buffers:layout},groups:2}):null;
  const submergedGroup=submerged?.bindGroup(resources),submergedLighting=submerged?shadows.bind(submerged.pipeline):null;
  return {
    assets:{pipeline,shadowPipeline},
    update(company,boat,enabled){
      const state=enabled?writeGunneryToolInstances(company,boat,instances):{count:0,ranges:[]};count=state.count;ranges=state.ranges;if(!count)return;
      const h=(boat.heading??0)*Math.PI/180;
      for(const[i,vector]of[[0,[1,0,0]],[4,[0,1,0]],[8,[0,0,1]]]){boatRotate(axis,...vector,h,boat.pitch??0,boat.roll??0);pose.set(axis,i);}
      pose.set([boat.x??0,boat.heave??0,boat.z??0,1],12);
      device.queue.writeBuffer(shapeBuffer,0,instances,0,count*8);device.queue.writeBuffer(poseBuffer,0,pose);
    },
    draw(pass){if(!count)return;pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(1,lighting);pass.setVertexBuffer(0,vertex);for(let i=0;i<ranges.length;i++)if(ranges[i].count)pass.draw(template.ranges[i].count,ranges[i].count,template.ranges[i].first,ranges[i].first);},
    drawShadow(pass){if(!count)return;pass.setPipeline(shadowPipeline);pass.setBindGroup(0,shadow);pass.setVertexBuffer(0,vertex);for(let i=0;i<ranges.length;i++)if(ranges[i].count)pass.draw(template.ranges[i].count,ranges[i].count,template.ranges[i].first,ranges[i].first);},
    drawSubmerged(pass,above=false){if(!count||!submerged)return;submerged.bind(pass,above);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedLighting);pass.setVertexBuffer(0,vertex);for(let i=0;i<ranges.length;i++)if(ranges[i].count)pass.draw(template.ranges[i].count,ranges[i].count,template.ranges[i].first,ranges[i].first);},
    destroy(){vertex.destroy();shapeBuffer.destroy();poseBuffer.destroy();},
  };
}
