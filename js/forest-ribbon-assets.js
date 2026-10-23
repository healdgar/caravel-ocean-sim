// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Receipt-verified, preauthored leaf indices. No geometric authoring at startup.
const check=(ok,message)=>{if(!ok)throw Error('Forest ribbon assets: '+message);};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const receipt=r=>uint(r?.bytes)&&r.bytes>0&&/^[a-f0-9]{64}$/.test(r.sha256??'');
const same=(a,b)=>a?.bytes===b?.bytes&&a?.sha256===b?.sha256;
const safe=p=>typeof p==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
const raw=a=>new Uint8Array(a.buffer,a.byteOffset,a.byteLength);
const hash=async bytes=>({bytes:bytes.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')});
const normalized=m=>new TextEncoder().encode(JSON.stringify(m));
const freeze=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){for(const v of Object.values(o))freeze(v);Object.freeze(o);}return o;};
const deviations=d=>d?.qualified===false&&['normalVector','exposure','linearRGB','canopyAO'].every(k=>Number.isFinite(d[k])&&d[k]>=0);

export function validateForestRibbonAssets(m){
 check(m?.format==='waterworld.forest-ribbon-assets'&&m.version===1&&m.experimental===true&&m.qualified===false&&m.complete===true&&m.units==='metres'&&m.upAxis==='Y','unsupported experimental ribbon manifest');
 check(receipt(m.source?.inspectionManifest)&&receipt(m.source?.normalizedInspection)&&receipt(m.source?.nativeManifest),'missing pinned source manifests');
 check(Array.isArray(m.methods)&&m.methods.length===2&&m.methods.every(r=>receipt(r)&&safe(r.file)),'missing authoring methods');
 check(Array.isArray(m.prototypes)&&m.prototypes.length>0&&m.prototypes.length<=5,'invalid prototype population');const ids=new Set();
 for(const p of m.prototypes){
  check(uint(p.id)&&!ids.has(p.id)&&typeof p.species==='string'&&uint(p.leafCount)&&p.leafCount>0&&p.leafCount<=500000,'invalid/duplicate specimen');ids.add(p.id);
  check(receipt(p.sourceVertices)&&receipt(p.sourceIndices)&&p.sourceVertices.bytes%60===0&&p.sourceIndices.bytes===p.leafCount*12*4,'source geometry layout differs');
  check(receipt(p.indices)&&safe(p.indices.file)&&receipt(p.indices.gzip)&&safe(p.indices.gzip.file)&&p.indices.bytes===p.leafCount*6*4&&p.indices.bytes<=64*1024*1024&&p.indices.gzip.bytes<=64*1024*1024,'invalid authored index transport');
  check(deviations(p.interpolationDeviations)&&Number.isFinite(p.maximumPositionErrorUpperMetres)&&p.maximumPositionErrorUpperMetres>=0&&Array.isArray(p.clusters)&&p.clusters.length>0,'missing unqualified positional/attribute evidence');
  let next=0,maxError=0;const nodes=new Set(),cover=[];
  for(const c of p.clusters){
   check(uint(c.sourceNodeID)&&!nodes.has(c.sourceNodeID)&&c.firstIndex===next&&uint(c.indexCount)&&c.indexCount>0&&c.indexCount%6===0&&uint(c.firstLeaf)&&uint(c.leafCount)&&c.indexCount===c.leafCount*6&&c.firstLeaf+c.leafCount<=p.leafCount&&Number.isFinite(c.reductionErrorMetres)&&c.reductionErrorMetres>=0&&deviations(c.interpolationDeviations),'invalid reduced source branch');
   nodes.add(c.sourceNodeID);cover.push([c.firstLeaf,c.firstLeaf+c.leafCount]);next+=c.indexCount;maxError=Math.max(maxError,c.reductionErrorMetres);
  }
  check(next===p.leafCount*6&&maxError===p.maximumPositionErrorUpperMetres,'incomplete reduced index/error cover');let cursor=0;
  for(const [start,end]of cover.sort((a,b)=>a[0]-b[0])){check(start===cursor,'overlapping/missing source blades');cursor=end;}check(cursor===p.leafCount,'truncated source leaf cover');
 }
 return m;
}

