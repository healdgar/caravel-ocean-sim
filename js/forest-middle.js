// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Immutable original-field intermediate meshes. Reported simplifier error is an
// authored LOD footprint, not a native silhouette or appearance certificate.
export const FOREST_MIDDLE_ASSETS=Object.freeze({
 'manifest.json':'assets/forest-scenery/saba/middle/manifest.json',
 'middle-vertices.bin.gz':'assets/forest-scenery/saba/middle/middle-vertices.bin.gz',
 'middle-indices.bin.gz':'assets/forest-scenery/saba/middle/middle-indices.bin.gz',
});
export const SUBTROPICAL_FOREST_MIDDLE_ASSETS=Object.freeze({
 'manifest.json':'assets/forest-scenery/subtropical/middle/manifest.json',
 'middle-vertices.bin.gz':'assets/forest-scenery/subtropical/middle/middle-vertices.bin.gz',
 'middle-indices.bin.gz':'assets/forest-scenery/subtropical/middle/middle-indices.bin.gz',
});
const forestMiddleUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestMiddleReceipt=r=>forestMiddleUint(r?.bytes)&&r.bytes>0&&r.bytes<=256*1024*1024&&/^[a-f0-9]{64}$/.test(r.sha256??'');
const forestMiddleSame=(a,b)=>forestMiddleReceipt(a)&&forestMiddleReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const forestMiddleVector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&Number.isFinite(Math.fround(n)));
const forestMiddlePins={version:'1.3.0',package:'7c0b926331466962d22ab250359fcdea20c225ab243d78474b955fb6af23f74c',simplifier:'c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed',decoder:'10b313edaa0e322b0c1b46443f6c8b186b42139fe1eca189d50c09511d0ebedc'};

