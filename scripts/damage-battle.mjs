// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A broadside against the player's ship, through the game's own sweep and damage code. It runs in the
// page. Same seed every time, so runs compare. Her shot holes stop leaking afterwards, so what she
// shows is the damage and not her foundering.
export async function fireBroadside({volleys}){
  const {applyShipImpactDamage,sweepShipSegment}=await import('/js/gunnery-control.js');
  const {boatRotate}=await import('/js/boat.js');
  const {repairVessel}=await import('/js/vessel-damage.js');
  const boat=oceanFleet.vessels[0].boat,length=boat.length,heading=boat.heading*Math.PI/180,out=[0,0,0],across=[0,0,0];
  // Fired from the side the review views look at.
  boatRotate(across,-1,0,0,heading,0,0);
  let seed=7,hits=0;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647,zones={};
  for(const {shots,mass,speed,minY,maxY,mast}of volleys){
    for(let i=0;i<shots;i++){
      if(boat.damage?.sunk||(mast&&(boat.damage?.mastState?.[mast]??0)>=2))break;
      const y=minY+rnd()*(maxY-minY),h=boat.heave??0,v=[-across[0]*speed,-2,-across[2]*speed];
      if(mast){
        // Shots at one mast only, so the others stand for comparison.
        applyShipImpactDamage(boat,{hitZone:'rigging',mastGroup:mast,localPosition:[0,y,0],position:[boat.x,y+h,boat.z],surfacePosition:[boat.x,y+h,boat.z],velocity:v,mass,energy:.5*mass*speed*speed,ammo:'round'});
        hits++;zones.rigging=(zones.rigging??0)+1;
      }else{
        const z=(rnd()-.5)*length*.92;
        boatRotate(out,0,0,z,heading,0,0);
        const cx=boat.x+out[0],cz=boat.z+out[2];
        const from=[cx+across[0]*length,y+h,cz+across[2]*length],to=[cx-across[0]*length,y+h,cz-across[2]*length];
        const hit=sweepShipSegment(from,to,.08,boat,{id:'broadside',x:from[0],z:from[2],heave:0,heading:0,pitch:0,roll:0});
        if(!hit)continue;
        hits++;zones[hit.hitZone??'hull']=(zones[hit.hitZone??'hull']??0)+1;
        applyShipImpactDamage(boat,{...hit,velocity:v,mass,energy:.5*mass*speed*speed,ammo:'round'});
      }
      // A real broadside takes seconds. The game's own loop runs between shots, as it would.
      if(i%3===2)await new Promise(requestAnimationFrame);
    }
  }
  window.damageReviewAfloat=setInterval(()=>repairVessel(boat,{leaks:true,flooding:true}),100);repairVessel(boat,{leaks:true,flooding:true});
  const d=boat.damage;
  return {hits,zones,hull:d.hullIntegrity,rig:d.rigIntegrity,masts:d.mastIntegrity,mastState:d.mastState,sunk:d.sunk,cracked:d.hullCracked,craters:d.craters.length,holes:d.holes?.length??0,broken:d.fracture?.brokenCount??null};
}
