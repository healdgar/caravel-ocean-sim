// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Explicit experimental inspection pages, not a native-plant fallback. No GPU
// allocations or frame-loop geometry work. Never fetch source vertex/index data.
const check=(ok,message)=>{if(!ok)throw Error('Forest inspection: '+message);};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const receipt=r=>uint(r?.bytes)&&r.bytes>0&&r.bytes<=512*1024*1024&&/^[a-f0-9]{64}$/.test(r.sha256??'');
const same=(a,b)=>receipt(a)&&receipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const safe=name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..');
const transport=r=>receipt(r)&&safe(r.file)&&receipt(r.gzip)&&r.gzip.file===r.file+'.gz';
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const checked=async(bytes,r,label)=>check(receipt(r)&&bytes.byteLength===r.bytes&&await hash(bytes)===r.sha256,label+' digest mismatch');
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

function validate(m){
 check(m?.format==='waterworld.forest-inspection-pilot'&&m.version===1&&m.experimental===true&&m.qualified===false&&m.complete===true&&m.units==='metres'&&m.upAxis==='Y'&&m.vertexStride===60&&m.indexType==='uint32','unsupported complete experimental60B manifest');
 check(m.attributes?.originalNativeRecord?.offset===0&&m.attributes.originalNativeRecord.bytes===56,'original record layout differs');
 for(const [key,offset,components]of [['position',0,3],['normal',12,3],['kindShade',24,2],['uv',32,2],['linearRGB',40,3],['nativeMaterial',52,1],['canopyAO',56,1]])check(m.attributes[key]?.offset===offset&&m.attributes[key].components===components,'attribute layout differs: '+key);
 check(m.layout?.maximumLeavesPerCluster===32&&m.layout.maximumTrianglesPerCluster===128&&m.layout.maximumPulledVerticesPerCluster===384&&uint(m.layout.nodesPerPage)&&m.layout.nodesPerPage>=1&&m.layout.nodesPerPage<=256,'unsafe cluster/page limits');
 check(receipt(m.source?.manifest)&&Array.isArray(m.source.methods)&&m.source.methods.length===2&&['scripts/prepare-forest-inspection.mjs','scripts/forest-lod-clusters.mjs'].every(name=>m.source.methods.some(r=>r.file===name&&receipt(r))),'missing source/exporter receipts');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])check(receipt(m.source.files?.[name]),'missing original source stream identity');
 check(m.source.files['vertices.bin'].bytes%56===0&&m.source.files['indices.bin'].bytes%4===0,'original source alignment differs');
 check(receipt(m.source.canopyShade?.manifest)&&m.source.canopyShade.manifest.file==='canopy-shade.json'&&receipt(m.source.canopyShade.field)&&m.source.canopyShade.field.file==='canopy-shade.bin'&&same(m.source.canopyShade.manifest,m.source.files['canopy-shade.json'])&&same(m.source.canopyShade.field,m.source.files['canopy-shade.bin']),'missing original AO identities');
 check(Array.isArray(m.prototypes)&&m.prototypes.length>0&&m.prototypes.length<=5,'invalid prototype registry');
 const prototypeIDs=new Set();let gpu=0,ids=0,encoded=0;
 for(const p of m.prototypes){
  check(uint(p.id)&&!prototypeIDs.has(p.id)&&typeof p.species==='string'&&/^[a-z]+$/.test(p.species)&&p.groundPlaneY===0&&vec(p.biologicalRootXYZ)&&p.biologicalRootXYZ.every(v=>v===0),'invalid origin/specimen');prototypeIDs.add(p.id);
  check(uint(p.leafCount)&&p.leafCount>0&&p.leafCount<=500000&&p.leafTriangles===4&&p.triangleCount===p.leafCount*4&&uint(p.sourceLeafRange?.firstIndex)&&p.sourceLeafRange.indexCount===p.triangleCount*3&&p.sourceLeafRange.firstIndex+p.sourceLeafRange.indexCount<=m.source.files['indices.bin'].bytes/4&&receipt(p.sourceLeafRange.indices)&&p.sourceLeafRange.indices.bytes===p.sourceLeafRange.indexCount*4,'invalid complete source leaf range');
  check(vec(p.low)&&vec(p.high)&&vec(p.centre)&&p.low.every((v,k)=>v<=p.high[k]&&Math.abs(p.centre[k]-(v+p.high[k])*.5)<1e-5),'invalid specimen bound');
  const materials=new Map();check(Array.isArray(p.nativeMaterials)&&p.nativeMaterials.length>0&&p.nativeMaterials.length<=16,'missing native leaf materials');
  for(const material of p.nativeMaterials){
   check(uint(material.index)&&!materials.has(material.index)&&/^foliage_[0-9]+$/.test(material.name)&&material.wrap==='clamp'&&['roughness','underside','transmission','opacityThreshold'].every(key=>Number.isFinite(material[key])&&material[key]>=0&&material[key]<=1)&&vec(material.undersideReference)&&material.undersideReference.every(v=>v>=0&&v<=1),'invalid original leaf optics');materials.set(material.index,material);
   for(const key of ['albedo','normal','roughnessMap'])if(material[key]){const r=material[key];check(receipt(r)&&r.bytes<=8*1024*1024&&safe(r.file)&&r.file.endsWith('.png')&&r.encoding===(key==='albedo'?'srgb':'linear')&&uint(r.width)&&uint(r.height)&&r.width>0&&r.height>0&&r.width<=4096&&r.height<=4096&&same(r,m.source.files[r.file])&&same(r,p.source?.native?.maps?.[r.file]),'native PNG receipt/layout differs');}
   check(material.albedo&&material.normal,'original pigment/normal maps required');
  }
  const h=p.hierarchy;check(h?.root===0&&transport(h.leafOrder)&&h.leafOrder.bytes===p.leafCount*4&&Array.isArray(h.nodes)&&h.nodes.length>0&&h.nodes.length<=p.leafCount*2-1,'invalid hierarchy/leaf-order transport');
  const seen=new Set(),frontier=[];
  function visit(id,parent,depth){
   const n=h.nodes[id];check(uint(id)&&n?.id===id&&!seen.has(id)&&n.parent===parent&&depth<=32&&uint(n.firstLeaf)&&uint(n.leafCount)&&n.leafCount>0&&n.firstLeaf+n.leafCount<=p.leafCount&&Array.isArray(n.children)&&(n.children.length===0||n.children.length===2),'hierarchy cycle/link/range differs');seen.add(id);
   if(n.children.length){const a=h.nodes[n.children[0]],b=h.nodes[n.children[1]];check(a&&b&&a.id!==b.id&&a.firstLeaf===n.firstLeaf&&b.firstLeaf===a.firstLeaf+a.leafCount&&a.leafCount+b.leafCount===n.leafCount,'children overlap or omit source leaves');for(const child of n.children)visit(child,id,depth+1);}
   if(n.leafCount<=32&&!(parent>=0&&h.nodes[parent].leafCount<=32))frontier.push(id);
   if(n.leafCount>32)check(n.children.length===2,'missing inspection refinement');
  }
  visit(0,-1,0);check(seen.size===h.nodes.length&&h.nodes[0].firstLeaf===0&&h.nodes[0].leafCount===p.leafCount,'incomplete hierarchy population');
  check(Array.isArray(p.clusters)&&p.clusters.length===frontier.length&&Array.isArray(p.pages)&&p.pages.length>0&&p.pages.length<=p.clusters.length,'incomplete cluster/page cover');
  const selected=new Set(),expectedFrontier=new Set(frontier),coverage=[];
  for(const [id,c]of p.clusters.entries()){
   const n=h.nodes[c.sourceNodeID];check(c.id===id&&uint(c.sourceNodeID)&&n&&!selected.has(c.sourceNodeID)&&expectedFrontier.has(c.sourceNodeID)&&c.parentNodeID===n.parent&&c.firstLeaf===n.firstLeaf&&c.leafCount===n.leafCount&&c.leafCount<=32&&uint(c.page)&&c.page<p.pages.length,'cluster source ownership differs');selected.add(c.sourceNodeID);coverage.push([c.firstLeaf,c.firstLeaf+c.leafCount]);
   check(uint(c.firstVertex)&&uint(c.vertexCount)&&c.vertexCount>=3&&c.vertexCount<=384&&uint(c.firstIndex)&&c.indexCount===c.leafCount*12&&c.indexCount<=384&&c.vertexCount<=c.indexCount,'cluster exceeds bounded complete32-blade pull');
   check(vec(c.low)&&vec(c.high)&&vec(c.centre)&&Number.isFinite(c.radius)&&c.radius>0&&c.extent===c.radius&&c.low.every((v,k)=>v<=c.high[k]&&v>=p.low[k]-1e-5&&c.high[k]<=p.high[k]+1e-5&&Math.abs(c.centre[k]-(v+c.high[k])*.5)<1e-5)&&Math.abs(Math.hypot(...c.high.map((v,k)=>(v-c.low[k])*.5))-c.radius)<1e-5,'cluster bound/radius differs');
   for(const [key,bytes]of [['leafIDs',c.leafCount*4],['originalGlobalIndices',c.indexCount*4],['originalGlobalVertexIDs',c.vertexCount*4]])check(receipt(c.sourceMembership?.[key])&&c.sourceMembership[key].bytes===bytes,'missing cluster source-membership receipt');
  }
  coverage.sort((a,b)=>a[0]-b[0]);let end=0;for(const [first,last]of coverage){check(first===end,'overlapping/missing source leaf frontier');end=last;}check(end===p.leafCount,'incomplete leaf frontier');
  const covered=new Set();
  for(const [index,page]of p.pages.entries()){
   check(page.index===index&&uint(page.vertexCount)&&page.vertexCount>0&&uint(page.indexCount)&&page.indexCount>0&&page.indexCount%3===0&&page.triangleCount===page.indexCount/3&&Array.isArray(page.clusterIDs)&&page.clusterIDs.length>0&&page.clusterIDs.length<=m.layout.nodesPerPage,'invalid inspection page');
   let v=0,i=0;for(const id of page.clusterIDs){const c=p.clusters[id];check(c&&c.id===id&&!covered.has(id)&&c.page===index&&c.firstVertex===v&&c.firstIndex===i,'page cluster vertex/index overlap or hole');covered.add(id);v+=c.vertexCount;i+=c.indexCount;}
   check(v===page.vertexCount&&i===page.indexCount&&page.decodedGPUBytes===v*60+i*4,'page totals differ');
   for(const [key,bytes]of [['vertices',v*60],['indices',i*4],['sourceIDs',v*4]]){const r=page.files?.[key];check(transport(r)&&r.bytes===bytes,'page transport/layout differs');encoded+=r.gzip.bytes;if(key==='sourceIDs')ids+=bytes;else gpu+=bytes;}
  }
  check(covered.size===p.clusters.length&&p.pages.reduce((sum,page)=>sum+page.triangleCount,0)===p.triangleCount,'page frontier truncates original triangles');ids+=h.leafOrder.bytes;encoded+=h.leafOrder.gzip.bytes;
 }
 check(m.decodedGPUBytes===gpu&&m.decodedSourceIDBytes===ids&&m.encodedBytes===encoded&&uint(m.maximumDecodedBytes)&&uint(m.maximumEncodedBytes)&&uint(m.maximumCombinedBytes)&&gpu+ids<=m.maximumDecodedBytes&&encoded<=m.maximumEncodedBytes&&gpu+ids+encoded<=m.maximumCombinedBytes,'declared inspection byte budgets differ');
 return m;
}

