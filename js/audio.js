import { SOUND_ASSETS } from './audio-assets.js';
import { VOICE_ASSETS, CREW_VOICES } from './voice-assets.js';
import { createVoiceDirector } from './voice-lines.js';
import { GUNNERY_AUDIO_ASSETS } from './gunnery-audio-assets.js';
import { WORLD_AUDIO_ASSETS } from './world-audio-assets.js';
import { createGunneryAudio } from './gunnery-audio.js';
import { weatherClamp, weatherAudioLevels, createHullAudioState, createTimberAudioState } from './weather-state.js';
import { CREW_WALK_CLIP_SECONDS, CREW_WALK_CYCLE_METRES } from './crew-motion.js';
import { WALKER_WORDS, ROUTE_STEP_M } from './town-streets.js';

const ALL_SOUNDS={...SOUND_ASSETS,...VOICE_ASSETS,...GUNNERY_AUDIO_ASSETS,...WORLD_AUDIO_ASSETS};
// Wind, weather, the hull, the crew's voices, footsteps and the guns are decoded when sound is enabled. What
// belongs to a place or an occasion (a shore, a town, a people, a sighting, a battle's wreckage and the
// captain's ten spoken gun-laying orders) is fetched and decoded when it is first wanted.
const BATTLE_SOUNDS=Object.freeze(['timber-crumble','stone-crumble','mast-snap',
  ...Object.keys(ALL_SOUNDS).filter(id=>id.startsWith('enemy-')||id.startsWith('captain-guns-lay-'))]);
const ON_DEMAND_SOUNDS=new Set([...BATTLE_SOUNDS,'shore-surf','shore-birds','town-ambience','crowd-panic',
  ...Object.keys(ALL_SOUNDS).filter(id=>id.startsWith('indigenous-')||id.startsWith('lookout-'))]);
const EAGER_SOUNDS=Object.freeze(Object.keys(ALL_SOUNDS).filter(id=>!ON_DEMAND_SOUNDS.has(id)));
// A clip asked for before it is decoded still starts if it is ready this soon; later than that its moment
// has passed. An order must be prompter, because the next line waits only for its stated length.
const LATE_START_SECONDS=1.5,ORDER_LATE_START_SECONDS=.4;
// A loop wanted only now and then is stopped once it has been silent this long.
const LOOP_REST_SECONDS=8;
// The shore and the nearest town are looked for this often, not every frame.
const PLACE_PROBE_SECONDS=.25;
// Speech has voices of its own, so falling timber cannot crowd out an order.
const speechSound=id=>/^(captain-|crew-|lookout-|enemy-|indigenous-)/.test(id);
const orderSound=id=>id.startsWith('captain-')||id.startsWith('crew-guns-');
// A long tail may overlap itself once; no shorter effect stacks more than three deep.
const sameSoundLimit=seconds=>seconds>=2?2:3;

// Integrated loudness (LUFS) & true-peak dB measured by SoundCraft 0.18.0 (`assets/artcraft/soundcraft-loudness-audit.json`).
export const SOUNDCRAFT_LUFS_AUDIT=Object.freeze({
  'cannon-report':Object.freeze({lufs:-23.62,peakDb:-8.51,truePeakDb:-8.49,targetLufs:-14.0,trimGain:2.3679}),
  'cannon-recoil':Object.freeze({lufs:-19.21,peakDb:-6.48,truePeakDb:-6.36,targetLufs:-18.5,trimGain:1.0847}),
  'cannon-rammer':Object.freeze({lufs:-26.94,peakDb:-7.32,truePeakDb:-7.05,targetLufs:-20.0,trimGain:2.0057}),
  'cannon-run-out':Object.freeze({lufs:-25.29,peakDb:-8.76,truePeakDb:-8.76,targetLufs:-19.5,trimGain:1.9475}),
  'captain-guns-give-fire':Object.freeze({lufs:-18.95,peakDb:-7.48,truePeakDb:-7.48,targetLufs:-16.0,trimGain:1.4039}),
  'crew-guns-ready':Object.freeze({lufs:-18.95,peakDb:-7.07,truePeakDb:-7.03,targetLufs:-16.5,trimGain:1.3255}),
  'lookout-sail-ho':Object.freeze({lufs:-19.64,peakDb:-7.02,truePeakDb:-7.00,targetLufs:-16.0,trimGain:1.5199}),
  'lookout-land-ho':Object.freeze({lufs:-18.35,peakDb:-8.13,truePeakDb:-8.13,targetLufs:-16.0,trimGain:1.3105}),
  'lookout-whale-ho':Object.freeze({lufs:-18.85,peakDb:-6.48,truePeakDb:-6.45,targetLufs:-16.0,trimGain:1.3888}),
});
export function soundcraftLufsTrim(id){
  return SOUNDCRAFT_LUFS_AUDIT[id]?.trimGain??1;
}

export function indigenousVoiceClipForCulture(cultureId=''){
  const id=String(cultureId??'').toLowerCase();
  if(id.includes('kalinago')||id.includes('lesser-antilles'))return 'indigenous-kalinago';
  if(id.includes('algonquian')||id.includes('abenaki')||id.includes('powhatan')||id.includes('mid-atlantic'))return 'indigenous-algonquian';
  if(id.includes('tupinamba')||id.includes('tupi')||id.includes('brazil')||id.includes('guiana'))return 'indigenous-tupinamba';
  if(id.includes('maya')||id.includes('mesoamerica')||id.includes('yucatan'))return 'indigenous-maya';
  return 'indigenous-taino';
}

export function probeShorelineSurf(arg1,arg2,settings={},weather={}){
  const isFirstTerrain=Boolean(arg1&&(typeof arg1.height==='function'||typeof arg1.heightAt==='function'||Array.isArray(arg1.ports)||arg1.port));
  const listener=isFirstTerrain?arg2:arg1;
  const terrain=isFirstTerrain?arg1:arg2;
  if(!listener||!terrain)return {active:false,nearShore:false,distance:Infinity,shoreDistance:Infinity,gain:0,lapGain:0,pan:0,rate:1,breakerIntensity:0,shorePosition:null};
  const sampleH=typeof terrain.heightAt==='function'
    ?(x,z)=>terrain.heightAt(x,z)
    :typeof terrain.height==='function'
      ?(x,z)=>terrain.height(x,z)
      :null;
  let bestDist=Infinity,bestX=listener.x,bestZ=listener.z,slope=0.15;
  if(sampleH){
    const h0=Number(sampleH(listener.x,listener.z));
    const distances=[8,18,36,68,115,175,250];
    const dirs=8;
    for(let i=0;i<dirs;i++){
      const angle=(i*Math.PI*2)/dirs;
      const dx=Math.cos(angle),dz=Math.sin(angle);
      let prevD=0,prevH=Number.isFinite(h0)?h0:-10;
      for(const d of distances){
        const x=listener.x+dx*d,z=listener.z+dz*d;
        const h=Number(sampleH(x,z));
        if(!Number.isFinite(h))continue;
        // Surf breaks where the ground passes through the waterline between two probes. Low ground
        // inland is not a shore, however near sea level it lies.
        const crossesShore=(prevH<=0.35&&h>=-0.45)||(prevH>=-0.45&&h<=0.35);
        if(crossesShore&&d<bestDist){
          const frac=prevH!==h?weatherClamp((0-prevH)/(h-prevH),0,1):0.5;
          bestDist=prevD+(d-prevD)*frac;
          bestX=listener.x+dx*bestDist;
          bestZ=listener.z+dz*bestDist;
          slope=Math.abs(h-prevH)/Math.max(1,d-prevD);
          break;
        }
        prevD=d;prevH=h;
      }
    }
  }
  const ports=Array.isArray(terrain.ports)?terrain.ports:terrain.port?[terrain.port]:[];
  for(const port of ports){
    const px=port?.harbourX??port?.x??port?.center?.x??port?.center?.[0],pz=port?.harbourZ??port?.z??port?.center?.z??port?.center?.[1];
    if(!Number.isFinite(px)||!Number.isFinite(pz))continue;
    const d=Math.hypot(px-listener.x,pz-listener.z);
    if(d<bestDist){bestDist=d;bestX=px;bestZ=pz;}
  }
  if(!Number.isFinite(bestDist)||bestDist>260){
    return {active:false,nearShore:false,distance:Infinity,shoreDistance:Infinity,gain:0,lapGain:0,pan:0,rate:1,breakerIntensity:0,shorePosition:null};
  }
  const wind=Number.isFinite(settings.windSpeed)?settings.windSpeed:6;
  const swell=Number.isFinite(settings.swellHs)?settings.swellHs:Number.isFinite(settings.swell1Height)?settings.swell1Height:0.6;
  const storm=Number.isFinite(weather?.intensity)?weather.intensity:0;
  const breakerIntensity=weatherClamp((wind/18)*0.45+(swell/2.4)*0.35+storm*0.25+Math.min(0.2,slope*0.5),0.12,1);
  const atten=1/(1+Math.max(0,bestDist-10)/58);
  const gain=weatherClamp((0.09+breakerIntensity*0.24)*atten,0,0.34);
  const dx=bestX-listener.x,dz=bestZ-listener.z,horiz=Math.hypot(dx,dz)||1;
  const rx=Number.isFinite(listener.rx)?listener.rx:Number.isFinite(listener.rightX)?listener.rightX:1;
  const rz=Number.isFinite(listener.rz)?listener.rz:Number.isFinite(listener.rightZ)?listener.rightZ:0;
  const pan=weatherClamp((dx*rx+dz*rz)/horiz,-1,1)*0.82;
  const rate=weatherClamp(1.12-breakerIntensity*0.24,0.84,1.14);
  const active=gain>0.008;
  return {active,nearShore:active,distance:bestDist,shoreDistance:bestDist,gain,lapGain:gain,pan,rate,breakerIntensity,shorePosition:{x:bestX,y:0,z:bestZ}};
}

