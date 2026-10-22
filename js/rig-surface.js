// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Descriptor-driven CPU poses for new mixed rigs. Existing Niña/Victory
// evaluators remain unchanged. All points are in the model's design frame.
const surfaceKinds=new Set(['square','lateen','headsail','gaff','bermudan']);
const surfaceClamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const surfaceSmooth=(a,b,x)=>{const t=surfaceClamp((x-a)/(b-a));return t*t*(3-2*t);};
const surfaceAdd=(a,b)=>a.map((x,i)=>x+b[i]);
const surfaceSubtract=(a,b)=>a.map((x,i)=>x-b[i]);
const surfaceMultiply=(a,s)=>a.map(x=>x*s);
const surfaceDot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const surfaceCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const surfaceMix=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
const surfaceFinitePoint=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
function surfaceUnit(p){const length=Math.hypot(...p);if(!(length>1e-12))throw Error('Degenerate rig surface axis');return surfaceMultiply(p,1/length);}
function surfaceRotate(p,axis,angle){
  const a=surfaceUnit(axis),c=Math.cos(angle),s=Math.sin(angle),cross=surfaceCross(a,p),dot=surfaceDot(a,p);
  return p.map((x,i)=>x*c+cross[i]*s+a[i]*dot*(1-c));
}
function surfaceCheck(surface){
  if(!surface||!Number.isInteger(surface.id)||surface.id<1||!surfaceKinds.has(surface.kind)
    ||!Number.isInteger(surface.mast)||surface.mast<0||surface.mast>2
    ||!Array.isArray(surface.corners)||![3,4].includes(surface.corners.length)||!surface.corners.every(surfaceFinitePoint)
    ||!surfaceFinitePoint(surface.pivot))throw Error('Invalid mixed-rig surface descriptor');
  if((surface.kind==='square'&&surface.corners.length!==4)||(surface.kind==='lateen'&&surface.corners.length!==3))throw Error('Invalid corner count for '+surface.kind);
  const [a,b,c]=surface.corners;
  if(Math.hypot(...surfaceCross(surfaceSubtract(b,a),surfaceSubtract(c,a)))<1e-10)throw Error('Degenerate rig surface corners');
}

// Quad corners: head port, head starboard, foot starboard, foot port.
// Triangle corners: the two ends of its sewn edge, then the free clew.
// Triangle UVs are barycentric: A*(1-u-v)+B*u+C*v; its sewn edge is v=0.
export function surfaceRestPoint(surface,u,v){
  surfaceCheck(surface);if(!Number.isFinite(u)||!Number.isFinite(v))throw Error('Invalid surface coordinates');
  const [a,b,c,d]=surface.corners;
  if(!d)return a.map((x,i)=>x+(b[i]-x)*u+(c[i]-x)*v);
  const p=surfaceMix(surfaceMix(a,b,u),surfaceMix(d,c,u),v);
  p[1]+=(surface.footRise??0)*4*u*(1-u)*v;return p;
}

// A physical main mast may carry fore-controlled headsails and main canvas.
// Never infer a control slot from the number or order of physical masts.
export function surfaceControlIndex(surface){
  const index={fore:0,main:1,mizzen:2}[surface?.controlGroup];
  if(index===undefined)throw Error('Unknown surface control group: '+surface?.controlGroup);
  return index;
}

export function rigSurfacePose(surface,state={}){
  surfaceCheck(surface);
  const control=surfaceControlIndex(surface),rig=state.rig?.[control]??{},lateen=surface.kind==='lateen';
  const deployed=surfaceClamp(lateen?(rig.deployed??state.set?.[control]??1):(state.set?.[control]??rig.deployed??1));
  const limit=surface.braceLimit??(surface.kind==='square'?Math.PI/3:1.2);
  if(!Number.isFinite(limit)||limit<0)throw Error('Invalid surface brace limit');
  const requestedYaw=state.surfaceYaw?.[surface.id]??state.groupYaw?.[control]??rig.yaw??(surface.kind==='square'?(state.squareYaw??0):(state.lateenYaw??0));
  const yaw=lateen?0:surfaceClamp(requestedYaw,-limit,limit);
  const pose={yaw,deployed,fill:surfaceClamp(rig.fill??0),side:surfaceClamp(rig.side??-(state.tack??1),-1,1),
    opening:surfaceClamp(rig.opening??.30,0,Math.PI/2),dip:surfaceClamp(rig.dip??0),pressure:surfaceClamp(rig.pressure??1,-1,1)};
  if(!lateen){
    const normal=surfaceRotateVector(surface,surface.camberAxis??(surface.kind==='square'?[0,0,1]:[1,0,0]),pose);
    const pressureSpeed=surface.pressureSpeed??1.5;
    if(!(pressureSpeed>0)||!Number.isFinite(pressureSpeed))throw Error('Invalid surface pressure speed');
    pose.pressure=surfaceClamp(((state.windSide??0)*normal[0]-(state.windForward??0)*normal[2])/pressureSpeed,-1,1);
  }
  return pose;
}

