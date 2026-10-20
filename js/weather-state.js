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
  const serials=new Float32Array(count).fill(-1);let revision=-1;
  return {sample(values,boatRevision){
    let event=null;const reset=revision!==boatRevision;revision=boatRevision;
    for(let i=0;i<count;i++){
      const at=i*16,serial=values[at+15],strength=values[at+7];
      if(!reset&&serials[i]>=0&&serial>serials[i]&&strength>.10&&(!event||strength>event.strength))
        event={x:values[at],y:values[at+1],z:values[at+2],strength};
      serials[i]=serial;
    }
    return event;
  }};
}

export function weatherAudioLevels({wind=0,speed=0,intensity=0,type=0,ship=1}){
  const w=weatherClamp(wind/24),heavy=weatherClamp((w-.35)/.65),r=weatherClamp(intensity);
  return {'wind-steady':.48*Math.sqrt(w)*(1-.65*heavy),'wind-strong':.55*heavy,
    'hull-wash':.4*weatherClamp(Math.abs(speed)/5)*ship,
    'rain-light':type===0?.5*Math.sqrt(r)*(1-r*.8):0,'rain-heavy':type===0?.65*r*r:0,
    'sleet-deck':type===2?.5*r*ship:0,'hail-deck':type===3?.6*r*ship:0};
}