export function computeTownAmbienceState(arg1,arg2,arg3={}){
  const isFirstPorts=Array.isArray(arg1)||Boolean(arg1&&(Array.isArray(arg1.ports)||arg1.port));
  const listener=isFirstPorts?arg2:arg1;
  const terrain=isFirstPorts?arg1:arg2;
  const opts=typeof arg3==='number'?{sunElev:arg3}:(arg3??{});
  const sunElev=opts.sunElev??25,time=opts.time??0,underFire=Boolean(opts.underFire);
  const ports=Array.isArray(terrain)?terrain:Array.isArray(terrain?.ports)?terrain.ports:terrain?.port?[terrain.port]:[];
  if(!listener||!ports.length){
    return {active:false,nearTown:false,distance:Infinity,gain:0,crowdGain:0,pan:0,underFire:false,hasIndigenous:false,cultureId:null,position:null,livingBuildings:0,livingPeople:0,dayFactor:1};
  }
  let nearest=null,bestDist=Infinity,bestX=0,bestZ=0;
  for(const port of ports){
    const px=port?.x??port?.harbourX??port?.center?.x??port?.center?.[0],pz=port?.z??port?.harbourZ??port?.center?.z??port?.center?.[1];
    if(!Number.isFinite(px)||!Number.isFinite(pz))continue;
    let d=Math.hypot(px-listener.x,pz-listener.z);
    let hx=px,hz=pz;
    const samples=port?.streets?.samples;
    if(samples&&samples.length>=4){
      for(let k=0;k<samples.length;k+=24){
        const sx=samples[k],sz=samples[k+2];
        const sd=Math.hypot(sx-listener.x,sz-listener.z);
        if(sd<d){d=sd;hx=sx;hz=sz;}
      }
    }
    if(d<bestDist){bestDist=d;nearest=port;bestX=hx;bestZ=hz;}
  }
  if(!nearest||bestDist>320){
    return {active:false,nearTown:false,distance:Infinity,gain:0,crowdGain:0,busyWalkGain:0,pan:0,underFire:false,hasIndigenous:false,cultureId:null,position:null,livingBuildings:0,livingPeople:0,dayFactor:1};
  }
  const instances=Array.isArray(nearest.instances)?nearest.instances:[];
  const livingBuildings=instances.length?instances.filter(inst=>!inst?.damage?.collapsed&&inst?.damageState?.state!=='ruined').length:12;
  const rawPeople=nearest.streets?.people??nearest.townsfolk?.people??0;
  const livingPeople=typeof rawPeople==='number'?rawPeople:Array.isArray(rawPeople)?rawPeople.filter(p=>p&&p.alive!==false&&!p.dead).length:0;
  const dayFactor=sunElev>2?1:sunElev>-6?0.58:0.28;
  const popFactor=weatherClamp(livingBuildings*0.035+Math.min(18,livingPeople)*0.025+0.22,0.15,1);
  const streetsUnderFire=nearest.streets?.underFireFrames!==undefined?nearest.streets.underFireFrames>0:(nearest.streets?.underFireCount>0);
  const portUnderFire=Boolean(underFire||(nearest.underFireUntil&&time<nearest.underFireUntil)||streetsUnderFire||(nearest.streets?.fleeTimer>0)||(nearest.townsfolk?.fleeTimer>0));
  const atten=1/(1+Math.max(0,bestDist-14)/68);
  const gain=weatherClamp(0.25*popFactor*dayFactor*atten,0,0.28);
  const walkAtten=bestDist<110?1/(1+Math.max(0,bestDist-8)/28):0;
  const busyWalkGain=livingPeople>0&&sunElev>-4?weatherClamp(0.095*popFactor*dayFactor*walkAtten,0,0.11):0;
  const dx=bestX-listener.x,dz=bestZ-listener.z,horiz=Math.hypot(dx,dz)||1;
  const rx=Number.isFinite(listener.rx)?listener.rx:Number.isFinite(listener.rightX)?listener.rightX:1;
  const rz=Number.isFinite(listener.rz)?listener.rz:Number.isFinite(listener.rightZ)?listener.rightZ:0;
  const pan=weatherClamp((dx*rx+dz*rz)/horiz,-1,1)*0.8;
  // Every port carries a settlement profile and a culture; only the profile's own flag says people live there.
  const ind=nearest.indigenousSettlement??null;
  const hasIndigenous=Boolean(ind?.hasIndigenousSettlement||nearest.hasIndigenousSettlement);
  const cultureId=ind?.cultureId??ind?.polityId??nearest.cultureId??null;
  const active=gain>0.008&&livingBuildings>0;
  return {
    active,
    nearTown:active,
    distance:bestDist,
    gain,
    crowdGain:gain,
    busyWalkGain,
    pan,
    underFire:portUnderFire,
    hasIndigenous,
    cultureId,
    position:{x:bestX,y:2,z:bestZ},
    livingBuildings,
    livingPeople,
    dayFactor
  };
}

export function computeHullFloodingAudioState(boat,vessels=[],listener={x:0,y:0,z:0}){
  const list=[];
  if(boat)list.push(boat);
  if(Array.isArray(vessels)){
    for(const v of vessels){
      const ship=v?.boat??v;
      if(ship&&!list.includes(ship))list.push(ship);
    }
  }
  let inflowActive=false,inflowRate=0,inflowGain=0,inflowPosition=null,bestInflowScore=0;
  let sinkingActive=false,sinkingIntensity=0,sinkingGain=0,sinkingPosition=null,bestSinkScore=0;
  for(const ship of list){
    const dmg=ship?.damage;
    if(!dmg||dmg.settledWreck)continue;
    const sx=ship.x??0,sy=ship.heave??0,sz=ship.z??0;
    const d=Math.hypot(sx-listener.x,sy-(listener.y??0),sz-listener.z);
    if(d>160)continue;
    let holeFlow=0,hx=sx,hy=sy,hz=sz;
    if(Array.isArray(dmg.holes)){
      const hRad=(ship.heading??0)*Math.PI/180,sinH=Math.sin(hRad),cosH=Math.cos(hRad);
      for(const hole of dmg.holes){
        const f=Math.max(hole?.flow??0,(hole?.submerged??0)*0.35);
        if(f>holeFlow){
          holeFlow=f;
          const lp=hole?.local??hole?.localPosition;
          if(Array.isArray(lp)||ArrayBuffer.isView(lp)){
            hx=sx+lp[2]*sinH+lp[0]*cosH;
            hy=sy+(lp[1]??0);
            hz=sz+lp[2]*cosH-lp[0]*sinH;
          }
        }
      }
    }
    const breachFlow=Math.max(holeFlow,(dmg.waterlineBreachArea??0)*2.5,(dmg.floodingRate??0)*0.8);
    if(breachFlow>0.015){
      const atten=1/(1+Math.max(0,d-6)/26);
      const score=breachFlow*atten;
      if(score>bestInflowScore){
        bestInflowScore=score;
        inflowActive=true;
        inflowRate=breachFlow;
        inflowGain=weatherClamp((0.12+Math.min(0.22,breachFlow*0.25))*atten,0.02,0.32);
        inflowPosition={x:hx,y:hy,z:hz};
      }
    }
    const isSinking=Boolean(dmg.sunk||(dmg.sinkingDepth??0)>0.05||(dmg.floodingTonnes??0)>32||(dmg.floodingLevel??0)>0.35);
    if(isSinking){
      const intensity=weatherClamp(
        (dmg.sunk?0.85:0)+Math.min(0.6,(dmg.sinkingDepth??0)/2.5)+Math.min(0.5,(dmg.floodingTonnes??0)/28)+Math.min(0.5,dmg.floodingLevel??0),
        0.2,1
      );
      const atten=1/(1+Math.max(0,d-8)/42);
      const score=intensity*atten;
      if(score>bestSinkScore){
        bestSinkScore=score;
        sinkingActive=true;
        sinkingIntensity=intensity;
        sinkingGain=weatherClamp((0.16+intensity*0.20)*atten,0.03,0.36);
        sinkingPosition={x:sx,y:sy,z:sz};
      }
    }
  }
  return {
    inflowActive,
    inflowRate,
    holeInflow:inflowRate,
    inflowGain,
    inflowPosition,
    holePosition:inflowPosition,
    sinkingActive,
    sinkingIntensity,
    sinkingGain,
    sinkingPosition,
  };
}

