// Authored wildlife encounter: normal simulation seconds, independent of voyage time.
export const DOLPHIN_LIMIT=7;
export const DOLPHIN_ENCOUNTER_SECONDS=105;
export const DOLPHIN_SPLASH_LIMIT=64;
export const DOLPHIN_SPLASH_SECONDS=4.2;
const DOLPHIN_CONTACT_STEP=.025,DOLPHIN_TRAIL_STEP=.25;
const dolphinClamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dolphinAngle=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function dolphinBreath(time,phase,period=7.8,breach=false){
  const cycle=(time/period+phase)%1;
  const q=(cycle-.45)/.155,arc=Math.exp(-q*q);
  const amplitude=breach?2.7:1.35;
  return {depth:-1.1+amplitude*arc,pitch:dolphinClamp(-2*q*amplitude*arc/(.155*period*4.2),-.65,.65)};
}
// Root depth is relative to the wave sampled by the dolphin vertex shader.
// Test the trunk, rather than a dorsal fin that can show while the body is submerged.
const dolphinBodySections=[[-.9,.065,.30],[-.6,.025,.36],[-.15,0,.365],[.3,-.035,.29],[.75,-.075,.15],[1.12,-.10,.065]];
export function dolphinSurfaceContact(depth,pitch=0,scale=1){
  const c=Math.cos(pitch),s=Math.sin(pitch);let min=Infinity,max=-Infinity;
  for(const [z,y,r]of dolphinBodySections){const centre=(c*y-s*z)*scale,extent=Math.abs(c)*r*.9*scale;min=Math.min(min,depth+centre-extent);max=Math.max(max,depth+centre+extent);}
  return {min,max,touching:min<=0&&max>=0};
}
function dolphinPoseAt(age,a,i){
  const cycle=Math.floor(age/a.period+a.phase),breach=(cycle+i)%5===0&&i%3===0;
  const pose=dolphinBreath(age,a.phase,a.period,breach);
  return {...pose,depth:pose.depth-dolphinClamp((age-96)/9,0,1)*3,breach};
}
export function createDolphinEncounter(random=Math.random){
  const rand=()=>dolphinClamp(Number(random())||0,0,.999999999);
  const animals=Array.from({length:DOLPHIN_LIMIT},(_,i)=>({x:0,z:0,heading:0,scale:.84+i*.035,phase:0,period:8,depth:-3,pitch:0,previousDepth:-3,breach:false}));
  const splashes=Array.from({length:DOLPHIN_SPLASH_LIMIT},()=>({x:0,z:0,age:10,strength:0,heading:0,seed:0,kind:'trail',speed:0,scale:1,id:0,animal:0}));
  const wait=()=>420-Math.log(Math.max(.00001,1-rand()))*900;
  let time=0,age=0,count=0,serial=0,splashSerial=0,next=wait(),previousX=NaN,previousZ=NaN,event=null;
  function safe(x,z,terrain){return !terrain||terrain.height(x,z)<-6;}
  function clear(){count=0;age=0;for(const s of splashes){s.age=10;s.strength=0;}next=time+wait();}
  function start(boat,{terrain=null,vessels=[boat]}={}){
    if(count)return false;
    const heading=(boat.heading??0)*Math.PI/180,side=rand()<.5?-1:1;
    let found=false;
    for(const candidate of [side,-side]){
      found=true;
      for(let i=0;i<DOLPHIN_LIMIT;i++){
        const fore=boat.length*.64+8+i%3*5,beam=candidate*(boat.beam*.5+6+Math.floor(i/3)*3);
        const x=boat.x+Math.sin(heading)*fore+Math.cos(heading)*beam,z=boat.z-Math.cos(heading)*fore+Math.sin(heading)*beam;
        if(!safe(x,z,terrain)||vessels.some(v=>v!==boat&&Math.hypot(x-v.x,z-v.z)<v.length*.65)){found=false;break;}
      }
      if(found){
        count=5+Math.floor(rand()*3);age=0;serial++;
        for(let i=0;i<count;i++){
          const a=animals[i],fore=boat.length*.64+8+i%3*5,beam=candidate*(boat.beam*.5+6+Math.floor(i/3)*3);
          Object.assign(a,{x:boat.x+Math.sin(heading)*fore+Math.cos(heading)*beam,z:boat.z-Math.cos(heading)*fore+Math.sin(heading)*beam,
            heading,side:candidate,phase:rand(),period:7+rand()*3,scale:.82+rand()*.23,depth:-2,pitch:0,previousDepth:-2,breach:false});
          a.contactTick=0;a.nextTrailAt=DOLPHIN_TRAIL_STEP*(1+i/DOLPHIN_LIMIT);
          const pose=dolphinPoseAt(0,a,i);a.contactPose=pose;a.contactBounds=dolphinSurfaceContact(pose.depth,pose.pitch,a.scale);a.entryPending=a.contactBounds.max>0;
        }
        event={id:serial,text:`Dolphins off the ${candidate<0?'port':'starboard'} bow · ${count} in the pod`};
        previousX=boat.x;previousZ=boat.z;return true;
      }
    }
    event={id:serial,text:'Dolphins need clear water at least six metres deep.'};return false;
  }
  return {
    animals,splashes,enabled:true,get active(){return count>0;},get count(){return count;},get time(){return time;},get age(){return age;},get event(){return event;},get nextAt(){return next;},
    trigger:start,clear,
    step(dt,boat,settings={},terrain=null,vessels=[boat]){
      dt=dolphinClamp(Number.isFinite(dt)?dt:0,0,.1);time+=dt;event=null;
      for(const s of splashes)s.age+=dt;
      if(Number.isFinite(previousX)&&Math.hypot(boat.x-previousX,boat.z-previousZ)>200){clear();previousX=boat.x;previousZ=boat.z;return;}
      previousX=boat.x;previousZ=boat.z;
      if(!count){
        if(time>=next){next=time+wait();if(this.enabled&&(settings.windSpeed??7)<19&&(settings.rain??0)<.55)start(boat,{terrain,vessels});}
        return;
      }
      const previousAge=age;age+=dt;
      if(age>DOLPHIN_ENCOUNTER_SECONDS){clear();return;}
      const heading=(boat.heading??0)*Math.PI/180,boatSpeed=Math.abs(boat.surgeVelocity??0);
      const depart=dolphinClamp((age-75)/30,0,1);
      for(let i=0;i<count;i++){
        const a=animals[i],oldX=a.x,oldZ=a.z,oldHeading=a.heading,fore=boat.length*.64+8+i%3*5+depart*80,beam=a.side*(boat.beam*.5+6+Math.floor(i/3)*3+depart*25);
        const tx=boat.x+Math.sin(heading)*fore+Math.cos(heading)*beam,tz=boat.z-Math.cos(heading)*fore+Math.sin(heading)*beam;
        const dx=tx-a.x,dz=tz-a.z,distance=Math.hypot(dx,dz);
        let desired=distance>3?Math.atan2(dx,-dz):heading+Math.sin(age*.3+a.phase*6)*.2;
        let speed=dolphinClamp(boatSpeed+(distance-3)*.22,2.5,8.5);
        // A motionless ship is passed naturally; dolphins never reverse to hold formation.
        if(boatSpeed<.4&&age>12){desired=heading+a.side*.22;speed=3.4;}
        for(const v of vessels){
          const d=Math.hypot(a.x-v.x,a.z-v.z),radius=v.length*.5+4;
          if(d<radius){desired=Math.atan2(a.x-v.x,-(a.z-v.z));speed=Math.max(speed,3);}
        }
        const aheadX=a.x+Math.sin(a.heading)*8,aheadZ=a.z-Math.cos(a.heading)*8;
        if(!safe(aheadX,aheadZ,terrain))desired=a.heading+a.side*Math.PI*.75;
        a.heading+=dolphinClamp(dolphinAngle(desired-a.heading),-.65*dt,.65*dt);
        const nx=a.x+Math.sin(a.heading)*speed*dt,nz=a.z-Math.cos(a.heading)*speed*dt;
        if(safe(nx,nz,terrain)){a.x=nx;a.z=nz;}else{a.heading+=dt*1.5;}
        const pose=dolphinPoseAt(age,a,i);a.breach=pose.breach;a.depth=pose.depth;a.pitch=pose.pitch;
        const travelled=Math.hypot(a.x-oldX,a.z-oldZ),actualSpeed=dt>0?travelled/dt:0;
        function stamp(kind,at,strength){
          const s=splashes.reduce((old,p)=>p.age>old.age?p:old,splashes[0]);
          const t=dolphinClamp((at-previousAge)/dt,0,1);
          Object.assign(s,{x:oldX+(a.x-oldX)*t,z:oldZ+(a.z-oldZ)*t,age:age-at,strength,
            heading:oldHeading+dolphinAngle(a.heading-oldHeading)*t,seed:a.phase*91+i,kind,speed:actualSpeed,scale:a.scale,id:++splashSerial,animal:i});
        }
        // Fixed contact ticks and absolute trail times keep emission independent of render FPS.
        // Event centres remain in world space; the GPU places them on the actual local wave.
        if(dt>0)while((a.contactTick+1)*DOLPHIN_CONTACT_STEP<=age+1e-8){
          const at=++a.contactTick*DOLPHIN_CONTACT_STEP,contactPose=dolphinPoseAt(at,a,i),bounds=dolphinSurfaceContact(contactPose.depth,contactPose.pitch,a.scale);
          const previous=a.contactPose,previousBounds=a.contactBounds,vertical=(contactPose.depth-previous.depth)/DOLPHIN_CONTACT_STEP;
          if(previousBounds.max<=0&&bounds.max>0){a.entryPending=true;stamp('emerge',at,dolphinClamp(.25+Math.max(0,vertical)*.06+actualSpeed*.015,.25,.65));}
          const firstReentry=previousBounds.min>0&&bounds.min<=0;
          const descendingPass=previous.depth>-.12*a.scale&&contactPose.depth<=-.12*a.scale;
          if(a.entryPending&&vertical<0&&(firstReentry||descendingPass)){
            stamp('entry',at,dolphinClamp(.45-vertical*.11+actualSpeed*.025,.5,1.25));a.entryPending=false;
          }
          a.contactPose=contactPose;a.contactBounds=bounds;
        }
        if(dt>0)while(a.nextTrailAt<=age+1e-8){
          const at=a.nextTrailAt;a.nextTrailAt+=DOLPHIN_TRAIL_STEP;
          const contactPose=dolphinPoseAt(at,a,i),bounds=dolphinSurfaceContact(contactPose.depth,contactPose.pitch,a.scale);
          if(actualSpeed>.3&&bounds.touching)stamp('trail',at,dolphinClamp(.18+actualSpeed*.022,.2,.4));
        }
        a.previousDepth=a.depth;
      }
    },
  };
}
