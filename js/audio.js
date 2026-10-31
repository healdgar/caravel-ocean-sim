import { SOUND_ASSETS } from './audio-assets.js';
import { VOICE_ASSETS, CREW_VOICES } from './voice-assets.js';
import { createVoiceDirector } from './voice-lines.js';
import { GUNNERY_AUDIO_ASSETS } from './gunnery-audio-assets.js';
import { createGunneryAudio } from './gunnery-audio.js';
import { weatherClamp, weatherAudioLevels, createHullAudioState, createTimberAudioState } from './weather-state.js';

const ALL_SOUNDS={...SOUND_ASSETS,...VOICE_ASSETS,...GUNNERY_AUDIO_ASSETS};

// One context, bounded ambience sources and at most eight event voices. Nothing is
// fetched or started until the listener enables sound with a browser gesture.
export function createSceneAudio({onStatus=()=>{}}={}){
  let context,master,limiter,loading,enabled=false,hidden=false,ready=false,volume=.7;
  let time=0,nextBird=25,nextFirePop=0,lastBellHalfHour=-1;
  let listener={x:0,y:2,z:0,rx:1,rz:0},shipDistance=1,anchorReeling=false,anchorPosition={x:0,y:0,z:0},previewCursor=0,previewUntil=0;
  const buffers=new Map(),loops=new Map(),voices=new Set(),reports=new Set(),pending=[];
  const status=()=>onStatus({enabled,ready,loading:!!loading,missing:Object.keys(ALL_SOUNDS).length-buffers.size});
  const mute=()=>{if(context)master.gain.setTargetAtTime(enabled&&!hidden?volume:0,context.currentTime,.06);};
  const dialogue=createVoiceDirector({play:(...args)=>play(...args,true),assets:VOICE_ASSETS,crew:CREW_VOICES,available:()=>enabled&&!hidden&&ready&&context?.state==='running'&&context.currentTime>=previewUntil});
  const gunsAudio=createGunneryAudio({play,listener:()=>listener,available:()=>enabled&&!hidden&&ready&&context?.state==='running'});
  const hullAudio=createHullAudioState(),timberAudio=createTimberAudioState();
  function stopEvents(){dialogue.clear();gunsAudio.clear();hullAudio.reset();timberAudio.reset();previewUntil=0;for(const v of [...voices,...reports]){try{v.stop();}catch{/* already ended */}}voices.clear();reports.clear();pending.length=0;}
  function creak(sound){if(sound&&shipDistance>.01)play(sound.id,sound.gain*shipDistance,sound.position,sound.rate,sound.spatial,sound.options);}
  function play(id,gain,position,rate=1,spatial=false,options={}){
    const pool=id==='cannon-report'?reports:voices,limit=id==='cannon-report'?12:8;
    if(!enabled||hidden||!ready||!buffers.has(id)||pool.size>=limit||context.state!=='running')return;
    const source=context.createBufferSource(),level=context.createGain(),pan=context.createStereoPanner();
    source.buffer=buffers.get(id);source.playbackRate.value=rate;
    const dx=position.x-listener.x,dz=position.z-listener.z,d=Math.hypot(dx,dz);
    pan.pan.value=weatherClamp((dx*listener.rx+dz*listener.rz)/Math.max(d,1),-1,1)*.85;
    const range=Math.hypot(dx,(position.y??position.heave??0)-listener.y,dz);
    level.gain.value=weatherClamp(gain,0,1)*(spatial?1/(1+Math.max(0,range-8)/24):1);
    const filters=[];let tail=source;
    for(const[type,hz]of[['highpass',options.highpassHz],['lowpass',options.lowpassHz]])if(Number.isFinite(hz)){
      const filter=context.createBiquadFilter();filter.type=type;filter.frequency.value=hz;filter.Q.value=.6;tail.connect(filter);tail=filter;filters.push(filter);
    }
    tail.connect(level).connect(pan).connect(master);pool.add(source);
    const offset=weatherClamp(options.offset??0,0,Math.max(0,source.buffer.duration-.01));
    const duration=Math.min(source.buffer.duration-offset,Number.isFinite(options.duration)?Math.max(.02,options.duration):source.buffer.duration),seconds=duration/rate;
    if(options.attack||options.release){
      const at=context.currentTime,target=level.gain.value,attack=Math.min(seconds*.3,options.attack??0),release=Math.min(seconds*.8,options.release??0);
      level.gain.setValueAtTime(0,at);level.gain.linearRampToValueAtTime(target,at+attack);
      level.gain.setValueAtTime(target,at+Math.max(attack,seconds-release));level.gain.linearRampToValueAtTime(0,at+seconds);
    }
    source.onended=()=>{pool.delete(source);source.disconnect();for(const filter of filters)filter.disconnect();level.disconnect();pan.disconnect();};source.start(0,offset,duration);return seconds;
  }
  function playSynth(kind,position=listener,gain=0.25){
    if(!enabled||hidden||!ready||!context||context.state!=='running'||voices.size>=8)return false;
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
    enabled=true;
    const resumePromise=context.resume().catch(()=>{});
    mute();
    if(buffers.size<Object.keys(ALL_SOUNDS).length&&!loading){
      loading=Promise.allSettled(Object.entries(ALL_SOUNDS).map(async([id,asset])=>{
        if(buffers.has(id))return;
        const response=await fetch(asset.url);if(!response.ok)throw Error('Sound unavailable: '+id);
        buffers.set(id,await context.decodeAudioData(await response.arrayBuffer()));
      })).then(()=>{ready=true;loading=null;startLoops();status();});
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
    gunneryOrder(id,boat){return gunsAudio.order(id,boat);},
    gunneryEvent(event){return gunsAudio.event(event);},
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
      const pos=ev.position??ev.vessel??boat??listener;
      const p={x:pos.x??listener.x,y:pos.y??pos.heave??listener.y,z:pos.z??listener.z};
      switch(ev.type){
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
          play('hull-slap',.25,p,.72,true,{duration:.52,lowpassHz:540});
          return true;
        case 'cast-off-start':
          play('anchor-release',.28,p,1.22,true,{duration:.65});
          play('hull-slap',.26,p,1.15,true,{duration:.62});
          return true;
        case 'boarding-round':{
          playSynth('sword',p,.34);
          if(((ev.round??1)%2)===1){
            play('cannon-report',.24,p,1.68,true,{duration:.26,highpassHz:340});
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
          if(ev.choice==='scuttle-repair'){
            play('cannon-rammer',.36,p,1.28,true,{duration:.45});
            play('timber-creak',.34,p,1.35,true,{offset:.2,duration:.85});
            play('anchor-splash',.32,p,.88,true,{duration:1.4});
          }else{
            play('cannon-run-out',.28,p,1.08,true,{duration:.75});
          }
          return true;
        case 'sail-handling':
          play('hull-slap',.22,p,1.38,true,{duration:.42,highpassHz:320});
          play('timber-creak',.20,p,1.28,true,{offset:.3,duration:.55,highpassHz:260});
          return true;
        case 'spyglass':
          return playSynth('spyglass',listener,.28);
        case 'surrender':
          playSynth('surrender-drum',p,.42);
          play('timber-creak',.26,p,.92,true,{duration:.8});
          return true;
        case 'watch-bell':
          return playSynth('bell',p,.30);
        default:
          return false;
      }
    },
    update(dt,settings,boat,frame,weather,activeFires=null){
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
      if(!enabled||hidden||!ready)return;
      if(anchorReeling){anchorPosition={x:boat.x,y:(boat.heave??0)+3,z:boat.z};startLoop('anchor-reel',ALL_SOUNDS['anchor-reel']);}
      mute();
      const wind=boat.enabled?(boat.sailState?.apparentSpeed??settings.windSpeed):settings.windSpeed;
      const levels=weatherAudioLevels({wind,...flow,intensity:weather.intensity,type:weather.type,ship:shipDistance});
      levels['hull-wash']=hullMix.wash*shipDistance;
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