// What the footstep listener keeps between frames: each walker's last counted footfall, held weakly so a
// port's people are released with the port, and when a step last sounded.
export function createFootstepMemory(){return {steps:new WeakMap(),towns:new WeakMap(),lastStepAt:-10};}
// Two footfalls to a walk cycle. walkTime runs in seconds of the walk clip (crewAdvanceWalk), not in radians.
function footfallIndex(walkTime,clipSeconds){
  return Math.floor(walkTime/((clipSeconds>0?clipSeconds:CREW_WALK_CLIP_SECONDS)/2));
}
// Townsfolk are drawn on the GPU from one rule of the clock (the ABOUT branch of TOWNSFOLK_WALK in
// js/wgsl/townsfolk.js). This is that rule for one walker: where they stand and how far they have walked
// this leg of their day, or null while they are indoors or at home after dark.
export function townWalkerStride(streets,index,clock,sunY=1,out={position:{x:0,y:0,z:0},walked:0,stopped:false,cycle:0},
  words=new Uint32Array(streets.walkers.buffer,streets.walkers.byteOffset,streets.walkers.length)){
  const w=streets.walkers,at=index*WALKER_WORDS,route=streets.samples;
  const first=words[at],count=words[at+1],phase=w[at+2],speed=w[at+3],side=w[at+4],pauseAt=w[at+5],pauseFor=w[at+6],indoors=w[at+7],length=w[at+8],abroad=w[at+9],flags=words[at+11];
  if(!(count>=2)||!(speed>0))return null;
  const dusk=weatherClamp((sunY+.1)/.24,0,1);
  if(abroad>.1+.9*dusk*dusk*(3-2*dusk))return null;
  const walking=length/speed,leg=walking+pauseFor+indoors;
  const turns=clock/(2*leg)+phase,turn=(turns-Math.floor(turns))*2*leg;
  const back=turn>=leg,inLeg=turn-(back?leg:0);
  const arrived=inLeg>=walking+pauseFor;
  if(arrived&&((flags>>(back?1:2))&1)===0)return null;
  const stopAt=walking*pauseAt;
  const walked=Math.min(length,(Math.min(inLeg,stopAt)+Math.max(0,inLeg-stopAt-pauseFor))*speed);
  const metres=back?length-walked:walked,lane=back?-1:1;
  const along=metres/ROUTE_STEP_M,i=Math.min(Math.floor(Math.max(along,0)),count-2),t=weatherClamp(along-i,0,1);
  const a=(first+i)*4,b=a+4,ahead=(first+Math.min(i+3,count-1))*4,behind=(first+Math.max(i-2,0))*4;
  const fx=route[ahead]-route[behind]+1e-4,fz=route[ahead+2]-route[behind+2],fl=Math.hypot(fx,fz)||1;
  const room=route[a+3]+(route[b+3]-route[a+3])*t,aside=lane*side*room;
  out.position.x=route[a]+(route[b]-route[a])*t+fz/fl*aside;
  out.position.y=route[a+1]+(route[b+1]-route[a+1])*t;
  out.position.z=route[a+2]+(route[b+2]-route[a+2])*t-fx/fl*aside;
  out.walked=walked;
  out.stopped=arrived||(pauseFor>0&&inLeg>=stopAt&&inLeg<stopAt+pauseFor);
  // The walk clip's frame follows the ground covered, as the shader draws it.
  out.cycle=walked/CREW_WALK_CYCLE_METRES+phase*7;
  return out;
}
const TOWN_STEP_REACH_M=18,TOWN_STEP_UNSEEN=-2147483648;
// Footfalls of the townsfolk within earshot. opts.clock is the frame clock the GPU walks them by.
function townFootfalls(memory,port,listener,clock,sunY,share,events){
  const streets=port?.streets;
  if(!streets||!(streets.people>0)||!streets.walkers||!streets.samples||!Number.isFinite(clock))return;
  let town=memory.towns.get(streets);
  if(!town){
    const s=streets.samples,box=[Infinity,-Infinity,Infinity,-Infinity];
    for(let k=0;k<s.length;k+=4){box[0]=Math.min(box[0],s[k]);box[1]=Math.max(box[1],s[k]);box[2]=Math.min(box[2],s[k+2]);box[3]=Math.max(box[3],s[k+2]);}
    const w=streets.walkers,people=Math.min(streets.people,Math.floor(w.length/WALKER_WORDS));
    town={box,words:new Uint32Array(w.buffer,w.byteOffset,w.length),last:new Int32Array(people).fill(TOWN_STEP_UNSEEN),
      stride:{position:{x:0,y:0,z:0},walked:0,stopped:false,cycle:0}};
    memory.towns.set(streets,town);
  }
  const {box,words,last,stride}=town,reach=TOWN_STEP_REACH_M+3;
  const outside=listener.x<box[0]-reach||listener.x>box[1]+reach||listener.z<box[2]-reach||listener.z>box[3]+reach;
  // A walker the guns have frightened runs by a clock kept on the GPU, which nothing here can read.
  if(outside||streets.underFireFrames>0){last.fill(TOWN_STEP_UNSEEN);return;}
  const shown=Math.min(last.length,Math.max(1,Math.round(streets.people*share)));
  for(let index=0;index<shown;index++){
    const here=townWalkerStride(streets,index,clock,sunY,stride,words);
    if(!here||here.stopped){last[index]=TOWN_STEP_UNSEEN;continue;}
    const step=Math.floor(here.cycle*2),before=last[index];
    last[index]=step;
    if(before===TOWN_STEP_UNSEEN||step<=before||events.length>=2)continue;
    const p=here.position,d=Math.hypot(p.x-listener.x,p.y-(listener.y??0),p.z-listener.z);
    if(d>TOWN_STEP_REACH_M)continue;
    events.push({kind:'ground',surface:'ground',id:'footstep-ground',position:{x:p.x,y:p.y,z:p.z},gain:0.050/(1+d/6.0),rate:0.92+((step&1)*0.07)+((step&3)*0.015)});
  }
}

