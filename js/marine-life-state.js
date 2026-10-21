// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Authored animal encounters, advanced in ordinary simulation seconds.
export const MARINE_ANIMAL_LIMIT=2;
export const MARINE_EFFECT_LIMIT=48;
export const MARINE_EFFECT_SECONDS=4.2;
export const MARINE_ENCOUNTER_SECONDS=95;
// Forehead outlet on the supplied rigged whale, in normalized actor metres.
export const WHALE_BLOWHOLE=Object.freeze([-.25,1.28,-6.0]);
const marineClamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const marineAngle=a=>Math.atan2(Math.sin(a),Math.cos(a));
const marineEase=t=>{t=marineClamp(t,0,1);return t*t*(3-2*t);};
export function marinePoseAt(age,animal){
  if(animal.type==='shark')return {depth:-.62+.12*Math.sin(age*.8+animal.phase),pitch:.025*Math.sin(age*.7+animal.phase),roll:.045*Math.sin(age*.45+animal.phase)};
  const cycle=age%20,q=(cycle-3)/1.4,arc=Math.exp(-q*q);
  let depth=-3.4+3*arc,pitch=-q*.12*arc,roll=0;
  const breach=animal.behavior==='breach'||animal.behavior==='encounter';
  const fluke=animal.behavior==='fluke'||animal.behavior==='encounter';
  if(breach&&age>=4&&age<10.2){
    if(age<6){const t=marineEase((age-4)/2);depth=(-3.4+3*Math.exp(-1/1.96))*(1-t)-t;pitch=.96*t;}
    else if(age<8.9){const t=age-6;depth=-1+13.7*t-4.905*t*t;pitch=.96*(1-t/3.6);roll=.30*Math.sin(t/2.9*Math.PI);}
    else{const t=marineEase((age-8.9)/1.3);depth=-2.52205*(1-t)-3.4*t;pitch=.18667*(1-t);}
  }
  const flukeStart=animal.behavior==='encounter'?34:4;
  if(fluke&&age>=flukeStart&&age<flukeStart+10){
    const t=age-flukeStart,beginQ=(flukeStart%20-3)/1.4,beginArc=Math.exp(-beginQ*beginQ);
    if(t<2){const f=marineEase(t/2);depth=(-3.4+3*beginArc)*(1-f)-.6*f;pitch=-beginQ*.12*beginArc*(1-f)-.78*f;}
    else if(t<7){const f=marineEase((t-2)/5);depth=-.6-7.5*f;pitch=-.78+.25*f;}
    else{const f=marineEase((t-7)/3);depth=-8.1*(1-f)-3.4*f;pitch=-.53*(1-f);}
  }
  const leave=marineEase((age-83)/12);depth-=leave*9;
  return {depth,pitch,roll};
}
export function marineSurfaceBounds(type,depth,pitch=0,scale=1,roll=0){
  const profile=type==='whale'?[[-6,.3,.6],[-4,.1,1.25],[-1,0,1.65],[2,-.15,1.3],[5,-.25,.4],[6.5,-.2,.12]]:
    [[-2,.02,.25],[-1,0,.55],[0,-.02,.57],[.25,1.05,.38],[1,-.1,.33],[1.8,-.1,.11]];
  const c=Math.cos(pitch),s=Math.sin(pitch);let min=Infinity,max=-Infinity;
  for(const[z,y,r]of profile){const centre=(c*y-s*z)*scale,extent=(Math.abs(c)*r+Math.abs(Math.sin(roll))*r*.7)*scale;
    min=Math.min(min,depth+centre-extent);max=Math.max(max,depth+centre+extent);}
  return {min,max,touching:min<=0&&max>=0};
}
export function createMarineLifeState(random=Math.random){
  const rand=()=>marineClamp(Number(random())||0,0,.999999999),wait=()=>900-Math.log(Math.max(.00001,1-rand()))*1800;
  const animals=Array.from({length:MARINE_ANIMAL_LIMIT},()=>({x:0,z:0,heading:0,depth:-8,pitch:0,roll:0,scale:1,phase:0,type:'whale',behavior:'encounter',speed:3}));
  const effects=Array.from({length:MARINE_EFFECT_LIMIT},()=>({x:0,z:0,age:10,strength:0,heading:0,seed:0,kind:'trail',scale:1,speed:0,height:0,windX:0,windZ:0,id:0,animal:0,anchorX:null,anchorZ:null}));
  let time=0,age=0,count=0,next=wait(),serial=0,effectSerial=0,event=null,previousX=NaN,previousZ=NaN;
  const safe=(x,z,type,terrain)=>!terrain||terrain.height(x,z)<(type==='whale'?-16:-6);
  function clear(){count=0;age=0;for(const e of effects){e.age=10;e.strength=0;}next=time+wait();}
  function trigger(type,boat,{terrain=null,vessels=[boat],behavior='encounter'}={}){
    if(!['shark','whale'].includes(type))throw new Error(`Unknown marine encounter: ${type}`);
    if(!['encounter','breach','fluke','blow'].includes(behavior))throw new Error(`Unknown whale behavior: ${behavior}`);
    if(count)return false;
    const heading=(boat.heading??0)*Math.PI/180,side=rand()<.5?-1:1,distance=(boat.beam??6)*.5+(type==='whale'?58:19),fore=(boat.length??20)*.45+20;
    let location=null;
    for(const candidate of [side,-side]){
      const x=boat.x+Math.sin(heading)*fore+Math.cos(heading)*candidate*distance,z=boat.z-Math.cos(heading)*fore+Math.sin(heading)*candidate*distance;
      // Check a footprint and intended forward path, not merely the root point.
      let valid=true;
      for(const reach of [0,15,35])for(const across of [-8,0,8]){
        const px=x+Math.sin(heading)*reach+Math.cos(heading)*across,pz=z-Math.cos(heading)*reach+Math.sin(heading)*across;
        if(!safe(px,pz,type,terrain)||vessels.some(v=>Math.hypot(px-v.x,pz-v.z)<(v.length??20)*.55+(type==='whale'?10:4))){valid=false;break;}
      }
      if(valid){location={x,z,side:candidate};break;}
    }
    if(!location){event={id:++serial,type,text:type==='whale'?'Whales need clear water at least sixteen metres deep.':'Sharks need clear water at least six metres deep.'};return false;}
    count=1;age=0;const a=animals[0];
    Object.assign(a,{...location,type,kind:type,behavior,heading,scale:type==='whale'?.94+rand()*.10:.95+rand()*.15,
      phase:rand()*Math.PI*2,speed:type==='whale'?3.0:2.1,contactTick:0,nextTrail:.65,nextBlow:type==='whale'?3:Infinity});
    Object.assign(a,marinePoseAt(0,a));a.contactPose=marinePoseAt(0,a);a.contactBounds=marineSurfaceBounds(type,a.depth,a.pitch,a.scale,a.roll);a.entryPending=a.contactBounds.max>0;
    previousX=boat.x;previousZ=boat.z;event={id:++serial,type,text:`${type==='whale'?'Whale':'Shark'} off the ${location.side<0?'port':'starboard'} bow`};return true;
  }
  function stamp(a,kind,at,oldAge,dt,oldX,oldZ,oldHeading,strength,offset=0){
    let slot=effects[0];for(const e of effects)if(e.age>slot.age)slot=e;
    const fraction=dt>0?marineClamp((at-oldAge)/dt,0,1):1,heading=oldHeading+marineAngle(a.heading-oldHeading)*fraction;
    const pose=marinePoseAt(at,a),scale=a.type==='whale'?5.2*a.scale:a.scale;
    const anchorX=oldX+(a.x-oldX)*fraction,anchorZ=oldZ+(a.z-oldZ)*fraction;
    Object.assign(slot,{x:anchorX+Math.sin(heading)*offset,z:anchorZ-Math.cos(heading)*offset,anchorX,anchorZ,
      age:age-at,strength,heading,seed:a.phase+at*.17,kind,scale,speed:a.speed,id:++effectSerial,animal:0,
      height:pose.depth+Math.cos(pose.pitch)*1.5+Math.sin(pose.pitch)*3.6,
      windX:0,windZ:0});return slot;
  }
  return {animals,effects,enabled:true,get active(){return count>0;},get count(){return count;},get age(){return age;},get time(){return time;},get event(){return event;},get nextAt(){return next;},trigger,clear,
    step(dt,boat,settings={},terrain=null,vessels=[boat]){
      dt=marineClamp(Number.isFinite(dt)?dt:0,0,.1);time+=dt;event=null;for(const e of effects)e.age+=dt;
      if(Number.isFinite(previousX)&&Math.hypot(boat.x-previousX,boat.z-previousZ)>250){clear();previousX=boat.x;previousZ=boat.z;return;}
      previousX=boat.x;previousZ=boat.z;
      if(!count){if(time>=next){next=time+wait();if(this.enabled&&(settings.windSpeed??7)<18&&(settings.rain??0)<.6)trigger(rand()<.42?'shark':'whale',boat,{terrain,vessels});}return;}
      const oldAge=age;age+=dt;if(age>=MARINE_ENCOUNTER_SECONDS){clear();return;}
      for(let i=0;i<count;i++){
        const a=animals[i],oldX=a.x,oldZ=a.z,oldHeading=a.heading;
        let desired=a.heading+Math.sin(age*.06+a.phase)*.12*dt;
        for(const v of vessels)if(Math.hypot(a.x-v.x,a.z-v.z)<(v.length??20)*.55+(a.type==='whale'?18:7))desired=Math.atan2(a.x-v.x,-(a.z-v.z));
        const look=a.type==='whale'?22:10;
        if(!safe(a.x+Math.sin(a.heading)*look,a.z-Math.cos(a.heading)*look,a.type,terrain))desired=a.heading+a.side*1.1;
        a.heading+=marineClamp(marineAngle(desired-a.heading),-.32*dt,.32*dt);
        const nx=a.x+Math.sin(a.heading)*a.speed*dt,nz=a.z-Math.cos(a.heading)*a.speed*dt;
        if(safe(nx,nz,a.type,terrain)){a.x=nx;a.z=nz;}else a.heading+=dt*a.side*.5;
        Object.assign(a,marinePoseAt(age,a));
        if(dt>0)while((a.contactTick+1)*.025<=age+1e-8){
          const at=++a.contactTick*.025,pose=marinePoseAt(at,a),bounds=marineSurfaceBounds(a.type,pose.depth,pose.pitch,a.scale,pose.roll);
          const old=a.contactBounds,vertical=(pose.depth-a.contactPose.depth)/.025;
          if(old.max<=0&&bounds.max>0){a.entryPending=true;stamp(a,'emerge',at,oldAge,dt,oldX,oldZ,oldHeading,a.type==='whale'?.85:.25);}
          if(a.entryPending&&vertical<0&&((old.min>0&&bounds.min<=0)||(a.contactPose.depth>-.2&&pose.depth<=-.2))){
            const strength=marineClamp(.55-vertical*.1,.6,a.type==='whale'?2.6:.9);
            stamp(a,'entry',at,oldAge,dt,oldX,oldZ,oldHeading,strength);
            if(a.type==='whale'){stamp(a,'entry',at,oldAge,dt,oldX,oldZ,oldHeading,strength*.65,3);stamp(a,'entry',at,oldAge,dt,oldX,oldZ,oldHeading,strength*.65,-3);}
            a.entryPending=false;
          }
          if(a.type==='whale'&&(a.behavior==='fluke'||a.behavior==='encounter')){
            const previousTail=a.contactPose.depth-Math.sin(a.contactPose.pitch)*6.5*a.scale-.2*Math.cos(a.contactPose.pitch)*a.scale;
            const tail=pose.depth-Math.sin(pose.pitch)*6.5*a.scale-.2*Math.cos(pose.pitch)*a.scale;
            if(previousTail>0&&tail<=0&&pose.pitch<-.3)stamp(a,'entry',at,oldAge,dt,oldX,oldZ,oldHeading,.82,-6.5*Math.cos(pose.pitch)*a.scale);
          }
          a.contactPose=pose;a.contactBounds=bounds;
        }
        if(dt>0)while(a.nextTrail<=age+1e-8){
          const at=a.nextTrail;a.nextTrail+=.65;const pose=marinePoseAt(at,a),bounds=marineSurfaceBounds(a.type,pose.depth,pose.pitch,a.scale,pose.roll);
          if(bounds.touching)stamp(a,'trail',at,oldAge,dt,oldX,oldZ,oldHeading,a.type==='whale'?.45:.22);
        }
        if(dt>0)while(a.nextBlow<=age+1e-8){
          const at=a.nextBlow;a.nextBlow+=20;const pose=marinePoseAt(at,a);
          const cr=Math.cos(pose.roll),sr=Math.sin(pose.roll),cp=Math.cos(pose.pitch),sp=Math.sin(pose.pitch);
          const bx=(cr*WHALE_BLOWHOLE[0]-sr*WHALE_BLOWHOLE[1])*a.scale;
          const bankY=sr*WHALE_BLOWHOLE[0]+cr*WHALE_BLOWHOLE[1],by=(cp*bankY-sp*WHALE_BLOWHOLE[2])*a.scale;
          const bz=(sp*bankY+cp*WHALE_BLOWHOLE[2])*a.scale,height=pose.depth+by;
          if(height>.02&&age<83){const blow=stamp(a,'blow',at,oldAge,dt,oldX,oldZ,oldHeading,.9);blow.height=height;
            blow.x+=Math.cos(blow.heading)*bx-Math.sin(blow.heading)*bz;blow.z+=Math.sin(blow.heading)*bx+Math.cos(blow.heading)*bz;
            const wind=(settings.windDir??120)*Math.PI/180,speed=marineClamp(settings.windSpeed??7,0,35);blow.windX=Math.cos(wind)*speed;blow.windZ=Math.sin(wind)*speed;}
        }
      }
    },
  };
}
