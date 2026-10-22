// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Immutable asset preparation and compact per-vessel inputs for the GPU rig.
// CPU cloth/rope sampling below runs only while an asset is constructed.
import {proceduralRigContext} from './additional-rig.js';
import {ADDITIONAL_DESIGNS,additionalDesign} from './models/additional.js';
import {LATER_SAIL_DESIGNS,laterSailDesign} from './models/later-sail.js';
import {ROWING_DESIGNS,rowingDesign} from './models/rowing.js';
import {rigSurfacePose,surfaceControlIndex,surfaceRopePoint,withRigPoseContext} from './rig-surface.js';
import {rowingStationPose,rowingSteeringPose} from './rowing.js';

// Binding 3 is a vec4 array. All offsets stored in it are vec4 offsets.
// Header: [surfaces,count,supports,count], [ropes,count,steering,hatch],
// [backend (0 legacy / 1 surfaces), vertexCount, rowingBasis, 0].
// Surface (10 vec4): [kind,corners,control,mast], [pivot,braceLimit],
// [A,footRise], [B,belly], [C,flutter], [D,pressureSpeed],
// [camberAxis,pinBand], [hingeAxis,sewnEdgeMask],
// [yardClearance,transferArc,transferLift,contactClearance],
// [contactBand,mastSide (-1 fore / 1 aft / 0 none),0,0].
// Support (4 vec4): [a,r], [b,rEnd], [mast,surface,movingOwner,flags], 0.
// Flags: 1 mast-face barrier; 2 skips its owning canvas. Missing indices = -1.
// Rope (10 vec4): a/b/lazyLead each [XYZ,surface] + [type,u,v,0],
// [sag,lazySag,side,paired], [workingSide,override,leadSplit,hasLazyLead],
// [edgeSurface,u0,v0,u1], [v1,isClothEdge,0,0]. Endpoint type: fixed0/cloth1/spar2.
// Steering (4 vec4): [pivot,hasWheel], [wheelCentre,ratio], [wheelAxis,0], 0.
// Hatch (1 vec4): [hinge,0].
// Binding 4 is three vec4 per indexed vertex: [category,index,u,v],
// [positionData,0], [normalData,0]. For ropes the latter two instead hold
// [c,s,nc,ns] and [preferredAcross,0]. For blades they are rest basis coordinates.
// Categories: static0/cloth1/spar2/rope3/blade4/rudder-or-tiller5/wheel6/hatch7.
// Binding 5 header: [time,wind,rudderRadians,hatchOpeningRadians], [scale,0],
// [surfaceCount,bladeCount,0,0], followed by 2 vec4 per surface and 4 per blade.
// Surface live: [yaw,deployed,fill,side], [opening,dip,pressure,0].
// Blade live: centre/along/across/normal, each XYZ, in hull-local metres.
export const RIG_GPU_LAYOUT=Object.freeze({
  headerVec4:3,surfaceVec4:10,supportVec4:4,ropeVec4:10,steeringVec4:4,hatchVec4:1,
  vertexFloats:12,frameHeaderFloats:12,surfaceStateFloats:8,bladeStateFloats:16,
});
const rigGPUPrivate=new WeakMap();
const rigGPUKinds=Object.freeze({square:0,lateen:1,headsail:2,gaff:3,bermudan:4});
const rigGPUEdges=Object.freeze({u0:1,u1:2,v0:4,v1:8,diagonal:16});
const rigGPUSub=(a,b)=>a.map((v,i)=>v-b[i]);
const rigGPUMul=(a,s)=>a.map(v=>v*s);
const rigGPUDot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const rigGPUCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function rigGPUUnit(v,fallback=[0,1,0]){const n=Math.hypot(...v);return n>1e-12?rigGPUMul(v,1/n):[...fallback];}
function rigGPUDesign(id){
  if(Object.hasOwn(ADDITIONAL_DESIGNS,id))return additionalDesign(id);
  if(Object.hasOwn(LATER_SAIL_DESIGNS,id))return laterSailDesign(id);
  if(Object.hasOwn(ROWING_DESIGNS,id))return rowingDesign(id);
  throw Error('No GPU rig descriptor for '+id);
}
function rigGPUFrameBasis(axis){
  const direction=rigGPUUnit(axis),reference=Math.abs(direction[1])<.9?[0,1,0]:[1,0,0];
  const across=rigGPUUnit(rigGPUCross(direction,reference));
  return {across,up:rigGPUCross(direction,across)};
}
function rigGPUSurfaceIndex(indices,id){
  const index=indices.get(id);if(index===undefined)throw Error('Unknown GPU rig surface '+id);return index;
}
function rigGPUSurfaceRecord(s){
  const kind=rigGPUKinds[s.kind];if(kind===undefined)throw Error('Unsupported GPU rig surface '+s.kind);
  const [a,b,c,d=c]=s.corners,axis=s.camberAxis??(s.kind==='square'?[0,0,1]:[1,0,0]);
  const sewn=s.sewnEdges??((s.kind==='gaff'&&s.corners.length===4)||s.kind==='bermudan'?['v0','u0']:['v0']);
  const sewnMask=sewn.reduce((bits,edge)=>{if(!rigGPUEdges[edge])throw Error('Unknown GPU sewn edge '+edge);return bits|rigGPUEdges[edge];},0);
  const contactSide=s.mastContactSide===undefined?0:s.mastContactSide==='fore'?-1:s.mastContactSide==='aft'?1:null;
  if(contactSide===null)throw Error('Invalid GPU mast contact side');
  return [kind,s.corners.length,surfaceControlIndex(s),s.mast,...s.pivot,s.braceLimit??(s.kind==='square'?Math.PI/3:1.2),
    ...a,s.footRise??0,...b,s.belly??.2,...c,s.flutter??.035,...d,s.pressureSpeed??1.5,
    ...axis,s.contactPinBand??.06,...(s.hingeAxis??[0,1,0]),sewnMask,
    s.yardClearance??.2,s.transferArc??.22,s.transferLift??Math.hypot(...rigGPUSub(b,a))*.15,s.contactClearance??.045,
    s.contactBand??.25,contactSide,0,0];
}
function rigGPUAttachment(a,indices){
  if(Array.isArray(a)&&a.length===3)return [...a,-1,0,0,0,0];
  if(!a||a.surface===undefined)throw Error('Invalid GPU rope attachment');
  const index=rigGPUSurfaceIndex(indices,a.surface);
  if(a.uv?.length===2)return [0,0,0,index,1,...a.uv,0];
  if(a.point?.length===3)return [...a.point,index,2,0,0,0];
  throw Error('GPU rope attachment requires UV or spar point');
}
function rigGPURopeRecord(line,indices,context){
  const edge=line.clothEdge,edgeIndex=line.surface===undefined?-1:rigGPUSurfaceIndex(indices,line.surface);
  // A sewn edge has no independent endpoints; the shader samples its canvas.
  const zero=[0,0,0,-1,0,0,0,0];
  const a=edge?zero:rigGPUAttachment(line.a,indices),b=edge?zero:rigGPUAttachment(line.b,indices);
  const lead=line.lazyLead===undefined?zero:rigGPUAttachment(line.lazyLead,indices);
  const binding=line.a?.surface??line.b?.surface??line.surface;
  const surface=binding===undefined?null:context.surfaces[rigGPUSurfaceIndex(indices,binding)];
  const paired=line.paired??(line.kind==='sheet'&&surface?.kind!=='square');
  if(paired&&(!surface||![-1,1].includes(line.side)))throw Error('GPU paired sheet needs its working side');
  return [...a,...b,...lead,line.sag??(line.kind==='sheet'?.04:0),line.lazySag??.25,line.side??0,Number(paired),
    line.workingSide??0,Number(line.workingSide!==undefined),line.leadSplit??.72,Number(line.lazyLead!==undefined),
    edgeIndex,edge?.[0][0]??0,edge?.[0][1]??0,edge?.[1][0]??0,edge?.[1][1]??0,Number(!!edge),0,0];
}

