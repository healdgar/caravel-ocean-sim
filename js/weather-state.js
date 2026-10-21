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

// New GPU contact serials, rather than a timer or wave height, trigger hull slaps.
// Suppress first samples and resets so loading/teleporting cannot play false impacts.
export function createImpactDetector(count=40){
  const serials=new Float32Array(count).fill(-1),drySamples=new Uint8Array(count);let revision=-1;
  return {contact:null,sample(values,boatRevision,context={}){
    let event=null,wet=0,pressure=0,closing=0,impact=0,weight=0,x=0,y=0,z=0,valid=0;
    const reset=revision!==boatRevision;revision=boatRevision;
    const exposedDepth=Math.min(.5,Math.max(.2,(context.draft??2)*.2));
    for(let i=0;i<count;i++){
      const at=i*16,serial=values[at+15],strength=values[at+7];
      if(!Number.isFinite(serial)||!Number.isFinite(strength)||!Number.isFinite(values[at])||!Number.isFinite(values[at+1])||!Number.isFinite(values[at+2]))continue;
      // The eight aft records force the stern wake; they are not bow slams.
      const bow=i<Math.min(32,count),contactWet=weatherClamp(values[at+11]),rise=weatherClamp(values[at+14],-8,8);
      const immersion=Number.isFinite(values[at+12])?values[at+12]:0;
      const reentry=bow&&!reset&&drySamples[i]>=2&&contactWet>.5&&rise>1.25;
      if(reset)drySamples[i]=0;
      else if(contactWet<.1&&immersion<-exposedDepth)drySamples[i]=Math.min(3,drySamples[i]+1);
      else if(contactWet>.5)drySamples[i]=0;
      if(bow){
        const force=weatherClamp(values[at+3],0,4),w=force+.03*contactWet;
        wet+=contactWet;pressure+=force;closing=Math.max(closing,Math.max(0,rise));impact=Math.max(impact,Math.max(0,strength));
        x+=values[at]*w;y+=values[at+1]*w;z+=values[at+2]*w;weight+=w;valid++;
      }
      const priority=strength+(reentry?4:0),previousPriority=event?event.strength+(event.kind==='reentry'?4:0):-1;
      if(bow&&!reset&&serials[i]>=0&&serial>serials[i]&&strength>.10&&priority>previousPriority)
        event={x:values[at],y:values[at+1],z:values[at+2],strength,closing:Math.max(0,rise),wet:contactWet,kind:reentry?'reentry':'light'};
      serials[i]=serial;
    }
    this.contact={revision:boatRevision,reset,wet:valid?wet/valid:0,pressure:valid?pressure/valid:0,closing,impact,
      position:weight>1e-8?{x:x/weight,y:y/weight,z:z/weight}:null};
    return event;
  }};
}

// One quiet, contact-driven water bed and sparse accents. Contact pressure is
// the renderer's authored forcing, not measured joules or an underside solver.
// Re-entry means a fore contact became wet after exposure; a genuine keel slam
// needs a lower-hull contact representation and a separately accepted sound.
export function createHullAudioState(){
  let time=0,lastContact=-Infinity,revision=null,contact=null,wash=0,quietUntil=0,latched=false,receding=0;
  return {
    contact(value){
      if(!value||!Number.isFinite(value.pressure)||!Number.isFinite(value.wet))return false;
      if(value.reset||revision!==value.revision){latched=false;receding=0;quietUntil=time+1;}
      revision=value.revision;contact=value;lastContact=time;return true;
    },
    update(dt,{speed=0}={}){
      dt=weatherClamp(dt,0,.1);time+=dt;
      const fresh=contact&&time-lastContact<1,wet=fresh?weatherClamp(contact.wet):.8;
      const pressure=fresh?weatherClamp(contact.pressure,0,2):0,closing=fresh?weatherClamp(contact.closing/3):0;
      const flow=weatherClamp(Math.abs(Number.isFinite(speed)?speed:0)/5);
      const target=weatherClamp(.32*Math.sqrt(flow)*Math.sqrt(wet)+.17*Math.sqrt(pressure)*wet+.08*closing*wet,0,.48);
      wash+=(target-wash)*(1-Math.exp(-dt/(target>wash ? .22 : 1.05)));
      // A new serial at the next bow station can still be the same passing wave.
      // Rearm only after its pressure/rise recedes, rather than every half second.
      if(fresh&&contact.closing<.24&&contact.impact<.09)receding+=dt;else receding=0;
      if(receding>.45)latched=false;
      return {wash,fresh,position:contact?.position??null};
    },
    impact(event){
      if(!event||!Number.isFinite(event.strength)||event.strength<.18||time<quietUntil)return null;
      if(![event.x,event.y??0,event.z].every(Number.isFinite))return null;
      const strength=weatherClamp(event.strength/3.5),reentry=event.kind==='reentry'&&event.closing>1.25&&event.wet>.5;
      // A new observed exposure/return is its own episode even if other bow
      // stations still carry wash. It still respects the longer quiet interval.
      if(latched&&!reentry)return null;
      latched=true;receding=0;quietUntil=time+(reentry?3.2:1.4+strength*.8);
      // Keep the continuous pressure-driven wash, but do not fake a bottom
      // crash by replaying that loop as a louder one-shot. Listening rejected
      // that substitution and the replacement candidates. Reserve the quiet
      // interval until an accepted impact texture and underside probes exist.
      if(reentry)return null;
      return {id:'hull-slap',gain:.027+.055*Math.sqrt(strength),rate:.93,position:event,
        options:{duration:.66,attack:.018,release:.24,lowpassHz:1800,highpassHz:90},kind:'light'};
    },
    reset(){lastContact=-Infinity;revision=null;contact=null;wash=0;quietUntil=time+1;latched=false;receding=0;},
  };
}

export function weatherAudioLevels({wind=0,speed=0,intensity=0,type=0,ship=1}){
  const w=weatherClamp(wind/24),heavy=weatherClamp((w-.35)/.65),r=weatherClamp(intensity);
  return {'wind-steady':.48*Math.sqrt(w)*(1-.65*heavy),'wind-strong':.55*heavy,
    'hull-wash':.4*weatherClamp(Math.abs(speed)/5)*ship,
    'rain-light':type===0?.5*Math.sqrt(r)*(1-r*.8):0,'rain-heavy':type===0?.65*r*r:0,
    'sleet-deck':type===2?.5*r*ship:0,'hail-deck':type===3?.6*r*ship:0};
}
