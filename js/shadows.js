import { SHADOW_CAST } from './wgsl/shadows.js';
import { HULL_VERTICAL_SCALE } from './hull.js';
import {POSED_VERTEX_LAYOUT,withPosedVesselVertices} from './vessel-pose.js';

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
  if(!Number.isSafeInteger(count)||count<1||count>9)throw new RangeError('Invalid fleet shadow size');
  const T=GPUTextureUsage,B=GPUBufferUsage;
  const textures=['depth32float','depth32float','rgba16float'].map((format,i)=>device.createTexture({label:'fleet shadow '+i,size:[resolution,resolution,count],format,usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}));
  const uniform=device.createBuffer({label:'fleet shadow frames',size:112*count,usage:B.UNIFORM|B.COPY_DST});
  const frames=new Float32Array(28*count),compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'}),linear=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'});
  return {resolution,
    sources:{uniform:{buffer:uniform},solid:textures[0].createView({dimension:'2d-array'}),compare,canvas:textures[1].createView({dimension:'2d-array'}),filter:textures[2].createView({dimension:'2d-array'}),linear},
    layer(index){return {views:textures.map(t=>t.createView({dimension:'2d',baseArrayLayer:index,arrayLayerCount:1}))};},
    update(vessels){if(vessels.length!==count)throw new Error('Shadow roster changed without rebuilding resources');for(let i=0;i<count;i++)frames.set(vessels[i].shadows.data,i*28);device.queue.writeBuffer(uniform,0,frames);},
    bind(pipe){return device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[{buffer:uniform},textures[0].createView({dimension:'2d-array'}),compare,textures[1].createView({dimension:'2d-array'}),textures[2].createView({dimension:'2d-array'}),linear].map((resource,binding)=>({binding,resource}))});},
    // The sea reads only its baked shadows, which keeps it inside the fragment stage's texture limit.
    bindSea(pipe,seaShadow){return device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:uniform}},{binding:5,resource:linear},{binding:6,resource:seaShadow}]});},
    destroy(){uniform.destroy();for(const t of textures)t.destroy();},
  };
}

