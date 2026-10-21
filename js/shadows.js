import { SHADOW_CAST } from './wgsl/shadows.js';
import { HULL_VERTICAL_SCALE } from './hull.js';

export function shadowMeshData(mesh,meshIndices=null) {
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],solid=[],canvas=[];
  let sailingRig=false;
  for(let i=0;i<mesh.length;i+=9)for(let axis=0;axis<3;axis++){
    bounds[axis]=Math.min(bounds[axis],mesh[i+axis]);bounds[axis+3]=Math.max(bounds[axis+3],mesh[i+axis]);
  }
  for(let i=0;i<(meshIndices?meshIndices.length:mesh.length/9);i+=3){
    const a=meshIndices?meshIndices[i]:i,b=meshIndices?meshIndices[i+1]:i+1,c=meshIndices?meshIndices[i+2]:i+2;
    const material=Math.floor(mesh[a*9+6]);(material===9 || material===13 ? canvas:solid).push(a,b,c);
    if((material===9 || material===13) && mesh[a*9+6]!==material)sailingRig=true;
  }
  // Rotating yards and the lateen stay inside this conservative swept envelope.
  if(sailingRig){
    bounds[0]=Math.min(bounds[0],-3.8);bounds[3]=Math.max(bounds[3],3.8);
    bounds[2]=Math.min(bounds[2],-7.5);bounds[5]=Math.max(bounds[5],7.5);
  }
  return {bounds,solid:new Uint32Array(solid),canvas:new Uint32Array(canvas)};
}

// Boat-relative coordinates retain precision during long voyages. Fit only the
// caster footprint: water receivers project into it even at very low sun angles.
export function fitVesselShadow(out,hull,sun,bounds,resolution,enabled=true) {
  const [sx,sy,sz]=sun;
  const horizontal=Math.hypot(sx,sz);
  const rx=horizontal>1e-5?sz/horizontal:1,rz=horizontal>1e-5?-sx/horizontal:0;
  const ux=sy*rz,uy=sz*rx-sx*rz,uz=-sy*rx;
  let xmin=Infinity,ymin=Infinity,zmin=Infinity,xmax=-Infinity,ymax=-Infinity,zmax=-Infinity;
  for(let i=0;i<8;i++){
    const x=bounds[(i&1)?3:0]*hull[12]/3.6;
    const y=bounds[(i&2)?4:1]*(hull[3]>0?hull[3]:HULL_VERTICAL_SCALE);const z=bounds[(i&4)?5:2]*hull[13]/12;
    const wx=hull[0]*x+hull[4]*y-hull[8]*z,wy=hull[1]*x+hull[5]*y-hull[9]*z,wz=hull[2]*x+hull[6]*y-hull[10]*z;
    const px=rx*wx+rz*wz,py=ux*wx+uy*wy+uz*wz,pz=-sx*wx-sy*wy-sz*wz;
    xmin=Math.min(xmin,px);xmax=Math.max(xmax,px);ymin=Math.min(ymin,py);ymax=Math.max(ymax,py);zmin=Math.min(zmin,pz);zmax=Math.max(zmax,pz);
  }
  // Margin includes animated canvas, rudder rotation, and the filter footprint.
  const width=Math.ceil((xmax-xmin+2)*4)/4,height=Math.ceil((ymax-ymin+2)*4)/4;
  const tx=width/resolution,ty=height/resolution;
  const cx=Math.round((xmin+xmax)*0.5/tx)*tx,cy=Math.round((ymin+ymax)*0.5/ty)*ty;
  zmin-=2;zmax+=2;const depth=zmax-zmin;
  out.fill(0);out[0]=rx*2/width;out[8]=rz*2/width;out[12]=-cx*2/width;
  out[1]=ux*2/height;out[5]=uy*2/height;out[9]=uz*2/height;out[13]=-cy*2/height;
  out[2]=-sx/depth;out[6]=-sy/depth;out[10]=-sz/depth;out[14]=-zmin/depth;out[15]=1;
  out.set(hull.subarray(16,19),16);out[19]=enabled && sy>0?1:0;
  out.set(sun,20);out[23]=depth;out[24]=tx;out[25]=ty;
  return out;
}