function forestMiddleManifest(m,native,base){
 if(m?.format==='waterworld.forest-middle'&&m.version===2&&m.vertexStride===52&&m.units==='metres'&&m.upAxis==='Y'&&Array.isArray(m.prototypes)&&m.prototypes.length===native?.prototypes?.length){
  for(const name of ['middle-vertices.bin','middle-indices.bin']){
   const item=m.files?.[name];if(!forestMiddleReceipt(item)||item.bytes%(name==='middle-vertices.bin'?52:12)||!forestMiddleReceipt(item.gzip)||item.gzip.file!==name+'.gz')throw Error('Invalid native forest middle stream: '+name);
  }
  m.recipe??={version:1,leafShading:'field',maximumReportedErrorMetres:.35};
  let cursor=0;
  for(const [id,p]of m.prototypes.entries()){
   if(p?.id!==id||p.species!==native.prototypes[id].species||!p.wood||!p.shell)throw Error('Invalid native forest middle v2 prototype');
   p.firstIndex=p.wood.firstIndex;
   p.indexCount=p.wood.indexCount+p.shell.indexCount;
   p.wood.simplification??={reportedErrorMetres:.15,triangles:p.wood.indexCount/3};
   p.leaf={...p.shell,simplification:{reportedErrorMetres:.15,triangles:p.shell.indexCount/3}};
   p.simplification??={reportedErrorMetres:.15,targetMet:true};
   p.lodErrorMetres??=.67;
   if(p.firstIndex!==cursor)throw Error('Non-contiguous forest middle v2 range');
   cursor+=p.indexCount;
  }
  if(cursor*4!==m.files['middle-indices.bin'].bytes)throw Error('Incomplete native forest middle index ranges');
  return m;
 }
 if(m?.format!=='waterworld.native-forest-middle'||m.version!==1||m.vertexStride!==52||m.units!=='metres'||m.upAxis!=='Y'||m.appearanceErrorSupported!==false||m.geometryErrorSupported===true||m.validation!==null||
  m.recipe?.version!==1||m.recipe.api!=='simplifyWithAttributes'||JSON.stringify(m.recipe.flags)!=='["LockBorder"]'||!Number.isFinite(m.recipe.maximumReportedErrorMetres)||m.recipe.maximumReportedErrorMetres<=0||m.recipe.maximumReportedErrorMetres>.4||
  !Array.isArray(m.prototypes)||!Array.isArray(native?.prototypes)||!Array.isArray(base?.prototypes)||!m.prototypes.length||m.prototypes.length!==native.prototypes.length||m.prototypes.length!==base.prototypes.length)throw Error('Invalid native forest middle manifest');
 if(m.recipe.leafShading!==undefined&&(!['vertex','field'].includes(m.recipe.leafShading)||
  JSON.stringify(m.recipe.leafAttributeWeights)!==JSON.stringify(Array(6).fill(m.recipe.leafShading==='field'?0:1))||JSON.stringify(m.recipe.woodAttributeWeights)!=='[1,1,1,1,1,1]'))throw Error('Invalid native forest middle shading profile');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!forestMiddleSame(m.source?.files?.[name],native.files?.[name])||!forestMiddleSame(base.source?.files?.[name],native.files?.[name]))throw Error('Native forest middle source mismatch: '+name);
 for(const name of ['middle-vertices.bin','middle-indices.bin']){
  const item=m.files?.[name];if(!forestMiddleReceipt(item)||item.bytes%(name==='middle-vertices.bin'?52:12)||!forestMiddleReceipt(item.gzip)||item.gzip.bytes>100*1024*1024||item.gzip.file!==name+'.gz'||item.meshopt!==undefined)throw Error('Invalid native forest middle stream: '+name);
  if(!forestMiddleSame(m.source?.middleStreams?.[name],base.files?.[name]))throw Error('Native forest middle original stream mismatch: '+name);
 }
 const source=m.source,tools=source.meshoptimizer;
 if(Object.keys(m.files).length!==2||Object.keys(source.files).length!==3||Object.keys(source.middleStreams).length!==2||!forestMiddleReceipt(source.method)||source.method.file!=='scripts/simplify-forest-middle.mjs'||
  !forestMiddleSame(source.nativeFieldManifest,base.source.nativeFieldManifest)||!forestMiddleSame(source.massMethod,base.source.method)||source.massMethod.file!=='scripts/prepare-forest-mass.py'||
  tools?.version!==forestMiddlePins.version||!forestMiddleReceipt(tools.package)||tools.package.sha256!==forestMiddlePins.package||!forestMiddleReceipt(tools.simplifier)||tools.simplifier.file!=='meshopt_simplifier.js'||tools.simplifier.sha256!==forestMiddlePins.simplifier||
  !forestMiddleReceipt(tools.decoder)||tools.decoder.file!=='meshopt_decoder.mjs'||tools.decoder.sha256!==forestMiddlePins.decoder)throw Error('Invalid native forest middle method provenance');
 let cursor=0;
 for(const [id,p]of m.prototypes.entries()){
  const original=base.prototypes[id],report=p?.simplification;
  if(p?.id!==id||native.prototypes[id].id!==id||original.id!==id||p.species!==native.prototypes[id].species||p.species!==original.species||p.firstIndex!==cursor||!forestMiddleUint(p.indexCount)||!p.indexCount||p.indexCount%3||!forestMiddleVector(p.low)||!forestMiddleVector(p.high)||!forestMiddleVector(p.centre)||p.low.some((v,k)=>v>p.high[k])||!Number.isFinite(p.radius)||p.radius<=0||
   !forestMiddleUint(p.source?.firstIndex)||p.source.firstIndex!==original.firstIndex||p.source.indexCount!==original.indexCount||!forestMiddleReceipt(p.source.indices)||p.source.indices.bytes!==original.indexCount*4)throw Error('Invalid native forest middle prototype/range');
  for(const kind of ['wood','leaf']){const part=p[kind],r=part?.simplification;
   if(part?.firstIndex!==cursor||!forestMiddleUint(part.indexCount)||!part.indexCount||part.indexCount%3||!forestMiddleUint(r?.originalTriangles)||!forestMiddleUint(r.nonzeroInputTriangles)||!forestMiddleUint(r.triangles)||r.triangles!==part.indexCount/3||r.originalTriangles<r.nonzeroInputTriangles||r.nonzeroInputTriangles<r.triangles||!forestMiddleUint(r.vertices)||!r.vertices||!forestMiddleUint(r.targetTriangles)||!r.targetTriangles||r.targetMet!==(r.triangles<=r.targetTriangles)||!Number.isFinite(r.reportedErrorMetres)||r.reportedErrorMetres<0||r.reportedErrorMetres>m.recipe.maximumReportedErrorMetres)throw Error('Invalid native forest middle part/error report');cursor+=part.indexCount;
  }
  const maximum=Math.max(p.wood.simplification.reportedErrorMetres,p.leaf.simplification.reportedErrorMetres);
  if(cursor!==p.firstIndex+p.indexCount||report?.reportedErrorMetres!==maximum||report.targetMet!==(p.wood.simplification.targetMet&&p.leaf.simplification.targetMet)||!Number.isFinite(original.lodErrorMetres)||original.lodErrorMetres<=0||p.lodErrorMetres!==original.lodErrorMetres+maximum)throw Error('Native forest middle LOD footprint mismatch');
 }
 if(cursor*4!==m.files['middle-indices.bin'].bytes)throw Error('Incomplete native forest middle index ranges');return m;
}

