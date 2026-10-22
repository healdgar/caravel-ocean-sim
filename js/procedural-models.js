// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Explicit adapters for the five later craft. No readiness promotion occurs
// here: root's integrated geometry/crew/physics/render gates own admission.
import {deepFreeze,defineRig} from './rig-definition.js';
import {ROWING_DESIGNS,rowingDesign,rowingDeck} from './models/rowing.js';
import {LATER_SAIL_DESIGNS,laterSailDesign,laterSailDeck,laterSailStairFlights} from './models/later-sail.js';
import {proceduralRigContext,laterSailSteeringPose,rowingAnchorFitting,rowingSurfaceSpar} from './additional-rig.js';
import {rigSurfacePose,surfaceRestPoint,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint,withRigPoseContext} from './rig-surface.js';
import {rowingStationPose,rowingSteeringPose} from './rowing.js';

const proceduralNodeAdd=(a,b)=>a.map((v,i)=>v+b[i]);
const proceduralNodeSub=(a,b)=>a.map((v,i)=>v-b[i]);
const proceduralNodeMul=(a,s)=>a.map(v=>v*s);
const proceduralNodeCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const proceduralNodeUnit=p=>{const n=Math.hypot(...p);if(!(n>1e-12))throw Error('Degenerate procedural attachment basis');return proceduralNodeMul(p,1/n);};
const proceduralNodeIdentity=()=>[[1,0,0],[0,1,0],[0,0,1]];
const proceduralNodeClamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
function proceduralNodeDesign(id){
  if(Object.hasOwn(ROWING_DESIGNS,id))return rowingDesign(id);
  if(Object.hasOwn(LATER_SAIL_DESIGNS,id))return laterSailDesign(id);
  throw Error('No later procedural model: '+id);
}
function proceduralNodeScale(boat,model){
  const d=model.designFrame,length=boat.length??model.runtime.length,beam=boat.beam??model.runtime.beam;
  if(![length,beam,d.verticalScale].every(v=>Number.isFinite(v)&&v>0))throw Error('Procedural nodes require positive hull dimensions');
  return [beam/d.beam,d.verticalScale,length/d.length];
}
function proceduralNodeAxisFrame(position,axis){
  const y=proceduralNodeUnit(axis),reference=Math.abs(y[0])<.9?[1,0,0]:[0,0,1],z=proceduralNodeUnit(proceduralNodeCross(reference,y)),x=proceduralNodeUnit(proceduralNodeCross(y,z));
  return {position,basis:[x,y,z],kind:'rigid'};
}
function proceduralNodeRigid(position,transform){
  const origin=transform(position),basis=proceduralNodeIdentity().map(e=>proceduralNodeSub(transform(proceduralNodeAdd(position,e)),origin));
  return {position:origin,basis,kind:'rigid'};
}
function proceduralNodeCloth(surface,boat,context,u,v,time,wind){
  const state=boat.sailState??{},live=withRigPoseContext(context,state),pose=live.poses.get(surface.id),sample=(u,v)=>surfaceClothPoint(surface,u,v,pose,live,time,wind),e=.0005;
  const a=proceduralNodeMul(proceduralNodeSub(sample(u+e,v),sample(u-e,v)),1/(2*e)),b=proceduralNodeMul(proceduralNodeSub(sample(u,v+e),sample(u,v-e)),1/(2*e));
  return {position:sample(u,v),basis:[a,b,proceduralNodeUnit(proceduralNodeCross(a,b))],kind:'surface'};
}
function proceduralNodeRestBoat(d){return {modelId:d.id,...d.runtime,rudder:0,rowingState:{phase:0,rate:0,effortPort:0,effortStarboard:0}};}

