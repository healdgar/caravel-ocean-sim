// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Muzzle-loading, solid round shot only. Metres, seconds, kilograms, world Y up.
// Historical reference: NHHC, The Constitution Gun Deck (official museum account):
// https://www.history.navy.mil/research/library/online-reading-room/title-list-alphabetically/c/the-constitution-gun-deck.html
// Inboard loading, wet sponge, rammer, side-tackle runout, priming, explicit
// command to fire and breeching-limited recoil. This is comparable early-19th-C
// practice, not a claim that its American drill is Victory's exact 1805 drill.
// Primary comparison: US Bureau of Ordnance, Ordnance Instructions (1866), ch. II:
// https://www.gutenberg.org/cache/epub/19058/pg19058-images.html
// Douglas, A Treatise on Naval Gunnery (1855), p. 38 gives a worked 32-pounder
// example at 1600 ft/s = 487.68 m/s. It is a later reference, not measured
// performance of this specific ship, charge or shot. Other muzzle velocities,
// reload durations, dispersion and gas momentum multiplier below are authored.
// https://www.ibiblio.org/pha/USN/Navy/Treatise%20on%20Naval%20Gunnery%20%28Douglas%29%20%281855%29.pdf
// Drag: F = -1/2 rho Cd A |v-wind| (v-wind); constant Cd is an approximation
// (real sphere Cd depends on Reynolds/Mach). No homing, artificial shot arcs,
// explosive cannonballs, ricochets, penetration or automatic repeated firing.
// https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/flight-equations-with-drag/
// https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/shape-effects-on-drag/

export const GUNNERY_STAGE_DURATIONS=Object.freeze({swab:6,load:8,ram:7,runout:8,prime:4});
export const GUNNERY_LIMITS=Object.freeze({guns:128,projectiles:128,events:512,fixedStep:1/120,maxAdvance:.5,maxFlight:30,maxRange:8000});
const GUNNERY_DRILL=Object.freeze(['swab','load','ram','runout','prime']);
const gunneryClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const gunneryFinite=(x,fallback)=>Number.isFinite(x)?x:fallback;
const gunneryVector=(v,fallback=[0,0,0])=>v&&v.length===3&&Array.from(v).every(Number.isFinite)?Array.from(v):[...fallback];
const gunneryMix=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
const gunneryLength=v=>Math.hypot(v[0],v[1],v[2]);
function gunneryUnit(v){const n=gunneryLength(v);return n>1e-12?v.map(x=>x/n):null;}
function gunneryRandom(state){
  let n=state.seed;n^=n<<13;n^=n>>>17;n^=n<<5;state.seed=n>>>0;
  return state.seed/4294967296;
}
function gunnerySide(side){return side==='port'||side===-1?'port':side==='starboard'||side===1?'starboard':null;}