// Array layers share three texture bindings across the whole scene. Each vessel
// renders into its own layer; adding a ship does not exhaust mobile texture slots.
export function createSceneShadows(device,count=2,resolution=2048){
  const T=GPUTextureUsage,B=GPUBufferUsage;
  const textures=['depth32float','depth32float','rgba16float'].map((format,i)=>device.createTexture({label:'fleet shadow '+i,size:[resolution,resolution,count],format,usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}));
  const uniform=device.createBuffer({label:'fleet shadow frames',size:112*count,usage:B.UNIFORM|B.COPY_DST});
  const frames=new Float32Array(28*count),compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'}),linear=device.createSampler({minFilter:'linear',magFilter:'linear'});
  return {resolution,
    layer(index){return {views:textures.map(t=>t.createView({dimension:'2d',baseArrayLayer:index,arrayLayerCount:1}))};},
    update(vessels){for(let i=0;i<count;i++)frames.set(vessels[i].shadows.data,i*28);device.queue.writeBuffer(uniform,0,frames);},
    bind(pipe){return device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[{buffer:uniform},textures[0].createView({dimension:'2d-array'}),compare,textures[1].createView({dimension:'2d-array'}),textures[2].createView({dimension:'2d-array'}),linear].map((resource,binding)=>({binding,resource}))});},
    destroy(){uniform.destroy();for(const t of textures)t.destroy();},
  };
}

export async function createVesselShadows({device,hullUBO,mesh,meshIndices=null,vertexBuffer,shader,resolution=2048,wetness=null,targets=null}) {
  const B=GPUBufferUsage,T=GPUTextureUsage;
  const data=new Float32Array(28),parts=shadowMeshData(mesh,meshIndices);
  const uniform=device.createBuffer({label:'vessel shadow frame',size:112,usage:B.UNIFORM|B.COPY_DST});
  const depth=label=>device.createTexture({label,size:[resolution,resolution],format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
  const solid=targets?null:depth('solid shadow'),canvas=targets?null:depth('canvas shadow');
  const transmission=targets?null:device.createTexture({label:'canvas shadow transmission',size:[resolution,resolution],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
  const views=targets?.views??[solid.createView(),canvas.createView(),transmission.createView()];
  const compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'});
  const linear=device.createSampler({minFilter:'linear',magFilter:'linear'});
  const fallback=wetness?[]:[device.createBuffer({size:8,usage:B.STORAGE}),device.createBuffer({size:mesh.length/9*4,usage:B.STORAGE})];
  const moisture=wetness?.state??fallback[0],lookup=wetness?.lookup??fallback[1];
  const module=await shader(SHADOW_CAST,'vessel shadows');
  const pipes=await Promise.all([false,true].map(cloth=>device.createRenderPipelineAsync({
    label:cloth?'canvas shadows':'solid shadows',layout:'auto',
    vertex:{module,entryPoint:'vs',buffers:[{arrayStride:36,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32'},{shaderLocation:3,offset:28,format:'float32x2'},
    ]}]},
    fragment:{module,entryPoint:cloth?'canvasFS':'solidFS',targets:cloth?[{format:'rgba16float'}]:[]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5},
  })));
  const groups=pipes.map(pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:hullUBO}},{binding:1,resource:{buffer:uniform}},
    {binding:2,resource:{buffer:moisture}},{binding:3,resource:{buffer:lookup}},
  ]}));
  const indices=[parts.solid,parts.canvas].map(values=>{
    const b=device.createBuffer({size:Math.max(4,values.byteLength),usage:B.INDEX|B.COPY_DST});
    device.queue.writeBuffer(b,0,values);return b;
  });
  const passes=[0,1].map(i=>({
    label:i?'canvas shadows':'solid shadows',
    colorAttachments:i?[{view:views[2],clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]:[],
    depthStencilAttachment:{view:views[i],depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},
  }));
  const counts=[parts.solid.length,parts.canvas.length];
  return {
    uniform,data,
    update(hull,sun,enabled){fitVesselShadow(data,hull,sun,parts.bounds,resolution,enabled);device.queue.writeBuffer(uniform,0,data);},
    encode(encoder,profiler,extraSolid,timingPrefix=''){
      if(!data[19])return;
      for(let i=0;i<2;i++){
        passes[i].timestampWrites=profiler?.writes(timingPrefix+(i?'Canvas shadows':'Solid shadows'));
        const pass=encoder.beginRenderPass(passes[i]);pass.setPipeline(pipes[i]);pass.setBindGroup(0,groups[i]);
        pass.setVertexBuffer(0,vertexBuffer);pass.setIndexBuffer(indices[i],'uint32');pass.drawIndexed(counts[i]);
        if(i===0)extraSolid?.(pass);pass.end();
      }
    },
    bind(pipe){return device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[
      {binding:0,resource:{buffer:uniform}},{binding:1,resource:views[0]},{binding:2,resource:compare},
      {binding:3,resource:views[1]},{binding:4,resource:views[2]},{binding:5,resource:linear},
    ]});},
    destroy(){solid?.destroy();canvas?.destroy();transmission?.destroy();uniform.destroy();for(const b of [...indices,...fallback])b.destroy();},
  };
}
