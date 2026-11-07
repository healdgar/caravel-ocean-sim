import { GUNNERY_AUDIO_ASSETS } from './gunnery-audio-assets.js';
import { WORLD_AUDIO_ASSETS } from './world-audio-assets.js';
import { isArrowAmmo } from './gunnery-state.js';

// The simulation uses these durations even when sound is disabled: a muted
// captain does not change when the ordered discharge happens.
export const GUNNERY_ORDER_SECONDS=Object.freeze({
  prepare:GUNNERY_AUDIO_ASSETS['captain-guns-prepare'].seconds,
  'fire-port':GUNNERY_AUDIO_ASSETS['captain-guns-fire-port'].seconds,
  'fire-starboard':GUNNERY_AUDIO_ASSETS['captain-guns-fire-starboard'].seconds,
  'give-fire':GUNNERY_AUDIO_ASSETS['captain-guns-give-fire']?.seconds??2,
  cease:GUNNERY_AUDIO_ASSETS['captain-guns-cease'].seconds,
});
export function gunneryElevationBand(elevationDegrees=0){
  const deg=Number.isFinite(Number(elevationDegrees))?Number(elevationDegrees):0;
  if(deg<=-1)return 'depress';
  if(deg<1)return 'point-blank';
  if(deg<3.5)return 'elev-2';
  if(deg<6.5)return 'elev-5';
  return 'elev-8';
}
export function gunneryLayOrderClip(side,elevationDegrees=0){
  const s=side==='starboard'?'starboard':'port';
  return `captain-guns-lay-${s}-${gunneryElevationBand(elevationDegrees)}`;
}
export function gunnerySoundSpeed(temperatureC=15){
  return 331.3+.606*Math.max(-30,Math.min(50,Number.isFinite(temperatureC)?temperatureC:15));
}
export function gunnerySoundDelay(source,ear,temperatureC=15){
  return Math.hypot(source.x-ear.x,(source.y??0)-(ear.y??0),source.z-ear.z)/gunnerySoundSpeed(temperatureC);
}