export function createRigGPUData(asset){
  const source=asset?.vertices,model=asset?.model,id=model?.id??asset?.modelId,backend=model?.rig?.backend;
  if(!(source instanceof Float32Array)||!source.length||source.length%9)throw Error('GPU rig needs nine-float indexed source vertices');
  if(!id||!['lateen3','square1805','surfaces-v1'].includes(backend))throw Error('Unsupported GPU rig backend '+backend);
  const count=source.length/9,vertices=new Float32Array(count*RIG_GPU_LAYOUT.vertexFloats);
  if(backend!=='surfaces-v1'){
    const data=Object.freeze({model:new Float32Array([3,0,3,0,3,0,3,3,0,count,0,0]),vertices,
      frameFloatCount:12,surfaceStateOffset:12,bladeStateOffset:12,bladeCount:0,surfaceCount:0,modelId:id});
    rigGPUPrivate.set(data,{frame:model.designFrame,runtime:model.runtime,surfaces:[],rowing:false});return data;
  }
  const design=rigGPUDesign(id),context=proceduralRigContext(id),rowing=Object.hasOwn(ROWING_DESIGNS,id);
  const surfaces=context.surfaces,indices=new Map(surfaces.map((s,i)=>[s.id,i]));
  const supports=[...(context._surfaceCollisionSupports??[
    ...(context.supports??[]),...(context.masts??[]).map((m,i)=>({a:m.foot,b:m.head,r:m.radius,rEnd:m.tipRadius,kind:'mast',mast:m.index??i})),
  ]),...(context.spars??[]).map(s=>({a:s.a,b:s.b,r:s.radius,kind:'spar',sparKind:s.kind,mast:s.mast,surface:s.surface,movingOwner:s.surface}))];
  const surfaceOffset=3,supportOffset=surfaceOffset+surfaces.length*10,ropeOffset=supportOffset+supports.length*4;
  const steeringOffset=ropeOffset+context.lines.length*10,hatchOffset=steeringOffset+4,packed=new Float32Array((hatchOffset+1)*4);
  packed.set([surfaceOffset,surfaces.length,supportOffset,supports.length,ropeOffset,context.lines.length,steeringOffset,hatchOffset,1,count,Number(rowing),0]);
  for(const [i,s]of surfaces.entries())packed.set(rigGPUSurfaceRecord(s),(surfaceOffset+i*10)*4);
  for(const [i,s]of supports.entries()){
    const face=s.kind==='mast'||s.kind==='spar'&&(s.sparKind===undefined||s.sparKind==='yard');
    const own=s.kind==='spar'||s.kind==='sail-stay',owner=s.movingOwner===undefined?-1:rigGPUSurfaceIndex(indices,s.movingOwner);
    const surface=s.surface===undefined?-1:rigGPUSurfaceIndex(indices,s.surface);
    packed.set([...s.a,s.r??0,...s.b,s.rEnd??s.r??0,s.mast??-1,surface,owner,Number(face)+2*Number(own),0,0,0,0],(supportOffset+i*4)*4);
  }
  for(const [i,line]of context.lines.entries())packed.set(rigGPURopeRecord(line,indices,context),(ropeOffset+i*10)*4);
  const wheel=design.steering.wheel;
  packed.set([...design.steering.pivot,Number(!!wheel),...(wheel?.centre??[0,0,0]),wheel?.turnRatio??12,...(wheel?.axis??[0,0,1]),0,0,0,0,0],steeringOffset*4);
  const hatch=design.hatch;packed.set(hatch?[hatch.centre[0],hatch.centre[1],hatch.centre[2]-hatch.size[2]/2,0]:[0,0,0,0],hatchOffset*4);
  const restContext={...withRigPoseContext(context,{}),time:0,wind:0},ropeSamples=new Map();
  const scale=[design.runtime.beam/design.frame.beam,design.frame.verticalScale,design.runtime.length/design.frame.length];
  const restBoat=rowing?{modelId:id,...design.runtime,rowingState:{phase:0,rate:0,effortPort:0,effortStarboard:0},rudder:0}:null;
  const restBlades=rowing?design.stations.map(s=>rowingStationPose(restBoat,s.id)):[];
  if(rowing)restBlades.push(rowingSteeringPose(restBoat));
  for(let i=0;i<count;i++){
    const at=i*9,meta=i*12,material=source[at+6],kind=Math.floor(material),code=Math.round((material-kind)*64),index=indices.get(code);
    if((kind===9||kind===13)&&index!==undefined)vertices.set([1,index,source[at+7],source[at+8]],meta);
    else if(kind===10&&index!==undefined)vertices.set([2,index,0,0],meta);
    else if(kind===12&&source[at+7]>=100){
      const lineIndex=Math.round(source[at+7]-100),line=context.lines[lineIndex],t=source[at+8];
      if(!line||line.static)throw Error('Invalid GPU running-rig vertex');
      const key=lineIndex+'/'+t;let sample=ropeSamples.get(key);
      if(!sample){
        const point=surfaceRopePoint(line,t,restContext),a=surfaceRopePoint(line,Math.max(0,t-.001),restContext),b=surfaceRopePoint(line,Math.min(1,t+.001),restContext);
        sample={point,...rigGPUFrameBasis(rigGPUSub(b,a))};ropeSamples.set(key,sample);
      }
      const q=[source[at]-sample.point[0],source[at+1]-sample.point[1],source[at+2]-sample.point[2]],normal=Array.from(source.subarray(at+3,at+6));
      vertices.set([3,lineIndex,t,0,rigGPUDot(q,sample.across),rigGPUDot(q,sample.up),rigGPUDot(normal,sample.across),rigGPUDot(normal,sample.up),...sample.across,0],meta);
    }else if(rowing&&(kind===16||kind===17)){
      const blade=kind===17?design.stations.length:code,pose=restBlades[blade];if(!pose)throw Error('Invalid GPU rowing material tag');
      const q=[source[at]*scale[0]-pose.bladeCentre[0],source[at+1]*scale[1]-pose.bladeCentre[1],source[at+2]*scale[2]-pose.bladeCentre[2]];
      const normal=rigGPUUnit([source[at+3]/scale[0],source[at+4]/scale[1],source[at+5]/scale[2]]),basis=[pose.bladeAlong,pose.bladeAcross,pose.bladeNormal];
      vertices.set([4,blade,0,0,...basis.map(axis=>rigGPUDot(q,axis)),0,...basis.map(axis=>rigGPUDot(normal,axis)),0],meta);
    }else if(!rowing&&(kind===7||kind===14))vertices.set([5,0,0,0],meta);
    else if(!rowing&&kind===8&&code===1&&wheel)vertices.set([6,0,0,0],meta);
    else if(!rowing&&kind===18&&hatch)vertices.set([7,0,0,0],meta);
  }
  if(!packed.every(Number.isFinite)||!vertices.every(Number.isFinite))throw Error('Non-finite GPU rig asset');
  const surfaceStateOffset=12,bladeStateOffset=surfaceStateOffset+surfaces.length*8,bladeCount=restBlades.length;
  const data=Object.freeze({model:packed,vertices,frameFloatCount:bladeStateOffset+bladeCount*16,surfaceStateOffset,bladeStateOffset,
    bladeCount,surfaceCount:surfaces.length,modelId:id});
  rigGPUPrivate.set(data,{frame:design.frame,runtime:design.runtime,surfaces,rowing,stations:rowing?design.stations:[]});return data;
}

