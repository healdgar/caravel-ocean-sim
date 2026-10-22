// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// One prescribed human stroke supplies geometry, grips, immersion and blade
// velocity. Water reaction is plate drag, never a speed target or forward boost.
import {rowingDesign,rowingHullWidth,rowingHullDeck,rowingDeck} from './models/rowing.js';

const rowingClamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const rowingAdd=(a,b)=>a.map((v,i)=>v+b[i]),rowingSub=(a,b)=>a.map((v,i)=>v-b[i]),rowingMul=(a,s)=>a.map(v=>v*s);
const rowingDot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const rowingCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rowingUnit=p=>{const n=Math.hypot(...p);return n>1e-12?rowingMul(p,1/n):[0,1,0];};
const rowingFinitePoint=p=>p?.length===3&&Array.from(p).every(Number.isFinite);
function rowingRotation(boat){
  const h=(boat.heading??0)*Math.PI/180,p=boat.pitch??0,r=boat.roll??0,ch=Math.cos(h),sh=Math.sin(h),cp=Math.cos(p),sp=Math.sin(p),cr=Math.cos(r),sr=Math.sin(r);
  return [[ch*cr-sh*sp*sr,cp*sr,sh*cr+ch*sp*sr],[-ch*sr-sh*sp*cr,cp*cr,-sh*sr+ch*sp*cr],[-sh*cp,-sp,ch*cp]];
}
function rowingRotate(axes,p){return [0,1,2].map(i=>axes[0][i]*p[0]+axes[1][i]*p[1]+axes[2][i]*p[2]);}
function rowingInverse(axes,p){return axes.map(axis=>rowingDot(axis,p));}
function rowingScale(boat,d){
  const length=boat.length??d.runtime.length,beam=boat.beam??d.runtime.beam;
  if(!(Number.isFinite(length)&&length>0&&Number.isFinite(beam)&&beam>0))throw Error('Invalid rowing vessel dimensions');
  return [beam/d.frame.beam,d.frame.verticalScale,length/d.frame.length];
}
const rowingSmooth=t=>{t=rowingClamp(t);return t*t*(3-2*t);};
const rowingSmoothDerivative=t=>t>0&&t<1?6*t*(1-t):0;

