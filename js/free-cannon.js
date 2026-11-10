import {createGunneryState,fireGunnery,stepGunnery} from './gunnery-state.js';
import {createGunnerySolidSweep,resolveSolidGunneryImpact,resolveWaterGunneryImpact} from './gunnery-control.js';

// The free camera's cannon, for trying out destruction: one 24-pounder, laid where the camera looks. Its ball flies
// as any other 24-pounder's does, so only a calibre is given here and gunnery-state.js fixes the rest.
export const FREE_CANNON_INTERVAL_S=1;
const MUZZLE_AHEAD_M=4,MUZZLE_BELOW_M=.8;

export function createFreeCannon({onEvent=()=>{},getVessels=()=>[],getTerrain=()=>null}={}){
  const state=createGunneryState([{id:'free-cannon',side:'port',calibre:24}]);
  const gun=state.guns[0],sweep=createGunnerySolidSweep({sourceBoat:null,getVessels,getTerrain});
  let wait=0,position=[0,0,0],direction=[0,0,-1];
  const muzzle=()=>({position,direction,velocity:[0,0,0]});
  const report=event=>{
    if(event.type==='impact'&&event.kind==='water'){
      resolveWaterGunneryImpact(event,{getVessels});
    }else if(event.type==='impact'&&event.kind!=='water'){
      const before=event.building?.damageState?.hits??0;
      const damage=resolveSolidGunneryImpact(event,{getTerrain});
      if(damage)event.damageReport=damage;
      // No ship fired this, so no fort should answer it by firing on one.
      const hurt=event.building?.damageState;
      if(hurt)hurt.forgivenHits=(hurt.forgivenHits??0)+hurt.hits-before;
    }
    if(event.type!=='ready')onEvent(event);
  };
  return {
    state,
    update(dt,{firing=false,eye=[0,0,0],forward=[0,0,-1],wind=[0,0,0]}={}){
      if(!(dt>0))return;
      wait=Math.max(0,wait-dt);
      if(firing&&wait===0){
        direction=[...forward];
        position=[eye[0]+forward[0]*MUZZLE_AHEAD_M,eye[1]+forward[1]*MUZZLE_AHEAD_M-MUZZLE_BELOW_M,eye[2]+forward[2]*MUZZLE_AHEAD_M];
        gun.stage='ready';gun.loading=false;gun.queued=false;gun.offset=0;
        fireGunnery(state,'port',{interval:.04});
        wait=FREE_CANNON_INTERVAL_S;
      }
      stepGunnery(state,dt,{deferSeaCollision:false,windVelocity:wind,muzzle,sweep,onEvent:report});
    },
  };
}
