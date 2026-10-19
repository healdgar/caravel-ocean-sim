import { ISLAND, decodeIsland, islandGeometry, islandVegetation, terrainSample, constrainIslandMotion } from './terrain-model.js';
import { TERRAIN, TERRAIN_LIGHT } from './wgsl/terrain.js';

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples}){
  const response=await fetch('assets/world/saba/height.bin');
  if(!response.ok)throw new Error(`Saba terrain unavailable (${response.status})`);
  const heights=decodeIsland(await response.arrayBuffer());
  const mesh=islandGeometry(heights),trees=islandVegetation(heights);
  const buffer=(data,usage,label)=>{
    const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST,label});
    if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;
  };
  const vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices');
  const indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices');
  const vegetation=buffer(trees,GPUBufferUsage.VERTEX,'island vegetation');
  const uniform=buffer(new Float32Array([ISLAND.x,ISLAND.z,ISLAND.span,1]),GPUBufferUsage.UNIFORM,'land domain');
  const elevation=device.createTexture({label:'island elevation',size:[ISLAND.size,ISLAND.size],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:ISLAND.size*4},[ISLAND.size,ISLAND.size]);
  const lighting=device.createTexture({label:'island sunlight',size:[64,64],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
  const canopyImage=await createImageBitmap(await(await fetch('assets/world/saba/canopy.png')).blob());
  const canopyMips=10;
  const canopy=device.createTexture({label:'canopy material',size:[512,512],format:'rgba8unorm',mipLevelCount:canopyMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  device.queue.copyExternalImageToTexture({source:canopyImage},{texture:canopy},[512,512]);canopyImage.close();
  const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(mipPipe);
  for(let m=1;m<canopyMips;m++){
    cp.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:canopy.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:canopy.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    cp.dispatchWorkgroups(Math.ceil((512>>m)/8),Math.ceil((512>>m)/8));
  }
  cp.end();device.queue.submit([enc.finish()]);
  const canopySampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:4});
  const module=await shader(TERRAIN,'island terrain');
  const makePipe=(entryPoint,buffers)=>device.createRenderPipelineAsync({label:entryPoint==='vs'?'island':'island trees',layout:'auto',
    vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:'fs',targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const terrainPipe=await makePipe('vs',[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]}]);
  const treePipe=await makePipe('treeVS',[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]);
  const lightPipe=await computePipe(TERRAIN_LIGHT,'island sunlight');
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,canopy.createView()],[8,canopySampler]];
  const groups=[terrainPipe,treePipe].map(pipe=>bind(pipe,resources));
  const cloudGroups=[terrainPipe,treePipe].map(pipe=>clouds.bindVolume(pipe));
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}]]);
  const cloudLight=clouds.bindVolume(lightPipe,true);
  let tick=0;
  return {
    waterGroup:pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:elevation.createView()}]}),
    triangles:mesh.indices.length/3,trees:trees.length/8,
    height:(x,z)=>terrainSample(heights,x,z),
    constrain:(boat,x,z)=>constrainIslandMotion(heights,boat,x,z),
    encode(pass,changed=false){
      if((tick++%8)!==0&&!changed)return;
      pass.setPipeline(lightPipe);pass.setBindGroup(0,lightGroup);pass.setBindGroup(1,cloudLight);pass.dispatchWorkgroups(8,8);
    },
    draw(pass){
      pass.setPipeline(terrainPipe);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,cloudGroups[0]);
      pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
      pass.setPipeline(treePipe);pass.setBindGroup(0,groups[1]);pass.setBindGroup(1,cloudGroups[1]);
      pass.setVertexBuffer(0,vegetation);pass.draw(96,trees.length/8);
    },
  };
}