export async function createVesselShadows({device,hullUBO,mesh,meshIndices=null,vertexBuffer,shader,resolution=2048,wetness=null,targets=null,posed=null}) {
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
  const module=await shader(posed?withPosedVesselVertices(SHADOW_CAST):SHADOW_CAST,'vessel shadows');
  const vertexBuffers=[{arrayStride:36,attributes:[
    {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    {shaderLocation:2,offset:24,format:'float32'},{shaderLocation:3,offset:28,format:'float32x2'},
  ]},...(posed?[POSED_VERTEX_LAYOUT]:[])];
  const pipes=await Promise.all([false,true].map(cloth=>device.createRenderPipelineAsync({
    label:cloth?'canvas shadows':'solid shadows',layout:'auto',
    vertex:{module,entryPoint:'vs',buffers:vertexBuffers},
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
        pass.setVertexBuffer(0,vertexBuffer);if(posed)pass.setVertexBuffer(1,posed.buffer);pass.setIndexBuffer(indices[i],'uint32');pass.drawIndexed(counts[i]);
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

// Radii the land shadow box may take. Its texels change size only when the box moves from one to the
// next, and the next is held until the need has left it by a margin, so a camera that bobs at a step's
// edge does not flick the whole map between two scales.
export const LAND_SHADOW_RADII = Object.freeze([185, 220, 260, 300, 340]);
export function landShadowRadiusStep(wanted, held = 0) {
  const fit = LAND_SHADOW_RADII.find((radius) => radius >= wanted) ?? LAND_SHADOW_RADII.at(-1);
  return fit > held || wanted < fit * 0.95 ? fit : held;
}
// Where the box sits: ahead of the camera, so more of it lies in view.
function landShadowCentre(camera, radius) {
  const lead = Math.min(115, radius * 0.45);
  return [(camera?.x ?? 0) + (camera?.forward?.[0] ?? 0) * lead, (camera?.z ?? 0) + (camera?.forward?.[2] ?? 0) * lead];
}
// The lowest and highest ground in the box's disc, read at its centre and around two rings.
export function landShadowRelief(groundAt, camera, radius) {
  const [x, z] = landShadowCentre(camera, radius);
  let low = Infinity, high = -Infinity;
  const read = (px, pz) => { const y = groundAt(px, pz); if (Number.isFinite(y)) { low = Math.min(low, y); high = Math.max(high, y); } };
  read(x, z);
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8, reach = radius * (i & 1 ? 0.55 : 1);
    read(x + Math.cos(angle) * reach, z + Math.sin(angle) * reach);
  }
  return low <= high ? [low, high] : [NaN, NaN];
}
// Casters are taken this far above the highest ground in the box: crowns, roofs and masts ashore.
const LAND_SHADOW_CASTER_RISE = 48;
const LAND_SHADOW_HEIGHT_STEP = 16;

// Fits the light's box to a disc of ground ahead of the camera. `low` and `high` are the lowest and
// highest ground in that disc; without them the ground is taken as level. The box is as tall as the
// disc looks from the sun, so a low sun spends its rows on ground and not on empty air, and as deep
// as the relief needs, so no height inside the disc falls out of it. Its centre moves in whole texels
// measured from the world's origin, so the texels stay on the same ground wherever the camera goes.
export function fitLandShadow(out, camera, groundY, sun, resolution = LAND_SHADOW_RESOLUTION, radius = 72, enabled = true, low = groundY, high = groundY) {
  const [sx, sy, sz] = sun;
  const horizontal = Math.hypot(sx, sz);
  const rx = horizontal > 1e-5 ? sz / horizontal : 1;
  const rz = horizontal > 1e-5 ? -sx / horizontal : 0;
  const ux = sy * rz, uy = sz * rx - sx * rz, uz = -sy * rx;
  const [cxWorld, czWorld] = landShadowCentre(camera, radius);
  const cyWorld = Number.isFinite(groundY) ? Math.max(0, groundY) : 0;
  const floor = Math.floor(Math.min(cyWorld, Number.isFinite(low) ? Math.max(0, low) : cyWorld) / LAND_SHADOW_HEIGHT_STEP) * LAND_SHADOW_HEIGHT_STEP - 2;
  const top = Math.ceil((Math.max(cyWorld, Number.isFinite(high) ? high : cyWorld) + LAND_SHADOW_CASTER_RISE) / LAND_SHADOW_HEIGHT_STEP) * LAND_SHADOW_HEIGHT_STEP;
  // The uniform holds positions from a nearby origin, which keeps them exact in 32-bit floats.
  const originX = Math.round(cxWorld / 64) * 64;
  const originY = Math.round(cyWorld / 16) * 16;
  const originZ = Math.round(czWorld / 64) * 64;
  // The disc and its heights as the light sees them: across, up its own rows, and along its rays.
  const up = Math.hypot(ux, uz), along = Math.max(0, uy);
  const width = Math.ceil(radius * 2);
  const rowLow = -radius * up + Math.min(floor * along, top * along), rowHigh = radius * up + Math.max(floor * along, top * along);
  const height = Math.max(Math.ceil(rowHigh - rowLow), 1);
  const tx = width / resolution;
  const ty = height / resolution;
  // Centre in the light's own axes from the world's origin, then to the nearest whole texel.
  const px = Math.round((rx * cxWorld + rz * czWorld) / tx) * tx;
  const py = Math.round((ux * cxWorld + uz * czWorld + (rowLow + rowHigh) / 2) / ty) * ty;
  const cx = px - (rx * originX + rz * originZ);
  const cy = py - (ux * originX + uy * originY + uz * originZ);
  const pz0 = -sx * (cxWorld - originX) + sy * originY - sz * (czWorld - originZ);
  const reach = radius * horizontal + 24;
  const zmin = pz0 - reach - sy * top;
  const zmax = pz0 + reach - sy * floor;
  const depth = zmax - zmin;
  out.fill(0);
  out[0] = (rx * 2) / width; out[8] = (rz * 2) / width; out[12] = (-cx * 2) / width;
  out[1] = (ux * 2) / height; out[5] = (uy * 2) / height; out[9] = (uz * 2) / height; out[13] = (-cy * 2) / height;
  out[2] = -sx / depth; out[6] = -sy / depth; out[10] = -sz / depth; out[14] = -zmin / depth; out[15] = 1;
  out[16] = originX; out[17] = originY; out[18] = originZ;
  out[19] = enabled && sy > 0.01 ? 1 : 0;
  // The last two mark this as the land's map, which holds no cloth, for receivers that read either kind.
  out.set(sun, 20); out[23] = depth; out[24] = tx; out[25] = ty; out[26] = 1;
  return out;
}

export const LAND_SHADOW_FORMAT = 'depth32float';
export const LAND_SHADOW_RESOLUTION = 2048;
export function createLandShadows(device, resolution = LAND_SHADOW_RESOLUTION) {
  const B = GPUBufferUsage, T = GPUTextureUsage;
  const data = new Float32Array(28);
  let heldRadius = 0;
  const uniform = device.createBuffer({ label: 'land shadow frame', size: 112, usage: B.UNIFORM | B.COPY_DST });
  const solid = device.createTexture({
    label: 'land solid shadow',
    size: [resolution, resolution],
    format: LAND_SHADOW_FORMAT,
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
  });
  const canvas = device.createTexture({
    label: 'land dummy canvas shadow',
    size: [1, 1],
    format: LAND_SHADOW_FORMAT,
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
  });
  const transmission = device.createTexture({
    label: 'land dummy shadow transmission',
    size: [1, 1],
    format: 'rgba16float',
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
  });
  const solidView = solid.createView();
  const canvasView = canvas.createView();
  const transmissionView = transmission.createView();
  // Clear dummy 1x1 canvas shadow to 1.0 (unoccluded) and transmission to 0 once at creation.
  {
    const enc = device.createCommandEncoder({ label: 'land shadow init' });
    enc.beginRenderPass({
      colorAttachments: [{ view: transmissionView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: canvasView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    }).end();
    device.queue.submit([enc.finish()]);
  }
  const compare = device.createSampler({ compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' });
  const linear = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const passDesc = {
    label: 'land solid shadows',
    colorAttachments: [],
    depthStencilAttachment: { view: solidView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  };
  return {
    resolution,
    format: LAND_SHADOW_FORMAT,
    uniform,
    data,
    solidView,
    compare,
    terrainResources: [
      [19, { buffer: uniform }],
      [20, solidView],
      [21, compare],
    ],
    // `groundAt(x, z)` gives the ground's height, from which the box takes the relief it must hold.
    update(camera, groundY, sun, radius = 72, enabled = true, groundAt = null) {
      heldRadius = landShadowRadiusStep(radius, heldRadius);
      const [low, high] = groundAt ? landShadowRelief(groundAt, camera, heldRadius) : [groundY, groundY];
      fitLandShadow(data, camera, groundY, sun, resolution, heldRadius, enabled, low, high);
      device.queue.writeBuffer(uniform, 0, data);
    },
    encode(encoder, profiler, drawCasters) {
      if (!data[19]) return;
      passDesc.timestampWrites = profiler?.writes('Land shadows');
      const pass = encoder.beginRenderPass(passDesc);
      drawCasters?.(pass);
      pass.end();
    },
    bind(pipe, groupIndex = 1) {
      return device.createBindGroup({
        layout: pipe.getBindGroupLayout(groupIndex),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: solidView },
          { binding: 2, resource: compare },
          { binding: 3, resource: canvasView },
          { binding: 4, resource: transmissionView },
          { binding: 5, resource: linear },
        ],
      });
    },
    destroy() {
      solid.destroy();
      canvas.destroy();
      transmission.destroy();
      uniform.destroy();
    },
  };
}
