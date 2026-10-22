// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {createMeshWriter} from './mesh-writer.js';
import {rowingDesign,rowingDeck,rowingHullWidth,rowingHullDeck,rowingRigContext,rowingBenchDescriptors} from './models/rowing.js';
import {hullLoftPoint,hullLoftBottom,hullLoftSheer} from './hull-loft.js';
import {rowingStationPose,rowingSteeringPose} from './rowing.js';
import {rowingAnchorFitting,rowingSurfaceSpar,proceduralRigContext} from './additional-rig.js';
import {surfaceRestPoint,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint} from './rig-surface.js';

const rowingMeshAdd=(a,b)=>a.map((v,i)=>v+b[i]),rowingMeshSub=(a,b)=>a.map((v,i)=>v-b[i]),rowingMeshMul=(a,s)=>a.map(v=>v*s);
const rowingMeshDot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const rowingMeshCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rowingMeshUnit=p=>{const n=Math.hypot(...p);return n>1e-12?rowingMeshMul(p,1/n):[0,1,0];};
function rowingMeshBasis(axis,preferred){
  const direction=rowingMeshUnit(axis),across=preferred?rowingMeshUnit(rowingMeshSub(preferred,rowingMeshMul(direction,rowingMeshDot(preferred,direction)))):
    rowingMeshUnit(rowingMeshCross(direction,Math.abs(direction[1])<.9?[0,1,0]:[1,0,0]));
  return {across,up:rowingMeshCross(direction,across)};
}
function rowingMeshRestBoat(d){return {modelId:d.id,...d.runtime,rowingState:{phase:0,rate:0,effortPort:0,effortStarboard:0},rudder:0};}

