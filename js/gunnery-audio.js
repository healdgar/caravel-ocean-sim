import { GUNNERY_AUDIO_ASSETS } from './gunnery-audio-assets.js';

// The simulation uses these durations even when sound is disabled: a muted
// captain does not change when the ordered discharge happens.
export const GUNNERY_ORDER_SECONDS=Object.freeze({
  prepare:GUNNERY_AUDIO_ASSETS['captain-guns-prepare'].seconds,
  'fire-port':GUNNERY_AUDIO_ASSETS['captain-guns-fire-port'].seconds,
  'fire-starboard':GUNNERY_AUDIO_ASSETS['captain-guns-fire-starboard'].seconds,
  cease:GUNNERY_AUDIO_ASSETS['captain-guns-cease'].seconds,
});
export function gunnerySoundSpeed(temperatureC=15){
  return 331.3+.606*Math.max(-30,Math.min(50,Number.isFinite(temperatureC)?temperatureC:15));
}
export function gunnerySoundDelay(source,ear,temperatureC=15){
  return Math.hypot(source.x-ear.x,(source.y??0)-(ear.y??0),source.z-ear.z)/gunnerySoundSpeed(temperatureC);
}

// Playback is supplied by the scene's one Web Audio context. Report arrivals
// within 100 ms share an acoustic voice, while every physical gun still fires.
// This gives a rolling broadside without creating fifty full-length sources.
export function createGunneryAudio({play,available=()=>true,listener=()=>({x:0,y:0,z:0}),temperature=()=>15}={}){
  let clock=0,voiceUntil=0,pendingOrder=null,pendingReady=null,lastOrder='',lastOrderAt=-100,lastMechanical=-100,lastReadyAt=-100;
  const arrivals=[],seenShots=new Set(),shotHistory=[];
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
  function startOrder(request){return playSpeech('captain-guns-'+request.id,request.position);}
  function enqueue(id,position,gain,report=false){
    const ear=listener(),distance=Math.hypot(position.x-ear.x,position.y-(ear.y??0),position.z-ear.z);
    if(!Number.isFinite(distance)||distance>18000)return false;
    const delay=gunnerySoundDelay(position,ear,temperature()),at=clock+delay;
    if(report){
      const existing=arrivals.find(a=>a.report&&Math.abs(a.at-at)<.10&&Math.hypot(a.position.x-position.x,a.position.z-position.z)<120);
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
    arrivals.push({id,position:{...position},at,gain,report,count:1,range:distance});
    return true;
  }
  return {
    order(id,boat){
      if(!(id in GUNNERY_ORDER_SECONDS)||!available())return false;
      if(id===lastOrder&&clock-lastOrderAt<.8)return false;
      const position=positionOf(boat);if(!position)return false;
      lastOrder=id;lastOrderAt=clock;
      if(id.startsWith('fire-')||id==='cease')pendingReady=null;
      const request={id,position};
      if(clock<voiceUntil){pendingOrder=request;return true;}
      return startOrder(request);
    },
    event(event){
      if(!event||!available())return false;
      const position=positionOf(event);if(!position)return false;
      if(event.type==='shot'){
        pendingReady=null;
        // IDs identify discharges, not permanent guns, so reloads remain audible.
        const key=event.shotId??(event.id!==undefined?event.id:null);
        if(key!==null){
          if(seenShots.has(key))return false;
          seenShots.add(key);shotHistory.push(key);
          if(shotHistory.length>128)seenShots.delete(shotHistory.shift());
        }
        const played=enqueue('cannon-report',position,.43,true);
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
        else if(pendingReady){const next=pendingReady;pendingReady=null;playSpeech('crew-guns-ready',next.position);}
      }
      arrivals.sort((a,b)=>a.at-b.at);
      while(arrivals.length&&arrivals[0].at<=clock){
        const event=arrivals.shift();
        play(event.id,event.gain*Math.exp(-event.range/18000),event.position,1,true);
      }
    },
    clear(){arrivals.length=0;pendingOrder=null;pendingReady=null;voiceUntil=clock;lastOrder='';lastOrderAt=-100;lastReadyAt=-100;seenShots.clear();shotHistory.length=0;},
    get pending(){return arrivals.length;},
    get busy(){return clock<voiceUntil;},
  };
}
