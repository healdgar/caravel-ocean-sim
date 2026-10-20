import { ISLAND, decodeIsland, decodeBiome, islandGeometry, islandVegetation, terrainSample, constrainIslandMotion, safeLandfallStart } from './terrain-model.js';
import { TREE_VARIANTS, treeGeometry, selectTreeLods } from './vegetation.js';
import { TERRAIN, TERRAIN_LIGHT } from './wgsl/terrain.js';

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples}){
  const load=async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`Saba terrain unavailable (${response.status})`);return response;};
  const [heightResponse,biomeResponse,albedoResponse]=await Promise.all([load(ISLAND.assets.height),load(ISLAND.assets.biome),load(ISLAND.assets.albedo)]);
  const heights=decodeIsland(await heightResponse.arrayBuffer()),biome=decodeBiome(await biomeResponse.arrayBuffer());
  const mesh=islandGeometry(heights),trees=islandVegetation(heights,biome);
  const buffer=(data,usage,label)=>{
    const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST,label});
    if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;
  };
  const vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices');
  const indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices');
  const uniform=buffer(new Float32Array([ISLAND.x,ISLAND.z,ISLAND.span,1]),GPUBufferUsage.UNIFORM,'land domain');
  const elevation=device.createTexture({label:'island elevation',size:[ISLAND.size,ISLAND.size],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:ISLAND.size*4},[ISLAND.size,ISLAND.size]);
  const lighting=device.createTexture({label:'island sunlight',size:[64,64],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
  const albedoImage=await createImageBitmap(await albedoResponse.blob());
  if(albedoImage.width!==ISLAND.albedoSize||albedoImage.height!==ISLAND.albedoSize)throw new Error('Incomplete Saba imagery seed');
  const albedoMips=1+Math.log2(ISLAND.albedoSize);
  const albedo=device.createTexture({label:'registered island imagery seed',size:[ISLAND.albedoSize,ISLAND.albedoSize],format:'rgba8unorm',mipLevelCount:albedoMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  device.queue.copyExternalImageToTexture({source:albedoImage},{texture:albedo},[ISLAND.albedoSize,ISLAND.albedoSize]);albedoImage.close();
  const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(mipPipe);
  for(let m=1;m<albedoMips;m++){
    cp.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:albedo.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:albedo.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    cp.dispatchWorkgroups(Math.ceil((ISLAND.albedoSize>>m)/8),Math.ceil((ISLAND.albedoSize>>m)/8));
  }
  cp.end();device.queue.submit([enc.finish()]);
  const biomeTexture=device.createTexture({label:'regional vegetation probability',size:[ISLAND.biomeSize,ISLAND.biomeSize],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:ISLAND.biomeSize},[ISLAND.biomeSize,ISLAND.biomeSize]);
  const landSampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',maxAnisotropy:4});
  const module=await shader(TERRAIN,'island terrain');
  const makePipe=(entryPoint,buffers)=>device.createRenderPipelineAsync({label:entryPoint==='vs'?'island':'island trees',layout:'auto',
    vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:'fs',targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const meshLayout={arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]};
  const terrainPipe=await makePipe('vs',[meshLayout]);
  const treePipe=await makePipe('treeVS',[meshLayout,{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'},{shaderLocation:4,offset:16,format:'float32x4'}]}]);
  const treeMeshes=Array.from({length:3},(_,lod)=>Array.from({length:TREE_VARIANTS},(_,variant)=>{
    const data=treeGeometry(variant,lod);return {buffer:buffer(data,GPUBufferUsage.VERTEX,`tree variant ${variant} detail ${lod}`),count:data.length/8};
  }));
  const treeBatches=Array.from({length:3*TREE_VARIANTS},(_,id)=>({
    buffer:buffer(new Float32Array(trees.length),GPUBufferUsage.VERTEX,`tree instances ${id}`),data:[],count:0,
  }));
  const previousLods=new Map();let lastCamera=null;
  function updateTrees(camera){
    if(lastCamera&&Math.hypot(camera.x-lastCamera.x,camera.y-lastCamera.y,camera.z-lastCamera.z)<16)return;
    lastCamera={x:camera.x,y:camera.y,z:camera.z};
    for(const batch of treeBatches){batch.data=[];batch.count=0;}
    for(const tree of selectTreeLods(trees,camera,previousLods)){
      const batch=treeBatches[tree.lod*TREE_VARIANTS+tree.variant];
      batch.data.push(...trees.subarray(tree.id*8,tree.id*8+8));batch.count++;
    }
    for(const batch of treeBatches)if(batch.count)device.queue.writeBuffer(batch.buffer,0,new Float32Array(batch.data));
  }
  const lightPipe=await computePipe(TERRAIN_LIGHT,'island sunlight');
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,albedo.createView()],[8,landSampler],[9,biomeTexture.createView()]];
  const groups=[terrainPipe,treePipe].map(pipe=>bind(pipe,resources));
  const cloudGroups=[terrainPipe,treePipe].map(pipe=>clouds.bindVolume(pipe));
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}]]);
  const cloudLight=clouds.bindVolume(lightPipe,true);
  let tick=0;
  return {
    waterGroup:pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:elevation.createView()}]}),
    triangles:mesh.indices.length/3,trees:trees.length/8,
    height:(x,z)=>terrainSample(heights,x,z),
    safeStart:(view,boat)=>safeLandfallStart(heights,view,boat),
    constrain:(boat,x,z)=>constrainIslandMotion(heights,boat,x,z),
    encode(pass,changed=false){
      if((tick++%8)!==0&&!changed)return;
      pass.setPipeline(lightPipe);pass.setBindGroup(0,lightGroup);pass.setBindGroup(1,cloudLight);pass.dispatchWorkgroups(8,8);
    },
    draw(pass,camera={x:0,y:6,z:0}){
      updateTrees(camera);
      pass.setPipeline(terrainPipe);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,cloudGroups[0]);
      pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
      pass.setPipeline(treePipe);pass.setBindGroup(0,groups[1]);pass.setBindGroup(1,cloudGroups[1]);
      for(let lod=0;lod<3;lod++)for(let variant=0;variant<TREE_VARIANTS;variant++){
        const batch=treeBatches[lod*TREE_VARIANTS+variant],mesh=treeMeshes[lod][variant];if(!batch.count)continue;
        pass.setVertexBuffer(0,mesh.buffer);pass.setVertexBuffer(1,batch.buffer);pass.draw(mesh.count,batch.count);
      }
    },
  };
}