// gunDefs retain their metadata (including id, deck and attachment). A caller
// supplies muzzle positions/directions after vessel scale and rigid rotation.
// Calibre means nominal shot weight in imperial pounds, not bore diameter.
export function createGunneryState(gunDefs=[],options={}){
  if(!Array.isArray(gunDefs)||gunDefs.length>GUNNERY_LIMITS.guns)throw new RangeError('Gunnery requires at most 128 gun definitions');
  const ids=new Set();
  const guns=gunDefs.map((def,index)=>{
    const id=def.id??index,side=gunnerySide(def.side);
    if(ids.has(id)||!side)throw new Error('Guns require unique ids and a port/starboard side');ids.add(id);
    const calibre=gunneryClamp(gunneryFinite(def.calibre,12),.25,68);
    const mass=gunneryClamp(gunneryFinite(def.mass,calibre*.45359237),.05,40);
    // Cast iron sphere at 7200 kg/m3. Nominal weights/windage vary historically.
    const diameter=gunneryClamp(gunneryFinite(def.diameter,Math.cbrt(6*mass/(Math.PI*7200))),.015,.25);
    const carronade=def.kind==='carronade';
    const muzzleSpeed=gunneryClamp(gunneryFinite(def.muzzleSpeed,carronade?300:calibre>=32?487.68:calibre>=24?470:calibre>=12?450:350),1,650);
    const durations={};for(const stage of GUNNERY_DRILL)durations[stage]=gunneryClamp(gunneryFinite(def.durations?.[stage],GUNNERY_STAGE_DURATIONS[stage]),.01,120);
    return {...def,id,index,side,calibre,mass,diameter,muzzleSpeed,durations,
      dragCoefficient:gunneryClamp(gunneryFinite(def.dragCoefficient,.47),0,2),
      dispersion:gunneryClamp(gunneryFinite(def.dispersion,.004),0,.05),
      speedVariation:gunneryClamp(gunneryFinite(def.speedVariation,.008),0,.1),
      recoilLength:gunneryClamp(gunneryFinite(def.recoilLength,calibre<6?.18:1.1),0,2),
      recoilDuration:gunneryClamp(gunneryFinite(def.recoilDuration,.85),.1,3),
      breechMass:gunneryClamp(gunneryFinite(def.breechMass,calibre>=32?3000:calibre>=24?2600:calibre>=12?1800:180),50,6000),
      gasMomentumMultiplier:gunneryClamp(gunneryFinite(def.gasMomentumMultiplier,1.25),1,2),
      stage:'secured',elapsed:0,progress:0,offset:gunneryClamp(gunneryFinite(def.recoilLength,calibre<6?.18:1.1),0,2),recoil:0,
      loading:false,queued:false,roundsFired:0,lastShot:-Infinity,lastBlocked:null};
  });
  return {guns,projectiles:[],queue:[],events:[],pendingEvents:[],time:0,accumulator:0,seed:(options.seed??0x14921805)>>>0||1,
    sequence:0,shotSequence:0,droppedTime:0,droppedEvents:0,
    maxProjectiles:gunneryClamp(Math.floor(gunneryFinite(options.maxProjectiles,GUNNERY_LIMITS.projectiles)),1,512),
    maxEvents:gunneryClamp(Math.floor(gunneryFinite(options.maxEvents,GUNNERY_LIMITS.events)),1,2048),
    gravity:gunneryClamp(gunneryFinite(options.gravity,9.80665),0,20),airDensity:gunneryClamp(gunneryFinite(options.airDensity,1.225),0,2),
    maxFlight:gunneryClamp(gunneryFinite(options.maxFlight,GUNNERY_LIMITS.maxFlight),.01,120),
    maxRange:gunneryClamp(gunneryFinite(options.maxRange,GUNNERY_LIMITS.maxRange),1,16000)};
}

export function prepareGunnery(state,side){
  side=gunnerySide(side);if(!side)return 0;
  let count=0;
  for(const gun of state.guns){
    if(gun.side!==side||gun.loading||gun.stage==='ready'||gun.queued)continue;
    gun.loading=true;gun.lastBlocked=null;count++;
    if(gun.stage!=='recoil'){gun.stage='swab';gun.elapsed=0;gun.progress=0;gun.offset=gun.recoilLength;gun.recoil=0;}
  }
  return count;
}

// Fire only the ready snapshot. Loading guns never inherit this order. Cadence
// is authored, representing independent gun captains firing a rolling broadside.
export function fireGunnery(state,side,{interval=.14}={}){
  side=gunnerySide(side);if(!side)return 0;
  const ready=state.guns.filter(g=>g.side===side&&g.stage==='ready'&&!g.queued);
  interval=gunneryClamp(gunneryFinite(interval,.14),.04,.6);
  ready.forEach((gun,i)=>{gun.queued=true;gun.lastBlocked=null;state.queue.push({gun,time:state.time+i*interval});});
  state.queue.sort((a,b)=>a.time-b.time||a.gun.index-b.gun.index);return ready.length;
}

export function gunnerySummary(state,side){
  const wanted=gunnerySide(side),guns=wanted?state.guns.filter(g=>g.side===wanted):state.guns;
  return {total:guns.length,ready:guns.filter(g=>g.stage==='ready'&&!g.queued).length,
    queued:guns.filter(g=>g.queued).length,loading:guns.filter(g=>g.loading).length,
    spent:guns.filter(g=>g.stage==='spent'||g.stage==='recoil').length};
}