export function createProceduralShipDefinition(id,{status='planned'}={}){
  if(!['planned','ready'].includes(status))throw Error('Unknown procedural readiness: '+status);
  const d=proceduralNodeDesign(id),row=Object.hasOwn(ROWING_DESIGNS,id),context=proceduralRigContext(id),nodes={},fittings=[],scale=[d.runtime.beam/d.frame.beam,d.frame.verticalScale,d.runtime.length/d.frame.length];
  const add=(id,position,kind='attachment',motion)=>{
    if(Object.hasOwn(nodes,id))throw Error('Duplicate '+d.id+' node '+id);
    nodes[id]={id,parent:id==='hull'?null:'hull',position:[...position],kind,...(motion?{motion}:{})};return nodes[id];
  };
  const deck=(z,x=0)=>row?rowingDeck(id,z):laterSailDeck(id,z,x),rest=proceduralNodeRestBoat(d),physicalToDesign=p=>p.map((v,i)=>v/scale[i]);
  add('hull',[0,0,0],'frame');add('deck.main',[0,deck(0),0],'frame');
  for(const zone of d.deckZones??[])if(zone.id!=='main'){const z=(zone.bounds[0]+zone.bounds[1])/2;add('deck.'+zone.id,[0,deck(z),z],'frame');}
  if(d.cockpit){const z=(d.cockpit.bounds[0]+d.cockpit.bounds[1])/2;add('deck.cockpit',[0,deck(z),z],'frame');}
  for(const [name,station]of Object.entries(d.crewStations))add('station.crew.'+name,[station.x,station.y??deck(station.z,station.x),station.z],'station');
  add('station.helm',[d.helm.x,deck(d.helm.z,d.helm.x),d.helm.z],'station');
  add('helm.camera',[d.helm.x,deck(d.helm.z,d.helm.x)+d.helm.eyeAboveDeck/d.frame.verticalScale,d.helm.z]);
  add('helm.rudder',d.steering.pivot,'part',{type:'procedural-helm',part:'rudder'});
  if(row){
    const pose=rowingSteeringPose(rest);
    add('helm.steering-oar',d.steering.pivot,'part',{type:'procedural-helm',part:'rudder'});
    for(let hand=0;hand<pose.hands.length;hand++)add('helm.grip.'+hand,physicalToDesign(pose.hands[hand]),'attachment',{type:'procedural-helm',part:'grip',hand});
    add('helm.grip',physicalToDesign(pose.hands[0]),'attachment',{type:'procedural-helm',part:'grip',hand:0});
  }else{
    const pose=laterSailSteeringPose(rest);
    if(pose.kind==='wheel')add('helm.wheel',d.steering.wheel.centre,'part',{type:'procedural-helm',part:'wheel'});
    else add('helm.tiller',d.steering.pivot,'part',{type:'procedural-helm',part:'tiller'});
    add('helm.grip',pose.handle,'attachment',{type:'procedural-helm',part:'grip',hand:0});
    for(let hand=0;hand<pose.grips.length;hand++)add('helm.grip.'+hand,pose.grips[hand],'attachment',{type:'procedural-helm',part:'grip',hand});
  }
  if(d.hatch){
    const h=d.hatch,hinge=[h.centre[0],h.centre[1],h.centre[2]-h.size[2]/2],grip=[h.centre[0],h.centre[1]+h.size[1],h.centre[2]+h.size[2]/2-.05/scale[2]];
    add('hatch.main',hinge,'part',{type:'procedural-hatch',point:hinge});add('hatch.grip',grip,'attachment',{type:'procedural-hatch',point:grip});
    let x=h.centre[0]+h.size[0]/2+.24/scale[0],z=h.centre[2];
    if(d.cockpit){
      x=0;const aft=Math.max(...d.structures.map(s=>s.centre[2]+s.size[2]/2)),flight=laterSailStairFlights(id).find(f=>f.zoneId==='cockpit');
      // Remain outside the cabin's .22 m navigation margin, but close enough
      // for the standing worker to reach the real forward-hinged roof lid.
      // Do not move the worker onto the descending cockpit flight.
      z=Math.min(aft+.28/scale[2],flight.z0-.20/scale[2]);
    }
    add('station.hatch',[x,deck(z,x),z],'station');
  }
  if(row?d.equipment.anchor:d.equipment.anchors)for(const side of [-1,1]){
    const name=side<0?'port':'starboard',ends=row?rowingAnchorFitting(id,side):context.anchorCathead(side);
    for(const [part,point]of Object.entries(ends))add('anchor.'+name+'.'+part,point);
  }
  const masts=context.masts.map((m,index)=>{
    const root='mast.'+m.id;add(root,m.foot,'frame',{type:'procedural-mast',mast:index});add(root+'.head',m.head,'attachment',{type:'procedural-mast',mast:index});
    const climbable=m.climbable===true&&typeof context.runnerPoint==='function';
    if(climbable){
      add(root+'.runner',context.runnerPoint(index,-1,0),'attachment',{type:'procedural-runner',mast:index,rungs:m.rungs});
      if(m.platform){add('lookout.'+m.id,m.platform,'station');fittings.push({id:m.id+'-platform',kind:'mast-platform',mast:m.id,node:'lookout.'+m.id});}
    }
    return {id:m.id,index,node:root,headNode:root+'.head',controlGroup:m.controlGroup??d.surfaces.find(s=>s.mast===index)?.controlGroup,
      climbable,...(climbable?{climbNode:root+'.runner'}:{})};
  });
  for(const [control,station]of Object.entries(context.controlStations??{})){
    add('station.haul.'+control,station.position,'station');
    add('rig.'+control+'.fall',station.lead,'attachment',{type:'procedural-fall',controlGroup:control,lineIndex:station.lineIndex});
  }
  const sails=d.surfaces.map(s=>{
    const triangle=s.corners.length===3,root='sail.'+s.name,u=triangle?1/3:.5,v=triangle?1/3:.5;
    add(root,surfaceRestPoint(s,u,v),'part',{type:'procedural-cloth',surface:s.id,u,v});
    const luffUV=s.kind==='gaff'?[0,.5]:[.5,0];
    add(root+'.luff',surfaceRestPoint(s,...luffUV),'attachment',{type:'procedural-cloth',surface:s.id,u:luffUV[0],v:luffUV[1]});
    const clews=s.kind==='square'?[['clew.port',0,1],['clew.starboard',1,1]]:s.kind==='gaff'?[['clew',1,1]]:[['clew',0,1]];
    const clewNodes=clews.map(([name,u,v])=>{const role=root+'.'+name;add(role,surfaceRestPoint(s,u,v),'attachment',{type:'procedural-cloth',surface:s.id,u,v});return role;});
    let yardNode,sparNode;
    const actualSpars=s.spars??(row&&s.kind==='square'?[rowingSurfaceSpar(s)]:[]);
    for(const spar of actualSpars){
      const role='spar.'+spar.id,centre=proceduralNodeMul(proceduralNodeAdd(spar.a,spar.b),.5);
      add(role,centre,'part',{type:'procedural-spar',surface:s.id,point:centre});
      for(const end of ['a','b'])add(role+'.'+end,spar[end],'attachment',{type:'procedural-spar',surface:s.id,point:spar[end]});
      if(spar.kind==='yard'){
        // A brace pivot can be on the mast axis. The visible yard attachment
        // remains at the actual spar centre, shared with spar.<id>.
        yardNode='yard.'+s.name;add(yardNode,centre,'part',{type:'procedural-spar',surface:s.id,point:centre});
      }
      sparNode??=role;
    }
    return {id:s.name,surfaceId:s.id,mast:context.masts[s.mast].id,kind:s.kind,controlGroup:s.controlGroup,sailNode:root,clewNodes,
      ...(yardNode?{yardNode}:sparNode?{sparNode}:{luffNode:root+'.luff'})};
  });
  if(row)for(const station of d.stations){
    const pose=rowingStationPose(rest,station.id),role='rowing.'+station.id;
    add(role,physicalToDesign(pose.bladeCentre),'part',{type:'procedural-rowing',stationId:station.id,part:'blade'});
    add(role+'.blade',physicalToDesign(pose.bladeCentre),'attachment',{type:'procedural-rowing',stationId:station.id,part:'blade'});
    for(let hand=0;hand<pose.hands.length;hand++)add(role+'.grip.'+hand,physicalToDesign(pose.hands[hand]),'attachment',{type:'procedural-rowing',stationId:station.id,part:'grip',hand});
    for(let foot=0;foot<pose.feet.length;foot++)add(role+'.foot.'+foot,physicalToDesign(pose.feet[foot]),'attachment',{type:'procedural-rowing',stationId:station.id,part:'foot',foot});
    if(station.pivot)add(role+'.pivot',station.pivot);
  }
  const rig=defineRig({id:id+'-rig',backend:'surfaces-v1',masts,sails,fittings},nodes,{planned:status!=='ready'});
  return deepFreeze({id,modelCode:d.modelCode,gpuPose:false,name:d.name,revision:d.revision,status,development:true,hullFamily:d.family,
    geometry:row?'rowing-procedural-v1':'later-sail-procedural-v1',designFrame:d.frame,runtime:d.runtime,crewStations:d.crewStations,
    capabilities:{...(d.capabilities??{}),sailing:d.surfaces.length>0,rowing:row,yardTransfer:d.surfaces.some(s=>s.kind==='lateen'),
      anchors:!!(row?d.equipment.anchor:d.equipment.anchors),gunnery:false},nodes,rig,referenceMeasurements:d.references??d.referenceMeasurements});
}

