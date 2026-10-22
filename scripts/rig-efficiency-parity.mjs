#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Compare two complete, independent source trees. This is an exact CPU parity
// gate and local elapsed-time receipt, not rendered clearance or an FPS test.
import {createHash} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const parityHelp='Usage: node scripts/rig-efficiency-parity.mjs --before /absolute/archived/repo [--after /repo]\nBoth roots must contain their complete independent JS trees and package.json.';
function parityArguments(argv){
  const options={after:process.cwd()};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];if(flag==='--help'||flag==='-h')return null;
    if(!['--before','--after'].includes(flag)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(parityHelp);
    const key=flag.slice(2);if(Object.hasOwn(options,key)&&key!=='after')throw Error('Repeated '+flag);
    options[key]=argv[++i];
  }
  if(!options.before||!isAbsolute(options.before))throw Error('--before requires an absolute archived repository root.\n'+parityHelp);
  return options;
}
const parityBytes=array=>Buffer.from(array.buffer,array.byteOffset,array.byteLength);
const parityHash=array=>createHash('sha256').update(parityBytes(array)).digest('hex');
function parityEqual(label,a,b){
  if(!ArrayBuffer.isView(a)||!ArrayBuffer.isView(b)||a.constructor!==b.constructor)throw Error(label+': typed-array kinds differ');
  const A=parityBytes(a),B=parityBytes(b);if(A.equals(B))return;
  let at=0;while(at<Math.min(A.length,B.length)&&A[at]===B[at])at++;
  const element=Math.floor(at/a.BYTES_PER_ELEMENT),record=a instanceof Float32Array?Math.floor(element/9):undefined,component=a instanceof Float32Array?['x','y','z','nx','ny','nz','material','u','v'][element%9]:undefined;
  throw Error(label+': first byte difference '+JSON.stringify({byte:at,element,record,component,before:a[element],after:b[element],beforeBytes:A.length,afterBytes:B.length,beforeSHA:parityHash(a),afterSHA:parityHash(b)}));
}
function parityFinite(label,array){for(let i=0;i<array.length;i++)if(!Number.isFinite(array[i]))throw Error(label+': non-finite value at '+i);}
function parityJSON(label,a,b){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': metadata differ');}