function gunneryEmit(state,environment,event){
  event.id=++state.sequence;
  if(state.events.length<state.maxEvents)state.events.push(event);else state.droppedEvents++;
  environment.onEvent?.(event);
}
function gunneryAdvanceGun(state,gun,dt,time,environment){
  if(gun.stage==='recoil'){
    const previous=gun.elapsed;gun.elapsed=Math.min(gun.recoilDuration,gun.elapsed+dt);gun.progress=gun.elapsed/gun.recoilDuration;
    // Fast initial movement followed by arrest by the breeching. No repeated
    // hull force while the recoil animation plays; the shot event owns impulse.
    gun.recoil=gun.offset=gun.recoilLength*(1-(1-gun.progress)**3);
    if(gun.progress<1)return;
    const consumed=gun.recoilDuration-previous;dt=Math.max(0,dt-consumed);time+=consumed;
    gun.stage=gun.loading?'swab':'spent';gun.elapsed=0;gun.progress=0;
  }
  if(!gun.loading||!GUNNERY_DRILL.includes(gun.stage))return;
  const attended=environment.gunAttended?.(gun)!==false;
  const rate=attended?gunneryClamp(gunneryFinite(environment.crewRate?.(gun),1),0,1):0;
  if(!rate)return;
  let available=dt*rate,used=0;
  for(let safety=0;safety<GUNNERY_DRILL.length&&gun.loading;safety++){
    const duration=gun.durations[gun.stage],take=Math.min(available,duration-gun.elapsed);
    gun.elapsed+=take;available-=take;used+=take;gun.progress=gunneryClamp(gun.elapsed/duration,0,1);
    gun.offset=gun.stage==='runout'?gun.recoilLength*(1-gun.progress):gun.stage==='prime'?0:gun.recoilLength;
    if(gun.elapsed+1e-10<duration)break;
    const next=GUNNERY_DRILL.indexOf(gun.stage)+1;gun.elapsed=0;gun.progress=0;
    if(next===GUNNERY_DRILL.length){
      gun.stage='ready';gun.loading=false;gun.offset=0;gun.recoil=0;
      gunneryEmit(state,environment,{type:'ready',gunId:gun.id,gun,time:time+used/rate});break;
    }
    gun.stage=GUNNERY_DRILL[next];
    if(available<=1e-12)break;
  }
}
function gunnerySpread(state,direction,angle){
  const u=gunneryUnit(Math.abs(direction[1])>.9?[direction[1],-direction[0],0]:[-direction[2],0,direction[0]]);
  const v=[direction[1]*u[2]-direction[2]*u[1],direction[2]*u[0]-direction[0]*u[2],direction[0]*u[1]-direction[1]*u[0]];
  const radius=Math.sqrt(gunneryRandom(state))*Math.tan(angle),theta=gunneryRandom(state)*2*Math.PI;
  return gunneryUnit(direction.map((x,i)=>x+radius*(u[i]*Math.cos(theta)+v[i]*Math.sin(theta))));
}
function gunneryWaterHeight(environment,x,z,time){
  const height=(environment.surfaceHeight??environment.waterHeight)?.(x,z,time)??0;
  return height===-Infinity?-Infinity:gunneryFinite(height,0);
}
function gunneryFireQueued(state,environment,end){
  while(state.queue.length&&state.queue[0].time<=end+1e-10){
    const queued=state.queue.shift(),gun=queued.gun;gun.queued=false;
    if(gun.stage!=='ready')continue;
    let blocked=state.projectiles.length>=state.maxProjectiles?'capacity':null;
    const muzzle=environment.muzzle?.(gun,queued.time);
    const position=gunneryVector(muzzle?.position,[NaN,NaN,NaN]);
    const direction=gunneryUnit(gunneryVector(muzzle?.direction,[0,0,0]));
    if(!position.every(Number.isFinite)||!direction)blocked='muzzle';
    else if(!environment.deferSeaCollision&&position[1]-gun.diameter/2<=gunneryWaterHeight(environment,position[0],position[2],queued.time))blocked='submerged';
    else if(environment.canFire?.(gun,muzzle)===false)blocked='obstructed';
    if(blocked){gun.lastBlocked=blocked;gunneryEmit(state,environment,{type:'blocked',gunId:gun.id,gun,time:queued.time,reason:blocked});continue;}
    const aimed=gunnerySpread(state,direction,gun.dispersion);
    const speed=gun.muzzleSpeed*(1+(gunneryRandom(state)*2-1)*gun.speedVariation),inherited=gunneryVector(muzzle.velocity);
    const velocity=aimed.map((x,i)=>x*speed+inherited[i]),shotId=++state.shotSequence;
    const projectile={id:shotId,gunId:gun.id,side:gun.side,position:[...position],previous:[...position],velocity,
      born:queued.time,time:queued.time,previousTime:queued.time,age:0,distance:0,mass:gun.mass,radius:gun.diameter/2,dragCoefficient:gun.dragCoefficient,
      history:[{time:queued.time,position:[...position],velocity:[...velocity]}]};
    state.projectiles.push(projectile);gun.stage='recoil';gun.elapsed=0;gun.progress=0;gun.offset=0;gun.recoil=0;
    gun.loading=false;gun.roundsFired++;gun.lastShot=queued.time;
    const impulse=aimed.map(x=>-x*speed*gun.mass*gun.gasMomentumMultiplier);
    gunneryEmit(state,environment,{type:'shot',shotId,gunId:gun.id,gun,time:queued.time,position:[...position],direction:aimed,
      velocity:[...velocity],inheritedVelocity:inherited,muzzleSpeed:speed,mass:gun.mass,radius:gun.diameter/2,impulse,
      energy:.5*gun.mass*speed*speed});
  }
}
function gunneryAcceleration(state,p,velocity,wind){
  const relative=velocity.map((x,i)=>x-wind[i]),speed=gunneryLength(relative);
  const drag=.5*state.airDensity*p.dragCoefficient*Math.PI*p.radius*p.radius/p.mass*speed;
  return relative.map((x,i)=>-drag*x-(i===1?state.gravity:0));
}
// Explicit midpoint integrates the full vector force. Fixed 120 Hz and swept
// contact bound error: a 488 m/s shot travels about 4m per integrator segment,
// but surface contact subdivides spatially to at most .75m before bisection.
function gunneryIntegrate(state,p,h,wind){
  const a=gunneryAcceleration(state,p,p.velocity,wind),mid=p.velocity.map((v,i)=>v+a[i]*h*.5);
  const am=gunneryAcceleration(state,p,mid,wind);
  return {position:p.position.map((v,i)=>v+mid[i]*h),velocity:p.velocity.map((v,i)=>v+am[i]*h)};
}
function gunnerySeaSweep(environment,p,from,to,t0,t1){
  const distance=gunneryLength(to.map((x,i)=>x-from[i])),steps=Math.min(64,Math.max(1,Math.ceil(distance/.75)));
  const clearance=t=>{const q=gunneryMix(from,to,t);return q[1]-p.radius-gunneryWaterHeight(environment,q[0],q[2],t0+(t1-t0)*t);};
  let low=0;
  if(clearance(0)<=0)return {fraction:0,kind:'water'};
  for(let i=1;i<=steps;i++){
    let high=i/steps;
    if(clearance(high)<=0){
      for(let j=0;j<14;j++){const mid=(low+high)*.5;if(clearance(mid)>0)low=mid;else high=mid;}
      return {fraction:high,kind:'water'};
    }
    low=high;
  }
  return null;
}
function gunneryAdvanceProjectiles(state,environment,end){
  let write=0;
  for(const p of state.projectiles){
    const h=end-p.time;if(!(h>0)){state.projectiles[write++]=p;continue;}
    const wind=gunneryVector(typeof environment.windVelocity==='function'?environment.windVelocity(p.position,p.time):environment.windVelocity);
    const from=p.position,next=gunneryIntegrate(state,p,h,wind),to=next.position;
    let hit=environment.deferSeaCollision?null:gunnerySeaSweep(environment,p,from,to,p.time,end);
    const solid=environment.sweep?.(from,to,p,p.time,end);
    if(Number.isFinite(solid?.fraction)&&solid.fraction>=0&&solid.fraction<=1&&(!hit||solid.fraction<hit.fraction))hit={...solid,kind:solid.kind??'solid'};
    if(hit){
      const fraction=gunneryClamp(hit.fraction,0,1),time=p.time+h*fraction,position=gunneryMix(from,to,fraction),velocity=gunneryMix(p.velocity,next.velocity,fraction);
      const water=hit.kind==='water',height=water?gunneryWaterHeight(environment,position[0],position[2],time):position[1];
      const surfacePosition=water?[position[0],height,position[2]]:[...position];
      gunneryEmit(state,environment,{...hit,type:'impact',shotId:p.id,gunId:p.gunId,time,position,surfacePosition,velocity,
        mass:p.mass,radius:p.radius,energy:.5*p.mass*gunneryLength(velocity)**2});
      continue;
    }
    p.position=to;p.velocity=next.velocity;p.time=end;p.age=end-p.born;
    p.history.push({time:end,position:[...to],velocity:[...next.velocity]});if(p.history.length>32)p.history.shift();
    p.distance+=gunneryLength(to.map((x,i)=>x-from[i]));
    if(p.age<state.maxFlight&&p.distance<state.maxRange&&p.position.every(Number.isFinite)&&p.velocity.every(Number.isFinite))state.projectiles[write++]=p;
  }
  state.projectiles.length=write;
}