function surfaceRotateVector(surface,p,pose){
  // A headsail hinges around its actual luff, not around a global mast axis.
  if(surface.kind==='headsail'||surface.kind==='bermudan')return surfaceRotate(p,surfaceSubtract(surface.corners[1],surface.corners[0]),pose.yaw);
  if(surface.kind==='gaff'&&surface.hingeAxis)return surfaceRotate(p,surface.hingeAxis,pose.yaw);
  return surfaceRotate(p,[0,1,0],pose.yaw);
}

export function surfaceYardPoint(surface,p,pose){
  surfaceCheck(surface);if(!surfaceFinitePoint(p))throw Error('Invalid surface spar point');
  if(surface.kind==='lateen'){
    const [a,b]=surface.corners,dip=pose.dip??0,side=pose.side??-1;
    const angle=-Math.atan2(a[2]-b[2],a[1]-b[1])*dip;
    const q=surfaceRotate(surfaceSubtract(p,surface.pivot),[1,0,0],angle);
    const radius=(surface.yardClearance??.2)+dip*(surface.transferArc??.22);
    q[0]+=side*radius;q[2]+=Math.sqrt(Math.max(0,1-side*side))*radius;
    q[1]+=dip*(surface.transferLift??Math.hypot(...surfaceSubtract(b,a))*.15);
    return surfaceAdd(surface.pivot,q);
  }
  const pivot=surface.kind==='headsail'||surface.kind==='bermudan'?surface.corners[0]:surface.pivot;
  // Gaff/boom canvas rotates about its mast pivot; using a diagonal luff axis
  // here would rotate a boom out of its proper horizontal plane.
  return surfaceAdd(pivot,surfaceRotateVector(surface,surfaceSubtract(p,pivot),pose));
}

