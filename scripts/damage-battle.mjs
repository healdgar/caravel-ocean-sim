// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A broadside against the player's ship, through the game's own sweep and damage code. It runs in the
// page. Same seed every time, so runs compare. Unless a scene says `leaking`, her shot holes stop leaking
// afterwards, so what she shows is the damage and not her foundering.
export async function fireBroadside({volleys,aloft=[],leaking=false}){
  const {applyShipImpactDamage,sweepShipSegment,vesselRailHeight}=await import('/js/gunnery-control.js');
  const {boatRotate}=await import('/js/boat.js');
  const {repairVessel}=await import('/js/vessel-damage.js');
  const {sweepCrewBodies}=await import('/js/crew-wounds.js');
  const {crewOpenEdgeInset}=await import('/js/crew-overboard.js');
  const {modelDeckWidth}=await import('/js/hull.js');
  const boat=oceanFleet.vessels[0].boat,length=boat.length,heading=boat.heading*Math.PI/180,out=[0,0,0],across=[0,0,0];
  // Fired from the side the review views look at.
  boatRotate(across,-1,0,0,heading,0,0);
  let seed=7,hits=0;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647,zones={};
  // Hands sent up the rigging first, by the crew code's own climb. The page reports what became of them.
  const company=boat.crewCompany,sent=[];
  for(const {mast,side,rung}of aloft){
    const s=company.crew.find(c=>c.visible!==false&&!c.seatedPose&&c.role!=='Helmsman'&&c.id!=='ines'&&!c.job&&!sent.includes(c));
    if(!s)throw Error('No free hand to send aloft');
    s.job={kind:'rig',mast,side,stage:'ascending',elapsed:0,rung,cursor:0,path:[],control:mast,revision:company.revision};s.intent='work';s.decisionIn=5;
    sent.push(s);
  }
  for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
  const heights=sent.map(s=>+s.position[1].toFixed(1));
  const events=[],priorEvents=boat.crewEvents;
  boat.crewEvents=e=>{events.push(e.type+':'+(e.sailor?.id??''));priorEvents?.(e);};
  window.damageReviewHands=()=>sent.map((s,i)=>({id:s.id,startedAt:heights[i],y:+s.position[1].toFixed(1),state:s.casualtyState,job:s.job?.kind??null,falling:Boolean(s.aloftFall),overboard:s.overboard?{cause:s.overboard.cause,inWater:s.overboard.inWater,alive:s.overboard.alive}:null,wounds:s.crewInjuries?.map(w=>w.kind+':'+w.bone)??[]})).concat({events});
  for(const {shots,mass,speed,minY,maxY,mast,untilStage}of volleys){
    for(let i=0;i<shots;i++){
      if(boat.damage?.sunk||(mast&&(boat.damage?.mastState?.[mast]??0)>=(untilStage??2)))break;
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
  // Level shots along her whole side, below the rail, each asked twice: as she is now, and as if nothing had
  // left her. How many fly further now is what the gaps do.
  const probeGaps=()=>{
    const d=boat.damage,state=d.fracture,length=boat.length,out=[0,0,0],shooter={id:'probe',x:0,z:0,heave:0,heading:0,pitch:0,roll:0};
    const result={rays:0,stopSame:0,carried:0,clean:0,bodiesShielded:0,bodiesExposed:0},h=boat.heave??0,crew=company?.crew??[];
    for(let i=0;i<=120;i++)for(const below of[.4,.9,1.6]){
      const z=(i/120-.5)*length*.9,rail=vesselRailHeight(boat,z);if(rail===null)continue;
      const y=rail-below;if(y<.8)continue;
      boatRotate(out,0,0,z,heading,0,0);
      const cx=boat.x+out[0],cz=boat.z+out[2],from=[cx+across[0]*length,y+h,cz+across[2]*length],to=[cx-across[0]*length,y+h,cz-across[2]*length];
      shooter.x=from[0];shooter.z=from[2];
      const now=sweepShipSegment(from,to,.08,boat,shooter);
      d.fracture=null;const whole=sweepShipSegment(from,to,.08,boat,shooter);d.fracture=state;
      if(!whole)continue;
      result.rays++;
      if(!now)result.clean++;else if(now.fraction>whole.fraction+1e-4)result.carried++;else result.stopSame++;
      // Who that shot reaches in her own frame, with her planking as it was and as it is.
      result.bodiesShielded+=sweepCrewBodies([-length,y,z],[length,y,z],.08,crew,whole.fraction).length;
      result.bodiesExposed+=sweepCrewBodies([-length,y,z],[length,y,z],.08,crew,now?.fraction??1).length;
    }
    return result;
  };
  // Idle hands standing where they should keep off an edge that has lost its rail.
  window.damageReviewEdge=()=>(company?.crew??[]).filter(s=>{
    if(s.job||s.overboard||s.casualtyState==='fallen'||s.visible===false)return false;
    const side=Math.sign(s.x),inset=crewOpenEdgeInset(boat,s.z,side);
    return inset>0&&Math.abs(s.x)>modelDeckWidth(boat,s.z)-inset-.34/(boat.beam/3.6)+.01;
  }).map(s=>s.id);
  if(!leaking){window.damageReviewAfloat=setInterval(()=>repairVessel(boat,{leaks:true,flooding:true}),100);repairVessel(boat,{leaks:true,flooding:true});}
  for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
  const d=boat.damage;
  return {hits,zones,hull:d.hullIntegrity,rig:d.rigIntegrity,masts:d.mastIntegrity,mastState:d.mastState,sunk:d.sunk,cracked:d.hullCracked,craters:d.craters.length,holes:d.holes?.length??0,broken:d.fracture?.brokenCount??null,gaps:probeGaps(),hands:window.damageReviewHands(),handsAtOpenEdge:window.damageReviewEdge()};
}