// A gun carries for miles, so a report falls off far more slowly than a voice or a block on deck.
const REPORT_REACH_M=150;
// Playback is supplied by the scene's one Web Audio context. Report arrivals
// within 100 ms share an acoustic voice, while every physical gun still fires.
// This gives a rolling broadside without creating fifty full-length sources.
export function createGunneryAudio({play,available=()=>true,listener=()=>({x:0,y:0,z:0}),temperature=()=>15}={}){
  let clock=0,voiceUntil=0,pendingOrder=null,pendingGiveFire=null,pendingReady=null,lastOrder='',lastOrderAt=-100,lastMechanical=-100,lastReadyAt=-100;
  const arrivals=[],seenShots=new Set(),shotHistory=[],gunTokens=new WeakMap();
  let gunCount=0;
  const gunToken=gun=>{
    if(!gun||typeof gun!=='object')return '';
    if(!gunTokens.has(gun))gunTokens.set(gun,++gunCount);
    return gunTokens.get(gun)+':';
  };
  const maxArrivals=32;
  function positionOf(event){
    const point=event?.position??event?.worldPosition??event;
    const position=Array.isArray(point)||ArrayBuffer.isView(point)?{x:point[0],y:point[1],z:point[2]}:{x:point?.x,y:point?.y??point?.heave??0,z:point?.z};
    return Number.isFinite(position.x)&&Number.isFinite(position.y)&&Number.isFinite(position.z)?position:null;
  }
  function playSpeech(id,position){
    const seconds=play(id,.64,position,1,true);
    if(!(seconds>0))return false;
    voiceUntil=clock+seconds+.12;
    return true;
  }
  function startOrder(request){
    if((request.id==='fire-port'||request.id==='fire-starboard')&&request.elevation!==null&&request.elevation!==undefined){
      const clip=gunneryLayOrderClip(request.id.slice(5),request.elevation);
      if(GUNNERY_AUDIO_ASSETS[clip])return playSpeech(clip,request.position);
    }
    return playSpeech('captain-guns-'+request.id,request.position);
  }
  let lastImpactAt=-100,lastScreamAt=-100,lastEnemyVoiceAt=-100,lastPanicAt=-100;
  function enqueue(id,position,gain,report=false,rate=1,options=undefined){
    const ear=listener(),distance=Math.hypot(position.x-ear.x,position.y-(ear.y??0),position.z-ear.z);
    if(!Number.isFinite(distance)||distance>18000)return false;
    const delay=gunnerySoundDelay(position,ear,temperature()),at=clock+delay;
    if(report){
      const existing=arrivals.find(a=>a.report&&a.id===id&&Math.abs(a.at-at)<.10&&Math.hypot(a.position.x-position.x,a.position.z-position.z)<120);
      if(existing){
        const n=existing.count+1;
        existing.position={x:(existing.position.x*existing.count+position.x)/n,y:(existing.position.y*existing.count+position.y)/n,z:(existing.position.z*existing.count+position.z)/n};
        existing.count=n;existing.gain=Math.min(.66,gain*Math.sqrt(n));
        return true;
      }
    }
    if(arrivals.length>=maxArrivals){
      const quiet=arrivals.findIndex(a=>!a.report);
      if(!report||quiet<0)return false;
      arrivals.splice(quiet,1);
    }
    arrivals.push({id,position:{...position},at,gain,report,count:1,range:distance,rate,options});
    return true;
  }
  return {
    order(id,boat){
      if(!(id in GUNNERY_ORDER_SECONDS)||!available())return false;
      if(id===lastOrder&&clock-lastOrderAt<.8)return false;
      const position=positionOf(boat);if(!position)return false;
      lastOrder=id;lastOrderAt=clock;
      if(id.startsWith('fire-')||id==='cease'){pendingReady=null;if(id==='cease')pendingGiveFire=null;}
      const elevation=boat?.gunnery||Number.isFinite(boat?.gunneryElevation)?(boat.gunneryElevation??0):null;
      const request={id,position,elevation};
      if(clock<voiceUntil){pendingOrder=request;return true;}
      return startOrder(request);
    },
    event(event){
      if(!event||!available())return false;
      const position=positionOf(event);if(!position)return false;
      if(event.type==='give-fire'){
        pendingReady=null;
        if(clock<voiceUntil){pendingGiveFire={position};return true;}
        return playSpeech('captain-guns-give-fire',position);
      }
      if(event.type==='casualty-scream'){
        if(clock-lastScreamAt<0.12)return false;
        lastScreamAt=clock;
        const isOverboard=Boolean(event.overboard||event.cause==='overboard'||event.cause==='aloft');
        const clip=event.crowd?'crowd-panic':isOverboard?(event.sex==='female'?'scream-female':'scream-overboard'):(event.sex==='female'?'scream-female':'scream-male');
        return enqueue(clip,position,event.gain??(WORLD_AUDIO_ASSETS[clip]?.gain??.28),false,event.rate??1,{reach:event.reach??85});
      }
      if(event.type==='timber-crumble'||event.type==='tree-fall'){
        return enqueue('timber-crumble',position,event.gain??.36,false,event.type==='tree-fall'?.82:(event.rate??1),{reach:event.reach??110});
      }
      if(event.type==='stone-crumble'||event.type==='masonry-collapse'){
        return enqueue('stone-crumble',position,event.gain??.38,false,event.collapsed?.84:(event.rate??1),{reach:event.reach??120});
      }
      if(event.type==='mast-snap'){
        enqueue('mast-snap',position,event.gain??.42,false,event.rate??.96,{reach:event.reach??135});
        return enqueue('timber-crumble',position,.30,false,.88,{offset:.14,reach:110});
      }
      if(event.type==='enemy-voice'){
        const minCooldown=event.action==='fire'?2.2:1.8;
        if(clock-lastEnemyVoiceAt<minCooldown)return false;
        const ear=listener();
        if(Math.hypot(position.x-ear.x,position.y-(ear.y??0),position.z-ear.z)>450)return false;
        lastEnemyVoiceAt=clock;
        const clip=event.action==='boarding'?'enemy-boarding-cry':event.action==='surrender'?'enemy-surrender-cry':'enemy-fire-order';
        return enqueue(clip,position,event.gain??.26,false,event.rate??1,{reach:event.reach??95});
      }
      if(event.type==='town-panic'){
        if(clock-lastPanicAt<1.2)return false;
        lastPanicAt=clock;
        return enqueue('crowd-panic',position,event.gain??.30,false,event.rate??1,{reach:event.reach??135});
      }
      if(event.type==='shot'){
        pendingReady=null;
        // IDs identify discharges, not permanent guns, so reloads remain audible. Every ship and fort battery
        // counts its own shots from one, so a number means nothing without the gun that fired it.
        const shot=event.shotId??event.id??null,key=shot===null?null:gunToken(event.gun)+shot;
        if(key!==null){
          if(seenShots.has(key))return false;
          seenShots.add(key);shotHistory.push(key);
          if(shotHistory.length>128)seenShots.delete(shotHistory.shift());
        }
        if(isArrowAmmo(event.ammo))return enqueue('bow-release',position,.26,false,1,{duration:.34,highpassHz:120,reach:45});
        const played=enqueue('cannon-report',position,.43,true,1,{reach:REPORT_REACH_M});
        const ear=listener();
        if(Math.hypot(position.x-ear.x,position.y-(ear.y??0),position.z-ear.z)<80&&clock-lastMechanical>.28){
          enqueue('cannon-recoil',position,.19);lastMechanical=clock;
        }
        return played;
      }
      if(event.type==='ready'){
        if(clock-lastReadyAt<8)return false;
        lastReadyAt=clock;pendingReady={position};return true;
      }
      if(event.type==='impact'){
        if(clock-lastImpactAt<0.045&&event.kind!=='magazine-explosion')return false;
        lastImpactAt=clock;
        const rep=event.damageReport??event;
        const casualties=event.casualties??rep.casualties??0;
        if((casualties>0||event.scream)&&clock-lastScreamAt>=0.35){
          lastScreamAt=clock;
          enqueue((event.sex??rep.sex)==='female'?'scream-female':'scream-male',position,.28,false,1,{reach:85});
        }
        if(isArrowAmmo(event.ammo))return enqueue('footstep-deck',position,.22,false,1.35,{duration:.28,highpassHz:240,reach:35});
        const kind=event.kind??(event.hitZone?'vessel':'water');
        if(kind==='magazine-explosion'){
          enqueue('cannon-report',position,.64,true,.58,{lowpassHz:420});
          enqueue('thunder-near',position,.55,true,.78,{duration:3.5,lowpassHz:360});
          enqueue('timber-crumble',position,.46,false,.82,{reach:140});
          return enqueue('timber-creak',position,.48,false,1.55,{offset:.12,duration:.85,highpassHz:220});
        }
        if(kind==='water'){
          const isGrape=event.ammo==='grape';
          return enqueue(isGrape?'hull-slap':'anchor-splash',position,isGrape?.22:.34,false,isGrape?1.35:.96,{duration:isGrape?.44:.88,release:.22,highpassHz:140});
        }
        if(kind==='rigging'||event.hitZone==='rigging'){
          if(event.mastSnap||rep.mastSnap||event.mastSpring||rep.mastSpring){
            enqueue('mast-snap',position,.42,false,(event.mastSnap||rep.mastSnap)?.95:1.12,{reach:135});
          }
          enqueue('hull-slap',position,.28,false,1.45,{duration:.42,release:.14,highpassHz:420});
          return enqueue('timber-creak',position,.26,false,1.35,{offset:.35,duration:.65,highpassHz:300});
        }
        if(kind==='scenery'){
          const felled=Boolean(event.felled||rep.felled);
          enqueue('cannon-recoil',position,.24,false,1.08,{duration:.42,lowpassHz:820});
          return enqueue('timber-crumble',position,felled?.38:.28,false,felled?.84:1.06,{reach:105});
        }
        if(kind==='building'){
          const isTimber=Boolean(event.materialClass==='timber'||event.timberClass||rep.timberClass);
          const collapsed=Boolean(event.collapsed||rep.collapsed);
          enqueue('cannon-recoil',position,.28,false,.85,{duration:.52,lowpassHz:680});
          enqueue('cannon-rammer',position,.22,false,.78,{duration:.38});
          if(isTimber){
            return enqueue('timber-crumble',position,collapsed?.38:.30,false,collapsed?.85:1.02,{reach:115});
          }
          return enqueue('stone-crumble',position,collapsed?.40:.32,false,collapsed?.84:1,{reach:120});
        }
        if(kind==='terrain'){
          enqueue('cannon-recoil',position,.28,false,.85,{duration:.52,lowpassHz:680});
          enqueue('cannon-rammer',position,.22,false,.78,{duration:.38});
          return enqueue('stone-crumble',position,.26,false,.74,{lowpassHz:920,reach:100});
        }
        // Hull / superstructure timber impact & oak splinters
        enqueue('cannon-recoil',position,.35,false,1.18,{duration:.48,lowpassHz:920});
        enqueue('hull-slap',position,.30,false,.84,{duration:.44,release:.16});
        enqueue('timber-crumble',position,.32,false,.96,{reach:95});
        return enqueue('timber-creak',position,.38,false,1.42,{offset:.10,duration:.65,highpassHz:240});
      }
      const id=event.type==='load'||event.type==='ram'?'cannon-rammer':event.type==='run-out'?'cannon-run-out':null;
      if(!id||clock-lastMechanical<.65)return false;
      const ear=listener();
      if(Math.hypot(position.x-ear.x,position.y-(ear.y??0),position.z-ear.z)>100)return false;
      lastMechanical=clock;return enqueue(id,position,.17);
    },
    update(dt){
      clock+=Math.max(0,Number.isFinite(dt)?dt:0);
      if(!available()){this.clear();return;}
      // Voice exchanges are independent of gun reports. Readiness is received
      // from the actual core ready transition, never an assumed load timer.
      if(clock>=voiceUntil){
        if(pendingOrder){const next=pendingOrder;pendingOrder=null;startOrder(next);}
        else if(pendingGiveFire){const next=pendingGiveFire;pendingGiveFire=null;playSpeech('captain-guns-give-fire',next.position);}
        else if(pendingReady){const next=pendingReady;pendingReady=null;playSpeech('crew-guns-ready',next.position);}
      }
      arrivals.sort((a,b)=>a.at-b.at);
      while(arrivals.length&&arrivals[0].at<=clock){
        const event=arrivals.shift();
        if(event.options!==undefined||(event.rate!==undefined&&event.rate!==1)){
          play(event.id,event.gain*Math.exp(-event.range/18000),event.position,event.rate??1,true,event.options);
        }else{
          play(event.id,event.gain*Math.exp(-event.range/18000),event.position,1,true);
        }
      }
    },
    clear(){arrivals.length=0;pendingOrder=null;pendingGiveFire=null;pendingReady=null;voiceUntil=clock;lastOrder='';lastOrderAt=-100;lastReadyAt=-100;lastImpactAt=-100;lastScreamAt=-100;lastEnemyVoiceAt=-100;lastPanicAt=-100;seenShots.clear();shotHistory.length=0;},
    get pending(){return arrivals.length;},
    get busy(){return clock<voiceUntil;},
  };
}