function surfaceClothMotion(surface,p,pose){
  if(surface.kind==='lateen'){
    const [a,b]=surface.corners,axis=surfaceSubtract(b,a);
    p=surfaceAdd(a,surfaceRotate(surfaceSubtract(p,a),axis,-pose.side*pose.opening));
  }
  return surfaceYardPoint(surface,p,pose);
}
function surfaceSewnWeight(surface,u,v){
  const edges=surface.sewnEdges??((surface.kind==='gaff'&&surface.corners.length===4)||surface.kind==='bermudan'?['v0','u0']:['v0']);
  let weight=1;
  for(const edge of edges){
    const distance=edge==='u0'?u:edge==='u1'?1-u:edge==='v0'?v:edge==='v1'?1-v:edge==='diagonal'?1-u-v:null;
    if(distance===null)throw Error('Unknown sewn surface edge: '+edge);
    weight*=surfaceSmooth(0,surface.contactPinBand??.06,distance);
  }
  return weight;
}
// Canonical model contexts freeze this once and carry it unchanged into their
// per-vessel runtime view. Only authored static support geometry is prepared;
// pressure, cloth side, contact clearance, time and sail state remain live.
export function withRigSupportCache(context){
  if(context._surfaceCollisionSupports)return context;
  const supports=[...(context.supports??[]),...(context.masts??[]).map((m,index)=>({a:m.foot,b:m.head,r:m.radius,kind:'mast',mast:m.index??index}))];
  const prepared=Object.freeze(supports.map(s=>{
    if(!surfaceFinitePoint(s.a)||!surfaceFinitePoint(s.b))throw Error('Invalid rig support descriptor');
    const axis=Object.freeze(surfaceSubtract(s.b,s.a));
    return Object.freeze({...s,_surfaceAxis:axis,_surfaceLength2:surfaceDot(axis,axis)});
  }));
  return {...context,_surfaceCollisionSupports:prepared};
}
export function withRigPoseContext(context,state={},poses=null){
  const live=poses??new Map((context.surfaces??[]).map(s=>[s.id,rigSurfacePose(s,state)]));
  if(!context.spars?.length)return {...context,state,poses:live};
  const stationary=context._surfaceCollisionSupports??[...(context.supports??[]),...(context.masts??[]).map((m,index)=>({a:m.foot,b:m.head,r:m.radius,kind:'mast',mast:m.index??index}))];
  const moving=context.spars.map(spar=>{
    const owner=surfaceFind(spar.surface,context),pose=live.get(owner.id),a=surfaceYardPoint(owner,spar.a,pose),b=surfaceYardPoint(owner,spar.b,pose),axis=surfaceSubtract(b,a);
    return {a,b,r:spar.radius,kind:'spar',surface:owner.id,mast:owner.mast,_surfaceAxis:axis,_surfaceLength2:surfaceDot(axis,axis)};
  });
  // Dynamic endpoints belong to this one pose view. They are deliberately
  // separate from the immutable authored-support preparation above.
  return {...context,state,poses:live,_surfaceActiveSupports:[...stationary,...moving]};
}
function surfaceApplySupports(point,reference,normal,surface,pose,context,u,v){
  const pin=surfaceSewnWeight(surface,u,v);if(pin===0)return point;
  const clearance=surface.contactClearance??.045,band=surface.contactBand??.25;
  if(!Number.isFinite(clearance)||clearance<0||!Number.isFinite(band)||band<=0)throw Error('Invalid surface contact margin');
  const p=[...point],supports=context._surfaceActiveSupports??context._surfaceCollisionSupports??[...(context.supports??[]),...(context.masts??[]).map((m,index)=>({a:m.foot,b:m.head,r:m.radius,kind:'mast',mast:m.index??index}))];
  for(const support of supports){
    if(support.kind==='spar'&&support.surface===surface.id)continue; // own sewn spar
    const {a,b}=support,r=(support.r??0)+clearance;
    if(!surfaceFinitePoint(a)||!surfaceFinitePoint(b)||!Number.isFinite(r)||r<0)throw Error('Invalid rig support descriptor');
    const axis=support._surfaceAxis??surfaceSubtract(b,a),length2=support._surfaceLength2??surfaceDot(axis,axis);if(length2<1e-12)throw Error('Degenerate rig support');
    const t=surfaceClamp(surfaceDot(surfaceSubtract(p,a),axis)/length2),q=surfaceMix(a,b,t),delta=surfaceSubtract(p,q);
    const mastBarrier=(support.kind==='mast'||support.kind==='spar')&&support.mast===surface.mast&&surface.mastContactSide;
    if(mastBarrier&&!['fore','aft'].includes(mastBarrier))throw Error('Invalid authored mast contact side');
    const direction=mastBarrier?[0,0,mastBarrier==='fore'?-1:1]:normal;
    let contactNormal=surfaceSubtract(direction,surfaceMultiply(axis,surfaceDot(direction,axis)/length2));
    if(Math.hypot(...contactNormal)<1e-10){
      const ref=surfaceSubtract(reference,q);contactNormal=surfaceSubtract(ref,surfaceMultiply(axis,surfaceDot(ref,axis)/length2));
      if(Math.hypot(...contactNormal)<1e-10)contactNormal=surfaceCross(axis,Math.abs(axis[1])/Math.sqrt(length2)<.9?[0,1,0]:[1,0,0]);
    }
    contactNormal=surfaceUnit(contactNormal);
    const signed=surfaceDot(delta,contactNormal),transverse=surfaceSubtract(delta,surfaceMultiply(contactNormal,signed)),distance=Math.hypot(...transverse);
    if(distance>=r+band)continue;
    // Keep the sheet on its authored side of the support, including when wind
    // backs it. A smooth tension band acts on actual cloth, never rope opacity.
    const restSide=surfaceDot(surfaceSubtract(reference,q),contactNormal);
    const side=mastBarrier?1:Math.abs(restSide)>1e-8?Math.sign(restSide):surface.kind==='lateen'?Math.sign(pose.side)||-1:-Math.sign(pose.pressure)||-1;
    const penetration=r-side*signed;
    if(penetration>0){
      const weight=(1-surfaceSmooth(r,r+band,distance))*pin;
      for(let i=0;i<3;i++)p[i]+=contactNormal[i]*side*penetration*weight;
    }
  }
  return p;
}

export function surfaceClothPoint(surface,u,v,pose,context={},time=0,wind=0){
  surfaceCheck(surface);
  const rest=surfaceRestPoint(surface,u,v),[a,b]=surface.corners,triangle=surface.corners.length===3;
  let gathered;
  if(surface.kind==='bermudan')gathered=surfaceMix(a,surface.corners[2],v);
  else if(triangle){const axis=surfaceSubtract(b,a),along=surfaceDot(surfaceSubtract(rest,a),axis)/surfaceDot(axis,axis);gathered=surfaceMix(a,b,along);}
  else gathered=surfaceRestPoint(surface,u,0);
  const deployed=surfaceClamp(pose.deployed??1),fill=surfaceClamp(pose.fill??0),flat=surfaceMix(gathered,rest,.012+.988*deployed);
  const envelope=triangle?27*u*v*Math.max(0,1-u-v):4*u*(1-u)*(v<=0||v>=1?0:Math.sin(Math.PI*v));
  const slack=1-surfaceSmooth(.2,.85,fill),flutter=Math.min(Math.max(wind,0)/4,1)*(surface.flutter??.035)*slack*slack*Math.sin(time*6+u*17+v*13);
  const sign=surface.kind==='lateen'?pose.side:1;
  const camber=((surface.belly??.2)*(pose.pressure??1)*sign*(.12+.88*fill)+flutter)*envelope*deployed;
  const axis=surfaceUnit(surface.camberAxis??(surface.kind==='square'?[0,0,1]:[1,0,0]));
  const reference=surfaceClothMotion(surface,flat,pose),point=surfaceClothMotion(surface,surfaceAdd(flat,surfaceMultiply(axis,camber)),pose);
  if(!(context.supports?.length||context.masts?.length))return point;
  const normal=surfaceUnit(surfaceSubtract(surfaceClothMotion(surface,surfaceAdd(flat,axis),pose),reference));
  return surfaceApplySupports(point,reference,normal,surface,pose,context,u,v);
}

