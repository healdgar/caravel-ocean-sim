import { ANCHOR_RENDER } from './wgsl/anchor.js';
import { anchorFairlead, anchorRodePoints, anchorEquipment, anchorEyeOffset } from './anchor-state.js';
import { boatRotate } from './boat.js';

// One anchor, a 48-span hemp rode, and one short-lived impact splash. No new
// textures, compute fields, readbacks, per-particle objects, or shadow maps.
export async function createAnchorRenderer({device,frameUBO,transView,skyView,sampler,envCubeView,sunVisBuf,shadows,shader,format,samples,waterOptics=null}) {
  const module=await shader(ANCHOR_RENDER,'anchor and hemp rode');
  const vertices=new Float32Array(4096*8);let cursor=0,solidCount=0,totalCount=0,stowedCache='',shapeScale=1;
  const buffer=device.createBuffer({label:'anchor dynamic geometry',size:vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  const poseBuffer=device.createBuffer({label:'anchor pose',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const pose=new Float32Array(16),axis=[0,0,0];
  const pipes=await Promise.all([false,true].map(transparent=>device.createRenderPipelineAsync({label:transparent?'anchor splash':'anchor and rode',layout:'auto',
    vertex:{module,entryPoint:'vs',buffers:[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]}]},
    fragment:{module,entryPoint:'fs',targets:[{format,...(transparent?{blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}:{})}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:!transparent,depthCompare:'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envCubeView,{buffer:sunVisBuf},{buffer:poseBuffer}];
  const groups=pipes.map(pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))}));
  const shadowGroups=pipes.map(pipe=>shadows.bind(pipe));
  const submerged=waterOptics?await waterOptics.capture({source:ANCHOR_RENDER,pipeline:pipes[0],
    vertex:{buffers:[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]}]},groups:2}):null;
  const submergedGroup=submerged?.bindGroup(resources),submergedShadows=submerged?shadows.bind(submerged.pipeline):null;
  const add=(p,n,kind=0,alpha=1)=>{if(cursor+8>vertices.length)throw new Error('Anchor geometry budget exceeded');vertices.set([p[0],p[1],p[2],n[0],n[1],n[2],kind,alpha],cursor);cursor+=8;};
  const triangle=(a,b,c,kind,alpha=1)=>{
    const u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n)||1;
    for(let i=0;i<3;i++)n[i]/=length;add(a,n,kind,alpha);add(b,n,kind,alpha);add(c,n,kind,alpha);
  };
  const tube=(a,b,radius,kind,sides=6)=>{
    radius*=shapeScale;
    const d=b.map((n,i)=>n-a[i]),length=Math.hypot(...d);if(length<1e-6)return;
    for(let i=0;i<3;i++)d[i]/=length;
    const seed=Math.abs(d[1])>.9?[1,0,0]:[0,1,0];
    const u=[d[1]*seed[2]-d[2]*seed[1],d[2]*seed[0]-d[0]*seed[2],d[0]*seed[1]-d[1]*seed[0]],l=Math.hypot(...u);
    for(let i=0;i<3;i++)u[i]/=l;
    const v=[d[1]*u[2]-d[2]*u[1],d[2]*u[0]-d[0]*u[2],d[0]*u[1]-d[1]*u[0]];
    const point=(p,j)=>p.map((n,i)=>n+radius*(u[i]*Math.cos(j*2*Math.PI/sides)+v[i]*Math.sin(j*2*Math.PI/sides)));
    for(let j=0;j<sides;j++){
      const aa=point(a,j),ab=point(a,j+1),ba=point(b,j),bb=point(b,j+1);
      triangle(aa,ab,ba,kind);triangle(ba,ab,bb,kind);
    }
  };
  return {
    update(state,boat){
      const equipment=anchorEquipment(boat),scale=equipment.renderScale;
      if(state.phase==='stowed'){
        const heading=(boat.heading??0)*Math.PI/180;
        boatRotate(axis,1,0,0,heading,boat.pitch??0,boat.roll??0);pose.set(axis,0);
        boatRotate(axis,0,1,0,heading,boat.pitch??0,boat.roll??0);pose.set(axis,4);
        boatRotate(axis,0,0,1,heading,boat.pitch??0,boat.roll??0);pose.set(axis,8);
        pose.set([boat.x??0,boat.heave??0,boat.z??0,1],12);device.queue.writeBuffer(poseBuffer,0,pose);
        const key=`${boat.modelId??'nina'}/${boat.length}/${boat.beam}/${scale}`;if(stowedCache===key)return;stowedCache=key;
        // The common idle state uploads only its 64-byte transform. Build its
        // iron/fairlead geometry once in hull-local metres, not every frame.
        boat={...boat,x:0,z:0,heave:0,heading:0,pitch:0,roll:0};const p=anchorFairlead(boat);
        state={...state,position:{x:p.x,y:p.y-anchorEyeOffset(boat),z:p.z},splash:null};
      }else{
        stowedCache='';pose.fill(0);device.queue.writeBuffer(poseBuffer,0,pose);
      }
      cursor=0;shapeScale=scale;const angle=(state.phase==='stowed'?(boat.heading??0):(state.worldHeading??0))*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),origin=state.position;
      const point=(x,y,z)=>{
        x*=scale;y*=scale;z*=scale;
        const p=[0,0,0];
        if(state.phase==='stowed')boatRotate(p,x,y,z,angle,boat.pitch??0,boat.roll??0);
        else{p[0]=c*x-s*z;p[1]=y;p[2]=s*x+c*z;}
        return p.map((n,i)=>n+[origin.x,origin.y,origin.z][i]);
      };
      // Stocked wrought-iron anchor: shank, timber stock, curved arms and flukes.
      tube(point(0,-.55,0),point(0,.56,0),.065,0,8);
      tube(point(0,.42,-.77),point(0,.42,.77),.11,1,4);
      for(const side of [-1,1]){
        tube(point(0,-.52,0),point(side*.32,-.61,0),.065,0,6);
        tube(point(side*.32,-.61,0),point(side*.61,-.28,0),.065,0,6);
        const a=point(side*.46,-.43,-.18),b=point(side*.46,-.43,.18),tip=point(side*.67,-.16,0);
        triangle(a,b,tip,0);triangle(point(side*.44,-.46,0),a,tip,0);triangle(b,point(side*.44,-.46,0),tip,0);
      }
      for(let i=0;i<12;i++)tube(point(Math.cos(i*Math.PI/6)*.12,.65+Math.sin(i*Math.PI/6)*.12,0),point(Math.cos((i+1)*Math.PI/6)*.12,.65+Math.sin((i+1)*Math.PI/6)*.12,0),.025,0,4);
      shapeScale=1;
      const rope=anchorRodePoints(state,boat);
      for(let i=0;i<rope.length-1;i++)tube(Object.values(rope[i]),Object.values(rope[i+1]),equipment.rodeRadius,2,5);
      // Fairlead ring makes the rope's attachment readable at close range.
      const p=anchorFairlead(boat);
      for(let i=0;i<10;i++)tube([p.x+Math.cos(i*Math.PI/5)*.10*scale,p.y+Math.sin(i*Math.PI/5)*.10*scale,p.z],
        [p.x+Math.cos((i+1)*Math.PI/5)*.10*scale,p.y+Math.sin((i+1)*Math.PI/5)*.10*scale,p.z],.025*scale,0,4);
      solidCount=cursor/8;
      if(state.splash){
        const age=state.time-state.splash.at;
        if(age>=0&&age<1.6){
          const splash=state.splash,fade=Math.max(0,1-age/1.6),splashScale=Math.sqrt(scale),radius=(.22+age*1.7)*splashScale;
          for(let i=0;i<24;i++){
            const a=i*Math.PI/12,b=(i+1)*Math.PI/12,inner=radius*.85;
            const p0=[splash.x+Math.cos(a)*inner,splash.y+.025,splash.z+Math.sin(a)*inner];
            const p1=[splash.x+Math.cos(b)*inner,splash.y+.025,splash.z+Math.sin(b)*inner];
            const p2=[splash.x+Math.cos(a)*radius,splash.y+.03,splash.z+Math.sin(a)*radius];
            const p3=[splash.x+Math.cos(b)*radius,splash.y+.03,splash.z+Math.sin(b)*radius];
            triangle(p0,p2,p1,3,.48*fade);triangle(p1,p2,p3,3,.48*fade);
          }
          if(age<.75)for(let i=0;i<16;i++){
            const a=i*Math.PI/8,r=(.2+age*(.7+Math.sin(i*7)*.25))*splashScale,height=Math.max(0,age*3.8-age*age*5.5)*splashScale,width=.06*(1-age/.75)*splashScale;
            const x=splash.x+Math.cos(a)*r,z=splash.z+Math.sin(a)*r;
            triangle([x-width,splash.y+.025,z],[x+width,splash.y+.025,z],[x,splash.y+height+.03,z+width],3,.5*fade);
          }
        }
      }
      totalCount=cursor/8;device.queue.writeBuffer(buffer,0,vertices,0,cursor);
    },
    drawSubmerged(pass){
      if(!submerged||!solidCount)return;
      submerged.bind(pass);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedShadows);pass.setVertexBuffer(0,buffer);pass.draw(solidCount);
    },
    draw(pass){
      pass.setVertexBuffer(0,buffer);
      for(let i=0;i<2;i++){
        const count=i?totalCount-solidCount:solidCount;if(!count)continue;
        pass.setPipeline(pipes[i]);pass.setBindGroup(0,groups[i]);pass.setBindGroup(1,shadowGroups[i]);pass.draw(count,1,i?solidCount:0);
      }
    },
    destroy(){buffer.destroy();poseBuffer.destroy();},
  };
}