export function rowingState(boat){
  const d=rowingDesign(boat.modelId);
  return boat.rowingState??={phase:0,rate:0,effortPort:0,effortStarboard:0,cadence:d.propulsion.cadence};
}
export function advanceRowing(boat,dt,commands={}){
  const d=rowingDesign(boat.modelId),state=rowingState(boat);
  if(!(Number.isFinite(dt)&&dt>0))return state;
  const requested=rowingClamp(Number.isFinite(commands.effort)?commands.effort:Number.isFinite(boat.rowingEffort)?boat.rowingEffort:0);
  const turn=rowingClamp(Number.isFinite(commands.turn)?commands.turn:Number.isFinite(boat.rowingTurn)?boat.rowingTurn:0,-1,1);
  const port=Number.isFinite(commands.port)?rowingClamp(commands.port):requested*(1+Math.min(0,turn));
  const starboard=Number.isFinite(commands.starboard)?rowingClamp(commands.starboard):requested*(1-Math.max(0,turn));
  const cadence=Number.isFinite(commands.cadence)?rowingClamp(commands.cadence,.12,d.propulsion.maxCadence):d.propulsion.cadence;
  const previous=Number.isFinite(state.rate)?state.rate:0,target=(port+starboard)>0?cadence:0,decay=Math.exp(-dt*3),next=target+(previous-target)*decay;
  // Exact integral of the first-order cadence response; phase is independent
  // of how a frame interval is partitioned. No vessel momentum is changed here.
  state.phase=(((Number.isFinite(state.phase)?state.phase:0)+target*dt+(previous-target)*(1-decay)/3)%1+1)%1;
  state.rate=next;state.cadence=cadence;state.effortPort=port;state.effortStarboard=starboard;return state;
}
function rowingStroke(d,state,station,phase){
  const effort=rowingClamp(station.side<0?state.effortPort??0:state.effortStarboard??0),fraction=d.propulsion.driveFraction;
  const cycle=((phase+(station.phaseOffset??0))%1+1)%1,drive=cycle<fraction&&effort>0,t=drive?cycle/fraction:(cycle-fraction)/(1-fraction);
  const active=effort>0,rate=active?(state.rate??0):0,tdot=rate/(drive?fraction:1-fraction);
  const progress=rowingSmooth(t),progressRate=rowingSmoothDerivative(t)*tdot,sign=drive?1:-1;
  const sweep=active?(drive?-1+2*progress:1-2*progress):-1,sweepRate=active?sign*2*progressRate:0;
  const a=t/.12,b=(t-.86)/.14,A=rowingSmooth(a),B=1-rowingSmooth(b);
  const immersed=drive?A*B:0,immersionRate=drive?(rowingSmoothDerivative(a)/.12*B-A*rowingSmoothDerivative(b)/.14)*tdot:0;
  return {effort,cycle,drive,sweep,sweepRate,immersed,immersionRate};
}
function rowingWaterSample(sampleWater,p,time){
  const value=sampleWater?sampleWater(p[0],p[2],time):0;
  const height=typeof value==='number'?value:value?.height,velocity=typeof value==='number'?[0,0,0]:value?.velocity??[0,0,0];
  return Number.isFinite(height)&&rowingFinitePoint(velocity)?{height,velocity:Array.from(velocity)}:null;
}
function rowingWetPolygon(corners,sampleWater,time){
  const depths=corners.map(p=>{const sample=rowingWaterSample(sampleWater,p,time);return sample?p[1]-sample.height:NaN;});
  if(!depths.every(Number.isFinite))return {area:0,centre:[0,0,0],valid:false};
  const polygon=[];
  for(let i=0;i<corners.length;i++){
    const j=(i+1)%corners.length,a=corners[i],b=corners[j],da=depths[i],db=depths[j];
    if(da<=0)polygon.push(a);if((da<0)!==(db<0)){const t=da/(da-db);polygon.push(a.map((v,k)=>v+(b[k]-v)*t));}
  }
  let area=0,centre=[0,0,0];
  for(let i=1;i<polygon.length-1;i++){
    const a=polygon[0],b=polygon[i],c=polygon[i+1],weight=.5*Math.hypot(...rowingCross(rowingSub(b,a),rowingSub(c,a)));
    area+=weight;centre=rowingAdd(centre,rowingMul(rowingAdd(rowingAdd(a,b),c),weight/3));
  }
  return {area,centre:area?rowingMul(centre,1/area):[0,0,0],valid:true};
}
function rowingPoseFinish(boat,d,pose,{time=0,sampleWater}={}){
  const axes=rowingRotation(boat),origin=[boat.x??0,boat.heave??0,boat.z??0];
  pose.bladeCorners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b])=>rowingAdd(pose.bladeCentre,
    rowingAdd(rowingMul(pose.bladeAlong,a*pose.bladeLength*.5),rowingMul(pose.bladeAcross,b*pose.bladeWidth*.5))));
  pose.worldCorners=pose.bladeCorners.map(p=>rowingAdd(origin,rowingRotate(axes,p)));
  const wet=rowingWetPolygon(pose.worldCorners,sampleWater,time);
  pose.wetArea=wet.area;pose.immersion=rowingClamp(wet.area/(pose.bladeLength*pose.bladeWidth));pose.waterValid=wet.valid;
  pose.wetCentreWorld=wet.centre;pose.wetCentre=wet.area?rowingInverse(axes,rowingSub(wet.centre,origin)):pose.bladeCentre;
  pose.worldNormal=rowingRotate(axes,pose.bladeNormal);pose.axes=axes;return pose;
}

