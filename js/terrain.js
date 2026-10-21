import { ISLAND, decodeIsland, decodeBiome, islandGeometry, islandVegetation, terrainSample, constrainIslandMotion, safeLandfallStart } from './terrain-model.js';
import { TREE_VARIANTS, TREE_VERTEX_FLOATS, treeRenderGeometry, selectTreeLods, createForestPatches, visibleForestIds } from './vegetation.js';
import { TERRAIN, TERRAIN_LIGHT } from './wgsl/terrain.js';

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples,waterOptics=null}){
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
  const submergedIndices=mesh.submergedIndices?buffer(mesh.submergedIndices,GPUBufferUsage.INDEX,'submerged island indices'):indices;
  const submergedCount=mesh.submergedIndices?.length??mesh.indices.length;
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
  const leafImage=await createImageBitmap(await (await load('assets/tree-foliage.png')).blob());
  // Preserve the exact source foliage's integrated linear colour when its
  // individual leaves are below the geometric LOD threshold. One authoring
  // image readback at load time; opaque fragments never fetch a leaf texture.
  const leafCanvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(leafImage.width,leafImage.height):Object.assign(document.createElement('canvas'),{width:leafImage.width,height:leafImage.height});
  const leafContext=leafCanvas.getContext('2d',{willReadFrequently:true});leafContext.drawImage(leafImage,0,0);
  const leafPixels=leafContext.getImageData(0,0,leafImage.width,leafImage.height).data,leafRGB=[0,0,0];let leafWeight=0;
  for(let i=0;i<leafPixels.length;i+=4){const alpha=leafPixels[i+3]/255;leafWeight+=alpha;for(let c=0;c<3;c++)leafRGB[c]+=Math.pow(leafPixels[i+c]/255,2.2)*alpha;}
  const leafMean=buffer(new Float32Array([...leafRGB.map(v=>v/Math.max(leafWeight,1)),leafWeight/(leafPixels.length/4)]),GPUBufferUsage.UNIFORM,'source foliage mean colour');
  const leafMips=1+Math.floor(Math.log2(Math.max(leafImage.width,leafImage.height)));
  const leafTexture=device.createTexture({label:'procedural twig and leaf cutouts',size:[leafImage.width,leafImage.height],format:'rgba8unorm',mipLevelCount:leafMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  device.queue.copyExternalImageToTexture({source:leafImage},{texture:leafTexture},[leafImage.width,leafImage.height]);leafImage.close();
  const leafEncoder=device.createCommandEncoder(),leafPass=leafEncoder.beginComputePass();leafPass.setPipeline(mipPipe);
  for(let m=1;m<leafMips;m++){
    leafPass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:leafTexture.createView({baseMipLevel:m-1,mipLevelCount:1})},
      {binding:1,resource:leafTexture.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    leafPass.dispatchWorkgroups(Math.ceil(Math.max(1,leafTexture.width>>m)/8),Math.ceil(Math.max(1,leafTexture.height>>m)/8));
  }
  leafPass.end();device.queue.submit([leafEncoder.finish()]);
  const biomeTexture=device.createTexture({label:'regional vegetation probability',size:[ISLAND.biomeSize,ISLAND.biomeSize],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:ISLAND.biomeSize},[ISLAND.biomeSize,ISLAND.biomeSize]);
  const landSampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',maxAnisotropy:4});
  const module=await shader(TERRAIN,'island terrain');
  const makePipe=(entryPoint,buffers,fragmentEntry='fs')=>device.createRenderPipelineAsync({label:entryPoint==='vs'?'island':fragmentEntry==='leafFS'?'island trees':'island canopy and wood',layout:'auto',
    vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:fragmentEntry,targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:fragmentEntry==='leafFS'&&samples>1}});
  const meshLayout={arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]};
  const terrainPipe=await makePipe('vs',[meshLayout]);
  const treeLayout={arrayStride:TREE_VERTEX_FLOATS*4,attributes:[...meshLayout.attributes,{shaderLocation:5,offset:32,format:'float32x2'}]};
  const treeBuffers=[treeLayout,{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'},{shaderLocation:4,offset:16,format:'float32x4'}]}];
  const opaqueTreePipe=await makePipe('treeVS',treeBuffers,'opaqueFS'),treePipe=await makePipe('treeVS',treeBuffers,'leafFS');
  const treeMeshes=Array.from({length:3},(_,lod)=>Array.from({length:TREE_VARIANTS},(_,variant)=>{
    const data=treeRenderGeometry(variant,lod);let opaqueEnd=0;
    while(opaqueEnd<data.length&&data[opaqueEnd+6]!==2)opaqueEnd+=TREE_VERTEX_FLOATS*3;
    const part=(data,label)=>({buffer:buffer(data,GPUBufferUsage.VERTEX,label),count:data.length/TREE_VERTEX_FLOATS});
    return {opaque:part(data.subarray(0,opaqueEnd),`tree wood/canopy ${variant} detail ${lod}`),
      leaves:part(data.subarray(opaqueEnd),`tree leaves ${variant} detail ${lod}`)};
  }));
  const treeBatches=Array.from({length:3*TREE_VARIANTS},(_,id)=>({
    buffer:null,capacity:0,label:`tree instances ${id}`,data:[],count:0,
  }));
  const previousLods=new Map(),forestPatches=createForestPatches(trees),lodStats={near:0,middle:0,far:0,budgetOverflow:0};let lastCamera=null,lastView=null,lastPixels=null;
  function updateTrees(camera,viewProjection){
    const sameView=(!viewProjection&&!lastView)||(viewProjection&&lastView&&lastView.every((v,i)=>Math.abs(v-viewProjection[i])<.004));
    const pixels=[camera.screenHeight,camera.tanHalfFovY,...(camera.forward??[])];
    const samePixels=lastPixels&&pixels.length===lastPixels.length&&pixels.every((v,i)=>v===lastPixels[i]);
    if(lastCamera&&sameView&&samePixels&&Math.hypot(camera.x-lastCamera.x,camera.y-lastCamera.y,camera.z-lastCamera.z)<1)return;
    lastPixels=pixels;
    lastCamera={x:camera.x,y:camera.y,z:camera.z};lastView=viewProjection?Array.from(viewProjection).slice(0,16):null;
    lodStats.near=0;lodStats.middle=0;lodStats.far=0;lodStats.budgetOverflow=0;
    for(const batch of treeBatches){batch.data=[];batch.count=0;}
    const candidates=visibleForestIds(forestPatches,camera,viewProjection);
    for(const tree of selectTreeLods(trees,camera,previousLods,undefined,candidates)){
      const batch=treeBatches[tree.lod*TREE_VARIANTS+tree.variant];
      batch.data.push(...trees.subarray(tree.id*8,tree.id*8+8));batch.count++;
      lodStats[['far','middle','near'][tree.lod]]++;if(tree.qualityBudgetOverflow)lodStats.budgetOverflow++;
    }
    for(const batch of treeBatches)if(batch.count){
      // Regional plant count bounds residency. Quality budgets must never
      // overflow a fixed 96/512-instance buffer or silently lower detail.
      if(batch.count>batch.capacity){
        batch.buffer?.destroy();batch.capacity=Math.min(trees.length/8,Math.max(batch.count,Math.ceil(batch.capacity*1.5),32));
        batch.buffer=device.createBuffer({size:batch.capacity*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,label:batch.label});
      }
      device.queue.writeBuffer(batch.buffer,0,new Float32Array(batch.data));
    }
  }
  const lightPipe=await computePipe(TERRAIN_LIGHT,'island sunlight');
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,albedo.createView()],[8,landSampler],[9,biomeTexture.createView()],[10,leafTexture.createView()],[11,{buffer:leafMean}]];
  // Opaque entry points have no leaf texture in their reachable call graph.
  // Auto layouts therefore correctly omit that binding instead of retaining a
  // dummy sample that would defeat the mobile opaque/feedback separation.
  const opaqueResources=resources.filter(([binding])=>binding!==10);
  const leafResources=resources.filter(([binding])=>binding!==9&&binding!==11);
  const groups=[bind(terrainPipe,opaqueResources),bind(opaqueTreePipe,opaqueResources),bind(treePipe,leafResources)];
  const cloudGroups=[terrainPipe,opaqueTreePipe,treePipe].map(pipe=>clouds.bindVolume(pipe));
  const submerged=waterOptics?await waterOptics.capture({source:TERRAIN,pipeline:terrainPipe,vertex:{buffers:[meshLayout]},world:'in.world',groups:2}):null;
  const submergedGroup=submerged?.bindGroup(opaqueResources.map(([binding,resource])=>({binding,resource}))),submergedClouds=submerged?clouds.bindVolume(submerged.pipeline):null;
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}]]);
  const cloudLight=clouds.bindVolume(lightPipe,true);
  let tick=0;
  return {
    waterGroup:pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:elevation.createView()}]}),
    triangles:mesh.indices.length/3,trees:trees.length/8,forestPatches:forestPatches.length,
    farTreeTriangles:treeMeshes[0].map(mesh=>mesh.opaque.count/3),
    lodStats,
    height:(x,z)=>terrainSample(heights,x,z),
    safeStart:(view,boat)=>safeLandfallStart(heights,view,boat),
    constrain:(boat,x,z)=>constrainIslandMotion(heights,boat,x,z),
    encode(pass,changed=false){
      if((tick++%8)!==0&&!changed)return;
      pass.setPipeline(lightPipe);pass.setBindGroup(0,lightGroup);pass.setBindGroup(1,cloudLight);pass.dispatchWorkgroups(8,8);
    },
    drawSubmerged(pass){
      if(!submerged||!submergedCount)return;
      submerged.bind(pass);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedClouds);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(submergedIndices,'uint32');pass.drawIndexed(submergedCount);
    },
    draw(pass,camera={x:0,y:6,z:0},viewProjection=null){
      updateTrees(camera,viewProjection);
      pass.setPipeline(terrainPipe);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,cloudGroups[0]);
      pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
      // Draw solid crowns/wood before cutout leaves for Apple hidden-surface
      // removal. The far tier has no alpha foliage or expensive bark fallback.
      for(const[pipe,groupIndex,part]of[[opaqueTreePipe,1,'opaque'],[treePipe,2,'leaves']]){
        pass.setPipeline(pipe);pass.setBindGroup(0,groups[groupIndex]);pass.setBindGroup(1,cloudGroups[groupIndex]);
        for(let lod=0;lod<3;lod++)for(let variant=0;variant<TREE_VARIANTS;variant++){
          const batch=treeBatches[lod*TREE_VARIANTS+variant],mesh=treeMeshes[lod][variant][part];if(!batch.count||!mesh.count)continue;
          pass.setVertexBuffer(0,mesh.buffer);pass.setVertexBuffer(1,batch.buffer);pass.draw(mesh.count,batch.count);
        }
      }
    },
  };
}
