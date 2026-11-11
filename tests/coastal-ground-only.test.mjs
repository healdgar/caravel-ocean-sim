// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A coast found at landfall is made in two passes: the land as elevation gives it, then the land of 1550 carved
// from that. The first pass lays ground and port only, because the second lays the city, paints the ground and
// plants it over its own heights. This holds that the land which results is the same to the last number as when the
// first pass did everything, and that a first pass left as ground can still be dressed if the second never comes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build1550HistoricalTerritoryPack,completeProceduralCoastalPack,generateProceduralCoastalPack,upgradeProceduralPackWithRealDEM} from '../js/coastal-world.js';

const GRID={size:257,biomeSize:256,albedoSize:512,vegetationCandidates:12000,deferSynthesis:true};
// How long a pass took and when the coast was found are the only things allowed to differ.
const TIMED=/\.(milliseconds|discoveredAt)$/;
function differences(a,b,path='pack',out=[],depth=0){
  if(a===b||out.length>8||TIMED.test(path))return out;
  if(typeof a==='function'&&typeof b==='function')return out;
  if(ArrayBuffer.isView(a)&&ArrayBuffer.isView(b)){
    if(a.length!==b.length){out.push(`${path} length ${a.length} against ${b.length}`);return out;}
    for(let i=0;i<a.length;i++)if(a[i]!==b[i]&&!(a[i]!==a[i]&&b[i]!==b[i])){out.push(`${path}[${i}] ${a[i]} against ${b[i]}`);break;}
    return out;
  }
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    if(depth>12||a instanceof Map||a instanceof Set||a instanceof WeakMap)return out;
    for(const key of new Set([...Object.keys(a),...Object.keys(b)]))differences(a[key],b[key],`${path}.${key}`,out,depth+1);
    return out;
  }
  if(!(a!==a&&b!==b))out.push(`${path} ${String(a).slice(0,40)} against ${String(b).slice(0,40)}`);
  return out;
}
// With no elevation to fetch, the upgrade falls back to the made land: the same two passes, without the network.
const firstPass=async(id,groundOnly)=>{const pack=generateProceduralCoastalPack(id,GRID);await upgradeProceduralPackWithRealDEM(pack,{groundOnly});return pack;};

for(const id of ['lisbon','cartagena'])test(`${id}: the land of 1550 is the same whether its base was dressed or left as ground`,{timeout:300000},async()=>{
  const dressed=await firstPass(id,false),ground=await firstPass(id,true);
  assert.ok(ground.heights&&ground.port&&ground.groundOnly,'the first pass kept its ground and port');
  assert.equal(ground.biome,undefined,'and painted nothing');assert.equal(ground.city,undefined);assert.equal(ground.port.streets,undefined);
  const whole=build1550HistoricalTerritoryPack(dressed),lean=build1550HistoricalTerritoryPack(ground);
  assert.equal(lean.groundOnly,null,'the land of 1550 is dressed');
  assert.ok(lean.biome?.length&&lean.albedo&&lean.mesh&&lean.vegetation,'with its paint, mesh and planting');
  if(id==='lisbon')assert.ok(lean.city?.typedCount>5000,`${lean.city?.typedCount} buildings in the city`);
  assert.deepEqual(differences(whole,lean),[]);
  // And where the second pass never comes, the ground is dressed as the first pass would have dressed it.
  const later=completeProceduralCoastalPack(await firstPass(id,true));
  assert.equal(later.groundOnly,null);
  assert.deepEqual(differences(dressed,later),[]);
});