async function parityTree(root){
  root=await realpath(resolve(root));
  for(const relative of ['package.json','js/models/procedural.js','js/rig-surface.js'])if(!(await stat(join(root,relative))).isFile())throw Error('Incomplete source tree: '+join(root,relative));
  const files={designs:'js/models/procedural.js',additionalDesigns:'js/models/additional.js',rowingDesigns:'js/models/rowing.js',rig:'js/additional-rig.js',
    additional:'js/additional-ships.js',rowing:'js/rowing-ships.js',later:'js/later-sail-ships.js',surface:'js/rig-surface.js',index:'js/caravel.js'};
  const loaded=await Promise.all(Object.entries(files).map(async([key,file])=>[key,await import(pathToFileURL(join(root,file)).href)]));
  return {root,...Object.fromEntries(loaded),times:{build:0,pose:0,direct:0}};
}
function parityAsset(tree,id){
  const start=performance.now(),groups=[],parts=new Map(),additional=Object.hasOwn(tree.additionalDesigns.ADDITIONAL_DESIGNS,id),rowing=Object.hasOwn(tree.rowingDesigns.ROWING_DESIGNS,id);
  const raw=additional?tree.additional.createAdditionalShipMesh(id,{groups,parts}):rowing?tree.rowing.createRowingShipMesh(id,{groups,parts}):tree.later.createLaterSailShipMesh(id,{groups,parts});
  const rawSnapshot=raw.slice();
  const asset={model:{id},...tree.index.indexCaravelMesh(raw)},createPose=()=>additional?tree.additional.createAdditionalAssetPose(asset):rowing?tree.rowing.createRowingAssetPose(asset):tree.later.createLaterSailAssetPose(asset);
  const sourceSnapshot=asset.vertices.slice(),indexSnapshot=asset.indices.slice();
  const record={raw,asset,groups,parts,pose:createPose(),otherPose:createPose(),target:new Float32Array(asset.vertices),otherTarget:new Float32Array(asset.vertices),
    rawSnapshot,sourceSnapshot,indexSnapshot,context:tree.rig.proceduralRigContext(id)};
  parityImmutable(id+' indexing/pose preparation',record);
  tree.times.build+=performance.now()-start;return record;
}
function parityCase(design,name){
  const base={set:[1,1,1],fill:1,side:-1,opening:.45,dip:0,yaw:[0,0,0],windSide:9,windForward:7,time:2.7,wind:14,rudder:-8,hatchesClosed:0,rowPhase:.08,effortPort:.7,effortStarboard:.5};
  const options={
    filled:{},
    backed:{fill:0,side:1,yaw:[-.45,.45,-.45],windSide:-9,windForward:-7,time:3.1,wind:22,rudder:17,hatchesClosed:.4,rowPhase:.30},
    furled:{set:[0,0,0],fill:0,time:4.4,wind:18,rowPhase:.44},
    lowered:{set:[.15,.35,.65],fill:.35,yaw:[.35,-.4,.55],time:5.7,wind:19,hatchesClosed:1,rowPhase:.60},
    transferred:{side:0,dip:1,fill:.1,opening:1.1,time:7.2,wind:8,rowPhase:.75},
    'other-spar':{time:3.1,wind:14,rowPhase:.22,otherSpar:true},
    recovery:{yaw:[-.55,.45,-.35],fill:.8,time:8.9,wind:24,rowPhase:.88,effortPort:.3,effortStarboard:.9,absent:true},
    restored:{},
  }[name];
  if(!options)throw Error('Unknown parity scenario '+name);
  const c={...base,...options},state={set:[...c.set],groupYaw:[...c.yaw],windSide:c.windSide,windForward:c.windForward,tack:c.side>0?-1:1,
    rig:c.set.map(deployed=>({deployed,fill:c.fill,side:c.side,opening:c.opening,dip:c.dip,pressure:1}))};
  if(c.otherSpar){
    const spar=design.surfaces.find(s=>s.id===12)??design.surfaces.find(s=>s.spars?.length||s.kind==='square')??design.surfaces[0];
    if(spar)state.surfaceYaw={[spar.id]:-.55};
  }
  const boat={modelId:design.id,...design.runtime,rudder:c.rudder,hatchesClosed:c.hatchesClosed,sailState:state,
    rowingState:{phase:c.rowPhase,rate:.45,cadence:.45,effortPort:c.effortPort,effortStarboard:c.effortStarboard}};
  if(c.absent&&design.stations?.length)boat.rowingAttendance=new Set(design.stations.filter((_,i)=>i%5!==0).map(s=>s.id));
  return {boat,time:c.time,wind:c.wind};
}
function parityDirect(tree,record,design,c){
  const started=performance.now(),api=tree.surface,state=c.boat.sailState,poses=new Map(design.surfaces.map(s=>[s.id,api.rigSurfacePose(s,state)])),context={...api.withRigPoseContext(record.context,state,poses),time:c.time,wind:c.wind},values=[],labels=[];
  const point=(label,p)=>{if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))throw Error(label+': invalid direct point');labels.push(label);values.push(...p);};
  for(const surface of design.surfaces){
    const pose=poses.get(surface.id),n=4;
    for(let i=0;i<=n;i++)for(let j=0;j<=n;j++){
      const u=i/n,v=j/n;if(surface.corners.length===3&&u+v>1)continue;
      // The same small off-edge samples generate production geometric normals.
      for(const [du,dv]of [[0,0],[-.0005,0],[.0005,0],[0,-.0005],[0,.0005]])point('cloth/'+surface.id+'/'+u+'/'+v+'/'+du+'/'+dv,api.surfaceClothPoint(surface,u+du,v+dv,pose,context,c.time,c.wind));
    }
    for(const [i,p]of surface.corners.entries())point('yard/'+surface.id+'/'+i,api.surfaceYardPoint(surface,p,pose));
    for(const spar of surface.spars??[])for(const end of ['a','b'])point('spar/'+surface.id+'/'+spar.id+'/'+end,api.surfaceYardPoint(surface,spar[end],pose));
  }
  for(const [i,line]of (record.context.lines??[]).entries())for(const t of [0,.001,.17,.37,.5,.83,.999,1])point('rope/'+i+'/'+t,api.surfaceRopePoint(line,t,context));
  tree.times.direct+=performance.now()-started;return {values:new Float64Array(values),labels};
}
function parityPose(tree,record,c,other=false){
  const start=performance.now(),target=other?record.otherTarget:record.target,result=(other?record.otherPose:record.pose)(c.boat,c.time,c.wind,target);
  tree.times.pose+=performance.now()-start;if(result!==true)throw Error(c.boat.modelId+': production pose did not write its target');parityFinite(c.boat.modelId+' posed mesh',target);return target;
}
function parityImmutable(label,record){
  parityEqual(label+' immutable raw triangles',record.rawSnapshot,record.raw);
  parityEqual(label+' immutable compact rest vertices',record.sourceSnapshot,record.asset.vertices);
  parityEqual(label+' immutable indices',record.indexSnapshot,record.asset.indices);
}

