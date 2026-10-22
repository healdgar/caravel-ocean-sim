import { ISLAND, decodeIsland, decodeBiome, islandGeometry, islandVegetation, terrainSample, terrainSurfaceSample, constrainIslandMotion, safeLandfallStart } from './terrain-model.js';
import { TREE_VARIANTS, TREE_VERTEX_FLOATS, TREE_PIXEL_ERROR, treeRenderGeometry, selectTreeLods, createForestPatches, visibleForestIds,
  GROUND_COVER,createGroundCoverPatches,groundCoverInstances,projectedGroundExtent,groundCoverError,groundCoverVisible,groundCoverGeometry } from './vegetation.js';
import { TERRAIN, TERRAIN_LIGHT } from './wgsl/terrain.js';
import { loadCanopyScenery, excludeCanopyRoots, createCanopyRenderer, canopyInspectionURL } from './canopy-scenery.js';

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples,waterOptics=null,
  canopyMode=typeof location==='undefined'?'auto':new URLSearchParams(location.search).get('canopy')||'auto'}){
  if(!['auto','near','far','off'].includes(canopyMode))throw Error('Unknown canopy scenery mode');
  // createTerrain is itself deferred until landfall; optional stand downloads
  // never run on the open-ocean startup path. Failure retains all old roots.
  let canopyFailure=null;
  const canopyPromise=canopyMode==='off'?Promise.resolve(null):loadCanopyScenery().catch(error=>{canopyFailure=error.message;return null;});
  const load=async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`Saba terrain unavailable (${response.status})`);return response;};
  const [heightResponse,biomeResponse,albedoResponse]=await Promise.all([load(ISLAND.assets.height),load(ISLAND.assets.biome),load(ISLAND.assets.albedo)]);
  const heights=decodeIsland(await heightResponse.arrayBuffer()),biome=decodeBiome(await biomeResponse.arrayBuffer());
  const mesh=islandGeometry(heights),originalTrees=islandVegetation(heights,biome),canopyPack=await canopyPromise;
  const trees=canopyPack?excludeCanopyRoots(originalTrees,canopyPack.manifest):originalTrees;
  const groundSample=(x,z)=>terrainSurfaceSample(heights,x,z),groundPatches=createGroundCoverPatches(ISLAND,groundSample);
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
  const makePipe=(entryPoint,buffers,fragmentEntry='fs')=>device.createRenderPipelineAsync({label:entryPoint==='vs'?'island':entryPoint==='groundVS'?'island ground cover':fragmentEntry==='leafFS'?'island trees':'island canopy and wood',layout:'auto',
    vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:fragmentEntry,targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:fragmentEntry==='leafFS'&&samples>1}});
  const meshLayout={arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]};
  const terrainPipe=await makePipe('vs',[meshLayout]);
  const treeLayout={arrayStride:TREE_VERTEX_FLOATS*4,attributes:[...meshLayout.attributes,{shaderLocation:5,offset:32,format:'float32x2'}]};
  const treeBuffers=[treeLayout,{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'},{shaderLocation:4,offset:16,format:'float32x4'}]}];
  const opaqueTreePipe=await makePipe('treeVS',treeBuffers,'opaqueFS'),treePipe=await makePipe('treeVS',treeBuffers,'leafFS');
  const groundPipe=await makePipe('groundVS',treeBuffers,'groundFS');
  const groundMeshes=Array.from({length:GROUND_COVER.variants},(_,variant)=>{
    const geometry=groundCoverGeometry(variant);return{buffer:buffer(geometry,GPUBufferUsage.VERTEX,`ground cover ${variant}`),count:geometry.length/TREE_VERTEX_FLOATS};
  });
  const groundBatches=groundMeshes.map((_,variant)=>({buffer:null,capacity:0,label:`ground cover instances ${variant}`,data:[],count:0}));
  const groundStats={patches:groundPatches.length,resident:0,rocks:0,grass:0,triangles:0},previousGround=new Set();
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
  const previousLods=new Map(),forestPatches=createForestPatches(trees),lodStats={near:0,middle:0,far:0,budgetOverflow:0};
  let lastCamera=null,lastView=null,lastPixels=null;
  let importedCanopy=null;
  function updateTrees(camera,viewProjection){
    // Its stricter projection bound must not inherit the legacy tree batching
    // cache's one-metre/view tolerance when crossing a three-pixel threshold.
    importedCanopy?.prepare(camera,viewProjection);
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
    for(const batch of groundBatches){batch.data=[];batch.count=0;}
    const groundNow=new Set();groundStats.resident=0;groundStats.rocks=0;groundStats.grass=0;groundStats.triangles=0;
    for(const id of visibleForestIds(groundPatches,camera,viewProjection)){
      const patch=groundPatches[id];
      if(projectedGroundExtent(...patch.centre,GROUND_COVER.maxExtent,camera,patch.radius)<TREE_PIXEL_ERROR*.88)continue;
      const instances=groundCoverInstances(patch,ISLAND,groundSample,biome);groundStats.resident++;
      for(let variant=0;variant<GROUND_COVER.variants;variant++){
        if(variant>=2&&projectedGroundExtent(...patch.centre,3.3,camera,patch.radius)<TREE_PIXEL_ERROR*.88)continue;
        const data=instances[variant],batch=groundBatches[variant];
        for(let i=0;i<data.length;i+=8){
          const key=id+':'+variant+':'+i,error=groundCoverError(data[i],data[i+1],data[i+2],data[i+3],data[i+4],camera);
          // Hysteresis retains small visible props a little longer; an omitted
          // prop never exceeds the three-pixel geometric extent threshold.
          if(!groundCoverVisible(error,previousGround.has(key)))continue;
          groundNow.add(key);batch.data.push(...data.subarray(i,i+8));batch.count++;
        }
      }
    }
    previousGround.clear();for(const key of groundNow)previousGround.add(key);
    for(let variant=0;variant<groundBatches.length;variant++){
      const batch=groundBatches[variant];if(!batch.count)continue;
      if(batch.count>batch.capacity){
        batch.buffer?.destroy();batch.capacity=Math.min(groundPatches.length*(GROUND_COVER.grassPerPatch+GROUND_COVER.rocksPerPatch),Math.max(batch.count,Math.ceil(batch.capacity*1.5),32));
        batch.buffer=device.createBuffer({size:batch.capacity*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,label:batch.label});
      }
      device.queue.writeBuffer(batch.buffer,0,new Float32Array(batch.data));
      groundStats[variant<2?'rocks':'grass']+=batch.count;groundStats.triangles+=batch.count*groundMeshes[variant].count/3;
    }
  }
  const lightPipe=await computePipe(TERRAIN_LIGHT,'island sunlight');
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,albedo.createView()],[8,landSampler],[9,biomeTexture.createView()],[10,leafTexture.createView()],[11,{buffer:leafMean}]];
  if(canopyPack)importedCanopy=await createCanopyRenderer({device,module,resources,clouds,format,samples,pack:canopyPack,mode:canopyMode});
  const canopyStats=importedCanopy?.stats??{loaded:false,mode:canopyMode,error:canopyFailure};
  canopyStats.replacedProceduralTrees=(originalTrees.length-trees.length)/8;
  canopyStats.coverage=canopyPack?.manifest.coverage??null;
  const canopyInspectionLink=canopyPack&&typeof location!=='undefined'?canopyInspectionURL(location.href,canopyPack.manifest):null;
  // Opaque entry points have no leaf texture in their reachable call graph.
  // Auto layouts therefore correctly omit that binding instead of retaining a
  // dummy sample that would defeat the mobile opaque/feedback separation.
  const opaqueResources=resources.filter(([binding])=>binding!==10);
  const leafResources=resources.filter(([binding])=>binding!==9&&binding!==11);
  const groups=[bind(terrainPipe,opaqueResources),bind(opaqueTreePipe,opaqueResources),bind(treePipe,leafResources)];
  const groundGroup=bind(groundPipe,opaqueResources);
  const cloudGroups=[terrainPipe,opaqueTreePipe,treePipe].map(pipe=>clouds.bindVolume(pipe));
  const submerged=waterOptics?await waterOptics.capture({source:TERRAIN,pipeline:terrainPipe,vertex:{buffers:[meshLayout]},world:'in.world',groups:2}):null;
  const submergedGroup=submerged?.bindGroup(opaqueResources.map(([binding,resource])=>({binding,resource}))),submergedClouds=submerged?clouds.bindVolume(submerged.pipeline):null;
  const submergedGround=waterOptics?await waterOptics.capture({source:TERRAIN,pipeline:groundPipe,vertex:{entryPoint:'groundVS',buffers:treeBuffers},entry:'groundFS',world:'in.world',groups:1}):null;
  const submergedGroundGroup=submergedGround?.bindGroup(opaqueResources.map(([binding,resource])=>({binding,resource})));
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}]]);
  const cloudLight=clouds.bindVolume(lightPipe,true);
  let tick=0;
  return {
    waterGroup:pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:elevation.createView()}]}),
    triangles:mesh.indices.length/3,trees:trees.length/8,forestPatches:forestPatches.length,
    farTreeTriangles:treeMeshes[0].map(mesh=>mesh.opaque.count/3),
    lodStats,groundStats,groundTriangles:groundMeshes.map(mesh=>mesh.count/3),canopyStats,canopyInspectionURL:canopyInspectionLink,
    prepare:updateTrees,
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
      if(submergedGround){
        submergedGround.bind(pass);pass.setBindGroup(0,submergedGroundGroup);
        for(let i=0;i<groundBatches.length;i++)if(groundBatches[i].count){
          pass.setVertexBuffer(0,groundMeshes[i].buffer);pass.setVertexBuffer(1,groundBatches[i].buffer);pass.draw(groundMeshes[i].count,groundBatches[i].count);
        }
      }
    },
    draw(pass,camera={x:0,y:6,z:0},viewProjection=null){
      updateTrees(camera,viewProjection);
      pass.setPipeline(terrainPipe);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,cloudGroups[0]);
      pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
      // Opaque ground props have no cutout/depth reconstruction and no cloud
      // ray march per blade. They remain in Apple's opaque visibility path.
      pass.setPipeline(groundPipe);pass.setBindGroup(0,groundGroup);
      for(let i=0;i<groundBatches.length;i++)if(groundBatches[i].count){
        pass.setVertexBuffer(0,groundMeshes[i].buffer);pass.setVertexBuffer(1,groundBatches[i].buffer);pass.draw(groundMeshes[i].count,groundBatches[i].count);
      }
      // Draw solid crowns/wood before cutout leaves for Apple hidden-surface
      // removal. The far tier has no alpha foliage or expensive bark fallback.
      for(const[pipe,groupIndex,part]of[[opaqueTreePipe,1,'opaque'],[treePipe,2,'leaves']]){
        // All imported wood/crowns draw before either family's cutout leaves.
        // Opaque terrain and both solid forest paths retain mobile HSR.
        if(part==='opaque')importedCanopy?.drawOpaque(pass);
        pass.setPipeline(pipe);pass.setBindGroup(0,groups[groupIndex]);pass.setBindGroup(1,cloudGroups[groupIndex]);
        for(let lod=0;lod<3;lod++)for(let variant=0;variant<TREE_VARIANTS;variant++){
          const batch=treeBatches[lod*TREE_VARIANTS+variant],mesh=treeMeshes[lod][variant][part];if(!batch.count||!mesh.count)continue;
          pass.setVertexBuffer(0,mesh.buffer);pass.setVertexBuffer(1,batch.buffer);pass.draw(mesh.count,batch.count);
        }
      }
      importedCanopy?.drawCutout(pass);
    },
  };
}