// Footsteps due this frame, two at most, from the captain's own walk, the crew on deck, the garrison on the
// ramparts and the townsfolk ashore. memory comes from createFootstepMemory and is the caller's to keep.
export function collectFootstepEvents(memory,opts={}){
  if(!memory?.steps)return [];
  const {boat,crew=[],fortSoldiers=null,ports=[],listener={x:0,y:0,z:0}}=opts;
  const time=Number.isFinite(opts.time)?opts.time:null;
  if(time!==null&&time-memory.lastStepAt<0.24)return [];
  const steps=memory.steps,events=[];
  const D2R=Math.PI/180;
  if(boat&&Number.isFinite(boat.deckWalkX)&&Number.isFinite(boat.deckWalkZ)){
    const prev=steps.get(boat);
    if(prev&&Number.isFinite(prev.x)){
      const moved=Math.hypot(boat.deckWalkX-prev.x,boat.deckWalkZ-prev.z);
      if(moved>=0.78){
        const h=(boat.heading??0)*D2R,sinH=Math.sin(h),cosH=Math.cos(h);
        const wx=(boat.x??0)+boat.deckWalkZ*sinH+boat.deckWalkX*cosH;
        const wz=(boat.z??0)+boat.deckWalkZ*cosH-boat.deckWalkX*sinH;
        prev.step++;prev.x=boat.deckWalkX;prev.z=boat.deckWalkZ;
        events.push({kind:'deck',surface:'deck',id:'footstep-deck',position:{x:wx,y:(boat.heave??0)+1.5,z:wz},gain:0.065,rate:0.92+(prev.step&1)*0.07});
      }
    }else steps.set(boat,{x:boat.deckWalkX,z:boat.deckWalkZ,step:0});
  }
  // Has this walker's foot come down since it was last looked at? A walker seen for the first time is only noted.
  const landed=s=>{
    const step=footfallIndex(s.walkTime,s.walkClipDuration),before=steps.get(s);
    if(before===undefined)steps.set(s,{step});else if(step!==before.step){const forward=step>before.step;before.step=step;if(forward)return step;}
    return -1;
  };
  const roster=Array.isArray(crew)&&crew.length?crew:(boat?.crew?.state?.crew??[]);
  if(boat&&Array.isArray(roster)){
    const h=(boat.heading??0)*D2R,sinH=Math.sin(h),cosH=Math.cos(h);
    for(const s of roster){
      if(!s||typeof s!=='object'||s.visible===false||s.dead||s.casualtyState==='fallen'||s.incapacitated||s.overboard||(s.walk??0)<=0.18||!Number.isFinite(s.walkTime))continue;
      const step=landed(s);
      if(step<0||events.length>=2)continue;
      const sx=s.position?.[0]??s.x??0,sy=s.position?.[1]??s.y??1.2,sz=s.position?.[2]??s.z??0;
      const wx=(boat.x??0)+sz*sinH+sx*cosH;
      const wy=(boat.heave??0)+sy;
      const wz=(boat.z??0)+sz*cosH-sx*sinH;
      const d=Math.hypot(wx-listener.x,wy-(listener.y??0),wz-listener.z);
      if(d<=16)events.push({kind:'deck',surface:'deck',id:'footstep-deck',position:{x:wx,y:wy,z:wz},gain:0.055/(1+d/5.5),rate:0.91+((step&1)*0.07)+((step&3)*0.015)});
    }
  }
  const garrisons=fortSoldiers?.state?.garrisons??(fortSoldiers?.state?.soldiers?[fortSoldiers.state]:fortSoldiers?.soldiers?[fortSoldiers]:[]);
  if(Array.isArray(garrisons)){
    for(const g of garrisons){
      for(const s of g?.soldiers??[]){
        if(!s||typeof s!=='object'||s.visible===false||s.dead||s.casualtyState==='fallen'||s.falling||(s.walk??0)<=0.18||!Number.isFinite(s.walkTime))continue;
        const step=landed(s);
        if(step<0||events.length>=2)continue;
        const sx=s.x??s.position?.[0]??0,sy=s.y??s.position?.[1]??2,sz=s.z??s.position?.[2]??0;
        const d=Math.hypot(sx-listener.x,sy-(listener.y??0),sz-listener.z);
        if(d<=18)events.push({kind:'ground',surface:'ground',id:'footstep-ground',position:{x:sx,y:sy,z:sz},gain:0.052/(1+d/6.0),rate:0.91+((step&1)*0.07)+((step&3)*0.015)});
      }
    }
  }
  const clock=opts.clock,sunY=Number.isFinite(opts.sunY)?opts.sunY:1,share=weatherClamp(opts.townShare??1,0,1);
  for(const port of Array.isArray(ports)?ports:[])townFootfalls(memory,port,listener,clock,sunY,share,events);
  if(events.length&&time!==null)memory.lastStepAt=time;
  return events;
}

