// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { createGunneryState, prepareGunnery, fireGunnery, stepGunnery, gunnerySummary, resolveGunneryImpact } from './gunnery-state.js';
import { createGunDefinitions, gunMuzzlePose } from './gunnery-models.js';
import { GUNNERY_ORDER_SECONDS } from './gunnery-audio.js';
import { boatRotate } from './boat.js';

// Explicit orders govern the drill. There is no automatic reload or repeated
// firing. The captain's spoken order has the same duration with sound muted.
export function createShipGunnery(boat,{onEvent=()=>{},onOrder=()=>{},muzzleBlock=()=>null}={}){
  const state=createGunneryState(createGunDefinitions(boat));boat.gunnery=state;
  let pending=null,prepared=false,lastReady=false,flash=null;
  const attended=gun=>!gun.visibleCrew||boat.gunneryAttendance?.has(gun.id)===true;
  const sideValid=side=>side==='port'||side==='starboard';
  const canFire=side=>sideValid(side)&&boat.gunnerySide===side&&!pending&&!state.queue.length&&
    state.guns.filter(g=>g.side===side).every(g=>g.stage==='ready'&&attended(g)&&!muzzleBlock(g,gunMuzzlePose(g,boat)));
  function recoil(event){
    const h=boat.hydrodynamics;if(!h)return;
    const impulse=event.impulse,centre=[0,0,0];
    boatRotate(centre,0,h.centreOfGravity-(h.draft-h.sinkage),0,boat.heading*Math.PI/180,boat.pitch,boat.roll);
    const r=event.position.map((x,i)=>x-([boat.x,boat.heave,boat.z][i]+centre[i]));
    const heading=boat.heading*Math.PI/180,sn=Math.sin(heading),cs=Math.cos(heading);
    boat.surgeVelocity=(boat.surgeVelocity??0)+(impulse[0]*sn-impulse[2]*cs)/(h.mass+h.addedMass);
    boat.leewayVelocity=(boat.leewayVelocity??0)+(impulse[0]*cs+impulse[2]*sn)/(h.mass*1.8);
    boat.heaveVelocity=(boat.heaveVelocity??0)+impulse[1]/(h.mass+h.addedMass);
    const torque=[r[1]*impulse[2]-r[2]*impulse[1],r[2]*impulse[0]-r[0]*impulse[2],r[0]*impulse[1]-r[1]*impulse[0]];
    const axis=(x,y,z)=>{const a=[0,0,0];boatRotate(a,x,y,z,boat.heading*Math.PI/180,boat.pitch,boat.roll);return a;};
    const dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0);
    const yawI=h.mass*(boat.length**2+boat.beam**2)/12*1.5;
    const axes=[axis(1,0,0),axis(0,1,0),axis(0,0,1)],inertia=[h.pitchInertia,yawI,h.rollInertia];
    const omega=[0,0,0];for(let j=0;j<3;j++){const d=dot(torque,axes[j])/inertia[j];for(let i=0;i<3;i++)omega[i]+=axes[j][i]*d;}
    // Convert a principal-axis angular impulse back to this integrator's Euler
    // rates. Directly adding body-axis rates is wrong on a pitched/heeled ship.
    const omegaH=[cs*omega[0]+sn*omega[2],omega[1],-sn*omega[0]+cs*omega[2]],dRoll=omegaH[2]/Math.cos(boat.pitch);
    boat.pitchVelocity=(boat.pitchVelocity??0)+omegaH[0];
    boat.rollVelocity=(boat.rollVelocity??0)+dRoll;
    boat.yawRate=(boat.yawRate??0)-omegaH[1]-Math.sin(boat.pitch)*dRoll;
  }
  return {
    state,
    prepare(side){
      if(!sideValid(side))return false;
      if(pending||state.queue.length||state.guns.some(g=>g.loading&&g.side!==side))return false;
      const changed=boat.gunnerySide!==side;
      boat.gunnerySide=side;prepared=true;lastReady=false;
      const count=prepareGunnery(state,side);if(count||changed)onOrder('prepare',boat);
      return count>0||changed;
    },
    fire(side){
      if(!canFire(side))return false;
      const order='fire-'+side;pending={side,at:state.time+GUNNERY_ORDER_SECONDS[order]};onOrder(order,boat);return true;
    },
    cease(){
      pending=null;state.queue.length=0;for(const g of state.guns)g.queued=false;
      onOrder('cease',boat);
    },
    standDown(){
      pending=null;state.queue.length=0;boat.gunnerySide=null;lastReady=false;
      for(const g of state.guns){g.queued=false;g.loading=false;}
    },
    update(dt,wind){
      if(pending&&state.time+1e-8>=pending.at){fireGunnery(state,pending.side);pending=null;}
      const before=new Map(state.guns.map(g=>[g.id,g.stage]));
      const events=stepGunnery(state,dt,{deferSeaCollision:true,
        windVelocity:wind,muzzle:gun=>gunMuzzlePose(gun,boat),
        gunAttended:attended,canFire:(gun,pose)=>attended(gun)&&!muzzleBlock(gun,pose),
        onEvent:event=>{if(event.type==='shot'){recoil(event);flash={gunId:event.gunId,side:event.gun.sideSign,time:event.time,mass:event.mass};}if(event.type!=='ready')onEvent(event);},
      });
      for(const gun of state.guns)if(before.get(gun.id)!==gun.stage&&(gun.stage==='ram'||gun.stage==='runout')){
        onEvent({type:gun.stage==='ram'?'load':'run-out',gun,position:gunMuzzlePose(gun,boat).position});
      }
      const s=gunnerySummary(state,boat.gunnerySide),ready=prepared&&s.total>0&&s.ready===s.total&&
        state.guns.filter(g=>g.side===boat.gunnerySide).every(attended);
      if(ready&&!lastReady)onEvent({type:'ready',position:[boat.x,boat.heave+3,boat.z]});
      lastReady=ready;return events;
    },
    impact(contact){return resolveGunneryImpact(state,contact.shotId??contact.id,contact);},
    summary(side){return gunnerySummary(state,side);},
    canFire,
    blockedReason(side){
      if(side!==boat.gunnerySide)return null;
      for(const gun of state.guns.filter(g=>g.side===side)){
        if(!attended(gun))return 'Manning guns';
        const reason=muzzleBlock(gun,gunMuzzlePose(gun,boat));if(reason)return reason;
      }return null;
    },
    get selectedSide(){return boat.gunnerySide??null;},
    get ordered(){return pending?.side??null;},
    // Reuse the two previously reserved Hull axis padding floats. GPU lighting
    // resolves the actual attachment, with no additional binding or larger UBO.
    get flash(){const age=flash?state.time-flash.time:1;return age>=0&&age<.085?{gunId:flash.gunId,energy:flash.side*Math.min(1,Math.cbrt(flash.mass/12))*Math.sin(Math.PI*age/.085)}:null;},
  };
}
