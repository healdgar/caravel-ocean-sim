// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {ANCHOR_GPU_RENDER} from './wgsl/anchor.js';
import {anchorFairlead,anchorRodePoints,anchorEquipment,anchorEyeOffset} from './anchor-state.js';
import {boatRotate} from './boat.js';

export const ANCHOR_GPU_RODE_SPANS=48;
export const ANCHOR_GPU_STATE_FLOATS=(4+ANCHOR_GPU_RODE_SPANS+1)*4;

// Asset construction only. Unit iron triangles retain the previous shape;
// tube/splash records are immutable parameters expanded by the vertex shader.
export function createAnchorGPUTemplate(){
  const data=[];
  const add=(p,n,kind)=>data.push(...p,...n,kind,1);
  const tri=(a,b,c,kind)=>{
    const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n)||1;
    for(let i=0;i<3;i++)n[i]/=length;add(a,n,kind);add(b,n,kind);add(c,n,kind);
  };
  const tube=(a,b,r,kind,sides)=>{
    const d=b.map((v,i)=>v-a[i]),length=Math.hypot(...d);for(let i=0;i<3;i++)d[i]/=length;
    const seed=Math.abs(d[1])>.9?[1,0,0]:[0,1,0],u=[d[1]*seed[2]-d[2]*seed[1],d[2]*seed[0]-d[0]*seed[2],d[0]*seed[1]-d[1]*seed[0]],m=Math.hypot(...u);
    for(let i=0;i<3;i++)u[i]/=m;const v=[d[1]*u[2]-d[2]*u[1],d[2]*u[0]-d[0]*u[2],d[0]*u[1]-d[1]*u[0]];
    const point=(p,j)=>p.map((x,i)=>x+r*(u[i]*Math.cos(j*2*Math.PI/sides)+v[i]*Math.sin(j*2*Math.PI/sides)));
    for(let j=0;j<sides;j++){const aa=point(a,j),ab=point(a,j+1),ba=point(b,j),bb=point(b,j+1);tri(aa,ab,ba,kind);tri(ba,ab,bb,kind);}
  };
  tube([0,-.55,0],[0,.56,0],.065,0,8);tube([0,.42,-.77],[0,.42,.77],.11,1,4);
  for(const side of [-1,1]){
    tube([0,-.52,0],[side*.32,-.61,0],.065,0,6);tube([side*.32,-.61,0],[side*.61,-.28,0],.065,0,6);
    const a=[side*.46,-.43,-.18],b=[side*.46,-.43,.18],tip=[side*.67,-.16,0];
    tri(a,b,tip,0);tri([side*.44,-.46,0],a,tip,0);tri(b,[side*.44,-.46,0],tip,0);
  }
  for(let i=0;i<12;i++)tube([Math.cos(i*Math.PI/6)*.12,.65+Math.sin(i*Math.PI/6)*.12,0],
    [Math.cos((i+1)*Math.PI/6)*.12,.65+Math.sin((i+1)*Math.PI/6)*.12,0],.025,0,4);
  const ironCount=data.length/8;
  const templateTube=(segment,sides,kind)=>{
    for(let j=0;j<sides;j++){
      const a=j*Math.PI*2/sides,b=(j+1)*Math.PI*2/sides;
      for(const [endpoint,angle]of [[0,a],[0,b],[1,a],[1,a],[0,b],[1,b]])add([segment,endpoint,angle],[a,0,0],kind);
    }
  };
  for(let i=0;i<ANCHOR_GPU_RODE_SPANS;i++)templateTube(i,5,4);
  for(let i=0;i<10;i++)templateTube(i,4,5);
  const solidCount=data.length/8;
  for(let i=0;i<24;i++)for(let corner=0;corner<6;corner++)add([i,corner,0],[0,0,0],6);
  const ringCount=data.length/8-solidCount;
  for(let i=0;i<16;i++)for(let corner=0;corner<3;corner++)add([i,corner,0],[0,0,0],7);
  return Object.freeze({vertices:new Float32Array(data),ironCount,solidCount,ringCount,totalCount:data.length/8});
}