export async function loadForestRibbonAssets(base,{fetchAsset=fetch,allowExperimental=false,maxAdditionalBytes=16*1024*1024}={}){
 check(allowExperimental===true,'explicit experimental review permission required');check(typeof base==='string'&&base&&uint(maxAdditionalBytes)&&maxAdditionalBytes>0&&maxAdditionalBytes<=128*1024*1024,'invalid URL/residency limit');base=base.replace(/\/$/,'')+'/';
 async function read(url,limit){const r=await fetchAsset(url);check(r.ok,'asset unavailable: '+url);const reader=r.body.getReader(),parts=[];let total=0;try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;check(total<=limit,'response exceeds receipt/budget');parts.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}const out=new Uint8Array(total);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
 const manifest=freeze(validateForestRibbonAssets(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(base+'manifest.json',16*1024*1024)))));let serial=Promise.resolve();
 async function apply(inspection){
  check(inspection?.immutable===true&&inspection.stats?.sourceMembershipVerified===true&&inspection.vertexStride===60&&!inspection.reduction&&inspection.vertices instanceof Uint8Array&&inspection.indices instanceof Uint32Array,'verified original inspection required');
  const p=manifest.prototypes.find(p=>p.id===inspection.prototype.id);check(p&&p.species===inspection.prototype.species&&p.leafCount===inspection.prototype.leafCount,'authored specimen differs');
  check(same(await hash(normalized(inspection.manifest)),manifest.source.normalizedInspection)&&same(inspection.manifest.source.manifest,manifest.source.nativeManifest),'inspection source manifest differs');
  check(same(await hash(inspection.vertices),p.sourceVertices)&&same(await hash(raw(inspection.indices)),p.sourceIndices),'authored source records/indices differ');
  const combinedBytes=inspection.indices.byteLength+p.indices.bytes;check(combinedBytes+2*p.indices.bytes+2*p.indices.gzip.bytes<=maxAdditionalBytes,'additional decoded/combined residency budget exceeded');
  const encoded=await read(base+p.indices.gzip.file,p.indices.gzip.bytes);check(same(await hash(encoded),p.indices.gzip),'encoded ribbon digest mismatch');
  const reader=new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),bytes=new Uint8Array(p.indices.bytes);let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;check(length+value.length<=bytes.length,'gzip expands beyond receipt');bytes.set(value,length);length+=value.length;}}catch(e){await reader.cancel().catch(()=>{});throw e;}
  check(length===bytes.length&&same(await hash(bytes),p.indices),'decoded ribbon digest mismatch');const reduced=new Uint32Array(bytes.buffer),source=inspection.indices,vertices=new Float32Array(inspection.vertices.buffer,inspection.vertices.byteOffset,inspection.vertices.byteLength/4);
  // Validate every retained outer corner/winding against its original blade.
  // Offline UV overlays supply E; re-running those overlays here is forbidden.
  for(let first=0;first<source.length;first+=12){const corners=[-1,-1,-1,-1],points=[[0,0],[1,0],[1,1],[0,1]];
   for(let k=0;k<12;k++){const id=source[first+k],u=vertices[id*15+8],v=vertices[id*15+9];for(let c=0;c<4;c++)if(u===points[c][0]&&v===points[c][1]&&(corners[c]<0||id<corners[c]))corners[c]=id;}
   check(corners.every(id=>id>=0),'source outer corner missing');const a=source[first]*15,b=source[first+1]*15,c=source[first+2]*15,orientation=(vertices[b+8]-vertices[a+8])*(vertices[c+9]-vertices[a+9])-(vertices[b+9]-vertices[a+9])*(vertices[c+8]-vertices[a+8]);check(orientation!==0,'degenerate source UV winding');
   const patterns=[[corners[0],corners[1],corners[2],corners[0],corners[2],corners[3]],[corners[0],corners[1],corners[3],corners[1],corners[2],corners[3]]];if(orientation<0)for(const pattern of patterns)for(let k=0;k<6;k+=3)[pattern[k+1],pattern[k+2]]=[pattern[k+2],pattern[k+1]];
   check(patterns.some(pattern=>pattern.every((id,k)=>id===reduced[first/2+k])),'authored indices changed source corners/winding');
  }
  check(p.clusters.length===inspection.clusters.length,'authored source branch population differs');const reducedNodes=[],originalNodes=[],ranges=new Map();
  for(const [i,c]of inspection.clusters.entries()){const authored=p.clusters[i];check(authored.sourceNodeID===c.sourceNodeID&&authored.firstLeaf===c.firstLeaf&&authored.leafCount===c.leafCount&&authored.firstIndex===c.firstIndex/2&&authored.indexCount===c.indexCount/2&&authored.reductionErrorMetres<=2*c.extent,'authored source branch ownership/bound differs');
   const low=Object.freeze({...c,representation:'ribbon',selectionKey:'ribbon:'+c.sourceNodeID,firstIndex:authored.firstIndex,indexCount:authored.indexCount,reductionErrorMetres:authored.reductionErrorMetres,interpolationDeviations:authored.interpolationDeviations,appearanceQualified:false}),full=Object.freeze({...c,representation:'original',selectionKey:'original:'+c.sourceNodeID,firstIndex:reduced.length+c.firstIndex,reductionErrorMetres:0});reducedNodes.push(low);originalNodes.push(full);
   for(const n of [low,full])ranges.set(n.selectionKey,Object.freeze({firstVertex:n.firstVertex,vertexCount:n.vertexCount,firstIndex:n.firstIndex,indexCount:n.indexCount}));
  }
  const indices=new Uint32Array(source.length+reduced.length);indices.set(reduced);indices.set(source,reduced.length);
  const reduction=Object.freeze({format:'waterworld.forest-ribbon-inspection',version:1,appearanceQualified:false,maximumPositionErrorUpperMetres:p.maximumPositionErrorUpperMetres,sourceTriangles:source.length/3,reducedTriangles:reduced.length/3,fullTriangles:indices.length/3,interpolationDeviations:p.interpolationDeviations,authored:true,boundAuthority:'Receipt-pinned offline UV overlays; appearance unqualified',asset:manifest.source});
  return Object.freeze({...inspection,indices,clusters:Object.freeze([...reducedNodes,...originalNodes]),ranges,sourceRanges:inspection.ranges,reduction});
 }
 return Object.freeze({manifest,apply(inspection){const pending=serial.then(()=>apply(inspection));serial=pending.catch(()=>{});return pending;}});
}