export function createRowingShipMesh(modelId,{groups,parts}={}){
  const d=rowingDesign(modelId),p=d.profile,context=proceduralRigContext(modelId),rest=rowingMeshRestBoat(d),sx=d.runtime.beam/d.frame.beam,sy=d.frame.verticalScale,sz=d.runtime.length/d.frame.length;
  const {out,quad,tri,box,tube,rope,group,tag,unit}=createMeshWriter({groups,parts});
  const physicalGeometry=build=>{
    const writer=createMeshWriter();build(writer);
    for(let i=0;i<writer.out.length;i+=9){
      const normal=unit([writer.out[i+3]*sx,writer.out[i+4]*sy,writer.out[i+5]*sz]);
      out.push(writer.out[i]/sx,writer.out[i+1]/sy,writer.out[i+2]/sz,...normal,writer.out[i+6],writer.out[i+7],writer.out[i+8]);
    }
  };
  const ports=d.stations.filter(s=>s.oarlock==='hull-port'),portRY=.055/sy,portRZ=.055/sz,portY=p.deck-.12/sy;
  const zs=[...new Set([...p.stations,...Array.from({length:65},(_,i)=>-6+12*i/64),...d.stations.map(s=>s.z),...ports.flatMap(s=>[s.z-portRZ,s.z+portRZ])])].sort((a,b)=>a-b);
  const levels=[...new Set([...Array.from({length:25},(_,i)=>p.levels[0]+(p.deck-p.levels[0])*i/24),...(ports.length?[portY-portRY,portY+portRY]:[])])].sort((a,b)=>a-b);
  const fractions=levels.map(y=>(y-p.levels[0])/(p.deck-p.levels[0]));
  const outer=(z,y,side)=>hullLoftPoint(p,z,y,side),inner=(z,t,side)=>{
    const y=Math.max(p.levels[0]+d.shellThickness,p.levels[0]+(p.deck-p.levels[0])*t),q=hullLoftPoint(p,z,y,side);
    q[0]=side*Math.max(0,Math.abs(q[0])-d.shellThicknessMetres/sx);return q;
  };
  const inPort=(z,y,side)=>ports.some(s=>s.side===side&&Math.abs(z-s.z)<portRZ-1e-8&&Math.abs(y-portY)<portRY-1e-8);
  const normals=(q,side,inside=false)=>{
    const e=.0001,dy=(rowingHullWidth(modelId,q[2],q[1]+e)-rowingHullWidth(modelId,q[2],q[1]-e))/(2*e),dz=(rowingHullWidth(modelId,q[2]+e,q[1])-rowingHullWidth(modelId,q[2]-e,q[1]))/(2*e);
    return unit([side*(inside?-1:1),-dy*(inside?-1:1),-dz*(inside?-1:1)]);
  };
  const hullStart=out.length;
  for(const side of [-1,1])for(let i=0;i<zs.length-1;i++)for(let j=0;j<levels.length-1;j++){
    const z=zs[i],Z=zs[i+1],y=levels[j],Y=levels[j+1],q=[outer(z,y,side),outer(Z,y,side),outer(Z,Y,side),outer(z,Y,side)];
    if(inPort((z+Z)*.5,(y+Y)*.5,side))continue;
    quad(...q,15,q.map(v=>normals(v,side)),[[y/(18*.12),z*.6],[y/(18*.12),Z*.6],[Y/(18*.12),Z*.6],[Y/(18*.12),z*.6]]);
  }
  group('hull.outer','hull',hullStart);
  const insideStart=out.length;
  for(const side of [-1,1])for(let i=0;i<zs.length-1;i++)for(let j=0;j<levels.length-1;j++){
    const z=zs[i],Z=zs[i+1],a=fractions[j],b=fractions[j+1],q=[inner(z,a,side),inner(z,b,side),inner(Z,b,side),inner(Z,a,side)];
    if(inPort((z+Z)*.5,(levels[j]+levels[j+1])*.5,side))continue;
    quad(...q,1,q.map(v=>normals(v,side,true)));
  }
  group('hull.inner','hull',insideStart);
  const closureStart=out.length;
  for(let i=0;i<zs.length-1;i++){
    const z=zs[i],Z=zs[i+1];
    quad(outer(z,levels[0],-1),outer(Z,levels[0],-1),outer(Z,levels[0],1),outer(z,levels[0],1),15);
    quad(inner(z,0,-1),inner(z,0,1),inner(Z,0,1),inner(Z,0,-1),1);
    for(const side of [-1,1])quad(outer(z,p.deck,side),outer(Z,p.deck,side),inner(Z,1,side),inner(z,1,side),1);
  }
  for(const z of [-6,6])for(const side of [-1,1])for(let j=0;j<levels.length-1;j++)quad(outer(z,levels[j],side),inner(z,fractions[j],side),inner(z,fractions[j+1],side),outer(z,levels[j+1],side),1);
  group('hull.closed-shell','hull',closureStart);
  for(const station of ports){
    const start=out.length,point=(angle,square,inside)=>{
      const a=Math.sin(angle),b=Math.cos(angle),factor=square?1/Math.max(Math.abs(a),Math.abs(b)):1;
      const y=portY+portRY*a*factor,z=station.z+portRZ*b*factor;
      return inside?inner(z,(y-p.levels[0])/(p.deck-p.levels[0]),station.side):outer(z,y,station.side);
    };
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8,b=(i+1)*Math.PI/8;
      for(const inside of [false,true])quad(point(a,true,inside),point(b,true,inside),point(b,false,inside),point(a,false,inside),1);
      quad(point(a,false,false),point(b,false,false),point(b,false,true),point(a,false,true),1);
    }
    group('rowing.port.'+station.id,'hull',start);
  }
  if(d.keel){
    const start=out.length,k=d.keel,cuts=[k.bounds[0],...zs.filter(z=>z>k.bounds[0]&&z<k.bounds[1]),k.bounds[1]],point=(z,side,lo)=>[side*k.width/2,hullLoftBottom(p,z)-(lo?k.depth:0),z];
    for(let i=0;i<cuts.length-1;i++){
      const z=cuts[i],Z=cuts[i+1];for(const side of [-1,1])quad(point(z,side,false),point(z,side,true),point(Z,side,true),point(Z,side,false),1);
      for(const lo of [false,true])quad(point(z,-1,lo),point(Z,-1,lo),point(Z,1,lo),point(z,1,lo),1);
    }
    for(const z of [cuts[0],cuts.at(-1)])quad(point(z,-1,false),point(z,1,false),point(z,1,true),point(z,-1,true),1);
    group('hull.keel','hull',start);
  }
  if(d.construction==='clinker-oak'){
    const start=out.length;
    for(const side of [-1,1])for(let j=2;j<24;j+=2)for(let i=0;i<zs.length-1;i++){
      const z=zs[i],Z=zs[i+1],base=levels[j],A=outer(z,base,side),B=outer(Z,base,side),a=outer(z,base+.010,side),b=outer(Z,base+.010,side);
      if(inPort((z+Z)*.5,base,side))continue;
      a[0]+=side*.004/sx;b[0]+=side*.004/sx;quad(A,B,b,a,1);
    }
    group('hull.clinker-laps','hull',start);
  }
  const floorStart=out.length;
  for(let i=1;i<zs.length-2;i++){
    const z=zs[i],Z=zs[i+1],y=rowingDeck(modelId,z),Y=rowingDeck(modelId,Z),w=Math.max(0,rowingHullWidth(modelId,z,y)-d.shellThicknessMetres/sx),W=Math.max(0,rowingHullWidth(modelId,Z,Y)-d.shellThicknessMetres/sx);
    for(let j=0;j<18;j++){
      const a=-1+2*j/18,b=-1+2*(j+1)/18;quad([a*w,y,z],[a*W,Y,Z],[b*W,Y,Z],[b*w,y,z],0);
    }
  }
  group('deck.floorboards','deck.main',floorStart);
  const benchesStart=out.length;
  for(const bench of rowingBenchDescriptors(modelId)){
    box(bench.min,bench.max,1);
    for(const leg of bench.supports)tube(leg.a,leg.b,leg.radius,1,leg.radius,leg.sides);
  }
  group('rowing.benches','deck.main',benchesStart);
  const framesStart=out.length;
  for(let i=4;i<zs.length-4;i+=5){
    if(ports.some(s=>Math.abs(zs[i]-s.z)<portRZ+.04))continue;
    for(const side of [-1,1])for(let j=2;j<24;j+=2)tube(inner(zs[i],j/24,side),inner(zs[i],Math.min(1,(j+2)/24),side),.012,1,.012,5,undefined,true);
  }
  group('hull.frames','hull',framesStart);
  const railStart=out.length;
  for(const side of [-1,1])for(let i=0;i<zs.length-1;i++)tube(outer(zs[i],p.deck,side),outer(zs[i+1],p.deck,side),.018,1,.018,6,undefined,true);
  group('hull.gunwales','hull',railStart);
  if(d.id==='oseberg'){
    const start=out.length;
    for(const sign of [-1,1]){
      const z=sign*6,y=rowingHullDeck(modelId,z),points=[];
      for(let i=0;i<=18;i++){const t=i/18;points.push([0,y+t*.90,z+sign*(.15*Math.sin(t*Math.PI)-.12*t*t)]);}
      for(let i=0;i<12;i++){const a=i*Math.PI/16;points.push([0,y+.90+.13*Math.sin(a),z-sign*.12-sign*.13*(1-Math.cos(a))]);}
      for(let i=0;i<points.length-1;i++)tube(points[i],points[i+1],.035,1,.031,8,undefined,true);
    }
    group('hull.carved-stems','hull',start);
  }
  for(const station of d.stations){
    const start=out.length,pose=rowingStationPose(rest,station.id),material=16+station.index/64;
    if(station.oarlock==='tholepins'){
      const pivot=station.pivot;for(const sign of [-1,1])tube([pivot[0],pivot[1]-.065/sy,pivot[2]+sign*.055/sz],[pivot[0],pivot[1]+.085/sy,pivot[2]+sign*.055/sz],.012/sy,1,.012/sy,6);
    }
    const dynamicStart=out.length;
    physicalGeometry(({tube,quad})=>{
      tube(pose.shaftA,pose.shaftB,d.propulsion.shaftRadius,material,d.propulsion.shaftRadius*.72,8);
      const n=pose.bladeNormal,offset=rowingMeshMul(n,d.propulsion.bladeThickness*.5),front=pose.bladeCorners.map(q=>rowingMeshAdd(q,offset)),back=pose.bladeCorners.map(q=>rowingMeshSub(q,offset));
      quad(...front,material,front.map(()=>n));quad(...back.slice().reverse(),material,back.map(()=>rowingMeshMul(n,-1)));
      for(let i=0;i<4;i++)quad(front[i],front[(i+1)%4],back[(i+1)%4],back[i],material);
    });
    group('rowing.propulsor.'+station.id,'rowing.'+station.id,dynamicStart,{type:'rowing-blade',stationId:station.id});
    group('rowing.station.'+station.id,'rowing.'+station.id,start);
  }
  const steeringStart=out.length,steering=rowingSteeringPose(rest);
  physicalGeometry(({tube,quad})=>{
    tube(steering.shaftA,steering.shaftB,.026,17,.018,8);
    const n=steering.bladeNormal,offset=rowingMeshMul(n,d.propulsion.bladeThickness*.5),front=steering.bladeCorners.map(q=>rowingMeshAdd(q,offset)),back=steering.bladeCorners.map(q=>rowingMeshSub(q,offset));
    quad(...front,17,front.map(()=>n));quad(...back.slice().reverse(),17,back.map(()=>rowingMeshMul(n,-1)));
    for(let j=0;j<4;j++)quad(front[j],front[(j+1)%4],back[(j+1)%4],back[j],17);
  });
  group('helm.steering-oar','helm.rudder',steeringStart,{type:'steering-oar'});
  const cargoStart=out.length;
  for(const c of d.equipment.cargo){const y=rowingDeck(modelId,c.z),[w,h,L]=c.extent;box([-w,y,c.z-L],[w,y+h,c.z+L],1);}
  const bailerY=rowingDeck(modelId,2.8);box([.22,bailerY,2.7],[.35,bailerY+.09,2.9],1);
  group('deck.stores','deck.main',cargoStart);
  if(d.equipment.anchor)for(const side of [-1,1]){
    const start=out.length,a=rowingAnchorFitting(modelId,side);tube(a.root,a.tip,.035/sy,1,.028/sy,6);
    group('anchor.'+(side<0?'port':'starboard'),'anchor.'+(side<0?'port':'starboard')+'.root',start);
  }
  for(const m of context.masts){const start=out.length;tube(m.foot,m.head,m.radius,1,.018,12);group('mast.'+m.id,'mast.'+m.id,start);}
  for(const s of context.surfaces){
    const start=out.length,n=20;
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      const uv=[[i/n,j/n],[(i+1)/n,j/n],[(i+1)/n,(j+1)/n],[i/n,(j+1)/n]],q=uv.map(p=>surfaceRestPoint(s,...p));quad(...q,tag(9,s.id),null,uv);
    }
    group('sail.'+s.name,'sail.'+s.name,start,{type:'surface-cloth',surface:s.id});
    const yardStart=out.length,spar=rowingSurfaceSpar(s);tube(spar.a,spar.b,spar.radius,tag(10,s.id),spar.radiusEnd,10);
    group('yard.'+s.name,'yard.'+s.name,yardStart,{type:'surface-yard',surface:s.id});
  }
  const rigStart=out.length;for(const line of context.supports)rope(line.a,line.b,line.r,2,1,0);group('rig.standing','hull',rigStart);
  const runtime={...context,state:{},poses:new Map(context.surfaces.map(s=>[s.id,rigSurfacePose(s,{})]))},runningStart=out.length;
  for(const [index,line] of context.lines.entries())for(let j=0;j<8;j++){
    const t=j/8,T=(j+1)/8;tube(surfaceRopePoint(line,t,runtime),surfaceRopePoint(line,T,runtime),line.r??.007,12,line.r??.007,4,[[100+index,t],[100+index,T]],true);
  }
  group('rig.running','hull',runningStart,{type:'surface-running-rigging'});
  return new Float32Array(out);
}

