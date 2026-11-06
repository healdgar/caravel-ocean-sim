// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How sailors get past each other. Routes still say where to go. This says who goes where on the deck in the meantime:
//  - Velocity obstacles (van den Berg et al., ORCA) keep two bodies apart, sharing the avoiding by right of way.
//  - Each keeps to starboard of his own direction of travel, so a head-on meeting does not dither.
//  - A gap one body wide takes one direction at a time. Whoever gives way waits at a wide spot before it, clear of the mouth.
//  - In a tight place a body turns his shoulders to pass, and the legs keep walking where he is going.
// Everything is in ship metres, with no randomness and no clock, so a run repeats exactly.
import {crewDeckField,crewDeckFloor,crewDeckLineRoom,crewDeckRoom,CREW_DECK_BODY_M} from './crew-deck.js';
import {crewTurnTowards} from './crew-motion.js';
import {vesselVerticalScale} from './hull.js';

// A sailor's torso from above, from the meshes: arms hang outside this, and a brush of them is allowed.
const CREW_BODY_HALF_WIDTH=.24,CREW_BODY_HALF_DEPTH=.19;
// Centre to centre: clear of each other's arms, shoulders touching, and turned to fit.
const TRAFFIC_ROOMY=.56,TRAFFIC_BY_STANDER=.545,TRAFFIC_BRUSH=.50,TRAFFIC_TURNED=.40,TRAFFIC_SQUEEZED=.32,TRAFFIC_SQUEEZE_AFTER=4,TRAFFIC_SQUEEZE_FOR=2;
const CREW_TURN_FULL=1.05;
const TRAFFIC_TURN_RATE=4.5,TRAFFIC_HEMMED=.8,TRAFFIC_CREEP=.1,TRAFFIC_EASE=14,TRAFFIC_TURN_ABOVE=.25,TRAFFIC_GRAZE=.003,TRAFFIC_NOT_COMING=1.2,TRAFFIC_GIVE_SECONDS=4,TRAFFIC_GIVE_CLEAR=1.25;
// A route's check keeps a body .30 from each face of a box, corners included. Clearance measures round the corners, so it can vouch only from .30 times root two, and half a cell.
const TRAFFIC_VOUCHED=.47,TRAFFIC_ROUND_ROOM=.44,TRAFFIC_TRAIL_STEP=.4,TRAFFIC_TRAIL_LENGTH=10;
const TRAFFIC_SIGHT=3.4,TRAFFIC_LOOK_TIME=2.2,TRAFFIC_MOVING_HORIZON=1.1,TRAFFIC_STILL_HORIZON=.9,TRAFFIC_NEIGHBOURS=6;
// Along a route. Narrow is too tight for two bodies even turned, and wide has room to stand aside.
const LANE_STEP=.25,LANE_NARROW=.44,LANE_WIDE=.8,LANE_SCAN=1.3,LANE_LOOK=4.5,LANE_STOP_SHORT=.55,LANE_INSIDE=.3,LANE_RETREAT=48;
const crewTrafficPlanes=new Float64Array(3*(TRAFFIC_NEIGHBOURS+3));
const crewTrafficScale=boat=>[(boat.beam??3.6)/3.6,vesselVerticalScale(boat),(boat.length??12)/12];

// Half the body's extent along a direction, as he stands now.
function crewBodyHalf(s,dx,dz){
  const yaw=(s.yaw??0)+(s.shoulderTurn??0),length=Math.hypot(dx,dz)||1,along=(dx*Math.sin(yaw)+dz*Math.cos(yaw))/length,across=(dx*Math.cos(yaw)-dz*Math.sin(yaw))/length;
  return Math.hypot(CREW_BODY_HALF_WIDTH*across,CREW_BODY_HALF_DEPTH*along);
}
// Who gives way. Gun crews and sail handlers at an order go before anyone strolling, and anyone carrying before anyone not.
function crewTrafficUrgency(s){
  const j=s.job;let urgency=0;
  if(j){
    if(j.kind==='gunnery'||j.kind==='boarding'||j.kind==='mooring')urgency=['return','waiting-return'].includes(j.stage)?1:3;
    else if(j.stage==='approach'||j.stage==='ascending'||j.stage==='descending')urgency=j.kind==='lookout'?2:3;
    else if(j.kind==='yield'||j.stage==='traffic-yield')urgency=2;
    else urgency=1;
  }
  // A loader goes to his gun with the rammer and the charge.
  if(s.carrying||(j?.kind==='gunnery'&&j.gunRole==='loader'&&j.stage!=='return'))urgency+=.6;
  if(s.casualtyState==='wounded')urgency+=.3;
  return urgency;
}
// A strict order over everyone, so that nobody can wait on someone waiting on them.
function crewTrafficOutranks(a,aInside,b,bInside){
  if(aInside!==bInside)return aInside;
  const ua=crewTrafficUrgency(a),ub=crewTrafficUrgency(b);
  if(ua!==ub)return ua>ub;
  return (a.crewIndex??0)<(b.crewIndex??0);
}
// Was this neighbour on his way somewhere last frame? Anyone else stands where they are, and is walked around.
const crewTrafficWalking=o=>o.trafficWalking===true;
const crewTrafficMoving=o=>o.trafficWalking===true&&!(o.trafficHolding>0);