function surfaceFind(id,context){
  if(typeof id==='object'){surfaceCheck(id);return id;}
  const surface=context.surfaces instanceof Map?context.surfaces.get(id):context.surfaces?.find(s=>s.id===id);
  if(!surface)throw Error('Unknown rope surface: '+id);return surface;
}
function surfaceContextPose(surface,context){
  return (context.poses instanceof Map?context.poses.get(surface.id):context.poses?.[surface.id])??rigSurfacePose(surface,context.state);
}

// Endpoint bindings are XYZ, {surface:id,uv:[u,v]} or {surface:id,point:XYZ}.
// The latter evaluates the actual spar, including another sail's moving yard.
export function surfaceAttachmentPoint(attachment,context={}){
  if(surfaceFinitePoint(attachment))return [...attachment];
  if(!attachment||attachment.surface===undefined)throw Error('Invalid rig rope attachment');
  const surface=surfaceFind(attachment.surface,context),pose=surfaceContextPose(surface,context);
  if(attachment.uv?.length===2)return surfaceClothPoint(surface,...attachment.uv,pose,context,context.time??0,context.wind??0);
  if(surfaceFinitePoint(attachment.point))return surfaceYardPoint(surface,attachment.point,pose);
  throw Error('Rig attachment requires cloth UV or spar point');
}

export function surfaceRopePoint(line,t,context={}){
  if(!Number.isFinite(t))throw Error('Invalid rope coordinate');t=surfaceClamp(t);
  if(line.clothEdge){
    const surface=surfaceFind(line.surface,context),pose=surfaceContextPose(surface,context),[a,b]=line.clothEdge;
    if(!Array.isArray(a)||!Array.isArray(b)||a.length!==2||b.length!==2||![...a,...b].every(Number.isFinite))throw Error('Invalid sewn rope edge');
    const uv=a.map((v,i)=>v+(b[i]-v)*t);
    return surfaceClothPoint(surface,...uv,pose,context,context.time??0,context.wind??0);
  }
  const a=surfaceAttachmentPoint(line.a,context),b=surfaceAttachmentPoint(line.b,context);
  if(t===0)return a;if(t===1)return b;
  const binding=line.a?.surface??line.b?.surface??line.surface;
  const surface=binding===undefined?null:surfaceFind(binding,context),pose=surface?surfaceContextPose(surface,context):null;
  const paired=line.paired??(line.kind==='sheet'&&surface?.kind!=='square');
  if(paired&&(!pose||![-1,1].includes(line.side)))throw Error('Paired sheet requires a surface and port/starboard side');
  const lazy=paired?1-surfaceSmooth(-.25,.25,line.side*(line.workingSide??pose.side)):0;
  const sag=line.sag??(line.kind==='sheet'?.04:0),lazySag=line.lazySag??.25;
  if(!Number.isFinite(sag)||sag<0||!Number.isFinite(lazySag)||lazySag<0)throw Error('Invalid rope sag');
  const working=surfaceMix(a,b,t);working[1]-=Math.sin(Math.PI*t)*sag;
  if(lazy===0)return working;
  let loose;
  if(line.lazyLead!==undefined){
    const lead=surfaceAttachmentPoint(line.lazyLead,context),split=line.leadSplit??.72;
    if(!(split>0&&split<1))throw Error('Invalid lazy sheet lead split');
    const q=t<split?t/split:(t-split)/(1-split);loose=t<split?surfaceMix(a,lead,q):surfaceMix(lead,b,q);
    loose[1]-=Math.sin(Math.PI*q)*lazySag;
  }else{loose=surfaceMix(a,b,t);loose[1]-=Math.sin(Math.PI*t)*(sag+lazySag);}
  return surfaceMix(working,loose,lazy);
}