// All returned attachment coordinates are hull-local metres. Mesh writers
// convert them through this model's frame; IK consumes the same hand points.
export function rowingStationPose(boat,stationId,{phase,time=0,sampleWater}={}){
  const d=rowingDesign(boat.modelId),state=rowingState(boat),station=Number.isInteger(stationId)?d.stations[stationId]:d.stations.find(s=>s.id===stationId);
  if(!station)throw Error('No rowing station '+stationId+' on '+d.id);
  const scale=rowingScale(boat,d),physical=p=>p.map((v,i)=>v*scale[i]),seat=physical(station.seat);
  const stroke=rowingStroke(d,state,station,Number.isFinite(phase)?phase:state.phase),spec=d.propulsion;
  const feather=(1-stroke.immersed)*Math.PI/2,cos=Math.cos(feather),sin=Math.sin(feather);
  let shaftA,shaftB,centre,velocity,along,across,normal,hands;
  if(station.kind==='oar'){
    const pivot=physical(station.pivot),theta=spec.catchAngle*stroke.sweep,thetaRate=spec.catchAngle*stroke.sweepRate;
    const R=station.outboard,desiredY=.32+(-.18-.32)*stroke.immersed,Y=(desiredY-pivot[1])/R;
    const phi=Math.asin(rowingClamp(Y,-.85,.85)),phiRate=Y>-.85&&Y<.85?(-.50*stroke.immersionRate/R)/Math.sqrt(1-Y*Y):0;
    const ct=Math.cos(theta),st=Math.sin(theta),cp=Math.cos(phi),sp=Math.sin(phi),side=station.side;
    along=[side*cp*ct,sp,cp*st];
    centre=rowingAdd(pivot,rowingMul(along,R));
    velocity=[side*R*(-sp*phiRate*ct-cp*st*thetaRate),R*cp*phiRate,R*(-sp*phiRate*st+cp*ct*thetaRate)];
    const up=rowingUnit(rowingSub([0,1,0],rowingMul(along,along[1]))),N=rowingUnit(rowingCross(along,up));
    across=rowingAdd(rowingMul(up,cos),rowingMul(N,sin));normal=rowingUnit(rowingCross(along,across));
    const handle=rowingAdd(pivot,rowingMul(along,-station.inboard));shaftA=rowingAdd(handle,rowingMul(along,-.10));shaftB=rowingAdd(centre,rowingMul(along,spec.bladeLength*.45));
    hands=[rowingAdd(handle,rowingMul(along,-.065)),rowingAdd(handle,rowingMul(along,.065))];
  }else{
    const z=station.z*scale[2],rim=rowingHullDeck(d.id,station.z),edge=rowingHullWidth(d.id,station.z,rim)*scale[0];
    centre=[station.side*(edge+.12),.48+(-.23-.48)*stroke.immersed,z+.46*stroke.sweep];
    velocity=[0,-.71*stroke.immersionRate,.46*stroke.sweepRate];
    along=rowingUnit([-station.side*.23,1,0]);
    const width=rowingUnit(rowingSub([1,0,0],rowingMul(along,along[0]))),N=rowingUnit(rowingCross(along,width));
    across=rowingAdd(rowingMul(width,cos),rowingMul(N,sin));normal=rowingUnit(rowingCross(along,across));
    shaftA=rowingAdd(centre,rowingMul(along,1.54));shaftB=rowingAdd(centre,rowingMul(along,-spec.bladeLength*.5));
    const low=rowingAdd(centre,rowingMul(along,.90)),high=rowingAdd(centre,rowingMul(along,1.39));hands=station.side<0?[high,low]:[low,high];
  }
  const footZ=seat[2]+(station.kind==='oar'?.58:-.46),floorDesign=rowingDeck(d.id,footZ/scale[2]),floor=floorDesign*scale[1];
  const footEdge=Math.max(.02,rowingHullWidth(d.id,footZ/scale[2],floorDesign)*scale[0]-d.shellThicknessMetres);
  const footX=rowingClamp(seat[0],-Math.max(0,footEdge-.12),Math.max(0,footEdge-.12));
  const feet=[[rowingClamp(footX-.10,-footEdge,footEdge),floor,footZ],[rowingClamp(footX+.10,-footEdge,footEdge),floor,footZ]];
  return rowingPoseFinish(boat,d,{stationId:station.id,station:station.index,side:station.side,drive:stroke.drive,effort:stroke.effort,
    seat,feet,hands,body:{position:seat,yaw:station.kind==='oar'?0:Math.PI,lean:(station.kind==='oar'?1:-1)*.16*stroke.sweep},
    shaftA,shaftB,bladeCentre:centre,bladeAlong:along,bladeAcross:across,bladeNormal:normal,bladeVelocity:velocity,
    bladeLength:spec.bladeLength,bladeWidth:spec.bladeWidth,feather}, {time,sampleWater});
}

export function rowingSteeringPose(boat,{time=0,sampleWater}={}){
  const d=rowingDesign(boat.modelId),scale=rowingScale(boat,d),spec=d.steering,pivot=spec.pivot.map((v,i)=>v*scale[i]);
  const angle=rowingClamp((boat.rudder??0)*Math.PI/180,-.65,.65),c=Math.cos(angle),s=Math.sin(angle);
  const turn=p=>{const q=rowingSub(p,pivot);return [pivot[0]+c*q[0]+s*q[2],p[1],pivot[2]-s*q[0]+c*q[2]];};
  const vector=p=>[c*p[0]+s*p[2],p[1],-s*p[0]+c*p[2]],handle=turn(spec.handle.map((v,i)=>v*scale[i])),centre=turn(spec.blade.map((v,i)=>v*scale[i]));
  const along=vector(rowingUnit([0,-1,.2])),normal=vector([1,0,0]),across=rowingUnit(rowingCross(normal,along));
  return rowingPoseFinish(boat,d,{stationId:'helm',side:1,drive:false,effort:0,shaftA:handle,shaftB:rowingAdd(centre,rowingMul(along,spec.bladeLength*.45)),
    bladeCentre:centre,bladeAlong:along,bladeAcross:across,bladeNormal:normal,bladeVelocity:[0,0,0],bladeLength:spec.bladeLength,bladeWidth:spec.bladeWidth,
    hands:[handle,rowingAdd(handle,rowingMul(rowingUnit(rowingSub(centre,handle)),.14))]}, {time,sampleWater});
}