export function createRigGPUFrame(data){
  if(!rigGPUPrivate.has(data))throw Error('Unknown GPU rig asset');return new Float32Array(data.frameFloatCount);
}

// O(surfaces + physical blades), independent of cloth tessellation, rope
// segments and indexed vertex count. No positions/normals travel back to CPU.
export function writeRigGPUFrame(data,boat,time,wind,target){
  const prepared=rigGPUPrivate.get(data);
  if(!prepared)throw Error('Unknown GPU rig asset');
  if(!(target instanceof Float32Array)||target.length!==data.frameFloatCount)throw Error('Compact GPU rig frame has wrong shape');
  if(boat.modelId!==undefined&&boat.modelId!==data.modelId)throw Error('GPU rig frame belongs to another ship model');
  if(!Number.isFinite(time)||!Number.isFinite(wind))throw Error('Invalid GPU rig frame time or wind');
  const {frame,runtime,surfaces,rowing,stations}=prepared,scale=[(boat.beam??runtime.beam)/frame.beam,frame.verticalScale,(boat.length??runtime.length)/frame.length];
  if(!scale.every(v=>Number.isFinite(v)&&v>0))throw Error('Invalid GPU rig dimensions');
  const rudder=(boat.rudder??0)*Math.PI/180,closed=Math.max(0,Math.min(1,boat.hatchesClosed??0));
  if(!Number.isFinite(rudder)||!Number.isFinite(closed))throw Error('Invalid GPU rig controls');
  target.set([time,wind,rudder,(1-closed)*Math.PI/2,...scale,0,surfaces.length,data.bladeCount,0,0]);
  for(let i=0;i<surfaces.length;i++){
    const pose=rigSurfacePose(surfaces[i],boat.sailState??{});
    target.set([pose.yaw,pose.deployed,pose.fill,pose.side,pose.opening,pose.dip,pose.pressure,0],data.surfaceStateOffset+i*8);
  }
  if(rowing){
    for(let i=0;i<data.bladeCount;i++){
      const pose=i<stations.length?rowingStationPose(boat,stations[i].id,{time}):rowingSteeringPose(boat,{time});
      target.set([...pose.bladeCentre,0,...pose.bladeAlong,0,...pose.bladeAcross,0,...pose.bladeNormal,0],data.bladeStateOffset+i*16);
    }
  }
  return target;
}