// Resolve a delayed GPU sweep against the actual FFT sea. Removing the active
// shot makes duplicate/out-of-order readbacks harmless. Contact events wait in
// pendingEvents until the next step; consumers dispatch only step events.
// `position` is ball centre and `surfacePosition` is the contact on the sea.
// A bounded 32-tick pose history recovers velocity at delayed impact time.
export function resolveGunneryImpact(state,projectileId,contact={}){
  const index=state.projectiles.findIndex(p=>p.id===projectileId);
  if(index<0)return null;
  const position=gunneryVector(contact.position,[NaN,NaN,NaN]);if(!position.every(Number.isFinite))return null;
  const p=state.projectiles[index],time=gunneryClamp(gunneryFinite(contact.time,p.time),p.born,p.time);
  let velocity=p.velocity;
  for(let i=0;i<p.history.length;i++){
    const a=p.history[i],b=p.history[Math.min(i+1,p.history.length-1)];
    if(i===p.history.length-1||time<=b.time){velocity=gunneryMix(a.velocity,b.velocity,gunneryClamp((time-a.time)/Math.max(1e-12,b.time-a.time),0,1));break;}
  }
  velocity=gunneryVector(contact.velocity,velocity);state.projectiles.splice(index,1);
  const kind=contact.kind??'water',surfacePosition=gunneryVector(contact.surfacePosition,kind==='water'?[position[0],position[1]-p.radius,position[2]]:position);
  const event={id:++state.sequence,type:'impact',kind,shotId:p.id,gunId:p.gunId,time,position,surfacePosition,
    velocity,mass:p.mass,radius:p.radius,energy:.5*p.mass*gunneryLength(velocity)**2};
  if(contact.normal)event.normal=gunneryVector(contact.normal,[0,1,0]);
  if(state.pendingEvents.length<state.maxEvents)state.pendingEvents.push(event);else state.droppedEvents++;
  return event;
}

