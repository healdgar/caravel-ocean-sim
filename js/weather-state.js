// Authored weather events, independent of the looping FFT clock and sailing speed.
export const STORM_WEATHER={rain:1,precipitation:0,thunder:.85,clouds:.94,cloudBase:.65,
  cloudDepth:4.5,cloudDensity:1.8,cloudAnvil:1,haze:7};
export const WEATHER_TYPES=['Rain','Snow','Sleet','Hail'];
export const weatherClamp=(x,lo=0,hi=1)=>Math.max(lo,Math.min(hi,Number.isFinite(x)?x:lo));

export function lightningEnvelope(age){
  // One discharge, a weaker return stroke, then a short cloud afterglow.
  if(age<0 || age>.65)return 0;
  return Math.min(1,Math.exp(-age*30)+.65*Math.exp(-Math.abs(age-.14)*70)+.15*Math.exp(-age*6));
}

export function createWeatherState(random=Math.random){
  let time=0,wait=4+random()*4,enabled=false,serial=0,strike=null;
  return {time:0,intensity:0,type:0,flash:0,strike:null,event:null,
    step(dt,settings,listener){
      dt=weatherClamp(dt,0,.1);time+=dt;this.time=time;this.event=null;
      this.intensity=weatherClamp(settings.rain);this.type=Math.round(weatherClamp(settings.precipitation,0,3));
      const storm=weatherClamp(settings.thunder),active=storm>.001;
      if(active&&!enabled)wait=4+random()*4;
      enabled=active;
      if(active){
        wait-=dt*storm;
        if(wait<=0){
          const angle=random()*Math.PI*2,distance=250+random()**1.6*3250;
          strike={serial:++serial,at:time,distance,delay:distance/343,
            x:listener.x+Math.sin(angle)*distance,z:listener.z+Math.cos(angle)*distance,
            height:weatherClamp(settings.cloudBase??1.5,.3,5)*1000,
            strength:.65+random()*.35,seed:random()*1000};
          this.event=strike;wait=9+random()*15;
        }
      }else strike=null;
      this.strike=strike;
      this.flash=strike?lightningEnvelope(time-strike.at)*strike.strength/(1+strike.distance/3500):0;
      return this;
    },
  };
}

export function hullRelativeWaterSpeed({speed=0,surge=speed,leeway=0,sway=leeway,currentSurge=0,currentSway=0,currentX=0,currentZ=0,heading=0}={}){
  const u=Number.isFinite(surge)?surge:0,v=Number.isFinite(sway)?sway:0;
  const cu=Number.isFinite(currentSurge)?currentSurge:0,cv=Number.isFinite(currentSway)?currentSway:0;
  const cx=Number.isFinite(currentX)?currentX:0,cz=Number.isFinite(currentZ)?currentZ:0;
  const h=(Number.isFinite(heading)?heading:0)*Math.PI/180;
  const worldAlong=cx*Math.sin(h)-cz*Math.cos(h),worldAcross=cx*Math.cos(h)+cz*Math.sin(h);
  return Math.hypot(u-cu-worldAlong,v-cv-worldAcross);
}