// A route, seen from a deck: where it runs tight and where there is room. Built once per route, in metres.
function crewTrafficLaneWidth(field,boat,x,y,z,tx,tz,scale){
  if(Math.abs(y-crewDeckFloor(boat,z/scale[2],x/scale[0])*scale[1])>.06)return 0;
  const reach=sign=>{
    let last=0,seen=false;
    for(let d=.04;d<LANE_SCAN;d+=.04){
      const room=crewDeckRoom(field,boat,x-tz*sign*d,z+tx*sign*d);
      if(room<.1)break;
      if(room>=CREW_DECK_BODY_M){last=d;seen=true;}else if(seen)break;
    }
    return last;
  };
  return reach(1)+reach(-1);
}
function crewTrafficLane(s,boat,field){
  const job=s.job,path=job?job.path:s.navigationPath;if(!path?.length)return null;
  const revision=boat.damage?.fracture?.revision??0;let lane=s.trafficLane;
  if(lane?.source===path&&lane.revision===revision)return lane;
  const scale=crewTrafficScale(boat),samples=[],first=new Int32Array(path.length+1);
  let ax=s.position[0],ay=s.position[1]-.028,az=s.position[2];
  for(let i=0;i<path.length;i++){
    first[i]=samples.length;
    const bx=path[i][0]*scale[0],by=path[i][1]*scale[1],bz=path[i][2]*scale[2],length=Math.hypot(bx-ax,bz-az);
    if(length>1e-6){
      const tx=(bx-ax)/length,tz=(bz-az)/length,count=Math.ceil(length/LANE_STEP);
      for(let k=1;k<=count;k++){
        const t=k/count,x=ax+(bx-ax)*t,y=ay+(by-ay)*t,z=az+(bz-az)*t,width=crewTrafficLaneWidth(field,boat,x,y,z,tx,tz,scale);
        samples.push({x,y,z,tx,tz,width});
      }
    }
    ax=bx;ay=by;az=bz;
  }
  first[path.length]=samples.length;
  return s.trafficLane={source:path,revision,samples,first};
}
// The first stretch ahead too tight for two, if one lies within reach. Beyond the end of the route there is nothing.
function crewTrafficSpan(lane,x,z,cursor,out){
  const samples=lane.samples;let at=lane.first[Math.min(cursor,lane.first.length-1)],distance=0,px=x,pz=z;
  while(at<samples.length&&(samples[at].x-x)*samples[at].tx+(samples[at].z-z)*samples[at].tz<=0)at++;
  out.here=at;out.entry=-1;out.exit=-1;out.distance=0;out.inside=false;
  for(let i=at;i<samples.length;i++){
    const q=samples[i];distance+=Math.hypot(q.x-px,q.z-pz);px=q.x;pz=q.z;
    if(q.width<LANE_NARROW){
      if(out.entry<0){out.entry=i;out.distance=distance;out.inside=distance<LANE_INSIDE;}
      out.exit=i;
    }else if(out.entry>=0)return true;
    if(out.entry<0&&distance>LANE_LOOK)return false;
    if(out.entry>=0&&distance-out.distance>LANE_LOOK*2)return true;
  }
  return out.entry>=0;
}
// Do these two stretches run over the same planks in opposite directions?
function crewTrafficSpansMeet(a,sa,b,sb){
  const A=a.samples,B=b.samples;
  for(let i=sa.entry;i<=sa.exit;i++)for(let k=sb.entry;k<=sb.exit;k++){
    const dx=A[i].x-B[k].x,dz=A[i].z-B[k].z;
    if(dx*dx+dz*dz<.1225&&A[i].tx*B[k].tx+A[i].tz*B[k].tz<-.25)return true;
  }
  return false;
}
const crewTrafficSpanA={},crewTrafficSpanB={};
// Should this walker stay out of a gap, for someone coming through it the other way? Returns who, or null.
function crewTrafficGapRival(s,company,boat,field,lane,x,z,cursor){
  if(!crewTrafficSpan(lane,x,z,cursor,crewTrafficSpanA))return null;
  const mine=crewTrafficSpanA;
  for(const o of company.crew){
    if(o===s||!crewTrafficWalking(o)||Math.abs(o.position[1]-s.position[1])>2.6)continue;
    if(Math.hypot(o.position[0]-x,o.position[2]-z)>LANE_LOOK*3)continue;
    const theirs=crewTrafficLane(o,boat,field);if(!theirs)continue;
    const cursorO=o.job?o.job.cursor:o.navigationCursor??0;
    if(!crewTrafficSpan(theirs,o.position[0],o.position[2],cursorO,crewTrafficSpanB))continue;
    if(!crewTrafficSpansMeet(lane,mine,theirs,crewTrafficSpanB))continue;
    if(crewTrafficOutranks(s,mine.inside,o,crewTrafficSpanB.inside))continue;
    // He is not coming, whatever his rank.
    if((o.trafficStill??0)>TRAFFIC_NOT_COMING)continue;
    return o;
  }
  return null;
}
// A place to stand clear of the gap's mouth: the last of the route's room before it, stepped to starboard if that side has any.
function crewTrafficWaitSpot(lane,span,field,boat,s,company,out){
  const samples=lane.samples;let at=span.entry;
  // As far short of the gap as we have to be, and no further back than where he has already got to.
  while(at>0&&samples[at].width<LANE_NARROW)at--;
  let walked=0;
  while(at>0&&walked<LANE_STOP_SHORT){walked+=Math.hypot(samples[at].x-samples[at-1].x,samples[at].z-samples[at-1].z);at--;}
  // Further back, to where a body can stand beside the lane.
  let wide=at;
  for(let back=0;wide>0&&samples[wide].width<LANE_WIDE&&back<16;back++)wide--;
  if(samples[wide].width>=LANE_WIDE)at=wide;
  const q=samples[at];let best=null;
  for(const side of[1,-1])for(const d of[.72,.6,.48]){
    const px=q.x-q.tz*side*d,pz=q.z+q.tx*side*d;
    if(crewDeckRoom(field,boat,px,pz)<CREW_DECK_BODY_M)continue;
    if(company.crew.some(o=>o!==s&&Math.hypot(o.position[0]-px,o.position[2]-pz)<TRAFFIC_BRUSH&&Math.abs(o.position[1]-s.position[1])<1.2))continue;
    best=[px,pz];break;
  }
  if(best){out[0]=best[0];out[1]=best[1];}else{out[0]=q.x;out[1]=q.z;}
}

