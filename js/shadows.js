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

// A vessel's shadow: its frame, fitted to her each frame, and its two maps (solid depth; canvas depth and what the
// canvas lets through). What casts into them is her caster's (castWith): the ship continuum's coarse cut of her
// (js/vessel-continuum.js, her canvas by its material's shadow, reading `wetness`), called once a map with `cloth` and
// `own(pipeline)`, this shadow's group 0 for a program that reads her hull, this frame, her surface moisture and its
// lookup (js/wgsl/shadows.js SHADOW_CAST, which the receivers' test casts with).
export function createVesselShadows({device,hullUBO,mesh,meshIndices=null,resolution=2048,wetness=null,targets=null}) {
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
  const groups=new Map();
  const own=pipe=>{
    if(!groups.has(pipe))groups.set(pipe,device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:hullUBO}},{binding:1,resource:{buffer:uniform}},
      {binding:2,resource:{buffer:moisture}},{binding:3,resource:{buffer:lookup}},
    ]}));
    return groups.get(pipe);
  };
  const passes=[0,1].map(i=>({
    label:i?'canvas shadows':'solid shadows',
    colorAttachments:i?[{view:views[2],clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]:[],
    depthStencilAttachment:{view:views[i],depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},
  }));
  let caster=null;
  return {
    uniform,data,
    // What wets her canvas, for a caster that lets light through it (js/vessel-continuum.js).
    wetness:{moisture,lookup},
    castWith(cast){caster=cast;},
    update(hull,sun,enabled){fitVesselShadow(data,hull,sun,parts.bounds,resolution,enabled);device.queue.writeBuffer(uniform,0,data);},
    encode(encoder,profiler,extraSolid,timingPrefix=''){
      if(!data[19])return;
      for(let i=0;i<2;i++){
        passes[i].timestampWrites=profiler?.writes(timingPrefix+(i?'Canvas shadows':'Solid shadows'));
        const pass=encoder.beginRenderPass(passes[i]);
        caster?.(pass,i===1,own);
        if(i===0)extraSolid?.(pass);pass.end();
      }
    },
    bind(pipe){return device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[
      {binding:0,resource:{buffer:uniform}},{binding:1,resource:views[0]},{binding:2,resource:compare},
      {binding:3,resource:views[1]},{binding:4,resource:views[2]},{binding:5,resource:linear},
    ]});},
    destroy(){solid?.destroy();canvas?.destroy();transmission?.destroy();uniform.destroy();for(const b of fallback)b.destroy();},
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
  // The last marks this as the land's map, whose texels are too coarse for a penumbra's blocker search, for receivers
  // that read either kind.
  out.set(sun, 20); out[23] = depth; out[24] = tx; out[25] = ty; out[26] = 1;
  return out;
}

