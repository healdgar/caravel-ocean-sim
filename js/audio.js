import { SOUND_ASSETS } from './audio-assets.js';
import { VOICE_ASSETS, CREW_VOICES } from './voice-assets.js';
import { createVoiceDirector } from './voice-lines.js';
import { weatherClamp, weatherAudioLevels } from './weather-state.js';

const ALL_SOUNDS={...SOUND_ASSETS,...VOICE_ASSETS};

// One context, bounded ambience sources and at most eight event voices. Nothing is
// fetched or started until the listener enables sound with a browser gesture.
export function createSceneAudio({onStatus=()=>{}}={}){
  let context,master,limiter,loading,enabled=false,hidden=false,ready=false,volume=.7;
  let time=0,lastSlap=-10,nextCreak=4,nextBird=25,lastRevision=-1;
  let listener={x:0,y:2,z:0,rx:1,rz:0},shipDistance=1,anchorReeling=false,anchorPosition={x:0,y:0,z:0},previewCursor=0,previewUntil=0;
  const buffers=new Map(),loops=new Map(),voices=new Set(),pending=[];
  const status=()=>onStatus({enabled,ready,loading:!!loading,missing:Object.keys(ALL_SOUNDS).length-buffers.size});
  const mute=()=>{if(context)master.gain.setTargetAtTime(enabled&&!hidden?volume:0,context.currentTime,.06);};
  const dialogue=createVoiceDirector({play:(...args)=>play(...args,true),assets:VOICE_ASSETS,crew:CREW_VOICES,available:()=>enabled&&!hidden&&ready&&context?.state==='running'&&context.currentTime>=previewUntil});
  function stopEvents(){dialogue.clear();previewUntil=0;for(const v of voices){try{v.stop();}catch{/* already ended */}}voices.clear();pending.length=0;}
  function play(id,gain,position,rate=1,spatial=false){
    if(!enabled||hidden||!ready||!buffers.has(id)||voices.size>=8||context.state!=='running')return;
    const source=context.createBufferSource(),level=context.createGain(),pan=context.createStereoPanner();
    source.buffer=buffers.get(id);source.playbackRate.value=rate;
    const dx=position.x-listener.x,dz=position.z-listener.z,d=Math.hypot(dx,dz);
    pan.pan.value=weatherClamp((dx*listener.rx+dz*listener.rz)/Math.max(d,1),-1,1)*.85;
    const range=Math.hypot(dx,(position.y??position.heave??0)-listener.y,dz);
    level.gain.value=weatherClamp(gain,0,1)*(spatial?1/(1+Math.max(0,range-8)/24):1);
    source.connect(level).connect(pan).connect(master);voices.add(source);
    source.onended=()=>{voices.delete(source);source.disconnect();level.disconnect();pan.disconnect();};source.start();return source.buffer.duration/rate;
  }
  function startLoop(id,asset){
    if(!asset?.loop||!buffers.has(id)||loops.has(id))return;
    const source=context.createBufferSource(),gain=context.createGain();source.buffer=buffers.get(id);
    source.loop=true;source.loopEnd=Math.min(asset.seconds,source.buffer.duration);gain.gain.value=0;
    source.connect(gain).connect(master);source.start(0,Math.random()*source.loopEnd);loops.set(id,{source,gain});
  }
  function startLoops(){
    for(const [id,asset] of Object.entries(ALL_SOUNDS))if(id!=='anchor-reel')startLoop(id,asset);
  }
  async function enable(){
    if(!context){
      const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Audio)throw Error('Web Audio is unavailable.');
      context=new Audio();master=context.createGain();master.gain.value=0;limiter=context.createDynamicsCompressor();
      limiter.threshold.value=-10;limiter.knee.value=12;limiter.ratio.value=5;limiter.attack.value=.003;limiter.release.value=.2;
      master.connect(limiter).connect(context.destination);
    }
    enabled=true;await context.resume();mute();
    if(buffers.size<Object.keys(ALL_SOUNDS).length&&!loading){
      loading=Promise.allSettled(Object.entries(ALL_SOUNDS).map(async([id,asset])=>{
        if(buffers.has(id))return;
        const response=await fetch(asset.url);if(!response.ok)throw Error('Sound unavailable: '+id);
        buffers.set(id,await context.decodeAudioData(await response.arrayBuffer()));
      })).then(()=>{ready=true;loading=null;startLoops();status();});
    }
    status();await loading;
  }
  return {
    get enabled(){return enabled;},get ready(){return ready;},
    async toggle(){
      if(enabled){enabled=false;stopEvents();mute();await context?.suspend();status();}
      else try{await enable();}catch(error){enabled=false;mute();status();throw error;}
    },
    visibility(value){hidden=value;stopEvents();if(context){if(hidden)context.suspend();else if(enabled)context.resume().catch(()=>{});}mute();},
    order(id,options){return dialogue.order(id,options);},
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
      else if(event.type==='splash')play('anchor-splash',.6,anchorPosition,1,true);
      else if(event.type==='drop')play('anchor-release',.4,anchorPosition,1,true);
    },
    impact(event){if(event&&time-lastSlap>.5){lastSlap=time;play('hull-slap',(.12+.2*Math.sqrt(event.strength))*shipDistance,event,.92+Math.random()*.14);}},
    update(dt,settings,boat,frame,weather){
      time+=dt;volume=weatherClamp(settings.soundVolume??.7);
      listener.x=frame[16];listener.y=frame[17];listener.z=frame[18];
      const right=Math.hypot(frame[20],frame[22])||1;listener.rx=frame[20]/right;listener.rz=frame[22]/right;
      shipDistance=boat.showProw?1/(1+Math.max(0,Math.hypot(boat.x-listener.x,boat.z-listener.z)-boat.length*.5)/18):0;
      dialogue.update(dt);
      if(!enabled||hidden||!ready)return;
      if(anchorReeling){anchorPosition={x:boat.x,y:(boat.heave??0)+3,z:boat.z};startLoop('anchor-reel',ALL_SOUNDS['anchor-reel']);}
      mute();
      if(lastRevision!==boat.revision){lastRevision=boat.revision;nextCreak=time+4;}
      const wind=boat.enabled?(boat.sailState?.apparentSpeed??settings.windSpeed):settings.windSpeed;
      const levels=weatherAudioLevels({wind,speed:boat.surgeVelocity??0,intensity:weather.intensity,type:weather.type,ship:shipDistance});
      for(const [id,loop] of loops){
        const gain=id==='anchor-reel'?(anchorReeling ? .3/(1+Math.max(0,Math.hypot(anchorPosition.x-listener.x,anchorPosition.y-listener.y,anchorPosition.z-listener.z)-8)/24):0):levels[id]??0;
        loop.gain.gain.setTargetAtTime(gain,context.currentTime,id==='anchor-reel'?.08:.45);
      }
      if(weather.event)pending.push({at:time+weather.event.delay,...weather.event,audioAt:time+weather.event.delay});
      for(let i=pending.length-1;i>=0;i--)if(time>=pending[i].audioAt){
        const e=pending.splice(i,1)[0];play(e.distance<1200?'thunder-near':'thunder-distant',.7/(1+e.distance/3000),e,.95+Math.random()*.1);
      }
      const strain=Math.abs(boat.rollVelocity??0)*2+Math.abs(boat.pitchVelocity??0)+Math.abs(boat.heaveVelocity??0)*.08;
      if(time>nextCreak&&strain>.055&&shipDistance>.01){
        play('timber-creak',weatherClamp(strain*.7,.08,.32)*shipDistance,{x:boat.x,z:boat.z},.92+Math.random()*.15);
        nextCreak=time+5+Math.random()*7;
      }
      if(time>nextBird){
        const activity=weatherClamp(settings.seabirds??.25)*(1-weather.intensity)*weatherClamp(1-settings.windSpeed/24);
        if(Math.random()<activity){const a=Math.random()*Math.PI*2;play('gull-near',.16,{x:listener.x+Math.sin(a)*30,z:listener.z+Math.cos(a)*30},.97+Math.random()*.06);}
        nextBird=time+25+Math.random()*55;
      }
    },
    destroy(){stopEvents();for(const {source} of loops.values())source.stop();context?.close();},
  };
}