async function parityMain(){
  const options=parityArguments(process.argv.slice(2));if(!options){console.log(parityHelp);return;}
  const [before,after]=await Promise.all([parityTree(options.before),parityTree(options.after)]);
  if(before.root===after.root)throw Error('Before and after must be independent repository roots.');
  const ids=Object.keys(before.designs.PROCEDURAL_DESIGNS).sort(),newIds=Object.keys(after.designs.PROCEDURAL_DESIGNS).sort();parityJSON('procedural model IDs',ids,newIds);
  if(ids.length!==7)throw Error('Expected all seven procedural models, received '+ids.length);
  const cases=['filled','backed','furled','lowered','transferred','other-spar','recovery','restored'],totalHash=createHash('sha256');let poseCases=0,vertices=0,indices=0,directPoints=0;
  console.log('Exact independent-tree CPU rig parity; local elapsed times are not FPS or GPU measurements.');
  console.log(JSON.stringify({before:before.root,after:after.root,models:ids.length,scenarios:cases}));
  for(const id of ids){
    const d=before.designs.PROCEDURAL_DESIGNS[id],D=after.designs.PROCEDURAL_DESIGNS[id];parityJSON(id+' design',d,D);
    const old=parityAsset(before,id),now=parityAsset(after,id),hash=createHash('sha256');
    parityEqual(id+' raw nine-float triangles',old.raw,now.raw);parityEqual(id+' compact nine-float vertices',old.asset.vertices,now.asset.vertices);parityEqual(id+' triangle indices',old.asset.indices,now.asset.indices);parityJSON(id+' groups',old.groups,now.groups);
    parityJSON(id+' part names',[...old.parts.keys()],[...now.parts.keys()]);for(const [name,part]of old.parts)parityEqual(id+' part '+name,part,now.parts.get(name));
    for(const array of [old.raw,old.asset.vertices,old.asset.indices])hash.update(parityBytes(array));
    let firstOld,firstNow,firstDirectOld,firstDirectNow,modelPoints=0;
    for(const name of cases){
      const a=parityCase(d,name),b=parityCase(D,name),inputA=JSON.stringify(a),inputB=JSON.stringify(b),attendanceA=[...(a.boat.rowingAttendance??[])],attendanceB=[...(b.boat.rowingAttendance??[])],other=name==='other-spar';
      const one=parityPose(before,old,a,other),two=parityPose(after,now,b,other);parityEqual(id+'/'+name+' compact position/normal/material/UV',one,two);
      const directOld=parityDirect(before,old,d,a),directNow=parityDirect(after,now,D,b);parityJSON(id+'/'+name+' direct sample labels',directOld.labels,directNow.labels);
      try{parityEqual(id+'/'+name+' direct Float64 cloth/rope/spar points',directOld.values,directNow.values);}catch(error){const A=parityBytes(directOld.values),B=parityBytes(directNow.values);let at=0;while(at<Math.min(A.length,B.length)&&A[at]===B[at])at++;throw Error(error.message+' sample='+directOld.labels[Math.floor(at/24)]);}
      if(name==='filled'){firstOld=one.slice();firstNow=two.slice();firstDirectOld=directOld.values.slice();firstDirectNow=directNow.values.slice();}
      if(name==='restored'){
        parityEqual(id+' before instance restores after other-spar/row/transfer changes',firstOld,one);parityEqual(id+' after instance restores after other-spar/row/transfer changes',firstNow,two);
        parityEqual(id+' before direct restoration',firstDirectOld,directOld.values);parityEqual(id+' after direct restoration',firstDirectNow,directNow.values);
      }
      if(JSON.stringify(a)!==inputA||JSON.stringify(b)!==inputB)throw Error(id+'/'+name+': renderer mutated physical input state');
      parityJSON(id+'/'+name+' before attendance unchanged',attendanceA,[...(a.boat.rowingAttendance??[])]);parityJSON(id+'/'+name+' after attendance unchanged',attendanceB,[...(b.boat.rowingAttendance??[])]);
      parityImmutable(id+'/before/'+name,old);parityImmutable(id+'/after/'+name,now);hash.update(parityBytes(one));hash.update(parityBytes(directOld.values));
      poseCases++;modelPoints+=directOld.values.length/3;
    }
    const digest=hash.digest('hex');totalHash.update(id).update(digest);vertices+=old.asset.vertices.length/9;indices+=old.asset.indices.length;directPoints+=modelPoints;
    console.log(JSON.stringify({model:id,cases:cases.length,rawVertices:old.raw.length/9,compactVertices:old.asset.vertices.length/9,triangles:old.asset.indices.length/3,directFloat64Points:modelPoints,sha256:digest}));
  }
  const rounded=tree=>Object.fromEntries(Object.entries(tree.times).map(([key,value])=>[key+'Ms',Number(value.toFixed(2))]));
  console.log(JSON.stringify({result:'EXACT',models:ids.length,poseCases,compactVertices:vertices,triangles:indices/3,directFloat64Points:directPoints,sha256:totalHash.digest('hex'),beforeLocalElapsed:rounded(before),afterLocalElapsed:rounded(after),limits:'CPU geometry/pose parity only; no rendered-clearance, GPU, FPS or device-performance claim.'}));
}
parityMain().catch(error=>{console.error(error.stack??String(error));process.exitCode=1;});
