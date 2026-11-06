// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Round shot against a building, through the game's own sweep and damage code. It runs in the page.
// Same seed every time, so runs compare. Shots come square onto one face, in a chosen stretch of wall.
export async function fireOnBuilding({prefab,volleys,everyFrames=3}){
  const {applyBuildingImpactDamage,sweepBuildingSegment}=await import('/js/gunnery-control.js');
  const port=oceanFleet.terrain?.port;
  const building=port?.instances?.find(i=>i.prefabId===prefab);
  if(!building)throw Error('No '+prefab+' in this port');
  const cos=Math.cos(building.yaw??0),sin=Math.sin(building.yaw??0),base=building.baseY??building.y??0;
  const toWorld=(x,y,z)=>[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
  let seed=11,hits=0,fired=0;const struck={};const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  for(const {shots,mass,speed,minY,maxY,centre=0,span=8,face=-1,range=160}of volleys){
    const half=(building.depth??building.length??20)*.5;
    for(let i=0;i<shots;i++){
      const u=centre+(rnd()-.5)*span,y=minY+rnd()*(maxY-minY);
      const out=toWorld(u,y,face*(half+range)),past=toWorld(u,y,face*(half-12));
      const hit=sweepBuildingSegment(out,past,.08,port);
      fired++;
      if(hit){
        const dir=[past[0]-out[0],past[1]-out[1],past[2]-out[2]],len=Math.hypot(...dir);
        const velocity=dir.map(v=>v/len*speed);
        applyBuildingImpactDamage(hit.building??building,{...hit,velocity,mass,energy:.5*mass*speed*speed,ammo:'round'});
        hits++;const name=(hit.building??building).prefabId;struck[name]=(struck[name]??0)+1;
      }
      if(i%everyFrames===everyFrames-1)await new Promise(requestAnimationFrame);
    }
  }
  const d=building.damageState;
  return {prefab,fired,hits,struck,state:d?.state,integrity:d?.integrity,breaches:d?.breaches,broken:d?.fracture?.brokenCount??null};
}
// Aim the orbit camera at a building: yaw and elevation in degrees, measured from its own face.
export async function aimAtBuilding({prefab,yaw,elevation,distance,height=5,face=-1}){
  const {DEFAULT_BOAT_LENGTH,vesselVerticalScale}=await import('/js/hull.js');
  const port=oceanFleet.terrain?.port,building=port?.instances?.find(i=>i.prefabId===prefab);
  if(!building)throw Error('No '+prefab+' in this port');
  const orbit=oceanFleet.orbit,boat=oceanFleet.vessels[0].boat;
  const size=Math.max(.7,Math.sqrt(boat.length/DEFAULT_BOAT_LENGTH));
  const faceYaw=(building.yaw??0)+(face<0?Math.PI:0);
  orbit.yaw=faceYaw+yaw*Math.PI/180;orbit.elevation=elevation*Math.PI/180;orbit.distance=distance/size;
  orbit.panX=building.x-boat.x;orbit.panZ=building.z-boat.z;
  orbit.panY=(building.baseY??building.y??0)+height-(boat.heave??0)-4*vesselVerticalScale(boat);
  return {x:building.x,z:building.z,base:building.baseY??building.y,yaw:building.yaw,boat:[boat.x,boat.z]};
}

// Where the broken pieces of every struck building ended up, against the ground under each.
export async function rubbleReport(){
  const {evaluateShardFlight}=await import('/js/ship-fracture.js');
  const terrain=oceanFleet.terrain,rows=[];
  for(const building of terrain?.port?.instances??[]){
    const state=building.damageState?.fracture;if(!state)continue;
    const {shards}=state.fracture,row={prefab:building.prefabId,shards:shards.length-1,broken:state.brokenCount,flying:state.flying.size,high:[],lowest:Infinity};
    for(let s=1;s<shards.length;s++){
      if(!state.broken[s])continue;
      const shard=shards[s],record=state.records.subarray(s*16,(s+1)*16),at=evaluateShardFlight(record,1e9,shard.centroid,[1,1,1]),ground=terrain.height(at[0],at[2]),floor=state.fracture.floorAt(at[0],at[2],at[1]);
      const above=at[1]-Math.max(ground,floor);
      if(above<row.lowest)row.lowest=above;
      if(above>2.5)row.high.push({part:shard.partKey,kind:shard.kind,from:shard.centroid.map(v=>+v.toFixed(1)),to:at.map(v=>+v.toFixed(1)),ground:+ground.toFixed(1),floor:+floor.toFixed(1),settle:+record[7].toFixed(2),gravity:+record[13].toFixed(2),vy:+record[5].toFixed(1)});
    }
    row.highCount=row.high.length;row.high=row.high.slice(0,6);
    rows.push(row);
  }
  return rows;
}