export const LAND_SHADOW_FORMAT = 'depth32float';
export const LAND_SHADOW_RESOLUTION = 2048;
// The land's canvas map packed for its receivers in one storage buffer, row by row (js/wgsl/shadows.js
// LAND_CLOTH_SHADOW): each texel what the canvas there lets through (rgb, unorm8, coverage taken out) and the canvas's
// depth (f32 bits). A buffer, not a texture, so it takes none of a receiver's sixteen sampled textures.
const LAND_CLOTH_PACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var clothDepth:texture_depth_2d;
@group(0) @binding(1) var clothColour:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> clothPacked:array<vec2u>;
@compute @workgroup_size(8,8) fn landClothPack(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(clothDepth);
  if(id.x>=size.x||id.y>=size.y){return;}
  let at=vec2i(id.xy);
  let colour=textureLoad(clothColour,at,0);
  let through=select(vec3f(1.0),clamp(colour.rgb/max(colour.a,0.000001),vec3f(0.0),vec3f(1.0)),colour.a>0.000001);
  clothPacked[id.y*size.x+id.x]=vec2u(pack4x8unorm(vec4f(through,1.0)),bitcast<u32>(textureLoad(clothDepth,at,0)));
}
`;
// The land's shadow: its frame, fitted ahead of the camera each frame, and its maps, as a vessel's are: solid depth,
// and canvas depth with what the canvas lets through. Everything ashore and every vessel of the fleet casts into the
// solid map; their canvas, by its material's shadow (js/wgsl/continuum-cut.js, a material's `canvas`), into the canvas
// map with its colour, half as fine (a sail's shadow is soft, and the map holds only the fleet's canvas). Receivers of
// the land's own group read the solid map and the canvas map packed in one storage buffer (js/wgsl/shadows.js
// LAND_CLOTH_SHADOW); those lit by its set (bind) read it as a vessel's (vesselShadow).
export function createLandShadows(device, resolution = LAND_SHADOW_RESOLUTION) {
  const B = GPUBufferUsage, T = GPUTextureUsage;
  const data = new Float32Array(28);
  let heldRadius = 0, clothHeld = false;
  const uniform = device.createBuffer({ label: 'land shadow frame', size: 112, usage: B.UNIFORM | B.COPY_DST });
  const clothResolution = Math.max(1, resolution >> 1);
  const depth = (label, size) => device.createTexture({ label, size: [size, size], format: LAND_SHADOW_FORMAT, usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
  const solid = depth('land solid shadow', resolution), canvas = depth('land canvas shadow', clothResolution);
  const transmission = device.createTexture({
    label: 'land canvas shadow transmission',
    size: [clothResolution, clothResolution],
    format: 'rgba16float',
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
  });
  const packed = device.createBuffer({ label: 'land canvas shadow packed', size: clothResolution * clothResolution * 8, usage: B.STORAGE });
  const solidView = solid.createView();
  const canvasView = canvas.createView();
  const transmissionView = transmission.createView();
  const compare = device.createSampler({ compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' });
  const linear = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const passDesc = {
    label: 'land solid shadows',
    colorAttachments: [],
    depthStencilAttachment: { view: solidView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  };
  const clothDesc = {
    label: 'land canvas shadows',
    colorAttachments: [{ view: transmissionView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: canvasView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  };
  const pack = device.createComputePipeline({
    label: 'land canvas shadow pack', layout: 'auto',
    compute: { module: device.createShaderModule({ label: 'land canvas shadow pack', code: LAND_CLOTH_PACK_WGSL }), entryPoint: 'landClothPack' },
  });
  const packGroup = device.createBindGroup({
    label: 'land canvas shadow pack', layout: pack.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: canvasView }, { binding: 1, resource: transmissionView }, { binding: 2, resource: { buffer: packed } }],
  });
  const packDesc = { label: 'land canvas shadow pack' };
  const castCloth = (encoder, profiler, drawCloth) => {
    clothDesc.timestampWrites = profiler?.writes('Land canvas shadows');
    const cloth = encoder.beginRenderPass(clothDesc);
    drawCloth?.(cloth);
    cloth.end();
    packDesc.timestampWrites = profiler?.writes('Land canvas shadow pack');
    const work = encoder.beginComputePass(packDesc);
    work.setPipeline(pack); work.setBindGroup(0, packGroup);
    work.dispatchWorkgroups(Math.ceil(clothResolution / 8), Math.ceil(clothResolution / 8));
    work.end();
  };
  // The canvas map cleared and packed once, so a receiver reads no cloth before any is cast.
  {
    const enc = device.createCommandEncoder({ label: 'land shadow init' });
    castCloth(enc, null, null);
    device.queue.submit([enc.finish()]);
  }
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
      [24, { buffer: packed }],
    ],
    // `groundAt(x, z)` gives the ground's height, from which the box takes the relief it must hold.
    update(camera, groundY, sun, radius = 72, enabled = true, groundAt = null) {
      heldRadius = landShadowRadiusStep(radius, heldRadius);
      const [low, high] = groundAt ? landShadowRelief(groundAt, camera, heldRadius) : [groundY, groundY];
      fitLandShadow(data, camera, groundY, sun, resolution, heldRadius, enabled, low, high);
      device.queue.writeBuffer(uniform, 0, data);
    },
    // `drawCasters(pass)` casts into the solid map; `drawCloth(pass)`, given while anything with canvas is shown, casts
    // that canvas into the canvas map. Once none is, the canvas map is cleared once and then left.
    encode(encoder, profiler, drawCasters, drawCloth = null) {
      if (!data[19]) return;
      passDesc.timestampWrites = profiler?.writes('Land shadows');
      const pass = encoder.beginRenderPass(passDesc);
      drawCasters?.(pass);
      pass.end();
      if (!drawCloth && !clothHeld) return;
      castCloth(encoder, profiler, drawCloth);
      clothHeld = Boolean(drawCloth);
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
      packed.destroy();
      uniform.destroy();
    },
  };
}