export function createRowingAssetPose(asset,options={}){
  const id=asset.model?.id??asset.modelId,d=rowingDesign(id),source=asset.vertices,restBoat=rowingMeshRestBoat(d),context=options.context??proceduralRigContext(id),surfaces=new Map(d.surfaces.map(s=>[s.id,s]));
  if(!(source instanceof Float32Array)||source.length%9)throw Error('Rowing pose requires nine-float asset vertices');
  const scale=[d.runtime.beam/d.frame.beam,d.frame.verticalScale,d.runtime.length/d.frame.length],physical=p=>p.map((v,i)=>v*scale[i]);
  const restPoses=d.stations.map(s=>rowingStationPose(restBoat,s.id));restPoses.push(rowingSteeringPose(restBoat));
  const restContext={...context,state:{},poses:new Map(d.surfaces.map(s=>[s.id,rigSurfacePose(s,{})]))},blades=[],yards=[],cloth=new Map(),ropes=new Map(),ropeVertices=[];
  for(let at=0;at<source.length;at+=9){
    const kind=Math.floor(source[at+6]),code=Math.round((source[at+6]-kind)*64),position=Array.from(source.subarray(at,at+3)),normal=Array.from(source.subarray(at+3,at+6));
    if(kind===16||kind===17){
      const index=kind===17?d.stations.length:code,pose=restPoses[index];if(!pose)throw Error('Invalid rowing blade material tag');
      const q=rowingMeshSub(physical(position),pose.bladeCentre),N=rowingMeshUnit(normal.map((v,i)=>v/scale[i]));
      blades.push({at,index,p:[rowingMeshDot(q,pose.bladeAlong),rowingMeshDot(q,pose.bladeAcross),rowingMeshDot(q,pose.bladeNormal)],
        n:[rowingMeshDot(N,pose.bladeAlong),rowingMeshDot(N,pose.bladeAcross),rowingMeshDot(N,pose.bladeNormal)]});
    }else if(kind===9&&surfaces.has(code)){
      const u=source[at+7],v=source[at+8],key=code+'/'+u+'/'+v;let sample=cloth.get(key);
      if(!sample){sample={surface:surfaces.get(code),u,v,indices:[]};cloth.set(key,sample);}sample.indices.push(at);
    }else if(kind===10&&surfaces.has(code))yards.push({at,surface:surfaces.get(code),position,normal});
    else if(kind===12&&source[at+7]>=100){
      const index=Math.round(source[at+7]-100),line=context.lines[index],t=source[at+8],key=index+'/'+t;if(!line)throw Error('Invalid rowing rig line');let sample=ropes.get(key);
      if(!sample){const point=surfaceRopePoint(line,t,restContext),a=surfaceRopePoint(line,Math.max(0,t-.001),restContext),b=surfaceRopePoint(line,Math.min(1,t+.001),restContext),basis=rowingMeshBasis(rowingMeshSub(b,a));sample={line,t,point,basis,across:basis.across};ropes.set(key,sample);}
      const q=rowingMeshSub(position,sample.point);ropeVertices.push({at,sample,p:[rowingMeshDot(q,sample.basis.across),rowingMeshDot(q,sample.basis.up)],n:[rowingMeshDot(normal,sample.basis.across),rowingMeshDot(normal,sample.basis.up)]});
    }
  }
  const samples=[...cloth.values()],ropeSamples=[...ropes.values()],poses=new Map(),runtime={...context,poses,state:null,time:0,wind:0};
  const write=(target,at,p,n)=>{for(let k=0;k<3;k++){target[at+k]=p[k];target[at+3+k]=n[k];}};
  return (boat,time,wind,target)=>{
    if(!(target instanceof Float32Array)||target.length!==source.length)throw Error('Rowing posed vertex buffer has wrong shape');
    const liveScale=[(boat.beam??d.runtime.beam)/d.frame.beam,d.frame.verticalScale,(boat.length??d.runtime.length)/d.frame.length];
    const live=d.stations.map(s=>rowingStationPose(boat,s.id,{time}));live.push(rowingSteeringPose(boat,{time}));
    for(const entry of blades){
      const p=live[entry.index],axes=[p.bladeAlong,p.bladeAcross,p.bladeNormal],point=rowingMeshAdd(p.bladeCentre,[0,1,2].map(i=>axes.reduce((sum,a,j)=>sum+a[i]*entry.p[j],0)));
      const normal=rowingMeshUnit([0,1,2].map(i=>axes.reduce((sum,a,j)=>sum+a[i]*entry.n[j],0)*liveScale[i]));
      write(target,entry.at,point.map((v,i)=>v/liveScale[i]),normal);
    }
    runtime.state=boat.sailState??{};runtime.time=time;runtime.wind=wind;for(const s of d.surfaces)poses.set(s.id,rigSurfacePose(s,runtime.state));
    for(const sample of samples){
      const {surface:s,u,v}=sample,pose=poses.get(s.id),e=.0005,point=surfaceClothPoint(s,u,v,pose,runtime,time,wind),du=rowingMeshSub(surfaceClothPoint(s,u+e,v,pose,runtime,time,wind),surfaceClothPoint(s,u-e,v,pose,runtime,time,wind)),dv=rowingMeshSub(surfaceClothPoint(s,u,v+e,pose,runtime,time,wind),surfaceClothPoint(s,u,v-e,pose,runtime,time,wind));
      const normal=rowingMeshUnit(rowingMeshCross(du,dv));for(const at of sample.indices)write(target,at,point,normal);
    }
    for(const entry of yards){const pose=poses.get(entry.surface.id),point=surfaceYardPoint(entry.surface,entry.position,pose),N=surfaceYardPoint(entry.surface,rowingMeshAdd(entry.position,entry.normal),pose);write(target,entry.at,point,rowingMeshUnit(rowingMeshSub(N,point)));}
    for(const sample of ropeSamples){const {line,t}=sample,a=surfaceRopePoint(line,Math.max(0,t-.001),runtime),b=surfaceRopePoint(line,Math.min(1,t+.001),runtime);sample.point=surfaceRopePoint(line,t,runtime);sample.basis=rowingMeshBasis(rowingMeshSub(b,a),sample.across);}
    for(const e of ropeVertices){const {point,basis}=e.sample;write(target,e.at,rowingMeshAdd(point,rowingMeshAdd(rowingMeshMul(basis.across,e.p[0]),rowingMeshMul(basis.up,e.p[1]))),rowingMeshUnit(rowingMeshAdd(rowingMeshMul(basis.across,e.n[0]),rowingMeshMul(basis.up,e.n[1]))));}
    return true;
  };
}