// New GPU contact serials, rather than a timer or wave height, trigger hull slaps.
// Suppress first samples and resets so loading/teleporting cannot play false impacts.
export function createImpactDetector(count=40){
  const bowLimit=Math.min(32,count),serials=new Float32Array(count).fill(-1),modestSerials=new Float32Array(bowLimit).fill(-1);
  let revision=-1;
  return {contact:null,sample(values,boatRevision,{now,staleSeconds=.35}={}){
    let event=null,modestEvent=null,wet=0,pressure=0,closing=0,relativeClosing=null,lastTroughTime=null,impact=0,weight=0,x=0,y=0,z=0,valid=0;
    const reset=revision!==boatRevision;revision=boatRevision;
    const hasModest=values?.length>=(count+bowLimit)*16;
    for(let i=0;i<count;i++){
      const at=i*16,serial=values[at+15],strength=values[at+7];
      if(!Number.isFinite(serial)||!Number.isFinite(strength)||!Number.isFinite(values[at])||!Number.isFinite(values[at+1])||!Number.isFinite(values[at+2]))continue;
      // The eight aft records force the stern wake; they are not bow slams.
      const bow=i<bowLimit,contactWet=weatherClamp(values[at+11]),rise=weatherClamp(values[at+14],-8,8);
      if(bow){
        const force=weatherClamp(values[at+3],0,4),w=force+.03*contactWet;
        wet+=contactWet;pressure+=force;closing=Math.max(closing,Math.max(0,rise));impact=Math.max(impact,Math.max(0,strength));
        x+=values[at]*w;y+=values[at+1]*w;z+=values[at+2]*w;weight+=w;valid++;
      }
      if(bow&&!reset&&serials[i]>=0&&serial>serials[i]&&strength>.10&&strength>(event?.strength??-1))
        event={x:values[at],y:values[at+1],z:values[at+2],strength,closing:Math.max(0,rise),wet:contactWet,kind:'light'};
      serials[i]=serial;
      if(bow&&hasModest){
        const mat=(count+i)*16,mx=values[mat],my=values[mat+1],mz=values[mat+2],mtime=values[mat+3];
        const mpeak=values[mat+4],mclosing=values[mat+5],mwet=weatherClamp(values[mat+6]),mserial=values[mat+7];
        const mage=values[mat+10],mtrough=values[mat+14],mrel=values[mat+15];
        if(Number.isFinite(mrel)&&mrel>-.5)relativeClosing=Math.max(relativeClosing??0,Math.max(0,mrel));
        if(Number.isFinite(mtrough)&&mtrough>=0)lastTroughTime=Math.max(lastTroughTime??-Infinity,mtrough);
        if(!Number.isFinite(mserial))continue;
        if(reset||modestSerials[i]<0||mserial<modestSerials[i]){modestSerials[i]=mserial;continue;}
        if(mserial>modestSerials[i]){
          modestSerials[i]=mserial;
          const age=Number.isFinite(now)&&Number.isFinite(mtime)?Math.max(Number.isFinite(mage)?mage:0,now-mtime):mage;
          if([mx,my,mz,mtime,mpeak,mclosing,age].every(Number.isFinite)&&mpeak>=.045&&mclosing>=.5&&mwet>.25&&age>=-.001&&age<=staleSeconds&&mpeak>(modestEvent?.strength??-1)){
            modestEvent={x:mx,y:my,z:mz,time:mtime,age,strength:mpeak,peakStrength:mpeak,closing:mclosing,peakClosing:mclosing,wet:mwet,probe:i,serial:mserial,kind:'modest'};
          }
        }
      }
    }
    this.contact={revision:boatRevision,reset,wet:valid?wet/valid:0,pressure:valid?pressure/valid:0,closing,
      relativeClosing:relativeClosing??closing,lastTroughTime,impact,position:weight>1e-8?{x:x/weight,y:y/weight,z:z/weight}:null};
    return event&&event.strength>=.18?event:(modestEvent??event);
  }};
}