/** Explicit experimental loader. Only the original manifest and approved PNGs
 * and original AO membership metadata are read from sourceBase; full native
 * geometry/AO buffers are never requested. Typed arrays are caller-owned
 * read-only upload inputs, not JavaScript-frozen array contents.
 * loadPrototype calls serialize, without an unbounded multi-prototype cache.
 * maxDecodedBytes bounds this request's retained upload/provenance/PNG/bitmap
 * data plus one page and reconstruction scratch; browser/crypto overhead and
 * arbitrarily caller-retained older packs are outside that declared byte bound.
 */
export async function loadForestInspectionPilot(base,{sourceBase,fetchAsset=fetch,allowExperimental=false,maxDecodedBytes=64*1024*1024}={}){
 check(allowExperimental===true,'explicit experimental review permission required');
 check(typeof base==='string'&&base&&typeof sourceBase==='string'&&sourceBase&&uint(maxDecodedBytes)&&maxDecodedBytes>0&&maxDecodedBytes<=512*1024*1024,'invalid source URLs or decoded budget');
 check(globalThis.crypto?.subtle&&typeof DecompressionStream==='function','verified gzip transport unavailable');
 base=base.replace(/\/+$/,'')+'/';sourceBase=sourceBase.replace(/\/+$/,'')+'/';
 async function responseBytes(url,limit){
  const response=await fetchAsset(url);check(response.ok,'asset unavailable: '+url);const reader=response.body?.getReader();
  if(!reader){const bytes=new Uint8Array(await response.arrayBuffer());check(bytes.byteLength<=limit,'asset exceeds byte limit');return bytes;}
  const chunks=[];let length=0;try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;check(length<=limit,'asset exceeds byte limit');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
 }
 async function read(r){
  check(transport(r)&&r.bytes<=maxDecodedBytes&&r.gzip.bytes<=maxDecodedBytes,'page exceeds decoded/transport bound');
  const encoded=await responseBytes(base+r.gzip.file,r.gzip.bytes);await checked(encoded,r.gzip,r.file+' encoded');const bytes=new Uint8Array(r.bytes),reader=new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;check(length+value.byteLength<=r.bytes,'gzip expands beyond receipt');bytes.set(value,length);length+=value.byteLength;}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  check(length===r.bytes,'short decoded page');await checked(bytes,r,r.file+' decoded');return bytes;
 }
 const decode=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 const manifest=validate(decode(await responseBytes(base+'manifest.json',16*1024*1024))),sourceRaw=await responseBytes(sourceBase+'manifest.json',4*1024*1024),source=decode(sourceRaw),sourceReceipt={bytes:sourceRaw.byteLength,sha256:await hash(sourceRaw)};
 check(source.format==='waterworld.forest-instances'&&source.version===2&&source.vertexStride===56&&source.units==='metres'&&source.upAxis==='Y'&&source.materialContract==='gene-surfaces-v3'&&Array.isArray(source.prototypes),'original native source metadata required');
 check(same(manifest.source.manifest,sourceReceipt)||same(manifest.source.manifest,source.runtimePackaging?.sourceManifest),'inspection source manifest identity differs');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])check(same(manifest.source.files[name],source.files?.[name]),'inspection original source identity differs: '+name);
 check(same(manifest.source.canopyShade.manifest,source.canopyShade),'inspection AO source identity differs');
 const shadeRaw=await responseBytes(sourceBase+'canopy-shade.json',4*1024*1024);await checked(shadeRaw,source.canopyShade,'original AO membership metadata');const shade=decode(shadeRaw);
 check(shade.format==='waterworld.native-canopy-light'&&shade.version===1&&shade.vertexCount===manifest.source.files['vertices.bin'].bytes/56&&Array.isArray(shade.prototypes),'invalid original AO membership metadata');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])check(same(shade.source?.files?.[name],source.files[name]),'original AO membership source differs');
 check(same(shade.files?.['canopy-shade.bin'],manifest.source.canopyShade.field),'original AO stream identity differs');
 for(const p of manifest.prototypes){const original=source.prototypes.find(q=>q.id===p.id);check(original?.species===p.species&&original.leaf?.firstIndex===p.sourceLeafRange.firstIndex&&original.leaf.indexCount===p.sourceLeafRange.indexCount,'inspection source specimen/range differs');
  const own=shade.prototypes.find(q=>q.id===p.id),leaf=own?.membership?.leaf;check(own?.species===p.species&&leaf?.firstIndex===p.sourceLeafRange.firstIndex&&leaf.indexCount===p.sourceLeafRange.indexCount&&same(leaf.indices,p.sourceLeafRange.indices),'inspection original leaf membership digest differs');
  const originalLeaves=original.nativeMaterials?.filter(m=>m.name.startsWith('foliage_'));check(originalLeaves?.length===p.nativeMaterials.length,'inspection source material table differs');
  for(const m of p.nativeMaterials){const originalMaterial=originalLeaves.find(q=>q.index===m.index);check(originalMaterial&&['name','roughness','underside','transmission','opacityThreshold','wrap'].every(key=>originalMaterial[key]===m[key])&&originalMaterial.undersideReference.every((v,k)=>v===m.undersideReference[k]),'inspection source optics differ');
   for(const key of ['albedo','normal','roughnessMap']){const r=m[key],expected=originalMaterial[key];check((!r&&!expected)||(r&&expected&&r.file===expected.file&&same(r,expected)&&r.width===expected.width&&r.height===expected.height&&r.encoding===expected.encoding&&same(r,source.files[r.file])),'inspection native PNG authority differs');}
  }
 }
 freeze(manifest);let serial=Promise.resolve();
 async function load(id){
  const prototype=manifest.prototypes.find(p=>p.id===id);check(uint(id)&&prototype,'unknown inspection prototype');
  const pages=prototype.pages,totalVertices=pages.reduce((n,p)=>n+p.vertexCount,0),totalIndices=pages.reduce((n,p)=>n+p.indexCount,0),retainedBytes=totalVertices*64+totalIndices*4+prototype.leafCount*4,scratchBytes=totalIndices*4+prototype.leafCount,largestPage=Math.max(...pages.map(p=>p.files.vertices.bytes+p.files.indices.bytes+p.files.sourceIDs.bytes+p.vertexCount));
  const mapRecords=new Map();for(const m of prototype.nativeMaterials)for(const key of ['albedo','normal','roughnessMap'])if(m[key]){const r=m[key],old=mapRecords.get(r.file);check(!old||(same(old,r)&&old.encoding===r.encoding&&old.width===r.width&&old.height===r.height),'conflicting original PNG');mapRecords.set(r.file,r);}
  const textureBytes=[...mapRecords.values()].reduce((sum,r)=>sum+r.bytes+r.width*r.height*4,0),peakDecodedBytes=retainedBytes+Math.max(scratchBytes+largestPage+384*4,textureBytes);
  check(totalVertices<=0xffffffff&&totalIndices<=0xffffffff&&peakDecodedBytes<=maxDecodedBytes,'prototype exceeds complete decoded budget; no truncation');
  const vertices=new Uint8Array(totalVertices*60),indices=new Uint32Array(totalIndices),sourceIDs=new Uint32Array(totalVertices),leafRaw=await read(prototype.hierarchy.leafOrder),leafOrder=new Uint32Array(leafRaw.buffer),clusters=[],ranges=new Map(),textures=new Map();let originalIndices=new Uint32Array(totalIndices),coveredLeaves=new Uint8Array(prototype.leafCount),vertexBase=0,indexBase=0;
  for(const id of leafOrder){check(id<prototype.leafCount&&!coveredLeaves[id],'leaf order repeats/omits original blade');coveredLeaves[id]=1;}
  check(coveredLeaves.every(x=>x===1),'incomplete original leaf permutation');
  const materials=new Map(prototype.nativeMaterials.map(m=>[m.index,m]));
  try{
   for(const page of pages){
    const vraw=await read(page.files.vertices),iraw=await read(page.files.indices),sraw=await read(page.files.sourceIDs),vf=new Float32Array(vraw.buffer),pi=new Uint32Array(iraw.buffer),ps=new Uint32Array(sraw.buffer),used=new Uint8Array(page.vertexCount);
    for(let local=0;local<page.vertexCount;local++){const row=vf.subarray(local*15,local*15+15),material=materials.get(row[13]);check(row.every(Number.isFinite)&&material&&row[6]===4+Number(material.name.slice(8))&&row[7]>=0&&row[7]<=1&&row[14]>=0&&row[14]<=1&&Math.abs(row[14]*255-Math.round(row[14]*255))<2e-5&&Math.abs(Math.hypot(row[3],row[4],row[5])-1)<=.01&&row.subarray(10,13).every(v=>v>=0)&&ps[local]<manifest.source.files['vertices.bin'].bytes/56,'invalid60B source record/material/normal/AO');}
    for(const clusterID of page.clusterIDs){const c=prototype.clusters[clusterID],global=new Uint32Array(c.indexCount),ownIDs=ps.subarray(c.firstVertex,c.firstVertex+c.vertexCount);check(new Set(ownIDs).size===ownIDs.length,'cluster compact source IDs repeat');
     await checked(new Uint8Array(leafOrder.buffer,(c.firstLeaf)*4,c.leafCount*4),c.sourceMembership.leafIDs,'cluster original leaves');await checked(new Uint8Array(ownIDs.buffer,ownIDs.byteOffset,ownIDs.byteLength),c.sourceMembership.originalGlobalVertexIDs,'cluster source vertices');
     for(let i=0;i<c.indexCount;i++){const local=pi[c.firstIndex+i];check(local>=c.firstVertex&&local<c.firstVertex+c.vertexCount,'index escapes its source cluster');used[local]=1;global[i]=ps[local];const first=local*15;check(c.low.every((v,k)=>vf[first+k]>=v-.001&&vf[first+k]<=c.high[k]+.001),'vertex escapes source cluster bound');
      if(i%12)check(vf[first+13]===vf[pi[c.firstIndex+i-i%12]*15+13],'source blade crosses materials');
     }
     await checked(new Uint8Array(global.buffer),c.sourceMembership.originalGlobalIndices,'cluster original indices');
     for(let leaf=0;leaf<c.leafCount;leaf++)originalIndices.set(global.subarray(leaf*12,leaf*12+12),leafOrder[c.firstLeaf+leaf]*12);
     const combined=freeze({...c,sourceFirstVertex:c.firstVertex,sourceFirstIndex:c.firstIndex,firstVertex:vertexBase+c.firstVertex,firstIndex:indexBase+c.firstIndex});clusters.push(combined);ranges.set(c.sourceNodeID,Object.freeze({firstVertex:combined.firstVertex,vertexCount:c.vertexCount,firstIndex:combined.firstIndex,indexCount:c.indexCount}));
    }
    check(used.every(x=>x===1),'unused vertex hides outside source cluster ownership');vertices.set(vraw,vertexBase*60);sourceIDs.set(ps,vertexBase);
    for(let i=0;i<pi.length;i++)indices[indexBase+i]=vertexBase+pi[i];vertexBase+=page.vertexCount;indexBase+=page.indexCount;
   }
   await checked(new Uint8Array(originalIndices.buffer),prototype.sourceLeafRange.indices,'reconstructed complete original leaf index order');originalIndices=null;coveredLeaves=null;
   for(const [file,r]of mapRecords){const bytes=await responseBytes(sourceBase+file,r.bytes);await checked(bytes,r,'original PNG '+file);check(typeof createImageBitmap==='function','browser PNG decoder required');const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}),{premultiplyAlpha:'none',colorSpaceConversion:'none',imageOrientation:'none'});
    if(bitmap.width!==r.width||bitmap.height!==r.height){bitmap.close();throw Error('Forest inspection: original PNG dimensions differ');}textures.set(file,Object.freeze({receipt:r,width:r.width,height:r.height,encoding:r.encoding,bytes,bitmap}));
   }
   let destroyed=false;return Object.freeze({manifest,prototype,vertexStride:60,vertices,indices,sourceIDs,leafOrder,clusters:Object.freeze(clusters),ranges,materials:Object.freeze([...prototype.nativeMaterials]),textures,
    immutable:true,stats:Object.freeze({vertexCount:totalVertices,indexCount:totalIndices,triangleCount:totalIndices/3,retainedBytes:retainedBytes+textureBytes,peakDecodedBytes,sourceGeometryFetched:false,sourceMembershipVerified:true,qualification:'Receipt-verified complete source index/leaf membership; source56B content trusted to pinned exporter receipts, no native appearance certificate'}),
    destroy(){if(!destroyed){destroyed=true;for(const {bitmap}of textures.values())bitmap.close();}},
   });
  }catch(error){for(const {bitmap}of textures.values())bitmap.close();throw error;}
 }
 return Object.freeze({manifest,loadPrototype(id){const pending=serial.then(()=>load(id));serial=pending.catch(()=>{});return pending;}});
}