// Coordinates remain exactly the physical anchor/catenary values. Stowed data
// lives in hull-local metres; the unchanged 64-byte actor pose places it.
export function writeAnchorGPUState(state,boat,target){
  if(!(target instanceof Float32Array)||target.length!==ANCHOR_GPU_STATE_FLOATS)throw Error('Anchor GPU state has wrong shape');
  const equipment=anchorEquipment(boat),stowed=state.phase==='stowed';
  if(stowed){
    boat={...boat,x:0,z:0,heave:0,heading:0,pitch:0,roll:0};const p=anchorFairlead(boat);
    state={...state,position:{x:p.x,y:p.y-anchorEyeOffset(boat),z:p.z},splash:null};
  }
  const fairlead=anchorFairlead(boat),p=state.position,age=state.splash?state.time-state.splash.at:-1;
  const active=!!state.splash&&age>=0&&age<1.6;
  target.set([equipment.renderScale,equipment.rodeRadius,(stowed?0:state.worldHeading??0)*Math.PI/180,Number(stowed),
    p.x,p.y,p.z,age,fairlead.x,fairlead.y,fairlead.z,Number(active),state.splash?.x??0,state.splash?.y??0,state.splash?.z??0,0]);
  const knots=anchorRodePoints(state,boat,ANCHOR_GPU_RODE_SPANS);
  for(let i=0;i<knots.length;i++){const q=knots[i];target.set([q.x,q.y,q.z,0],16+i*4);}
  return active?(age<.75?192:144):0;
}

export async function createAnchorRenderer({device,frameUBO,transView,skyView,sampler,envCubeView,sunVisBuf,shadows,shader,format,samples,waterOptics=null}){
  const module=await shader(ANCHOR_GPU_RENDER,'anchor and hemp rode'),template=createAnchorGPUTemplate();
  const buffer=device.createBuffer({label:'anchor immutable templates',size:template.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(buffer,0,template.vertices);
  const poseBuffer=device.createBuffer({label:'anchor pose',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const stateBuffer=device.createBuffer({label:'anchor compact physical state',size:ANCHOR_GPU_STATE_FLOATS*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  const pose=new Float32Array(16),values=new Float32Array(ANCHOR_GPU_STATE_FLOATS),axis=[0,0,0];let solidCount=0,totalCount=0,stowedCache='';
  const layout=[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]}];
  const pipes=await Promise.all([false,true].map(transparent=>device.createRenderPipelineAsync({label:transparent?'anchor splash':'anchor and rode',layout:'auto',
    vertex:{module,entryPoint:'vs',buffers:layout},fragment:{module,entryPoint:'fs',targets:[{format,...(transparent?{blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}:{})}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:!transparent,depthCompare:'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envCubeView,{buffer:sunVisBuf},{buffer:poseBuffer},{buffer:stateBuffer}];
  const groups=pipes.map(pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))}));
  const shadowGroups=pipes.map(pipe=>shadows.bind(pipe));
  const submerged=waterOptics?await waterOptics.capture({source:ANCHOR_GPU_RENDER,pipeline:pipes[0],vertex:{buffers:layout},groups:2}):null;
  const submergedGroup=submerged?.bindGroup(resources),submergedShadows=submerged?shadows.bind(submerged.pipeline):null;
  return {
    update(state,boat){
      if(state.phase==='stowed'){
        const heading=(boat.heading??0)*Math.PI/180;
        boatRotate(axis,1,0,0,heading,boat.pitch??0,boat.roll??0);pose.set(axis,0);
        boatRotate(axis,0,1,0,heading,boat.pitch??0,boat.roll??0);pose.set(axis,4);
        boatRotate(axis,0,0,1,heading,boat.pitch??0,boat.roll??0);pose.set(axis,8);
        pose.set([boat.x??0,boat.heave??0,boat.z??0,1],12);device.queue.writeBuffer(poseBuffer,0,pose);
        const key=`${boat.modelId??'nina'}/${boat.length}/${boat.beam}/${anchorEquipment(boat).renderScale}`;
        if(stowedCache===key)return;stowedCache=key;
      }else{stowedCache='';pose.fill(0);device.queue.writeBuffer(poseBuffer,0,pose);}
      solidCount=template.solidCount;totalCount=solidCount+writeAnchorGPUState(state,boat,values);
      device.queue.writeBuffer(stateBuffer,0,values);
    },
    drawSubmerged(pass){
      if(!submerged||!solidCount)return;
      submerged.bind(pass);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedShadows);pass.setVertexBuffer(0,buffer);pass.draw(solidCount);
    },
    draw(pass){
      pass.setVertexBuffer(0,buffer);
      for(let i=0;i<2;i++){const count=i?totalCount-solidCount:solidCount;if(!count)continue;pass.setPipeline(pipes[i]);pass.setBindGroup(0,groups[i]);pass.setBindGroup(1,shadowGroups[i]);pass.draw(count,1,i?solidCount:0);}
    },
    destroy(){buffer.destroy();poseBuffer.destroy();stateBuffer.destroy();},
  };
}
