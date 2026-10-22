// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Explicit one-shot fixture generation. The test suite never updates goldens.
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SHIP_MODELS} from '../js/ship-models.js';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {GPU_RIG_ORACLE_CASES,gpuRigOracleBoat,gpuRigCPUOracle,gpuRigOracleSamples} from '../tests/helpers/gpu-rig-oracle.mjs';

const fixture=new URL('../tests/data/vessel-gpu-oracle.json',import.meta.url);
try{await readFile(fixture);throw Error('Frozen GPU oracle already exists; refusing to overwrite it');}catch(e){if(e.code!=='ENOENT')throw e;}
const cache=createShipAssetCache(),models=[];
for(const model of Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry&&m.rig.backend==='surfaces-v1')){
  const asset=cache.get(model.id),oracle=gpuRigCPUOracle(asset),indices=gpuRigOracleSamples(asset.vertices),cases=[];
  for(const c of GPU_RIG_ORACLE_CASES){
    const posed=new Float32Array(asset.vertices);oracle(gpuRigOracleBoat(model,c),c.time,c.wind,posed);
    cases.push({name:c.name,samples:indices.map(vertex=>({vertex,material:asset.vertices[vertex*9+6],position:Array.from(posed.subarray(vertex*9,vertex*9+3)),normal:Array.from(posed.subarray(vertex*9+3,vertex*9+6))}))});
  }
  models.push({id:model.id,vertexCount:asset.vertices.length/9,sourceSHA256:createHash('sha256').update(asset.vertices).digest('hex'),cases});
}
await mkdir(new URL('../tests/data/',import.meta.url),{recursive:true});
await writeFile(fixture,JSON.stringify({version:1,sourceCommit:'379881a62e4b9a90bac030f88dab5bbf871aef8c',description:'Frozen pre-GPU-port CPU geometry; five complete control/rowing states. Tests never regenerate.',controls:GPU_RIG_ORACLE_CASES,models})+'\n',{flag:'wx'});
console.log('Wrote '+fixture.pathname+' for '+models.length+' complete CPU reference models');