// One context, bounded ambience sources, and three bounded sets of event voices: twelve gun reports, four
// spoken voices, and eight for everything else. Nothing is fetched or started until the listener enables
// sound with a browser gesture.
export function createSceneAudio({onStatus=()=>{}}={}){
  let context,master,limiter,loading,enabled=false,hidden=false,ready=false,volume=.7;
  let time=0,nextBird=25,nextShoreBird=8,nextFirePop=0,nextBubbleAt=0,nextTownPanic=0,nextIndigenousVoice=4,nextSailLuffAt=0;
  let lastScreamAt=-100,lastOarStrokeAt=-100,prevRowPhase=null,lastLookoutKind=null,lastLookoutCallAt=-100;
  let listener={x:0,y:2,z:0,rx:1,rz:0},shipDistance=1,anchorReeling=false,anchorPosition={x:0,y:0,z:0},previewCursor=0,previewUntil=0;
  let footsteps=createFootstepMemory(),epoch=0,battleWarmed=false,warmedCulture=null;
  let shoreProbe=null,townProbe=null,nextProbeAt=0,probedTerrain=null,probedTowns=null;
  const buffers=new Map(),decoding=new Map(),failed=new Set(),loops=new Map(),pending=[];
  const voices=new Set(),reports=new Set(),speech=new Set(),playing=new Map();
  // missing counts the clips that could not be fetched or decoded, not those that have yet to be asked for.
  const status=()=>onStatus({enabled,ready,loading:!!loading,missing:failed.size});
  const mute=()=>{if(context)master.gain.setTargetAtTime(enabled&&!hidden?volume:0,context.currentTime,.06);};
  const dialogue=createVoiceDirector({play:(...args)=>play(...args,true),assets:VOICE_ASSETS,crew:CREW_VOICES,available:()=>enabled&&!hidden&&ready&&context?.state==='running'&&context.currentTime>=previewUntil});
  const gunsAudio=createGunneryAudio({play,listener:()=>listener,available:()=>enabled&&!hidden&&ready&&context?.state==='running'});
  const hullAudio=createHullAudioState(),timberAudio=createTimberAudioState();
  const panTo=p=>{const dx=p.x-listener.x,dz=p.z-listener.z;return weatherClamp((dx*listener.rx+dz*listener.rz)/(Math.hypot(dx,dz)||1),-1,1);};
  function stopEvents(){
    dialogue.clear();gunsAudio.clear();hullAudio.reset();timberAudio.reset();footsteps=createFootstepMemory();
    previewUntil=0;prevRowPhase=null;lastLookoutKind=null;nextProbeAt=0;epoch++;
    for(const source of [...playing.keys()]){try{source.stop();}catch{/* already ended */}}
    voices.clear();reports.clear();speech.clear();playing.clear();pending.length=0;
  }
  // Fetch and decode one clip, once. A failure is remembered until sound is next enabled.
  function load(id){
    if(!context||!ALL_SOUNDS[id]||buffers.has(id)||failed.has(id))return null;
    let job=decoding.get(id);
    if(!job){
      job=(async()=>{
        const response=await fetch(ALL_SOUNDS[id].url);if(!response.ok)throw Error('Sound unavailable: '+id);
        buffers.set(id,await context.decodeAudioData(await response.arrayBuffer()));
      })().catch(()=>{failed.add(id);if(ready)status();}).finally(()=>{decoding.delete(id);});
      decoding.set(id,job);
    }
    return job;
  }
  // The clips of a battle are wanted together, and soon after its first order.
  function warmBattle(){
    if(battleWarmed||!enabled||!ready)return;
    battleWarmed=true;for(const id of BATTLE_SOUNDS)load(id);
  }
  // The garrison queues its cries for us to sound. Unheard, they are dropped as they come and not kept for later.
  function drainFortCries(fort,each){
    const drain=list=>{if(!Array.isArray(list)||!list.length)return;if(each)for(const cry of list.splice(0))each(cry);else list.length=0;};
    drain(fort?.state?.audioEvents);drain(fort?.audioEvents);
    if(Array.isArray(fort?.state?.garrisons))for(const garrison of fort.state.garrisons)drain(garrison?.audioEvents);
  }
  function creak(sound){if(sound&&shipDistance>.01)play(sound.id,sound.gain*shipDistance,sound.position,sound.rate,sound.spatial,sound.options);}
  // Free a voice's place at once; it fades over a few hundredths of a second so that it does not click off.
  function cutShort(source){
    const voice=playing.get(source),at=context.currentTime;
    voice.pool.delete(source);
    try{
      if(typeof voice.level.gain.cancelScheduledValues==='function')voice.level.gain.cancelScheduledValues(at);
      voice.level.gain.setTargetAtTime(0,at,.012);source.stop(at+.05);
    }catch{/* already ended */}
  }
  // Returns the seconds the clip will sound for, or nothing when it cannot be played.
  function play(id,gain,position,rate=1,spatial=false,options={}){
    if(!enabled||hidden||!ready||context.state!=='running')return;
    if(buffers.has(id))return start(id,gain,position,rate,spatial,options);
    const job=ON_DEMAND_SOUNDS.has(id)?load(id):null;
    if(!job)return;
    // Not decoded yet: the caller is told how long the clip runs, and it starts if it is ready while it still matters.
    const asked=context.currentTime,from=epoch,where={x:position.x,y:position.y??position.heave??0,z:position.z};
    job.then(()=>{
      if(from===epoch&&buffers.has(id)&&enabled&&!hidden&&context.currentTime-asked<=(orderSound(id)?ORDER_LATE_START_SECONDS:LATE_START_SECONDS))start(id,gain,where,rate,spatial,options);
    });
    const seconds=ALL_SOUNDS[id].seconds;
    return Math.min(seconds-Math.min(options.offset??0,seconds),Number.isFinite(options.duration)?Math.max(.02,options.duration):seconds)/rate;
  }
  function start(id,gain,position,rate,spatial,options){
    if(context.state!=='running')return;
    const pool=id==='cannon-report'?reports:speechSound(id)?speech:voices,limit=pool===reports?12:pool===speech?4:8;
    const buffer=buffers.get(id);
    const offset=weatherClamp(options.offset??0,0,Math.max(0,buffer.duration-.01));
    const duration=Math.min(buffer.duration-offset,Number.isFinite(options.duration)?Math.max(.02,options.duration):buffer.duration),seconds=duration/rate;
    if(pool===voices){
      // No one sound may take every voice.
      let same=0;for(const source of pool)if(playing.get(source).id===id)same++;
      if(same>=sameSoundLimit(seconds))return;
    }
    if(pool.size>=limit){
      // An order is not lost to chatter: it takes the place of the oldest voice that is not itself an order.
      if(pool!==speech||!orderSound(id))return;
      let oldest=null;
      for(const source of pool){oldest??=source;if(!orderSound(playing.get(source).id)){oldest=source;break;}}
      cutShort(oldest);
    }
    const source=context.createBufferSource(),level=context.createGain(),pan=context.createStereoPanner();
    source.buffer=buffer;source.playbackRate.value=rate;
    const dx=position.x-listener.x,dz=position.z-listener.z,d=Math.hypot(dx,dz);
    pan.pan.value=weatherClamp((dx*listener.rx+dz*listener.rz)/Math.max(d,1),-1,1)*.85;
    const range=Math.hypot(dx,(position.y??position.heave??0)-listener.y,dz);
    // The loudness trim is applied to the clamped gain, not clamped with it: a trim above one would otherwise
    // flatten every loud call of that clip to the same level. The limiter on the master follows.
    level.gain.value=weatherClamp(gain,0,1)*soundcraftLufsTrim(id)*(spatial?1/(1+Math.max(0,range-8)/(options.reach??24)):1);
    const filters=[];let tail=source;
    if(typeof context.createBiquadFilter==='function'){
      for(const[type,hz]of[['highpass',options.highpassHz],['lowpass',options.lowpassHz]])if(Number.isFinite(hz)){
        const filter=context.createBiquadFilter();filter.type=type;filter.frequency.value=hz;filter.Q.value=.6;tail.connect(filter);tail=filter;filters.push(filter);
      }
    }
    tail.connect(level).connect(pan).connect(master);pool.add(source);playing.set(source,{id,pool,level});
    if((options.attack||options.release)&&typeof level.gain.setValueAtTime==='function'&&typeof level.gain.linearRampToValueAtTime==='function'){
      const at=context.currentTime,target=level.gain.value,attack=Math.min(seconds*.3,options.attack??0),release=Math.min(seconds*.8,options.release??0);
      level.gain.setValueAtTime(0,at);level.gain.linearRampToValueAtTime(target,at+attack);
      level.gain.setValueAtTime(target,at+Math.max(attack,seconds-release));level.gain.linearRampToValueAtTime(0,at+seconds);
    }
    source.onended=()=>{pool.delete(source);playing.delete(source);source.disconnect();for(const filter of filters)filter.disconnect();level.disconnect();pan.disconnect();};
    source.start(0,offset,duration);return seconds;
  }
  function playSynth(kind,position=listener,gain=0.25){
    if(!enabled||hidden||!ready||!context||context.state!=='running'||voices.size>=8||typeof context.createOscillator!=='function')return false;
    const now=context.currentTime;
    const dx=(position?.x??listener.x)-listener.x,dz=(position?.z??listener.z)-listener.z,d=Math.hypot(dx,dz);
    const range=Math.hypot(dx,((position?.y??position?.heave??0)-listener.y),dz);
    const atten=1/(1+Math.max(0,range-8)/28);
    const effGain=weatherClamp(gain*atten,0,0.85);
    if(effGain<0.005)return false;
    const pan=context.createStereoPanner();
    pan.pan.value=weatherClamp((dx*listener.rx+dz*listener.rz)/Math.max(d,1),-1,1)*0.85;
    pan.connect(master);
    if(kind==='sword'||kind==='grapple'){
      const freqs=kind==='sword'?[1480,2320,3640]:[620,1140,1890];
      const dur=kind==='sword'?0.22:0.34;
      for(let i=0;i<freqs.length;i++){
        const osc=context.createOscillator(),g=context.createGain();
        osc.type=i===0?'triangle':'sine';
        const detune=0.94+Math.random()*0.12;
        osc.frequency.setValueAtTime(freqs[i]*detune,now);
        osc.frequency.exponentialRampToValueAtTime(freqs[i]*detune*0.88,now+dur);
        g.gain.setValueAtTime(0.001,now);
        g.gain.linearRampToValueAtTime(effGain/(i+1.2),now+0.006);
        g.gain.exponentialRampToValueAtTime(0.0008,now+dur);
        osc.connect(g).connect(pan);
        osc.start(now);osc.stop(now+dur+0.01);
        if(i===0)osc.onended=()=>pan.disconnect();
      }
      return true;
    }
    if(kind==='spyglass'){
      const osc=context.createOscillator(),g=context.createGain();
      osc.type='triangle';
      osc.frequency.setValueAtTime(520,now);
      osc.frequency.exponentialRampToValueAtTime(1180,now+0.065);
      g.gain.setValueAtTime(0.001,now);
      g.gain.linearRampToValueAtTime(effGain*0.65,now+0.008);
      g.gain.exponentialRampToValueAtTime(0.0008,now+0.075);
      osc.connect(g).connect(pan);
      osc.start(now);osc.stop(now+0.08);
      osc.onended=()=>pan.disconnect();
      return true;
    }
    if(kind==='bell'){
      const partials=[880,1760,2420];
      for(let i=0;i<partials.length;i++){
        const osc=context.createOscillator(),g=context.createGain();
        osc.type='sine';
        osc.frequency.setValueAtTime(partials[i],now);
        const dur=1.45/(i+1);
        g.gain.setValueAtTime(0.001,now);
        g.gain.linearRampToValueAtTime(effGain*0.55/(i+1),now+0.008);
        g.gain.exponentialRampToValueAtTime(0.0006,now+dur);
        osc.connect(g).connect(pan);
        osc.start(now);osc.stop(now+dur+0.02);
        if(i===0)osc.onended=()=>pan.disconnect();
      }
      return true;
    }
    if(kind==='surrender-drum'){
      const osc=context.createOscillator(),g=context.createGain();
      osc.type='sine';
      osc.frequency.setValueAtTime(128,now);
      osc.frequency.exponentialRampToValueAtTime(58,now+0.42);
      g.gain.setValueAtTime(0.001,now);
      g.gain.linearRampToValueAtTime(effGain*0.85,now+0.012);
      g.gain.exponentialRampToValueAtTime(0.0008,now+0.45);
      osc.connect(g).connect(pan);
      osc.start(now);osc.stop(now+0.46);
      osc.onended=()=>pan.disconnect();
      return true;
    }
    pan.disconnect();
    return false;
  }
  // Called every frame a loop is wanted: it starts as soon as its clip is decoded.
  function startLoop(id,asset){
    if(!asset?.loop||loops.has(id))return;
    if(!buffers.has(id)){load(id);return;}
    const source=context.createBufferSource(),gain=context.createGain(),pan=typeof context.createStereoPanner==='function'?context.createStereoPanner():null;
    source.buffer=buffers.get(id);
    source.loop=true;source.loopEnd=Math.min(asset.seconds,source.buffer.duration);gain.gain.value=0;
    if(pan)source.connect(gain).connect(pan).connect(master);
    else source.connect(gain).connect(master);
    source.start(0,Math.random()*source.loopEnd);loops.set(id,{source,gain,pan,silentSince:null});
  }
  function stopLoop(id){
    const loop=loops.get(id);if(!loop)return;
    loops.delete(id);
    try{loop.source.stop();}catch{/* already ended */}
    loop.source.disconnect();loop.gain.disconnect();loop.pan?.disconnect();
  }
  function startLoops(){
    for(const [id,asset] of Object.entries(ALL_SOUNDS))if(id!=='anchor-reel'&&!asset.lazyLoop)startLoop(id,asset);
  }
  async function enable(){
    if(!context){
      const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Audio)throw Error('Web Audio is unavailable.');
      context=new Audio();master=context.createGain();master.gain.value=0;limiter=context.createDynamicsCompressor();
      limiter.threshold.value=-10;limiter.knee.value=12;limiter.ratio.value=5;limiter.attack.value=.003;limiter.release.value=.2;
      master.connect(limiter).connect(context.destination);
    }
    enabled=true;
    const resumePromise=context.resume().catch(()=>{});
    mute();
    if(!loading){
      // Whatever failed last time is tried again, here or when it is next wanted.
      failed.clear();battleWarmed=false;warmedCulture=null;
      if(EAGER_SOUNDS.some(id=>!buffers.has(id)))loading=Promise.all(EAGER_SOUNDS.map(id=>load(id))).then(()=>{ready=true;loading=null;startLoops();status();});
    }
    status();await loading;await resumePromise;timberAudio.reset();
  }
  return {
    get enabled(){return enabled;},get ready(){return ready;},
    enable,
    resume(){if(enabled&&context&&context.state!=='running')context.resume().then(()=>mute()).catch(()=>{});},
    async toggle(){
      if(enabled){enabled=false;stopEvents();mute();await context?.suspend();status();}
      else try{await enable();}catch(error){enabled=false;mute();status();throw error;}
    },
    visibility(value){hidden=value;stopEvents();if(context){if(hidden)context.suspend();else if(enabled)context.resume().catch(()=>{});}mute();},
    order(id,options){return dialogue.order(id,options);},
    gunneryOrder(id,boat){warmBattle();return gunsAudio.order(id,boat);},
    gunneryEvent(event){warmBattle();return gunsAudio.event(event);},
    previewCrew(id,boat){
      if(dialogue.busy||(context?.currentTime??0)<previewUntil)return false;
      const person=CREW_VOICES.find(p=>p.id===id)??CREW_VOICES[previewCursor++%Math.max(1,CREW_VOICES.length)];
      const duration=person&&play('crew-'+person.id,.6,boat??listener,1,true);
      if(duration>0){previewUntil=context.currentTime+duration+.1;return person.name;}return false;
    },
    anchor(event,boat){
      if(!event)return;
      anchorPosition={x:event.x??boat?.x??0,y:event.y??boat?.heave??0,z:event.z??boat?.z??0};
      if(event.type==='reel-start')anchorReeling=true;
      else if(event.type==='reel-stop'||event.type==='secured')anchorReeling=false;
      else if(event.type==='splash')play('anchor-splash',.6,anchorPosition,1,true,{duration:.88,release:.22});
      else if(event.type==='drop')play('anchor-release',.4,anchorPosition,1,true);
    },
    hullContact(contact){if(enabled&&!hidden&&ready)timberAudio.contact(contact);return hullAudio.contact(contact);},
    hullUnderside(event){
      if(enabled&&!hidden&&ready){const accepted=hullAudio.underside(event);if(accepted)creak(timberAudio.underside(event));return accepted;}
      return false;
    },
    impact(event){
      if(!enabled||hidden||!ready)return;
      const sound=hullAudio.impact(event);if(sound)play(sound.id,sound.gain*shipDistance,sound.position,sound.rate,true,sound.options);
      creak(timberAudio.impact(event));
    },
    event(ev,boat){
      if(!ev||!enabled||hidden||!ready)return false;
      const pos=ev.position??ev.worldPosition??ev.vessel??boat??listener;
      const p=Array.isArray(pos)||ArrayBuffer.isView(pos)
        ?{x:pos[0]??listener.x,y:pos[1]??listener.y,z:pos[2]??listener.z}
        :{x:pos.x??listener.x,y:pos.y??pos.heave??listener.y,z:pos.z??listener.z};
      switch(ev.type){
        case 'overboard':
        case 'falling-from-aloft':
        case 'fell-from-aloft':
        case 'casualty-scream':{
          if(ev.propagate)return gunsAudio.event({...ev,type:'casualty-scream',position:p});
          if(time-lastScreamAt<0.35)return false;
          lastScreamAt=time;
          const sex=ev.sex??ev.sailor?.sex??'male';
          const isOverboard=Boolean(ev.overboard||ev.type==='overboard'||ev.type==='falling-from-aloft'||ev.cause==='overboard'||ev.cause==='aloft');
          const clip=ev.crowd?'crowd-panic':isOverboard?(sex==='female'?'scream-female':'scream-overboard'):(sex==='female'?'scream-female':'scream-male');
          play(clip,ev.gain??0.30,p,ev.rate??(0.96+Math.random()*0.08),true,{reach:ev.reach??85});
          return true;
        }
        case 'timber-crumble':
        case 'tree-fall':
          if(ev.propagate)return gunsAudio.event({...ev,position:p});
          play('timber-crumble',ev.gain??0.36,p,ev.type==='tree-fall'?0.82:(ev.rate??1),true,{reach:ev.reach??110});
          return true;
        case 'stone-crumble':
        case 'masonry-collapse':
          if(ev.propagate)return gunsAudio.event({...ev,position:p});
          play('stone-crumble',ev.gain??0.38,p,ev.collapsed?0.84:(ev.rate??1),true,{reach:ev.reach??120});
          return true;
        case 'mast-snap':
          if(ev.propagate)return gunsAudio.event({...ev,position:p});
          play('mast-snap',ev.gain??0.42,p,ev.rate??0.96,true,{reach:ev.reach??135});
          play('timber-creak',0.32,p,1.28,true,{offset:0.15,duration:0.8,reach:110});
          return true;
        case 'water-bubble':
        case 'hull-flooding':
          play('water-bubble',ev.gain??0.30,p,ev.rate??1,true,{reach:ev.reach??48});
          return true;
        case 'enemy-voice':{
          if(ev.propagate)return gunsAudio.event({...ev,position:p});
          const clip=ev.action==='boarding'?'enemy-boarding-cry':ev.action==='surrender'?'enemy-surrender-cry':'enemy-fire-order';
          play(clip,ev.gain??0.34,p,ev.rate??1,true,{reach:ev.reach??125});
          return true;
        }
        case 'indigenous-voice':{
          const clip=indigenousVoiceClipForCulture(ev.cultureId);
          play(clip,ev.gain??0.30,p,ev.rate??1,true,{reach:ev.reach??95});
          return true;
        }
        case 'lookout-sighting':
        case 'lookout-call':{
          if(ev.kind===lastLookoutKind&&time-lastLookoutCallAt<14)return false;
          if(ev.kind!==lastLookoutKind&&time-lastLookoutCallAt<14&&ev.fromUpdate)return false;
          lastLookoutKind=ev.kind??'ship';
          lastLookoutCallAt=time;
          const isLand=ev.kind==='land';
          const isMarine=ev.kind==='whale'||ev.kind==='dolphin'||ev.kind==='humpback'||ev.kind==='sperm-whale'||ev.kind==='orca';
          const clip=isLand?'lookout-land-ho':isMarine?'lookout-whale-ho':'lookout-sail-ho';
          // Play only the crisp Spanish masthead hail ("¡Vela!" / "¡Tierra!" / "¡Ballena!") without the long bilingual studio readout
          play(clip,ev.gain??0.26,{x:p.x,y:(p.y??0)+11,z:p.z},ev.rate??0.98,true,{duration:0.95,release:0.22,reach:ev.reach??75});
          return true;
        }
        case 'town-panic':
          if(ev.propagate)return gunsAudio.event({...ev,position:p});
          play('crowd-panic',ev.gain??0.30,p,ev.rate??1,true,{reach:ev.reach??135});
          return true;
        case 'oar-stroke':
          play('oar-stroke',ev.gain??0.22,p,ev.rate??(0.95+Math.random()*0.1),true,{reach:ev.reach??38});
          return true;
        case 'sail-luff':
          play('sail-luff',ev.gain??0.24,p,ev.rate??(0.95+Math.random()*0.1),true,{reach:ev.reach??42});
          return true;
        case 'footstep-deck':
          play('footstep-deck',ev.gain??0.06,p,ev.rate??(0.92+Math.random()*0.10),true,{duration:0.22,attack:0.015,release:0.12,lowpassHz:1650,reach:ev.reach??14});
          return true;
        case 'footstep-ground':
          play('footstep-ground',ev.gain??0.055,p,ev.rate??(0.92+Math.random()*0.10),true,{duration:0.22,attack:0.015,release:0.12,lowpassHz:1850,reach:ev.reach??16});
          return true;
        case 'dock-start':
          play('wind-strong',.28,p,1.65,true,{offset:.2,duration:.42,highpassHz:520});
          play('timber-creak',.24,p,1.25,true,{offset:.1,duration:.55});
          return true;
        case 'grapple-start':
          playSynth('grapple',p,.36);
          play('anchor-release',.38,p,1.18,true,{duration:.85});
          return true;
        case 'making-fast':
          play('timber-creak',.32,p,1.12,true,{offset:.15,duration:.95});
          play('cannon-run-out',.22,p,.92,true,{duration:.75});
          return true;
        case 'dock-complete':
          play('cannon-rammer',.34,p,.78,true,{duration:.48});
          play('hull-slap',.25,p,.72,true,{duration:.44,release:.16,lowpassHz:540});
          return true;
        case 'cast-off-start':
          play('anchor-release',.28,p,1.22,true,{duration:.65});
          play('hull-slap',.26,p,1.15,true,{duration:.44,release:.16});
          return true;
        case 'boarding-round':{
          playSynth('sword',p,.34);
          if(((ev.round??1)%2)===1){
            play('cannon-report',.24,p,1.68,true,{duration:.26,highpassHz:340});
            play('enemy-boarding-cry',.28,p,1,true,{reach:95});
          }else{
            play('cannon-rammer',.26,p,1.35,true,{duration:.35});
          }
          const voice=CREW_VOICES[(ev.round??0)%Math.max(1,CREW_VOICES.length)];
          if(voice)play('crew-'+voice.id,.32,p,.96+((ev.round??0)%3)*.05,true,{duration:.65});
          return true;
        }
        case 'vessel-captured':{
          playSynth('bell',p,.35);
          const v1=CREW_VOICES[0],v2=CREW_VOICES[1];
          if(v1)play('crew-'+v1.id,.46,p,1.04,true);
          if(v2)play('crew-'+v2.id,.38,p,.98,true,{offset:.08});
          return true;
        }
        case 'boarding-repulsed':
          playSynth('surrender-drum',p,.38);
          play('timber-creak',.30,p,.82,true,{duration:.9});
          return true;
        case 'prize-disposition':
          if(ev.disposition==='scuttle-repair'){
            play('cannon-rammer',.36,p,1.28,true,{duration:.45});
            play('timber-creak',.34,p,1.35,true,{offset:.2,duration:.85});
            play('anchor-splash',.32,p,.88,true,{duration:.88,release:.22});
          }else{
            play('cannon-run-out',.28,p,1.08,true,{duration:.75});
          }
          return true;
        case 'sail-handling':
          play('sail-luff',.22,p,1.02,true,{duration:1.4,reach:42});
          play('hull-slap',.22,p,1.38,true,{duration:.42,highpassHz:320});
          play('timber-creak',.20,p,1.28,true,{offset:.3,duration:.55,highpassHz:260});
          return true;
        case 'spyglass':
          return playSynth('spyglass',listener,.28);
        case 'surrender':
          playSynth('surrender-drum',p,.42);
          play('enemy-surrender-cry',.32,p,1,true,{reach:115});
          play('timber-creak',.26,p,.92,true,{duration:.8});
          return true;
        case 'watch-bell':
          return playSynth('bell',p,.30);
        default:
          return false;
      }
    },
    update(dt,settings,boat,frame,weather,activeFires=null,worldState=null){
      time+=dt;volume=weatherClamp(settings.soundVolume??.7);
      listener.x=frame[16];listener.y=frame[17];listener.z=frame[18];
      const right=Math.hypot(frame[20],frame[22])||1;listener.rx=frame[20]/right;listener.rz=frame[22]/right;
      shipDistance=boat.showProw?1/(1+Math.max(0,Math.hypot(boat.x-listener.x,boat.z-listener.z)-boat.length*.5)/18):0;
      dialogue.update(dt);
      gunsAudio.update(dt);
      const flow={speed:boat.surgeVelocity??0,leeway:boat.leewayVelocity??0,heading:boat.heading??0,
        currentSurge:boat.currentSurge??0,currentSway:boat.currentSway??0,
        currentX:boat.currentX??settings.currentX??0,currentZ:boat.currentZ??settings.currentZ??0};
      const hullMix=hullAudio.update(dt,flow);
      const strain=Math.abs(boat.rollVelocity??0)*2+Math.abs(boat.pitchVelocity??0)+Math.abs(boat.heaveVelocity??0)*.08;
      const timberSound=timberAudio.update(dt,{strain,position:boat,revision:boat.revision,audible:enabled&&!hidden&&ready&&shipDistance>.01});
      if(!enabled||hidden||!ready){drainFortCries(worldState?.fortSoldiers);return;}
      if(anchorReeling){anchorPosition={x:boat.x,y:(boat.heave??0)+3,z:boat.z};startLoop('anchor-reel',ALL_SOUNDS['anchor-reel']);}
      mute();
      const wind=boat.enabled?(boat.sailState?.apparentSpeed??settings.windSpeed):settings.windSpeed;
      const levels=weatherAudioLevels({wind,...flow,intensity:weather.intensity,type:weather.type,ship:shipDistance});
      levels['hull-wash']=hullMix.wash*shipDistance;

      // Where the nearest shore and town lie changes slowly, so they are looked for a few times a second; which
      // ear they fall on follows the listener every frame.
      const terrain=worldState?.terrain??boat?.terrain??null;
      const townSource=worldState?.ports??terrain;
      const sunElev=worldState?.sunElev??settings.sunElev??25;
      // The caller may hand over a fresh list of the same ports each frame, so a list is known by its first port.
      const towns=Array.isArray(townSource)?townSource[0]??null:townSource;
      if(time>=nextProbeAt||terrain!==probedTerrain||towns!==probedTowns){
        shoreProbe=probeShorelineSurf(listener,terrain,settings,weather);
        townProbe=computeTownAmbienceState(listener,townSource,{sunElev,time,underFire:Boolean(worldState?.underFire)});
        probedTerrain=terrain;probedTowns=towns;nextProbeAt=time+PLACE_PROBE_SECONDS;
        if(shoreProbe.active||townProbe.active)load('shore-birds');
      }
      const shore=shoreProbe,townState=townProbe;

      // Shoreline surf crashing & lapping
      if(shore.active){
        startLoop('shore-surf',ALL_SOUNDS['shore-surf']);
        levels['shore-surf']=shore.gain;
        const surfLoop=loops.get('shore-surf');
        if(surfLoop){
          surfLoop.source.playbackRate.value=shore.rate;
          if(surfLoop.pan)surfLoop.pan.pan.value=panTo(shore.shorePosition)*.82;
        }
      }else{
        levels['shore-surf']=0;
      }

      // Busy towns ambience (multi-person walking + unintelligible background crowd chatter) & bombardment panic
      if(townState.active){
        const townPan=panTo(townState.position)*.8;
        startLoop('town-ambience',ALL_SOUNDS['town-ambience']);
        levels['town-ambience']=townState.underFire?townState.gain*0.35:townState.gain;
        const townLoop=loops.get('town-ambience');
        if(townLoop?.pan)townLoop.pan.pan.value=townPan;
        if(townState.underFire){
          startLoop('crowd-panic',ALL_SOUNDS['crowd-panic']);
          levels['crowd-panic']=Math.min(0.26,townState.gain*1.15);
          const panicLoop=loops.get('crowd-panic');
          if(panicLoop){
            panicLoop.source.playbackRate.value=1.0;
            if(panicLoop.pan)panicLoop.pan.pan.value=townPan;
          }
          if(time>=nextTownPanic&&townState.position){
            playSynth('bell',townState.position,0.20);
            nextTownPanic=time+8.5+Math.random()*5.5;
          }
        }else if(townState.busyWalkGain>0.006){
          // There is no clip of a peaceful crowd yet: the panic loop, slowed and quiet, stands in for one.
          startLoop('crowd-panic',ALL_SOUNDS['crowd-panic']);
          levels['crowd-panic']=townState.busyWalkGain;
          const panicLoop=loops.get('crowd-panic');
          if(panicLoop){
            panicLoop.source.playbackRate.value=0.88;
            if(panicLoop.pan)panicLoop.pan.pan.value=townPan;
          }
        }else{
          levels['crowd-panic']=0;
        }
      }else{
        levels['town-ambience']=0;
        levels['crowd-panic']=0;
      }

      // Native American languages at sovereign Indigenous settlements or Taíno canoes
      let indigenousCulture=townState.hasIndigenous&&townState.distance<220?townState.cultureId:null;
      let indigenousPos=townState.position;
      if(!indigenousCulture){
        if(boat?.modelId==='taino-canoe'&&shipDistance>0.1){
          indigenousCulture=boat.cultureId??'taino-greater-antilles';
          indigenousPos={x:boat.x,y:(boat.heave??0)+1.5,z:boat.z};
        }else if(Array.isArray(worldState?.vessels)){
          for(const v of worldState.vessels){
            const vs=v?.boat??v;
            if(!vs)continue;
            if(v?.faction==='indigenous-confederacy'||vs?.modelId==='taino-canoe'){
              const d=Math.hypot((vs.x??0)-listener.x,(vs.z??0)-listener.z);
              if(d<160){
                indigenousCulture=v?.cultureId??vs?.cultureId??'taino-greater-antilles';
                indigenousPos={x:vs.x??0,y:(vs.heave??0)+1.5,z:vs.z??0};
                break;
              }
            }
          }
        }
      }
      if(indigenousCulture&&indigenousPos){
        // Their speech is fetched when they are first in earshot, ahead of the first words.
        if(indigenousCulture!==warmedCulture){warmedCulture=indigenousCulture;load(indigenousVoiceClipForCulture(indigenousCulture));}
        if(time>=nextIndigenousVoice){
          // The long wait follows only words that were spoken; with every voice taken they try again shortly.
          const spoken=play(indigenousVoiceClipForCulture(indigenousCulture),0.26,indigenousPos,0.97+Math.random()*0.06,true,{reach:95})>0;
          nextIndigenousVoice=time+(spoken?12+Math.random()*16:1.5);
        }
      }

      // Coastal shorebirds near land/ports
      if(((shore.active&&shore.distance<260)||(townState.active&&townState.distance<300))&&sunElev>-8&&(weather?.intensity??0)<0.75&&time>=nextShoreBird){
        const birdPos=shore.shorePosition??townState.position??listener;
        play('shore-birds',0.18,{x:birdPos.x,y:birdPos.y+6,z:birdPos.z},0.95+Math.random()*0.1,true,{reach:120});
        nextShoreBird=time+14+Math.random()*24;
      }

      // Bubbling & gurgling water escaping a flooding or sinking ship
      const floodState=computeHullFloodingAudioState(boat,worldState?.vessels,listener);
      if((floodState.inflowActive||floodState.sinkingActive)&&time>=nextBubbleAt){
        if(floodState.sinkingActive&&floodState.sinkingPosition){
          play('water-bubble',floodState.sinkingGain,floodState.sinkingPosition,0.84+Math.random()*0.14,true,{reach:65});
          play('timber-creak',floodState.sinkingGain*0.72,floodState.sinkingPosition,0.78+Math.random()*0.14,true,{duration:0.85,lowpassHz:620,reach:65});
          nextBubbleAt=time+1.35+Math.random()*0.85;
        }else if(floodState.inflowActive&&floodState.inflowPosition){
          play('water-bubble',floodState.inflowGain,floodState.inflowPosition,1.04+Math.random()*0.16,true,{duration:1.5,highpassHz:140,reach:38});
          nextBubbleAt=time+1.75+Math.random()*1.05;
        }
      }

      // Footsteps of people walking on ship decks and on the ground
      const footstepEvents=collectFootstepEvents(footsteps,{
        boat,
        crew:worldState?.crew,
        fortSoldiers:worldState?.fortSoldiers,
        ports:worldState?.ports??(Array.isArray(terrain?.ports)?terrain.ports:terrain?.port?[terrain.port]:[]),
        listener,
        time,
        // The townsfolk are walked on the GPU by the frame's clock and sun; their footfalls are found from the same two.
        clock:frame[19],
        sunY:frame[33],
        townShare:worldState?.townShare,
      });
      for(const step of footstepEvents){
        play(step.id,step.gain,step.position,step.rate,true,{duration:0.22,attack:0.015,release:0.12,lowpassHz:step.kind==='deck'?1650:1850,reach:step.kind==='deck'?14:16});
      }

      // Drain queued fort garrison / rampart fall casualty screams
      drainFortCries(worldState?.fortSoldiers,cry=>this.event(cry,boat));

      // Rowing oarlocks & blade catch
      const rowEvs=worldState?.rowingEvents;
      if(Array.isArray(rowEvs)&&rowEvs.length&&time-lastOarStrokeAt>=0.45){
        const ev=rowEvs.find(e=>e.kind==='entry')??rowEvs[0];
        play('oar-stroke',0.22,{x:ev.x??boat.x,y:boat.heave??0,z:ev.z??boat.z},0.95+Math.random()*0.1,true,{reach:38});
        lastOarStrokeAt=time;
      }else if(boat?.rowingState){
        const rs=boat.rowingState;
        const effort=Math.max(rs.effortPort??0,rs.effortStarboard??0,boat.rowingEffort??0);
        if(effort>0.05&&(rs.rate??0)>0.05&&Number.isFinite(rs.phase)){
          const wrappedCrossing=prevRowPhase!==null&&((rs.phase<prevRowPhase&&(prevRowPhase-rs.phase)>Math.PI)||(Math.floor(rs.phase/(Math.PI*2))>Math.floor(prevRowPhase/(Math.PI*2))));
          if(wrappedCrossing&&time-lastOarStrokeAt>=0.45){
            play('oar-stroke',0.22*Math.min(1,effort+0.3),{x:boat.x,y:boat.heave??0,z:boat.z},0.95+Math.random()*0.1,true,{reach:38});
            lastOarStrokeAt=time;
          }
          prevRowPhase=rs.phase;
        }
      }

      // Sail canvas luffing / flogging when pinching into wind
      const sails=boat?.sailState;
      const sailArea=sails?.area??(((boat?.sailFore??0)+(boat?.sailMain??0)+(boat?.sailMizzen??0))*20);
      if(sails&&sailArea>1&&(sails.apparentSpeed??wind)>2.2&&shipDistance>0.05){
        const fill=Math.max(sails.squareFill??0,sails.lateenFill??0);
        const isLuffing=(sails.luffing??0)>0.25||(fill<0.26&&Math.abs(sails.apparentAngle??0)<0.85);
        if(isLuffing&&time>=nextSailLuffAt){
          play('sail-luff',Math.min(0.26,0.14+(1-fill)*0.12)*shipDistance,{x:boat.x,y:(boat.heave??0)+6,z:boat.z},0.94+Math.random()*0.12,true,{reach:42});
          nextSailLuffAt=time+2.4+Math.random()*1.8;
        }
      }

      // Lookout sighting calls when a new horizon contact is sighted
      const sight=boat?.lookoutSighting;
      if(sight?.kind&&sight.kind!=='dolphin'&&sight.kind!==lastLookoutKind&&time-lastLookoutCallAt>=14){
        this.event({type:'lookout-sighting',...sight,fromUpdate:true,position:{x:sight.x??boat.x,y:sight.y??((boat.heave??0)+12),z:sight.z??boat.z}},boat);
      }

      // Spatial shipboard fire crackle & roar when any vessel is burning nearby
      const fires=Array.isArray(activeFires)&&activeFires.length?activeFires:(boat?.damage?.worldFires??[]);
      let fireAudioLevel=0,nearestFirePos=null;
      for(const f of fires){
        if(!f?.position||!(f.intensity>0.04))continue;
        const d=Math.hypot(f.position[0]-listener.x,(f.position[1]??0)-listener.y,f.position[2]-listener.z);
        const atten=(f.intensity??0.5)/(1+Math.max(0,d-6)/22);
        if(atten>fireAudioLevel){
          fireAudioLevel=atten;
          nearestFirePos={x:f.position[0],y:f.position[1]??1.5,z:f.position[2]};
        }
      }
      if(fireAudioLevel>0.02){
        levels['sleet-deck']=Math.max(levels['sleet-deck']??0,Math.min(0.42,fireAudioLevel*0.34));
        levels['wind-strong']=Math.max(levels['wind-strong']??0,Math.min(0.32,fireAudioLevel*0.24));
        if(time>=nextFirePop&&nearestFirePos){
          play('timber-creak',Math.min(0.32,fireAudioLevel*0.28),nearestFirePos,1.45+Math.random()*0.35,true,{offset:Math.random()*1.8,duration:0.28+Math.random()*0.25,highpassHz:320});
          nextFirePop=time+0.38+Math.random()*0.65;
        }
      }
      for(const [id,loop] of loops){
        const gain=id==='anchor-reel'?(anchorReeling ? .3/(1+Math.max(0,Math.hypot(anchorPosition.x-listener.x,anchorPosition.y-listener.y,anchorPosition.z-listener.z)-8)/24):0):levels[id]??0;
        loop.gain.gain.setTargetAtTime(gain,context.currentTime,id==='anchor-reel'?.08:.45);
        // The reel, the shore and the towns are heard only now and then: once such a loop has rested a while
        // it is stopped, and started afresh when it is next wanted.
        if(gain>0)loop.silentSince=null;
        else if(id==='anchor-reel'||ALL_SOUNDS[id].lazyLoop){
          loop.silentSince??=time;
          if(time-loop.silentSince>=LOOP_REST_SECONDS)stopLoop(id);
        }
      }
      if(weather.event)pending.push({at:time+weather.event.delay,...weather.event,audioAt:time+weather.event.delay});
      for(let i=pending.length-1;i>=0;i--)if(time>=pending[i].audioAt){
        const e=pending.splice(i,1)[0];play(e.distance<1200?'thunder-near':'thunder-distant',.7/(1+e.distance/3000),e,.95+Math.random()*.1);
      }
      creak(timberSound);
      if(time>nextBird){
        const activity=weatherClamp(settings.seabirds??.25)*(1-weather.intensity)*weatherClamp(1-settings.windSpeed/24);
        if(Math.random()<activity){const a=Math.random()*Math.PI*2;play('gull-near',.16,{x:listener.x+Math.sin(a)*30,z:listener.z+Math.cos(a)*30},.97+Math.random()*.06);}
        nextBird=time+25+Math.random()*55;
      }
    },
    destroy(){stopEvents();for(const {source} of loops.values())source.stop();context?.close();},
  };
}
