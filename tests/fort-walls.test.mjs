// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A port's works stand clear of each other and of its waterfront, and a bastion's guns open on its faces and flanks,
// never where a curtain joins it. The works are its board's (js/old-world-board.js), built of the city's types.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProceduralCoastalPack} from '../js/coastal-world.js';
import {BAKED_BOARDS} from '../js/board-model.js';
import {registerBakedBoard} from '../js/old-world.js';
import {depthInOutline,portWorkBuildings} from '../js/fort-plan.js';
import {CITY_BATTERY,CITY_BUILDING_TYPES,CITY_CORNER_BASTION,CITY_CURTAIN,cityCornerBastionPlan,cityCornerBastionType} from '../js/old-world-buildings.js';

// Boards that stand more than one work.
const WORKED=['havana:1600','san-juan:1550'];

function upsampleSurvey(survey,n){
  const sN=Math.round(Math.sqrt(survey.length)),out=new Float32Array(n*n);
  for(let j=0;j<n;j++){
    const sy=j/(n-1)*(sN-1),y0=Math.min(sN-2,Math.floor(sy)),ty=sy-y0;
    for(let i=0;i<n;i++){
      const sx=i/(n-1)*(sN-1),x0=Math.min(sN-2,Math.floor(sx)),tx=sx-x0;
      const a=survey[y0*sN+x0],b=survey[y0*sN+x0+1],c=survey[(y0+1)*sN+x0],d=survey[(y0+1)*sN+x0+1];
      out[j*n+i]=(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
    }
  }
  return out;
}
// A port laid on its board, on the ground the board was founded on.
const packs=new Map();
function boardPack(key){
  if(!packs.has(key)){
    const baked=JSON.parse(readFileSync(new URL('../'+BAKED_BOARDS[key],import.meta.url),'utf8'));
    const region={...baked.region,size:257,biomeSize:64,albedoSize:64,vegetationCandidates:100,year:baked.year};
    registerBakedBoard(baked);
    packs.set(key,generateProceduralCoastalPack(region,{},upsampleSurvey(baked.survey,region.size)));
  }
  return packs.get(key);
}

test('every work stands its line, its guns and its gate, and is struck through its own types',{timeout:300000},()=>{
  for(const key of WORKED){
    const {port}=boardPack(key),buildings=portWorkBuildings(port);
    assert.ok(port.works.length>=2,`${key} stands ${port.works.length} works`);
    assert.equal(buildings.length,port.works.length,`${key}: every work is armed`);
    for(const {work,trace} of buildings){
      assert.ok(work.outline.length>=4&&work.guns.length>=1,`${key}: ${work.name}`);
      assert.ok(work.types[1]>work.types[0],`${key}: ${work.name} is built of types`);
      for(const gun of work.guns)assert.ok(gun.piece>=work.types[0]&&gun.piece<work.types[1],`${key}: ${work.name}'s gun is one of its own types`);
      // Its gate is in its back, away from the water its front looks at.
      assert.ok(trace.gate.nz>0,`${key}: ${work.name}'s gate opens landward`);
    }
  }
});

test('a port with two works keeps them apart, and its waterfront stands clear of both',{timeout:300000},()=>{
  let pairs=0;
  for(const key of WORKED){
    const {port}=boardPack(key);
    for(const a of port.works)for(const b of port.works){
      if(a===b)continue;
      pairs++;
      for(const [x,z] of a.outline)assert.ok(depthInOutline(b.outline,x,z)<=0,`${key}: ${a.name} stands inside ${b.name}`);
    }
    for(const w of port.waterfront)for(const work of port.works){
      assert.ok(depthInOutline(work.outline,w.x,w.z)<=0,`${key}: a ${w.kind} stands within ${work.name}`);
    }
  }
  assert.ok(pairs>0,'some port has two works');
});

test('a bastion\'s guns open on its faces and flanks, never where a curtain joins it or at its salient',()=>{
  for(const bays of CITY_CORNER_BASTION.faces)for(const height of CITY_CORNER_BASTION.heights){
    const T=CITY_BUILDING_TYPES[cityCornerBastionType(bays,height)],{F,s}=cityCornerBastionPlan(bays),t=CITY_CURTAIN.thick/2;
    assert.ok(T.guns.length>=4,`${T.name}: a gun to each flank and its faces`);
    // Where each flank leaves the curtain's outer face, and the salient.
    for(const [x,z] of [[F,-t],[-t,F],[-s,-s]]){
      for(const gun of T.guns)assert.ok(Math.hypot(gun.x-x,gun.z-z)>CITY_BATTERY.embrasure,`${T.name}: a gun at ${gun.x.toFixed(1)},${gun.z.toFixed(1)} opens at ${x.toFixed(1)},${z.toFixed(1)}`);
    }
  }
});