// One quiet, contact-driven water bed and sparse accents. Contact pressure is
// the renderer's authored forcing, not measured joules or an underside solver.
// The separate underside sampler observes lower-hull exposure/return. Its
// encounter speed gates events; it is not impact pressure or measured energy.
export function createHullAudioState(){
  let time=0,lastContact=-Infinity,revision=null,contact=null,wash=0,quietUntil=0,latched=false,receding=0,lastReturn=null;
  let modestQuietUntil=0,modestLatched=false,modestReceding=0,lastModestEventTime=-Infinity,returnQuietUntil=0;
  return {
    contact(value){
      if(!value||!Number.isFinite(value.pressure)||!Number.isFinite(value.wet))return false;
      if(value.reset||revision!==value.revision){
        latched=false;receding=0;quietUntil=time+1;
        modestLatched=false;modestReceding=0;modestQuietUntil=time+1;lastModestEventTime=-Infinity;returnQuietUntil=0;
      }else if(Number.isFinite(value.lastTroughTime)&&value.lastTroughTime>lastModestEventTime+.12&&time>=returnQuietUntil){
        modestLatched=false;
      }
      revision=value.revision;contact=value;lastContact=time;return true;
    },
    underside(event){
      if(event?.kind!=='underside-reentry'||!(event.closing>1.25)||!(event.age>=0&&event.age<=.35))return false;
      if(![event.x,event.y,event.z,event.closing].every(Number.isFinite))return false;
      if(![event.epoch,event.probe,event.serial].every(Number.isInteger)||event.probe<0||event.probe>=10)return false;
      const key=[event.epoch,event.probe,event.serial].join(':');if(key===lastReturn)return false;
      lastReturn=key;latched=true;receding=0;quietUntil=Math.max(quietUntil,time+3.2);
      modestLatched=true;modestReceding=0;returnQuietUntil=Math.max(returnQuietUntil,time+3.2);modestQuietUntil=Math.max(modestQuietUntil,returnQuietUntil);
      // Listening rejected the available crash candidates. Continue the wash
      // and suppress a coincident light splash, without substituting a sound.
      return true;
    },
    update(dt,options={}){
      dt=weatherClamp(dt,0,.1);time+=dt;
      const fresh=contact&&time-lastContact<1,wet=fresh?weatherClamp(contact.wet):.8;
      const pressure=fresh?weatherClamp(contact.pressure,0,2):0,closing=fresh?weatherClamp(contact.closing/3):0;
      const flow=weatherClamp(hullRelativeWaterSpeed(options)/5);
      const target=weatherClamp(.32*Math.sqrt(flow)*Math.sqrt(wet)+.17*Math.sqrt(pressure)*wet+.08*closing*wet,0,.48);
      wash+=(target-wash)*(1-Math.exp(-dt/(target>wash ? .22 : 1.05)));
      // A new serial at the next bow station can still be the same passing wave.
      // Rearm only after its pressure/rise recedes, rather than every half second.
      if(fresh&&contact.closing<.24&&contact.impact<.09)receding+=dt;else receding=0;
      if(receding>.45)latched=false;
      const faceClosing=fresh&&Number.isFinite(contact.relativeClosing)?contact.relativeClosing:fresh?contact.closing:0;
      if(fresh&&faceClosing<.22&&time>=returnQuietUntil)modestReceding+=dt;else modestReceding=0;
      if(modestReceding>.10)modestLatched=false;
      return {wash,fresh,position:contact?.position??null};
    },
    impact(event){
      if(!event||!Number.isFinite(event.strength)||![event.x,event.y??0,event.z].every(Number.isFinite))return null;
      if(event.kind==='modest'){
        const closing=event.closing,peakClosing=event.peakClosing??closing,peakStrength=event.peakStrength??event.strength;
        if(![closing,peakClosing,peakStrength].every(Number.isFinite)||peakStrength<.045||closing<.5||peakClosing<closing)return null;
        if(event.age!==undefined&&(!Number.isFinite(event.age)||event.age<-.001||event.age>.35))return null;
        if(event.time!==undefined&&!Number.isFinite(event.time))return null;
        if(time<modestQuietUntil||time<returnQuietUntil||modestLatched)return null;
        const strength=weatherClamp(peakStrength/1.2);
        modestLatched=true;modestReceding=0;lastModestEventTime=Number.isFinite(event.time)?event.time:time;
        modestQuietUntil=time+.65+strength*.35;
        return {id:'hull-slap',gain:.018+.038*Math.sqrt(strength),rate:.96,
          position:{x:event.x,y:event.y??0,z:event.z},time:event.time??time,
          peakStrength,peakClosing,
          options:{duration:.48,attack:.014,release:.20,lowpassHz:1950,highpassHz:110},kind:'modest'};
      }
      if(event.strength<.18||time<quietUntil||(event.kind&&event.kind!=='light')||latched)return null;
      const strength=weatherClamp(event.strength/3.5);
      latched=true;receding=0;quietUntil=time+1.4+strength*.8;
      modestLatched=true;modestReceding=0;modestQuietUntil=Math.max(modestQuietUntil,quietUntil);
      return {id:'hull-slap',gain:.027+.055*Math.sqrt(strength),rate:.93,position:event,
        options:{duration:.66,attack:.018,release:.24,lowpassHz:1800,highpassHz:90},kind:'light'};
    },
    reset(){
      lastContact=-Infinity;revision=null;contact=null;wash=0;quietUntil=time+1;latched=false;receding=0;lastReturn=null;
      modestQuietUntil=time+1;modestLatched=false;modestReceding=0;lastModestEventTime=-Infinity;returnQuietUntil=0;
    },
  };
}