// Water samples are world-space {height,velocity:[vx,vy,vz]} (or height alone).
// Flat stationary water is the explicit default. Wave phase speed is never used
// as incident fluid velocity. Force/moment output is N/Nm, in the boat integrator's
// heading-frame/generalized axes; the function never updates speed or phase.
export function rowingForces(out,boat,{time=0,sampleWater,cg}={}){
  const d=rowingDesign(boat.modelId),h=(boat.heading??0)*Math.PI/180,p=boat.pitch??0,ch=Math.cos(h),sh=Math.sin(h),cp=Math.cos(p),sp=Math.sin(p);
  for(const key of ['forward','side','heaveForce','rollMoment','pitchMoment','yawMoment','power','crewPower','waterPower','dissipation','activeBlades','wetBlades'])out[key]=0;
  const forces=out.blades??=[];forces.length=0;
  const centre=rowingFinitePoint(cg)?Array.from(cg):[0,boat.hydrodynamics?(boat.hydrodynamics.centreOfGravity-(boat.hydrodynamics.datumDraft??-d.profile.levels[0]*d.frame.verticalScale)):0,0];
  const u=boat.surgeVelocity??0,v=boat.leewayVelocity??0,w=boat.heaveVelocity??0,pr=boat.pitchVelocity??0,rr=boat.rollVelocity??0,yr=boat.yawRate??0;
  if(![u,v,w,pr,rr,yr].every(Number.isFinite))return out;
  const translation=[u*sh+v*ch,w,-u*ch+v*sh],omega=[pr*ch-rr*sh*cp,-yr-rr*sp,pr*sh+rr*ch*cp];
  const poses=d.stations.map(s=>rowingStationPose(boat,s.id,{time,sampleWater}));poses.push(rowingSteeringPose(boat,{time,sampleWater}));
  for(const pose of poses){
    if(!(pose.wetArea>0)||!pose.waterValid)continue;
    const water=rowingWaterSample(sampleWater,pose.wetCentreWorld,time);if(!water)continue;
    const r=rowingRotate(pose.axes,rowingSub(pose.wetCentre,centre)),bodyVelocity=rowingAdd(translation,rowingCross(omega,r)),strokeVelocity=rowingRotate(pose.axes,pose.bladeVelocity);
    const relative=rowingSub(rowingAdd(bodyVelocity,strokeVelocity),water.velocity),closing=rowingDot(relative,pose.worldNormal);
    const cd=pose.stationId==='helm'?d.steering.dragCoefficient:d.propulsion.dragCoefficient;
    let magnitude=-.5*1025*cd*pose.wetArea*Math.abs(closing)*closing;
    const forceDirection=pose.worldNormal,rawInput=-magnitude*rowingDot(forceDirection,strokeVelocity);
    if(pose.stationId!=='helm'){
      const station=d.stations[pose.station],lever=station.kind==='oar'?station.inboard/station.outboard:1;
      const forceLimit=d.propulsion.maxHandForce*lever*(pose.drive?pose.effort:1);
      let factor=Math.min(1,forceLimit/Math.max(Math.abs(magnitude),1e-12));
      if(pose.drive&&rawInput>0)factor=Math.min(factor,d.propulsion.maxPower*pose.effort/rawInput);
      magnitude*=factor;
    }
    const force=rowingMul(forceDirection,magnitude),moment=rowingCross(r,force);
    out.forward+=force[0]*sh-force[2]*ch;out.side+=force[0]*ch+force[2]*sh;out.heaveForce+=force[1];out.yawMoment-=moment[1];
    out.pitchMoment+=moment[0]*ch+moment[2]*sh;out.rollMoment+=-moment[0]*sh*cp-moment[1]*sp+moment[2]*ch*cp;
    out.power+=rowingDot(force,bodyVelocity);out.crewPower-=rowingDot(force,strokeVelocity);out.waterPower+=rowingDot(force,water.velocity);out.dissipation-=rowingDot(force,relative);
    out.wetBlades++;if(pose.drive)out.activeBlades++;
    forces.push({stationId:pose.stationId,force,relativeVelocity:relative,normal:pose.worldNormal,wetArea:pose.wetArea,drive:pose.drive,crewPower:-rowingDot(force,strokeVelocity)});
  }
  return out;
}