// environment.muzzle(gun,t): {position:[x,y,z],direction:[x,y,z],velocity:[x,y,z]}
// velocity must include translation + omega cross attachment offset, not only
// forward ship speed. direction includes elevation and current pitch/roll.
// surfaceHeight(x,z,t) is sampled during sweep; optional sweep(from,to,shot,t0,t1)
// returns the first solid intersection fraction. deferSeaCollision:true skips
// CPU sea/muzzle-plane contact; resolveGunneryImpact accepts actual GPU results.
// Caller owns precise ship/land
// collision. gunAttended(gun) and crewRate(gun) gate work, not shot trajectories.
// A tab gap advances at most .5s of this real-time simulation, records excess in
// droppedTime, and never bursts through minutes of reload/fire on resume.
export function stepGunnery(state,dt,environment={}){
  state.events=state.pendingEvents.splice(0);for(const event of state.events)environment.onEvent?.(event);
  if(!(dt>0)||!Number.isFinite(dt))return state.events;
  for(const p of state.projectiles){p.previous=[...p.position];p.previousTime=p.time;}
  const advance=Math.min(dt,GUNNERY_LIMITS.maxAdvance);state.droppedTime+=dt-advance;state.accumulator+=advance;
  const h=GUNNERY_LIMITS.fixedStep;
  while(state.accumulator+1e-12>=h){
    const start=state.time,end=start+h;
    for(const gun of state.guns)gunneryAdvanceGun(state,gun,h,start,environment);
    gunneryFireQueued(state,environment,end);
    gunneryAdvanceProjectiles(state,environment,end);
    state.time=end;state.accumulator=Math.max(0,state.accumulator-h);
  }
  return state.events;
}