// Always returns a design-space affine frame. The central parts adapter applies
// anisotropic design→vessel/world transforms once, including normal covectors.
export function proceduralShipNodeTransform(boat,model,node,options={}){
  if(typeof node==='string')node=model.nodes[node];if(!node)throw Error('Absent '+model.id+' procedural node');
  const d=proceduralNodeDesign(model.id),context=proceduralRigContext(model.id),motion=node.motion,time=options.time??0,wind=options.wind??0,row=Object.hasOwn(ROWING_DESIGNS,model.id);
  if(!motion){
    if(node.parent!==null&&node.parent!=='hull')throw Error('Unmodeled moving procedural parent: '+node.parent);
    return {position:[...node.position],basis:proceduralNodeIdentity(),kind:'rigid'};
  }
  if(motion.type==='procedural-cloth'||motion.type==='procedural-spar'){
    const surface=d.surfaces.find(s=>s.id===motion.surface);if(!surface)throw Error('Absent authored procedural surface '+motion.surface);
    if(motion.type==='procedural-cloth')return proceduralNodeCloth(surface,boat,context,options.u??motion.u,options.v??motion.v,time,wind);
    return proceduralNodeRigid(motion.point,p=>surfaceYardPoint(surface,p,rigSurfacePose(surface,boat.sailState??{})));
  }
  if(motion.type==='procedural-mast'){
    const m=context.masts[motion.mast];return proceduralNodeAxisFrame([...node.position],proceduralNodeSub(m.head,m.foot));
  }
  if(motion.type==='procedural-runner'){
    const step=proceduralNodeClamp(options.step??0,0,motion.rungs),side=options.side??-1,p=context.runnerPoint(motion.mast,side,step),m=context.masts[motion.mast];
    const direction=proceduralNodeSub(context.runnerPoint(motion.mast,side,Math.min(motion.rungs,step+.01)),context.runnerPoint(motion.mast,side,Math.max(0,step-.01)));
    return proceduralNodeAxisFrame(p,direction.some(x=>Math.abs(x)>1e-10)?direction:proceduralNodeSub(m.head,m.foot));
  }
  if(motion.type==='procedural-fall'){
    const line=context.lines[motion.lineIndex];if(line?.kind!=='working-fall')throw Error('Absent physical working fall');
    const t=options.t??(options.height>0?proceduralNodeClamp((options.height-line.a[1])/(line.b[1]-line.a[1])):1),runtime={...context,state:boat.sailState??{},time,wind};
    const a=surfaceRopePoint(line,Math.max(0,t-.001),runtime),b=surfaceRopePoint(line,Math.min(1,t+.001),runtime);
    return proceduralNodeAxisFrame(surfaceRopePoint(line,t,runtime),proceduralNodeSub(b,a));
  }
  if(motion.type==='procedural-hatch'){
    const h=d.hatch,pivot=[h.centre[0],h.centre[1],h.centre[2]-h.size[2]/2],angle=(1-proceduralNodeClamp(boat.hatchesClosed??0))*Math.PI/2,c=Math.cos(angle),s=Math.sin(angle);
    return proceduralNodeRigid(motion.point,p=>{const q=proceduralNodeSub(p,pivot);return [p[0],pivot[1]+c*q[1]+s*q[2],pivot[2]-s*q[1]+c*q[2]];});
  }
  if(motion.type==='procedural-helm'){
    if(row){
      const pose=rowingSteeringPose(boat,{time}),scale=proceduralNodeScale(boat,model),position=motion.part==='grip'?pose.hands[options.hand??(options.along<0?1:motion.hand??0)]:d.steering.pivot.map((v,i)=>v*scale[i]);
      return {position:position.map((v,i)=>v/scale[i]),basis:[pose.bladeAlong,pose.bladeAcross,pose.bladeNormal].map(a=>a.map((v,i)=>v/scale[i])),kind:'rigid'};
    }
    const pose=laterSailSteeringPose(boat);
    if(motion.part==='wheel')return {position:pose.wheel.centre,basis:pose.basis,kind:'rigid'};
    if(motion.part==='grip')return {position:pose.grips[options.hand??(options.along<0?1:motion.hand??0)]??pose.handle,basis:pose.basis,kind:'rigid'};
    return {position:[...d.steering.pivot],basis:pose.rudderBasis,kind:'rigid'};
  }
  if(motion.type==='procedural-rowing'){
    const pose=rowingStationPose(boat,motion.stationId,{time}),scale=proceduralNodeScale(boat,model),p=motion.part==='grip'?pose.hands[options.hand??motion.hand]:motion.part==='foot'?pose.feet[motion.foot]:pose.bladeCentre;
    return {position:p.map((v,i)=>v/scale[i]),basis:[pose.bladeAlong,pose.bladeAcross,pose.bladeNormal].map(a=>a.map((v,i)=>v/scale[i])),kind:'rigid'};
  }
  throw Error('No authoritative procedural node evaluator: '+motion.type);
}

export function resolveProceduralShipNode(boat,model,node,{space='vessel',out=[0,0,0],...options}={}){
  if(!['design','vessel'].includes(space))throw Error('Unknown procedural point space: '+space);
  const transform=proceduralShipNodeTransform(boat,model,node,options),scale=space==='design'?[1,1,1]:proceduralNodeScale(boat,model);
  for(let i=0;i<3;i++)out[i]=transform.position[i]*scale[i];return out;
}