// Half-planes on velocity: nx*vx+nz*vz >= c. Finds the velocity closest to the preferred one within all of them.
function crewTrafficSolve(count,prefX,prefZ,maxSpeed,out){
  let vx=prefX,vz=prefZ;const speed=Math.hypot(vx,vz);
  if(speed>maxSpeed&&speed>0){vx*=maxSpeed/speed;vz*=maxSpeed/speed;}
  const P=crewTrafficPlanes;
  for(let i=0;i<count;i++){
    const nx=P[i*3],nz=P[i*3+1],c=P[i*3+2];
    if(nx*vx+nz*vz>=c-1e-9)continue;
    const px=nx*c,pz=nz*c,dx=-nz,dz=nx,root=maxSpeed*maxSpeed-c*c;
    if(root<0)return false;
    let lo=-Math.sqrt(root),hi=-lo;
    for(let k=0;k<i;k++){
      const denom=P[k*3]*dx+P[k*3+1]*dz,numer=P[k*3+2]-(P[k*3]*px+P[k*3+1]*pz);
      if(Math.abs(denom)<1e-9){if(numer>1e-9)return false;continue;}
      const t=numer/denom;
      if(denom>0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
      if(lo>hi)return false;
    }
    const t=Math.max(lo,Math.min(hi,dx*(prefX-px)+dz*(prefZ-pz)));
    vx=px+dx*t;vz=pz+dz*t;
  }
  out[0]=vx;out[1]=vz;return true;
}
// The half-plane of velocities that keeps clear of one neighbour for the horizon, taking this share of the avoiding.
function crewTrafficPlane(index,px,pz,vx,vz,ovx,ovz,radius,horizon,share){
  const distance2=px*px+pz*pz,rx=vx-ovx,rz=vz-ovz,inverse=1/horizon,P=crewTrafficPlanes;
  let ux,uz,nx,nz;
  if(distance2>radius*radius){
    const wx=rx-inverse*px,wz=rz-inverse*pz,w2=wx*wx+wz*wz,dot=wx*px+wz*pz;
    if(dot<0&&dot*dot>radius*radius*w2){
      const w=Math.sqrt(w2)||1e-9;nx=wx/w;nz=wz/w;const u=radius*inverse-w;ux=nx*u;uz=nz*u;
    }else{
      const leg=Math.sqrt(distance2-radius*radius);let dx,dz;
      if(px*wz-pz*wx>0){dx=(px*leg-pz*radius)/distance2;dz=(px*radius+pz*leg)/distance2;}
      else{dx=-(px*leg+pz*radius)/distance2;dz=-(-px*radius+pz*leg)/distance2;}
      const along=rx*dx+rz*dz;ux=along*dx-rx;uz=along*dz-rz;
      nx=-dz;nz=dx;
    }
  }else{
    // Already this close. Not closer, and no more than that: nobody leaps apart.
    const d=Math.sqrt(distance2)||1e-9;nx=-px/d;nz=-pz/d;
    P[index*3]=nx;P[index*3+1]=nz;P[index*3+2]=nx*ovx+nz*ovz;
    return;
  }
  P[index*3]=nx;P[index*3+1]=nz;P[index*3+2]=nx*(vx+share*ux)+nz*(vz+share*uz);
}
// Keep off whatever is near, by the way the clearance falls away. Where the route itself runs closer, so may he.
function crewTrafficWall(index,field,boat,x,z,reach,prefX,prefZ){
  const room=crewDeckRoom(field,boat,x,z);
  if(room>=CREW_DECK_BODY_M+.35)return index;
  const e=field.dx*1.5,gx=crewDeckRoom(field,boat,x+e,z)-crewDeckRoom(field,boat,x-e,z),gz=crewDeckRoom(field,boat,x,z+e)-crewDeckRoom(field,boat,x,z-e),g=Math.hypot(gx,gz);
  if(g<1e-6)return index;
  const P=crewTrafficPlanes,nx=gx/g,nz=gz/g;
  P[index*3]=nx;P[index*3+1]=nz;P[index*3+2]=Math.min(0,-(room-CREW_DECK_BODY_M)/reach,nx*prefX+nz*prefZ);
  return index+1;
}
// Somewhere to stand out of this neighbour's way: off the line he is walking, on open deck, and clear of anyone else.
function crewTrafficGiveWay(s,rival,field,boat,x,z,segmentClear){
  const theirs=crewTrafficLane(rival,boat,field),roomHere=crewDeckRoom(field,boat,x,z);let best=null,bestScore=-Infinity;
  for(let k=0;k<8;k++)for(const reach of[.8,.55]){
    const px=x+Math.cos(k*Math.PI/4)*reach,pz=z+Math.sin(k*Math.PI/4)*reach,room=crewDeckRoom(field,boat,px,pz);
    if(room<CREW_DECK_BODY_M||crewDeckLineRoom(field,boat,x,z,px,pz)<Math.min(CREW_DECK_BODY_M,roomHere-.01))continue;
    if(!segmentClear(s,boat,x,z,px,pz))continue;
    let clear=Infinity;
    for(const n of crewTrafficNear)if(n.o!==rival)clear=Math.min(clear,Math.hypot(n.o.position[0]-px,n.o.position[2]-pz));
    if(clear<TRAFFIC_BRUSH)continue;
    // How far off his line that leaves him.
    let off=Math.hypot(rival.position[0]-px,rival.position[2]-pz);
    if(theirs){
      const cursor=rival.job?rival.job.cursor:rival.navigationCursor??0;let at=theirs.first[Math.min(cursor,theirs.first.length-1)],seen=0;
      for(;at<theirs.samples.length&&seen<14;at++,seen++)off=Math.min(off,Math.hypot(theirs.samples[at].x-px,theirs.samples[at].z-pz));
    }
    const score=Math.min(off,TRAFFIC_ROOMY)*3-reach*.5+Math.min(room,1)*.2;
    if(off>=TRAFFIC_TURNED&&score>bestScore){bestScore=score;best=[px,pz];}
  }
  if(best)s.trafficGive={rival,x:best[0],z:best[1],time:0};
  return Boolean(best);
}
// Is the deck open all the way there, with room at the end of it?
function crewTrafficSideOpen(field,boat,x,z,dx,dz,roomHere){
  const length=Math.hypot(dx,dz),count=Math.max(1,Math.ceil(length/.08));
  let room=roomHere;
  for(let i=1;i<=count;i++){
    room=crewDeckRoom(field,boat,x+dx*i/count,z+dz*i/count);
    if(room<.1)return false;
  }
  return room>=CREW_DECK_BODY_M||room>=roomHere;
}
// Is there a way past this body on that hand, with nobody else in it?
function crewTrafficRoundable(field,boat,o,sideX,sideZ){
  const px=o.position[0]+sideX*TRAFFIC_ROOMY,pz=o.position[2]+sideZ*TRAFFIC_ROOMY;
  if(crewDeckRoom(field,boat,px,pz)<CREW_DECK_BODY_M)return false;
  for(const n of crewTrafficNear)if(n.o!==o&&Math.hypot(n.o.position[0]-px,n.o.position[2]-pz)<TRAFFIC_BRUSH)return false;
  return true;
}
// How close another body may be let, as they stand, to one who has turned his shoulders to go by.
const crewTrafficHard=(s,o,dx,dz)=>s.trafficSqueeze>0?TRAFFIC_SQUEEZED:Math.max(TRAFFIC_TURNED-.02,crewBodyHalf(o,dx,dz)+CREW_BODY_HALF_DEPTH-.03);
// May a body step here? Solid things by the clearance, or, below what that can vouch for, by the exact check: along the
// route, or away from what is near. Bodies by what they are standing like, unless he is drawing away from them.
function crewTrafficAllowed(s,boat,field,x,z,nx,nz,atLeast,segmentClear){
  if(nx===x&&nz===z)return true;
  const roomThere=crewDeckRoom(field,boat,nx,nz);
  if(!s.job&&roomThere<TRAFFIC_ROUND_ROOM)return false;
  if(roomThere<TRAFFIC_VOUCHED&&!((roomThere>=CREW_DECK_BODY_M||roomThere>=atLeast)&&segmentClear(s,boat,x,z,nx,nz)))return false;
  for(const n of crewTrafficNear){
    const o=n.o,px=o.position[0]-nx,pz=o.position[2]-nz,d=Math.hypot(px,pz);
    if(d>=n.d-1e-6||o.casualtyState==='fallen')continue;
    // Going by a shoulder closes on it a little, for a moment, and that is all right. Walking into it is not.
    if(d<crewTrafficHard(s,o,px,pz)-TRAFFIC_GRAZE*4||(d<crewTrafficHard(s,o,px,pz)&&d<n.d-TRAFFIC_GRAZE))return false;
  }
  return true;
}
const crewTrafficVelocity=[0,0],crewTrafficSpot=[0,0];
const crewTrafficNear=[];

// His way back along the route to the last of the room, and then on again. False if he has come no way that had any.
function crewTrafficRetreat(s,boat,lane,here){
  const samples=lane.samples,back=[];let at=Math.min(here,samples.length)-1;
  while(at>=0&&samples[at].width<LANE_WIDE&&back.length<LANE_RETREAT){back.push(samples[at]);at--;}
  if(at<0||samples[at].width<LANE_WIDE)return false;
  back.push(samples[at]);
  const scale=crewTrafficScale(boat),design=back.map(q=>[q.x/scale[0],q.y/scale[1],q.z/scale[2]]),job=s.job,path=job?job.path:s.navigationPath,cursor=job?job.cursor:s.navigationCursor??0;
  const mended=[...design,...design.slice(0,-1).reverse(),...path.slice(cursor)];
  if(job){job.path=mended;job.cursor=0;}else{s.navigationPath=mended;s.navigationCursor=0;}
  s.trafficLane=null;s.trafficOffRoute=false;
  return true;
}
// On a stair or a ladder he cannot step aside, but he can stay off it, or back down it. True if he stands this frame.
export function crewTrafficGate(s,company,boat,x,z,dt){
  s.trafficWalkingNow=true;
  const field=crewDeckField(boat);if(!field)return false;
  const lane=crewTrafficLane(s,boat,field);if(!lane)return false;
  const rival=crewTrafficGapRival(s,company,boat,field,lane,x,z,s.job?s.job.cursor:s.navigationCursor??0);
  if(!rival){s.trafficHolding=0;return false;}
  s.trafficHolding=(s.trafficHolding??0)+dt;
  return !crewTrafficRetreat(s,boat,lane,crewTrafficSpanA.here);
}
// One step for a walker free to leave the line of his route, in metres: {x,z} is where he should be. Null when he is on
// the route and it is clear, so that he walks it exactly. rejoin(s,boat,x,z) finds a straight way back onto his route.
export function crewTrafficStep(s,company,boat,{x,z,toX,toZ,speed,dt,segmentClear,rejoin}){
  const field=crewDeckField(boat);
  s.trafficWalkingNow=true;
  if(!field||!(dt>0)||!(speed>0))return null;
  const lane=crewTrafficLane(s,boat,field),cursor=s.job?s.job.cursor:s.navigationCursor??0;
  const dist=Math.hypot(toX-x,toZ-z),dirX=dist>1e-9?(toX-x)/dist:Math.sin(s.yaw??0),dirZ=dist>1e-9?(toZ-z)/dist:Math.cos(s.yaw??0);
  const pace=Math.min(speed,dist/dt);
  let prefX=dirX*pace,prefZ=dirZ*pace,holding=false;
  // Standing clear for someone, until they have gone by.
  const giving=s.trafficGive;
  if(giving){
    giving.time+=dt;
    const away=Math.hypot(giving.rival.position[0]-x,giving.rival.position[2]-z);
    if(giving.time>TRAFFIC_GIVE_SECONDS||!crewTrafficWalking(giving.rival)||away>TRAFFIC_GIVE_CLEAR)s.trafficGive=null;
    else{
      const hx=giving.x-x,hz=giving.z-z,hd=Math.hypot(hx,hz),stroll=Math.min(speed,hd/.25*speed);
      holding=true;s.trafficHolding=(s.trafficHolding??0)+dt;s.trafficOffRoute=true;
      if(hd<.04){prefX=0;prefZ=0;}else{prefX=hx/hd*stroll;prefZ=hz/hd*stroll;}
    }
  }
  // Stay out of a gap someone is coming through.
  if(lane&&!s.trafficGive){
    const rival=crewTrafficGapRival(s,company,boat,field,lane,x,z,cursor);
    if(rival){
      // Both in it, and it is his to give up. He goes back the way he came, to where there is room.
      if(crewTrafficSpanA.inside&&crewTrafficRetreat(s,boat,lane,crewTrafficSpanA.here)){
        s.trafficHolding=(s.trafficHolding??0)+dt;
        return {x,z,holding:true,blocked:false,hemmed:false,ask:null};
      }
      crewTrafficWaitSpot(lane,crewTrafficSpanA,field,boat,s,company,crewTrafficSpot);
      const hx=crewTrafficSpot[0]-x,hz=crewTrafficSpot[1]-z,hd=Math.hypot(hx,hz);
      holding=true;s.trafficHolding=(s.trafficHolding??0)+dt;s.trafficOffRoute=true;
      const stroll=Math.min(speed,hd/.25*speed);
      if(hd<.04){prefX=0;prefZ=0;}else{prefX=hx/hd*stroll;prefZ=hz/hd*stroll;}
    }else s.trafficHolding=0;
  }
  const prefSpeed=Math.hypot(prefX,prefZ);
  // Who is near, on this deck, and might be met within a couple of seconds?
  crewTrafficNear.length=0;
  let threat=false;
  for(const o of company.crew){
    if(o===s||!o.position||o.overboard||o.aloftFall||(o.job?.rung??0)>0)continue;
    if(Math.abs(o.position[1]-s.position[1])>1.2)continue;
    // A man lying on the deck is gone round if there is room and stepped over if not. He keeps no one from taking his place.
    if(o.casualtyState==='fallen'&&(s.trafficSqueeze>0||Math.hypot(o.position[0]-toX,o.position[2]-toZ)<.7))continue;
    const px=o.position[0]-x,pz=o.position[2]-z,d=Math.hypot(px,pz);
    if(d>TRAFFIC_SIGHT)continue;
    const moving=crewTrafficMoving(o),ovx=moving?o.trafficVx??0:0,ovz=moving?o.trafficVz??0:0;
    const rx=prefX-ovx,rz=prefZ-ovz,r2=rx*rx+rz*rz,t=r2>1e-9?Math.max(0,Math.min(TRAFFIC_LOOK_TIME,(px*rx+pz*rz)/r2)):0,gap=Math.hypot(px-rx*t,pz-rz*t);
    // Closing on them is the concern. Someone already near and not getting nearer is only someone to keep in mind.
    // Going by someone at arm's length is enough for a body standing still, and more is wanted of two on the move.
    if(gap<(moving?TRAFFIC_ROOMY:TRAFFIC_BY_STANDER)&&gap<d-.003){threat=true;crewTrafficNear.push({o,px,pz,d,t,moving,ovx,ovz,gap});}
    else if(d<1.4)crewTrafficNear.push({o,px,pz,d,t,moving,ovx,ovz,gap});
  }
  if(!threat&&!holding){
    s.shoulderTurnTarget=0;
    if(!s.trafficOffRoute)return null;
    // Nobody about, and off his route: back onto it, in a line that is known to be clear. Failing that, the route wants mending.
    if(rejoin(s,boat,x,z)){s.trafficOffRoute=false;return {x,z,holding:false,blocked:false,hemmed:false,ask:null};}
    return {x,z,holding:false,blocked:true,hemmed:false,ask:null};
  }
  crewTrafficNear.sort((a,b)=>a.d-b.d);
  if(crewTrafficNear.length>TRAFFIC_NEIGHBOURS)crewTrafficNear.length=TRAFFIC_NEIGHBOURS;
  // Someone standing idle where a hand at work has to go, with no way round them: they can step aside. No need to wait until nose to nose.
  let ask=null;
  if(s.job&&crewTrafficUrgency(s)>=1&&!holding){
    const last=lane?.samples.at(-1),rightX=-dirZ,rightZ=dirX;
    for(const n of crewTrafficNear){
      const o=n.o;
      if(n.moving||o.job||n.d>1.8||n.gap>=.5||n.t<=0||o.seatedPose)continue;
      const onGoal=last&&Math.hypot(o.position[0]-last.x,o.position[2]-last.z)<TRAFFIC_ROOMY;
      if(onGoal||!(crewTrafficRoundable(field,boat,o,rightX,rightZ)||crewTrafficRoundable(field,boat,o,-rightX,-rightZ))){ask=o;break;}
    }
  }
  // Keep to starboard of the way he is going: move over before the meeting, not at it. Someone standing still he goes round
  // on whichever hand is nearer and has the room. Neither way is any good through a bulkhead.
  const routeX=prefX,routeZ=prefZ;
  let stander=null;
  if(!holding&&prefSpeed>0){
    const rightX=-prefZ/prefSpeed,rightZ=prefX/prefSpeed;let soonest=null;
    for(const n of crewTrafficNear)if(n.t>0&&n.gap<(n.moving?TRAFFIC_ROOMY:TRAFFIC_BY_STANDER)&&n.gap<n.d-.003&&(!soonest||n.t<soonest.t))soonest=n;
    if(soonest&&!soonest.moving)stander=soonest.o;
    // Someone crossing, or going the same way, is for the velocities to sort out. Nobody leaves his line for that.
    if(soonest&&soonest.moving&&soonest.ovx*prefX+soonest.ovz*prefZ>=-.25*prefSpeed)soonest=null;
    if(soonest){
      const n=soonest,cx=n.px-(prefX-n.ovx)*n.t,cz=n.pz-(prefZ-n.ovz)*n.t,side=cx*rightX+cz*rightZ,head=n.moving&&n.ovx*prefX+n.ovz*prefZ<-.25*prefSpeed;
      // Half each when the two of them can, and all of it when the other has nowhere to go.
      const hisRoom=head?crewDeckRoom(field,boat,n.o.position[0]-rightX*TRAFFIC_ROOMY*.5,n.o.position[2]-rightZ*TRAFFIC_ROOMY*.5):0;
      const aheadX=prefX*n.t,aheadZ=prefZ*n.t,toRight=head&&hisRoom>=CREW_DECK_BODY_M?(TRAFFIC_ROOMY+side)*.5:TRAFFIC_ROOMY+side,toLeft=TRAFFIC_ROOMY-side,roomHere=crewDeckRoom(field,boat,x,z);
      const firstRight=head||toRight<=toLeft,first=firstRight?toRight:-toLeft,second=firstRight?-toLeft:toRight;
      let over=0;
      if(crewTrafficSideOpen(field,boat,x,z,aheadX+rightX*first,aheadZ+rightZ*first,roomHere))over=first;
      // Meeting someone, with no room on his own hand, he holds his line: the other is going that way himself.
      else if(!head&&crewTrafficSideOpen(field,boat,x,z,aheadX+rightX*second,aheadZ+rightZ*second,roomHere))over=second;
      if(over){
        const wantX=aheadX+rightX*over,wantZ=aheadZ+rightZ*over,want=Math.hypot(wantX,wantZ)||1;
        prefX=wantX/want*prefSpeed;prefZ=wantZ/want*prefSpeed;
      }
    }
  }
  const vx=s.trafficVx??0,vz=s.trafficVz??0;let solved=false;
  for(const radius of[TRAFFIC_ROOMY,TRAFFIC_BRUSH,TRAFFIC_TURNED]){
    let count=0;
    for(const n of crewTrafficNear){
      const o=n.o,hurt=o.casualtyState==='fallen';
      const combined=Math.max(hurt?TRAFFIC_TURNED*.6:crewTrafficHard(s,o,n.px,n.pz),Math.min(radius,n.d-.002));
      const share=!n.moving?1:crewTrafficUrgency(s)===crewTrafficUrgency(o)?.5:crewTrafficUrgency(s)>crewTrafficUrgency(o)?.15:.85;
      crewTrafficPlane(count++,n.px,n.pz,vx,vz,n.ovx,n.ovz,combined,n.moving?TRAFFIC_MOVING_HORIZON:TRAFFIC_STILL_HORIZON,share);
    }
    count=crewTrafficWall(count,field,boat,x,z,.3,routeX,routeZ);
    count=crewTrafficWall(count,field,boat,x+prefX*.35,z+prefZ*.35,.7,routeX,routeZ);
    solved=crewTrafficSolve(count,prefX,prefZ,speed,crewTrafficVelocity);
    // Going wide is as good as going on. Only a stop asks a body to squeeze.
    if(solved&&(holding||Math.hypot(crewTrafficVelocity[0],crewTrafficVelocity[1])>=.35*speed&&crewTrafficVelocity[0]*dirX+crewTrafficVelocity[1]*dirZ>=-.1*speed))break;
  }
  // Nothing may leave the deck or enter a body, whatever the solver wants. If it wants the impossible, the route as drawn may still do.
  let outX=solved?crewTrafficVelocity[0]:0,outZ=solved?crewTrafficVelocity[1]:0;
  const roomHere=crewDeckRoom(field,boat,x,z),closer=roomHere-.005;
  if(!crewTrafficAllowed(s,boat,field,x,z,x+outX*dt,z+outZ*dt,closer,segmentClear)){
    outX=0;outZ=0;
    // If that was no good, the route itself, from where he is. He may have to get back onto it first.
    if(!holding){
      if(s.trafficOffRoute&&rejoin(s,boat,x,z)){s.trafficOffRoute=false;return {x,z,holding:false,blocked:false,hemmed:false,ask};}
      if(!s.trafficOffRoute&&crewTrafficAllowed(s,boat,field,x,z,x+dirX*pace*dt,z+dirZ*pace*dt,-1,segmentClear)){outX=dirX*pace;outZ=dirZ*pace;}
    }
  }
  // People do not change their minds thirty times a second. What the solver asks for is eased into, where the deck allows it.
  const ease=1-Math.exp(-dt*TRAFFIC_EASE),easedX=vx+(outX-vx)*ease,easedZ=vz+(outZ-vz)*ease;
  if((outX||outZ)&&crewTrafficAllowed(s,boat,field,x,z,x+easedX*dt,z+easedZ*dt,closer,segmentClear)){outX=easedX;outZ=easedZ;}
  // Feet go where the body faces, so a turn eats into the pace. A shuffle turns nobody round.
  if(Math.hypot(outX,outZ)>speed*TRAFFIC_TURN_ABOVE){
    const desired=Math.atan2(outX,outZ),turned=crewTurnTowards(s.yaw??0,desired,dt,TRAFFIC_TURN_RATE*1.1);
    s.yaw=turned;
    const facing=Math.max(0,Math.cos(desired-turned));
    outX*=facing;outZ*=facing;
  }
  const nx=x+outX*dt,nz=z+outZ*dt;
  // In a tight place the shoulders come round, to face whoever he is squeezing past.
  let turnTo=0,tightest=TRAFFIC_BRUSH+.06;
  const speedNow=Math.hypot(nx-x,nz-z)/dt;
  if(speedNow>speed*TRAFFIC_TURN_ABOVE)for(const n of crewTrafficNear){
    if(n.o.casualtyState==='fallen')continue;
    const alongX=(nx-x)/dt/speedNow,alongZ=(nz-z)/dt/speedNow,forward=n.px*alongX+n.pz*alongZ,sideways=Math.abs(n.px*alongZ-n.pz*alongX);
    if(forward<-.3||forward>.9||sideways>=tightest)continue;
    tightest=sideways;
    const need=Math.max(0,Math.min(1,(TRAFFIC_BRUSH+.06-sideways)/(TRAFFIC_BRUSH+.06-TRAFFIC_TURNED)));
    const side=n.px*Math.cos(s.yaw??0)-n.pz*Math.sin(s.yaw??0);
    turnTo=Math.sign(side||1)*need*CREW_TURN_FULL;
  }
  s.shoulderTurnTarget=turnTo;
  if(Math.abs((nx-x)*dirZ-(nz-z)*dirX)>1e-4||holding)s.trafficOffRoute=true;
  // A creep is a stop: bodies nearly touching can leave him a velocity of nothing much.
  const blocked=Math.hypot(nx-x,nz-z)<speed*dt*TRAFFIC_CREEP&&!holding;
  // Stopped by someone with nothing to do, he can say so. Stopped by nothing but the ship, it is the route that wants mending.
  // Hemmed in long enough, by someone who cannot or will not shift, he goes by as close as two turned bodies can.
  if(s.trafficSqueeze>0)s.trafficSqueeze-=dt;
  s.trafficStuck=blocked?(s.trafficStuck??0)+dt:0;
  if(s.trafficStuck>TRAFFIC_SQUEEZE_AFTER){s.trafficStuck=0;s.trafficSqueeze=TRAFFIC_SQUEEZE_FOR;}
  let hemmed=false;
  if(blocked)for(const n of crewTrafficNear)if(n.d<TRAFFIC_HEMMED){
    hemmed=true;
    if(!ask&&s.job&&!n.moving&&!n.o.job&&!n.o.seatedPose&&n.o.casualtyState!=='fallen')ask=n.o;
    // Nose to nose with someone who goes first: he steps out of their way.
    if(!s.trafficGive&&crewTrafficWalking(n.o)&&crewTrafficOutranks(n.o,false,s,false)&&!crewTrafficGiveWay(s,n.o,field,boat,x,z,segmentClear)&&lane){
      // Nowhere to stand aside: he goes back the way he came.
      crewTrafficSpan(lane,x,z,cursor,crewTrafficSpanA);
      if(crewTrafficRetreat(s,boat,lane,crewTrafficSpanA.here))break;
    }
  }
  return {x:nx,z:nz,holding,blocked,hemmed,ask,stander};
}
// Is someone who goes first standing nose to nose with this walker? Then the place to go back to is the nearest on his own
// trail that puts him out of their way, as a point in metres, or null if there is no need or nowhere. After long enough,
// anyone: the one who should give way may have nowhere to go, and then it falls to the other.
export function crewTrafficBackTo(s,company,boat,anyone=false){
  const field=crewDeckField(boat),trail=s.trafficTrail;
  if(!field||!trail?.length)return null;
  let rival=null;
  for(const o of company.crew)if(o!==s&&crewTrafficWalking(o)&&Math.abs(o.position[1]-s.position[1])<1.2&&Math.hypot(o.position[0]-s.position[0],o.position[2]-s.position[2])<TRAFFIC_HEMMED&&(anyone||crewTrafficOutranks(o,false,s,false))){rival=o;break;}
  if(!rival)return null;
  const apart=Math.hypot(rival.position[0]-s.position[0],rival.position[2]-s.position[2]),room=crewDeckRoom(field,boat,s.position[0],s.position[2]);
  let furthest=null;
  for(let i=trail.length-1;i>=0;i--){
    const p=trail[i],away=Math.hypot(rival.position[0]-p[0],rival.position[2]-p[2]);
    if(away<apart+TRAFFIC_TRAIL_STEP)continue;
    furthest=p;
    if(crewDeckRoom(field,boat,p[0],p[2])>=Math.max(CREW_DECK_BODY_M,room+.05))return p;
  }
  return furthest;
}
// After everyone has stepped: what each actually did, for the next frame's neighbours, and how far the shoulders have come round.
export function crewTrafficAfterStep(company,boat,dt){
  if(!(dt>0))return;
  for(const s of company.crew){
    // The way he came, for when he has to go back along it.
    if(s.trafficWalkingNow){
      const trail=s.trafficTrail??=[],last=trail.at(-1);
      if(!last||Math.hypot(s.position[0]-last[0],s.position[2]-last[2])>=TRAFFIC_TRAIL_STEP){
        trail.push([s.position[0],s.position[1]-.028,s.position[2]]);
        if(trail.length>TRAFFIC_TRAIL_LENGTH)trail.shift();
      }
    }
    const vx=(s.position[0]-(s.trafficX??s.position[0]))/dt,vz=(s.position[2]-(s.trafficZ??s.position[2]))/dt;
    s.trafficVx=vx;s.trafficVz=vz;s.trafficX=s.position[0];s.trafficZ=s.position[2];
    s.trafficStill=Math.hypot(vx,vz)<.02?(s.trafficStill??0)+dt:0;
    s.trafficWalking=s.trafficWalkingNow===true;s.trafficWalkingNow=false;
    const target=s.trafficWalking?s.shoulderTurnTarget??0:0,turn=s.shoulderTurn??0;
    s.shoulderTurn=turn===target?turn:crewTurnTowards(turn,target,dt,TRAFFIC_TURN_RATE);
    if(!s.trafficWalking){s.trafficHolding=0;s.trafficGive=null;}
  }
}