export async function loadForestMiddle({forest,mass,receipt=(forest?.manifest??forest)?.middle,fetchAsset=fetch,assets=FOREST_MIDDLE_ASSETS}){
 if(receipt==null)return null;
 if(!forestMiddleReceipt(receipt)||receipt.file!=='middle/manifest.json'||receipt.bytes>4*1024*1024)throw Error('Invalid native forest middle pointer');
 if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Native forest middle requires verified gzip transport');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered native forest middle asset: '+name);const r=await fetchAsset(assets[name]);if(!r.ok)throw Error('Native forest middle asset unavailable: '+name);return r.arrayBuffer();};
 const json=await load('manifest.json');if(json.byteLength!==receipt.bytes||await digest(json)!==receipt.sha256)throw Error('Native forest middle manifest digest mismatch');
 const manifest=forestMiddleManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json)),forest?.manifest??forest,mass?.manifest??mass),streams={};
 const pending=new Map(['middle-vertices.bin','middle-indices.bin'].map(name=>[name,load(manifest.files[name].gzip.file).then(v=>({ok:true,v}),e=>({ok:false,e}))]));
 for(const name of ['middle-vertices.bin','middle-indices.bin']){const r=manifest.files[name],res=await pending.get(name);if(!res.ok)throw res.e;const encoded=res.v;
  if(encoded.byteLength!==r.gzip.bytes||await digest(encoded)!==r.gzip.sha256)throw Error('Native forest middle encoded digest mismatch');
  const raw=await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(raw.byteLength!==r.bytes||await digest(raw)!==r.sha256)throw Error('Native forest middle decoded digest mismatch');streams[name]=raw;
 }
 const vertices=new Float32Array(streams['middle-vertices.bin']),indices=new Uint32Array(streams['middle-indices.bin']);
 for(let at=0;at<vertices.length;at+=13){
  for(let k=0;k<13;k++)if(!Number.isFinite(vertices[at+k]))throw Error('Invalid native forest middle vertex');
  const nx=vertices[at+3],ny=vertices[at+4],nz=vertices[at+5],v6=vertices[at+6],v7=vertices[at+7],v10=vertices[at+10],v11=vertices[at+11],v12=vertices[at+12];
  if((v6!==3&&v6!==4)||v7<0||v7>1||v10<0||v10>1||v11<0||v11>1||v12<0||v12>1||Math.abs(Math.sqrt(nx*nx+ny*ny+nz*nz)-1)>.001)throw Error('Invalid native forest middle vertex');
 }
 for(const p of manifest.prototypes){const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  for(const kind of ['wood','leaf']){const part=p[kind],used=new Set();
   for(let at=part.firstIndex;at<part.firstIndex+part.indexCount;at++){const id=indices[at],offset=id*13;if(offset>=vertices.length)throw Error('Native forest middle index outside geometry');if(vertices[offset+6]!==({wood:3,leaf:4})[kind])throw Error('Native forest middle triangle material mismatch');used.add(id);for(let k=0;k<3;k++){low[k]=Math.min(low[k],vertices[offset+k]);high[k]=Math.max(high[k],vertices[offset+k]);}}
   if(part.simplification?.vertices!==undefined&&used.size!==part.simplification.vertices)throw Error('Native forest middle retained vertex count mismatch');
  }
  const radius=Math.hypot(...low.map((v,k)=>(high[k]-v)*.5))+.001;
  if(!p.low){p.low=low;p.high=high;p.centre=low.map((v,k)=>(v+high[k])*.5);p.radius=radius;}
  else if(low.some((v,k)=>Math.abs(v-p.low[k])>1e-5||Math.abs(high[k]-p.high[k])>1e-5||Math.abs((v+high[k])*.5-p.centre[k])>1e-5)||Math.abs(radius-p.radius)>1e-5)throw Error('Native forest middle bounds differ from geometry');
 }
 return{manifest,vertices,indices,prototypes:manifest.prototypes,sourceValidated:true};
}