// Acoustic severity only: these contacts do not measure timber stress, force or
// joules. One shared clock prevents a contact groan and motion creak stacking.
export function createTimberAudioState(random=Math.random){
  let time=0,nextCreak=4,revision=null,contact=null,lastContact=-Infinity,settleUntil=1,episode=false,receding=0,epoch=-1;
  const serials=new Float64Array(10).fill(-1);
  function reset(nextRevision=null){
    revision=nextRevision;contact=null;lastContact=-Infinity;settleUntil=time+1;nextCreak=time+4;
    episode=false;receding=0;epoch=-1;serials.fill(-1);
  }
  function fresh(){return contact&&time-lastContact<=.35&&time>=settleUntil;}
  function emit(gain,position,contactDriven){
    if(time<nextCreak)return null;
    nextCreak=time+5+weatherClamp(random())*7;
    return {id:'timber-creak',gain,position,rate:contactDriven ? .90+weatherClamp(random())*.08 : .92+weatherClamp(random())*.15,
      spatial:contactDriven,options:contactDriven?{duration:4,attack:.025,release:.3}:{}};
  }
  function encounter(severity,event){
    if(!fresh()||episode)return null;
    // Consume even during cooldown: an old wave must not play belatedly when
    // the preceding periodic/contact creak finishes, nor once per hull probe.
    episode=true;receding=0;
    return emit(.10+.18*Math.sqrt(weatherClamp(severity)),event,true);
  }
  return {
    contact(value){
      if(!value||!Number.isFinite(value.revision)||!Number.isFinite(value.pressure)||!Number.isFinite(value.wet)
        ||!Number.isFinite(value.closing)||!Number.isFinite(value.impact))return false;
      if(value.reset||revision!==value.revision)reset(value.revision);
      contact=value;lastContact=time;return true;
    },
    impact(event){
      // Waterline strength is authored spray severity; require actual positive
      // encounter rate as well. Ordinary quiet water slaps remain unchanged.
      if(event?.kind!=='light'||!(event.strength>=.8)||!(event.closing>1.25)||!(event.wet>.4)
        ||![event.x,event.y,event.z,event.strength,event.closing,event.wet].every(Number.isFinite)
        ||(event.age!==undefined&&!(event.age>=0&&event.age<=.35))
        ||(event.revision!==undefined&&event.revision!==revision)||!(contact?.wet>0))return null;
      return encounter(event.strength/3.5,event);
    },
    underside(event){
      if(event?.kind!=='underside-reentry'||!(event.closing>1.25)||!(event.age>=0&&event.age<=.35)
        ||![event.x,event.y,event.z,event.closing].every(Number.isFinite)
        ||![event.epoch,event.probe,event.serial].every(Number.isInteger)||event.probe<0||event.probe>=serials.length
        ||event.revision!==revision||event.epoch<epoch||!fresh())return null;
      if(event.epoch!==epoch){epoch=event.epoch;serials.fill(-1);}
      if(event.serial<=serials[event.probe])return null;
      serials[event.probe]=event.serial;
      return encounter(event.closing/5,event);
    },
    update(dt,{strain=0,position=null,revision:currentRevision=revision,audible=true}={}){
      time+=weatherClamp(dt,0,.1);
      if(currentRevision!==revision)reset(currentRevision);
      if(fresh()&&contact.closing<.24&&contact.impact<.09)receding+=weatherClamp(dt,0,.1);else receding=0;
      if(receding>.45)episode=false;
      if(!audible||!Number.isFinite(strain)||strain<=.055||!position||![position.x,position.z].every(Number.isFinite))return null;
      return emit(weatherClamp(strain*.7,.08,.32),position,false);
    },
    reset,
  };
}

export function weatherAudioLevels({wind=0,speed=0,leeway=0,currentSurge=0,currentSway=0,currentX=0,currentZ=0,heading=0,intensity=0,type=0,ship=1}){
  const w=weatherClamp(wind/24),heavy=weatherClamp((w-.35)/.65),r=weatherClamp(intensity);
  const flow=hullRelativeWaterSpeed({speed,leeway,currentSurge,currentSway,currentX,currentZ,heading});
  return {'wind-steady':.48*Math.sqrt(w)*(1-.65*heavy),'wind-strong':.55*heavy,
    'hull-wash':.4*weatherClamp(flow/5)*ship,
    'rain-light':type===0?.5*Math.sqrt(r)*(1-r*.8):0,'rain-heavy':type===0?.65*r*r:0,
    'sleet-deck':type===2?.5*r*ship:0,'hail-deck':type===3?.6*r*ship:0};
}
