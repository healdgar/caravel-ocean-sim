import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { CLOUD_DENSITY, CLOUD_LIGHT, CLOUD_FIELD_MIPS, CLOUD_SAMPLE, CLOUD_BINDINGS, CLOUD_CAMERA_RAYS, CLOUD_RESOLVE } from './wgsl/clouds.js';

const CLOUD_FRAME_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
`;

export async function createVolumetricClouds({ device, frameUBO, transView, skyView, sampler, computePipe, fieldSize = [128, 64, 128] }) {
  const U = GPUTextureUsage, B = GPUBufferUsage;
  const [densityPipe, lightPipe, mipPipe, rayPipe, resolvePipe] = await Promise.all([
    computePipe(CLOUD_DENSITY, 'cloud density'),
    computePipe(CLOUD_LIGHT, 'cloud lighting'),
    computePipe(CLOUD_FIELD_MIPS, 'cloud field mips'),
    computePipe(FRAME_WGSL + ATMO_CORE_WGSL + CLOUD_FRAME_BINDINGS + SKY_RENDER_FUNCS + CLOUD_SAMPLE + CLOUD_CAMERA_RAYS, 'cloud rays'),
    computePipe(FRAME_WGSL + CLOUD_BINDINGS + CLOUD_RESOLVE, 'cloud resolve'),
  ]);
  const uniform = device.createBuffer({ label:'cloud frame', size:128, usage:B.UNIFORM | B.COPY_DST });
  const bakeUniform = device.createBuffer({ label:'cloud bake', size:32, usage:B.UNIFORM | B.COPY_DST });
  const data = new Float32Array(32), bake = new Float32Array(8), previous = new Float32Array(19);
  const levels = 4;
  const volume = label => device.createTexture({ label, dimension:'3d', size:fieldSize,
    mipLevelCount:levels, format:'rgba16float', usage:U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
  const density = volume('cloud density field'), lighting = volume('cloud light field');
  const fieldSampler = device.createSampler({ magFilter:'linear', minFilter:'linear', mipmapFilter:'linear',
    addressModeU:'repeat', addressModeV:'clamp-to-edge', addressModeW:'repeat' });
  const view = (texture, mip) => texture.createView({ baseMipLevel:mip, mipLevelCount:1 });
  const group = (pipe, index, entries) => device.createBindGroup({ layout:pipe.getBindGroupLayout(index),
    entries:entries.map(([binding, resource]) => ({binding,resource})) });
  const volumeEntries = [[0,{buffer:uniform}],[1,density.createView()],[2,lighting.createView()],[3,fieldSampler]];
  const bgDensity = group(densityPipe,0,[[0,{buffer:bakeUniform}],[1,view(density,0)]]);
  const bgLight = group(lightPipe,0,[[0,{buffer:bakeUniform}],[1,view(density,0)],[2,fieldSampler],[3,view(lighting,0)]]);
  const bgMips = [];
  for(let m=1;m<levels;m++) bgMips.push(group(mipPipe,0,[[0,view(density,m-1)],[1,view(lighting,m-1)],[2,view(density,m)],[3,view(lighting,m)]]));
  const bgRayVolume = group(rayPipe,1,volumeEntries);
  const bgResolveFrame = group(resolvePipe,1,[[0,{buffer:uniform}]]);
  let width=0,height=0,current=0,valid=false,densityDirty=true,lightDirty=true;
  let raw,colors=[],depths=[],rayGroups=[],resolveGroups=[],skyGroups=[];
  let windX=0,windZ=0,previousWindX=0,previousWindZ=0;
  let lastCoverage=NaN,lastThickness=NaN,lastStorm=NaN,lastBase=NaN,lastDensity=NaN,lastHaze=NaN;
  let sunX=NaN,sunY=NaN,sunZ=NaN,skyPipeline;

  function resize(w,h,quality) {
    const scale=Math.min(Math.max(0.25,Math.min(1,quality)),1280/w,720/h);
    const nw=Math.max(1,Math.ceil(w*scale)),nh=Math.max(1,Math.ceil(h*scale));
    if(nw===width && nh===height)return;
    width=nw;height=nh;valid=false;
    for(const t of [raw,...colors,...depths])t?.destroy();
    const target=(label,format)=>device.createTexture({label,size:[width,height],format,
      usage:U.TEXTURE_BINDING|U.STORAGE_BINDING|U.COPY_SRC});
    raw=target('cloud raw','rgba16float');
    colors=[target('cloud history A','rgba16float'),target('cloud history B','rgba16float')];
    depths=[target('cloud depth A','r32float'),target('cloud depth B','r32float')];
    // Ray depth is already the unfiltered temporal depth. Write its history
    // slot directly; resolve only reads it and the preceding frame's slot.
    rayGroups=[0,1].map(i=>group(rayPipe,0,[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,raw.createView()],[5,depths[i].createView()]]));
    resolveGroups=[0,1].map(i=>group(resolvePipe,0,[[0,{buffer:frameUBO}],[1,raw.createView()],[2,depths[i].createView()],
      [3,colors[1-i].createView()],[4,depths[1-i].createView()],[5,sampler],[6,colors[i].createView()]]));
    if(skyPipeline)skyGroups=colors.map(t=>group(skyPipeline,1,[[4,t.createView()]]));
  }

  function update(frame,settings,dt) {
    resize(frame[36],frame[37],settings.cloudQuality ?? 0.5);
    const coverage=Math.max(0,Math.min(1,settings.clouds));
    const thickness=Math.max(0.5,Math.min(5,settings.cloudDepth ?? 2.2));
    const storm=Math.max(0,Math.min(1,settings.cloudAnvil ?? 0.15));
    const base=Math.max(0.3,Math.min(5,settings.cloudBase ?? 1.5));
    const optical=Math.max(0.1,Math.min(3,settings.cloudDensity ?? 1));
    densityDirty=coverage!==lastCoverage || thickness!==lastThickness || storm!==lastStorm;
    const lightOffset=frame.length>=132&&frame[115]>.5?96:32;
    const sunChanged=frame[lightOffset]!==sunX || frame[lightOffset+1]!==sunY || frame[lightOffset+2]!==sunZ;
    lightDirty=densityDirty || sunChanged || optical!==lastDensity;
    const changed=lightDirty || base!==lastBase || optical!==lastDensity || settings.haze!==lastHaze;
    // Large camera jumps invalidate history; ordinary pitch/roll is reprojected.
    const jump=Math.hypot(frame[16]-previous[16],frame[17]-previous[17],frame[18]-previous[18])>250;
    data.set(previous.subarray(0,16));data[16]=previous[16];data[17]=previous[17];data[18]=previous[18];
    windX-=frame[56]*frame[58]*dt*0.001;windZ-=frame[57]*frame[58]*dt*0.001;
    data[20]=windX;data[21]=windZ;data[22]=previousWindX;data[23]=previousWindZ;
    data[24]=base;data[25]=thickness;data[26]=optical*4.0;data[27]=valid && !changed && !jump ? 1:0;
    data[28]=width;data[29]=height;data[30]=frame[70];data[31]=coverage>0.001?1:0;
    device.queue.writeBuffer(uniform,0,data);
    bake[0]=coverage;bake[1]=thickness;bake[2]=storm;bake[3]=optical;bake[4]=frame[lightOffset];bake[5]=frame[lightOffset+1];bake[6]=frame[lightOffset+2];
    if(lightDirty)device.queue.writeBuffer(bakeUniform,0,bake);
    previous.set(frame.subarray(0,16));previous[16]=frame[16];previous[17]=frame[17];previous[18]=frame[18];
    previousWindX=windX;previousWindZ=windZ;
    lastCoverage=coverage;lastThickness=thickness;lastStorm=storm;lastBase=base;lastDensity=optical;lastHaze=settings.haze;
    sunX=frame[lightOffset];sunY=frame[lightOffset+1];sunZ=frame[lightOffset+2];current=1-current;
    return changed;
  }

  function encode(pass) {
    if(densityDirty){pass.setPipeline(densityPipe);pass.setBindGroup(0,bgDensity);pass.dispatchWorkgroups(...fieldSize.map(n=>Math.ceil(n/4)));}
    if(lightDirty){
      pass.setPipeline(lightPipe);pass.setBindGroup(0,bgLight);pass.dispatchWorkgroups(...fieldSize.map(n=>Math.ceil(n/4)));
      pass.setPipeline(mipPipe);
      for(let m=1;m<levels;m++){pass.setBindGroup(0,bgMips[m-1]);pass.dispatchWorkgroups(...fieldSize.map(n=>Math.ceil(Math.max(1,n>>m)/4)));}
    }
    pass.setPipeline(rayPipe);pass.setBindGroup(0,rayGroups[current]);pass.setBindGroup(1,bgRayVolume);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));
    pass.setPipeline(resolvePipe);pass.setBindGroup(0,resolveGroups[current]);pass.setBindGroup(1,bgResolveFrame);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));
    valid=true;densityDirty=false;lightDirty=false;
  }
  return {
    update,encode,
    bindVolume(pipe,sunOnly=false){return group(pipe,1,sunOnly?volumeEntries.filter(([b])=>b!==2):volumeEntries);},
    setSkyPipeline(pipe){skyPipeline=pipe;if(colors.length)skyGroups=colors.map(t=>group(pipe,1,[[4,t.createView()]]));},
    drawSky(pass){pass.setBindGroup(1,skyGroups[current]);},
    get output(){return colors[current];},
    get density(){return density;},
    get historyValid(){return data[27]===1;},
    destroy(){for(const t of [density,lighting,raw,...colors,...depths])t?.destroy();uniform.destroy();bakeUniform.destroy();},
  };
}
