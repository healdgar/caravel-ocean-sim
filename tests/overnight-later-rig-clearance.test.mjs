// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Actual posed mesh/finite spar checks. Root executes these; no mask, source
// substring or expected count substitutes for geometric clearance.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLaterSailShipMesh,createLaterSailAssetPose} from '../js/later-sail-ships.js';
import {LATER_SAIL_DESIGNS} from '../js/models/later-sail.js';
import {laterSailRigContext} from '../js/additional-rig.js';
import {rigSurfacePose,surfaceClothPoint,surfaceYardPoint,withRigPoseContext} from '../js/rig-surface.js';
import {indexCaravelMesh} from '../js/caravel.js';

const clearanceSub=(a,b)=>a.map((v,i)=>v-b[i]),clearanceAdd=(a,b)=>a.map((v,i)=>v+b[i]),clearanceMul=(a,s)=>a.map(v=>v*s);
const clearanceDot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0),clearanceCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clearanceClamp=x=>Math.max(0,Math.min(1,x)),clearanceLength2=v=>clearanceDot(v,v);
function clearanceTrianglePoint(p,a,b,c){
  const ab=clearanceSub(b,a),ac=clearanceSub(c,a),ap=clearanceSub(p,a),d1=clearanceDot(ab,ap),d2=clearanceDot(ac,ap);
  if(d1<=0&&d2<=0)return a;
  const bp=clearanceSub(p,b),d3=clearanceDot(ab,bp),d4=clearanceDot(ac,bp);if(d3>=0&&d4<=d3)return b;
  const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0)return clearanceAdd(a,clearanceMul(ab,d1/(d1-d3)));
  const cp=clearanceSub(p,c),d5=clearanceDot(ab,cp),d6=clearanceDot(ac,cp);if(d6>=0&&d5<=d6)return c;
  const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0)return clearanceAdd(a,clearanceMul(ac,d2/(d2-d6)));
  const va=d3*d6-d5*d4;if(va<=0&&d4-d3>=0&&d5-d6>=0)return clearanceAdd(b,clearanceMul(clearanceSub(c,b),(d4-d3)/(d4-d3+d5-d6)));
  const inverse=1/(va+vb+vc);return clearanceAdd(a,clearanceAdd(clearanceMul(ab,vb*inverse),clearanceMul(ac,vc*inverse)));
}
function clearanceSegments(a,b,c,d){
  const u=clearanceSub(b,a),v=clearanceSub(d,c),w=clearanceSub(a,c),A=clearanceDot(u,u),B=clearanceDot(u,v),C=clearanceDot(v,v),D=clearanceDot(u,w),E=clearanceDot(v,w);
  let s=0,t=0;
  if(A<1e-20)t=C>1e-20?clearanceClamp(E/C):0;
  else if(C<1e-20)s=clearanceClamp(-D/A);
  else{
    const denominator=A*C-B*B;s=denominator>1e-20?clearanceClamp((B*E-C*D)/denominator):0;t=(B*s+E)/C;
    if(t<0){t=0;s=clearanceClamp(-D/A);}else if(t>1){t=1;s=clearanceClamp((B-D)/A);}
  }
  return {distance:Math.sqrt(clearanceLength2(clearanceSub(clearanceAdd(a,clearanceMul(u,s)),clearanceAdd(c,clearanceMul(v,t))))),t:s};
}
function clearanceTriangleAxis(a,b,c,foot,head){
  const axis=clearanceSub(head,foot),ab=clearanceSub(b,a),ac=clearanceSub(c,a),cross=clearanceCross(axis,ac),det=clearanceDot(ab,cross);
  if(Math.abs(det)>1e-16){
    const inv=1/det,tvec=clearanceSub(foot,a),u=clearanceDot(tvec,cross)*inv,q=clearanceCross(tvec,ab),v=clearanceDot(axis,q)*inv,t=clearanceDot(ac,q)*inv;
    if(u>=0&&v>=0&&u+v<=1&&t>=0&&t<=1)return {distance:0,t};
  }
  const candidates=[[a,b],[b,c],[c,a]].map(([p,q])=>clearanceSegments(foot,head,p,q));
  if(clearanceLength2(clearanceCross(ab,ac))>1e-20)for(const [p,t]of [[foot,0],[head,1]])candidates.push({distance:Math.sqrt(clearanceLength2(clearanceSub(p,clearanceTrianglePoint(p,a,b,c)))),t});
  return candidates.reduce((best,q)=>q.distance<best.distance?q:best);
}
const clearanceMastRadius=(mast,t)=>mast.radius*(1-.76*t);
const clearanceBoat=(d,yaw,set=[1,1,1],backed=false)=>({modelId:d.id,...d.runtime,rudder:0,hatchesClosed:1,
  sailState:{set,groupYaw:[yaw,yaw,yaw],windSide:backed?-9:9,windForward:backed?-7:7,rig:[0,1,2].map(()=>({fill:backed?0:1,side:backed?1:-1}))}});
const clearanceAssets=new Map();
function clearanceAsset(d){
  if(!clearanceAssets.has(d.id)){const raw=createLaterSailShipMesh(d.id),asset={model:{id:d.id},...indexCaravelMesh(raw)};clearanceAssets.set(d.id,{asset,pose:createLaterSailAssetPose(asset)});}
  return clearanceAssets.get(d.id);
}
function clearanceClothTriangles(asset,target){
  const triangles=[];
  for(let at=0;at<asset.indices.length;at+=3){
    const indices=Array.from(asset.indices.subarray(at,at+3)),first=indices[0]*9,kind=Math.floor(target[first+6]);if(kind!==9&&kind!==13)continue;
    const surface=Math.round((target[first+6]-kind)*64),points=indices.map(i=>Array.from(target.subarray(i*9,i*9+3)));
    triangles.push({surface,points,triangle:at/3,min:[0,1,2].map(i=>Math.min(...points.map(p=>p[i]))),max:[0,1,2].map(i=>Math.max(...points.map(p=>p[i])))});
  }
  return triangles;
}

for(const d of Object.values(LATER_SAIL_DESIGNS))test(`${d.id} actual sewn fittings and posed cloth retain finite mast clearance through bracing, backing and lowering`,()=>{
  const context=laterSailRigContext(d.id),{asset,pose}=clearanceAsset(d),target=new Float32Array(asset.vertices);
  for(const [yaw,set,backed]of [[0,[1,1,1],false],[.67,[1,1,1],false],[-.67,[1,1,1],false],[1.35,[1,1,1],false],[-1.35,[1,1,1],false],[.45,[.15,.35,.65],false],[-.45,[1,1,1],true]]){
    const boat=clearanceBoat(d,yaw,set,backed);assert.equal(pose(boat,2.7,18,target),true);
    let worst={clearance:Infinity};
    for(let at=0;at<asset.indices.length;at+=3){
      const indices=Array.from(asset.indices.subarray(at,at+3)),first=indices[0]*9,kind=Math.floor(target[first+6]);if(kind!==9&&kind!==13)continue;
      const code=Math.round((target[first+6]-kind)*64),points=indices.map(i=>Array.from(target.subarray(i*9,i*9+3)));
      for(const mast of context.masts){
        const q=clearanceTriangleAxis(...points,mast.foot,mast.head),gap=q.distance-clearanceMastRadius(mast,q.t);
        if(gap<worst.clearance)worst={clearance:gap,surface:code,mast:mast.id,triangle:at/3,yaw,set,backed,points};
      }
    }
    assert.ok(worst.clearance>=-3e-5,JSON.stringify(worst));
    // Entire finite spar axes, not just their endpoint positions, must avoid
    // the mast body including their own finite drawn radius.
    for(const surface of d.surfaces)for(const spar of surface.spars??[]){
      const p=rigSurfacePose(surface,boat.sailState),a=surfaceYardPoint(surface,spar.a,p),b=surfaceYardPoint(surface,spar.b,p);
      for(const mast of context.masts){const q=clearanceSegments(mast.foot,mast.head,a,b),gap=q.distance-clearanceMastRadius(mast,q.t)-spar.radius;assert.ok(gap>=-3e-5,`${d.id} ${surface.name} ${spar.id} crosses ${mast.id}: ${gap}`);}
    }
  }
  // A support push must never be the only thing keeping a sewn edge outside
  // its own mast. Evaluate the actual pinned boundary without support forces.
  for(const surface of d.surfaces){
    const mast=context.masts[surface.mast],p=rigSurfacePose(surface,clearanceBoat(d,0).sailState);
    for(const [u,v]of surface.kind==='square'?[[.5,0]]:surface.kind==='gaff'?[[0,0],[0,1]]:[[1,0]]){
      const a=surfaceClothPoint(surface,u,v,p,{},0,0),q=clearanceSegments(mast.foot,mast.head,a,a);
      assert.ok(q.distance-clearanceMastRadius(mast,q.t)>0,`${surface.name} pinned cloth is embedded in its mast`);
    }
  }
});

test('the re-led clipper staysail remains physically separate from both poses of the independently braced adjacent yard',()=>{
  const d=LATER_SAIL_DESIGNS['flying-cloud'],c=laterSailRigContext(d.id),{asset,pose}=clearanceAsset(d),base=clearanceBoat(d,0),other={...base,sailState:{...base.sailState,surfaceYaw:{12:.55}}};
  const stay=d.surfaces.find(s=>s.id===22),one=new Float32Array(asset.vertices),two=new Float32Array(asset.vertices),again=new Float32Array(asset.vertices),staticSupports=c._surfaceCollisionSupports;
  assert.deepEqual(rigSurfacePose(stay,base.sailState),rigSurfacePose(stay,other.sailState),'only the other physical yard is rebraced');
  const a=withRigPoseContext(c,base.sailState),b=withRigPoseContext(c,other.sailState);
  assert.notDeepEqual(a._surfaceActiveSupports.find(s=>s.kind==='spar'&&s.surface===12),b._surfaceActiveSupports.find(s=>s.kind==='spar'&&s.surface===12));
  pose(base,3.1,14,one);pose(other,3.1,14,two);pose(base,3.1,14,again);
  const first=[],second=[];
  for(let at=0;at<asset.vertices.length;at+=9)if(Math.floor(asset.vertices[at+6])===13&&Math.round((asset.vertices[at+6]-13)*64)===22){
    first.push(...one.subarray(at,at+3));second.push(...two.subarray(at,at+3));
  }
  assert.ok(first.length>0);assert.deepEqual(first,second,'a properly separated staysail need not deform in response to a distant yard');
  const yard=d.surfaces.find(s=>s.id===12),spar=yard.spars.find(s=>s.kind==='yard');
  for(const [state,target]of [[base.sailState,one],[other.sailState,two]]){
    const pose=rigSurfacePose(yard,state),a=surfaceYardPoint(yard,spar.a,pose),b=surfaceYardPoint(yard,spar.b,pose);
    let gap=Infinity;
    for(const triangle of clearanceClothTriangles(asset,target).filter(t=>t.surface===22)){
      const q=clearanceTriangleAxis(...triangle.points,a,b);gap=Math.min(gap,q.distance-spar.radius*(1-.30*q.t));
    }
    assert.ok(gap>3e-5,'the unchanged actual staysail triangles clear the finite moving yard, rather than ignoring a real contact');
  }
  assert.deepEqual(new Uint32Array(one.buffer),new Uint32Array(again.buffer),'dynamic support views cannot contaminate another instance/pose');
  assert.equal(c._surfaceCollisionSupports,staticSupports);assert.ok(Object.isFrozen(staticSupports));
});

test('foreign foremast yards do not pull the actual main royal across the inter-mast gap',()=>{
  const d=LATER_SAIL_DESIGNS['flying-cloud'],c=laterSailRigContext(d.id),{asset,pose}=clearanceAsset(d),boat=clearanceBoat(d,0),target=new Float32Array(asset.vertices),surface=d.surfaces.find(s=>s.id===9),p=rigSurfacePose(surface,boat.sailState);
  pose(boat,3.1,14,target);
  const influence=Math.max(...c.masts.map(m=>m.radius),...c.spars.map(s=>s.radius))+(surface.contactClearance??.045)+(surface.contactBand??.25);
  for(let at=0;at<asset.vertices.length;at+=9)if(Math.floor(asset.vertices[at+6])===9&&Math.round((asset.vertices[at+6]-9)*64)===9){
    const reference=surfaceClothPoint(surface,asset.vertices[at+7],asset.vertices[at+8],p,{},3.1,14),actual=Array.from(target.subarray(at,at+3));
    assert.ok(Math.hypot(...clearanceSub(actual,reference))<=influence,'a foreign spar cannot create a nonlocal contact displacement across the mast spacing');
  }
});

test('named clipper staysail pinned heads set below their actual matching yard tier',()=>{
  const d=LATER_SAIL_DESIGNS['flying-cloud'];
  for(const s of d.surfaces.filter(s=>s.headFitting?.belowYard)){
    const yard=d.surfaces.flatMap(s=>s.spars??[]).find(p=>p.id===s.headFitting.belowYard);
    assert.ok(yard);assert.ok((yard.a[1]-yard.radius-s.corners[1][1])*d.frame.verticalScale>=.05-1e-9,'actual pinned cloth head cannot thread down through its named finite yard');
  }
});

test('later-mast contact cones use the exact radius taper drawn by the actual mast mesh',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const c=laterSailRigContext(d.id);
    for(const mast of c.masts){
      assert.equal(mast.tipRadius,mast.radius*.24);
      const support=c._surfaceCollisionSupports.find(s=>s.kind==='mast'&&s.mast===mast.index);
      assert.equal(support.r,mast.radius);assert.equal(support.rEnd,mast.tipRadius,'upper cloth cannot collide against an imaginary full-base-radius cylinder');
    }
  }
});

test('clipper topmast shrouds land on actual side-and-aft platform quadrants',()=>{
  const c=laterSailRigContext('flying-cloud');
  for(const support of c.supports.filter(s=>s.kind==='topmast-shroud')){
    const top=c.masts[support.mast].platform,dx=support.a[0]-top[0],dz=support.a[2]-top[2];
    assert.ok(dz>0,'a topmast shroud cannot lead forward through the fore-hung topsail');
    assert.ok(Math.hypot(dx,dz)<.34,'the lower shroud attachment remains on the actual drawn mast platform');
    assert.equal(support.a[1],top[1]);
  }
});

test('clipper lower shrouds use their own actual aft hull chainplate spread',()=>{
  const d=LATER_SAIL_DESIGNS['flying-cloud'],c=laterSailRigContext(d.id);
  for(const [index,mast]of d.masts.entries())for(const side of [-1,1]){
    const lines=c.supports.filter(s=>s.kind==='shroud'&&s.mast===index&&s.side===side);
    assert.deepEqual(lines.map(l=>l.a[2]),mast.chainplateZ);
    assert.equal(new Set(lines.map(l=>l.a[2])).size,4,'four actual chainplates cannot collapse at a clipped stern coordinate');
    for(const line of lines){assert.ok(line.a[2]>mast.z+1,'the windward lead is not rooted inside the close-braced course envelope');assert.equal(Math.sign(line.a[0]),side);}
  }
});

for(const d of Object.values(LATER_SAIL_DESIGNS))test(`${d.id} actual cloth triangles clear finite standing rigging and other moving spars`,()=>{
  const context=laterSailRigContext(d.id),{asset,pose}=clearanceAsset(d),target=new Float32Array(asset.vertices);
  for(const [yaw,set]of [[0,[1,1,1]],[.67,[1,1,1]],[-.67,[1,1,1]],[.35,[.20,.40,.65]]]){
    const boat=clearanceBoat(d,yaw,set);pose(boat,3.1,14,target);
    const obstacles=context.supports.map((s,index)=>({...s,name:`${s.kind}.${s.mast}.${s.side}.${index}`,radiusAt:()=>s.r??0}));
    for(const surface of d.surfaces)for(const spar of surface.spars??[]){
      const p=rigSurfacePose(surface,boat.sailState);
      obstacles.push({a:surfaceYardPoint(surface,spar.a,p),b:surfaceYardPoint(surface,spar.b,p),r:spar.radius,radiusAt:t=>spar.radius*(1-.30*t),surface:surface.id,name:spar.id});
    }
    for(const obstacle of obstacles){obstacle.min=obstacle.a.map((v,i)=>Math.min(v,obstacle.b[i])-obstacle.r);obstacle.max=obstacle.a.map((v,i)=>Math.max(v,obstacle.b[i])+obstacle.r);}
    let worst={clearance:Infinity};
    for(const triangle of clearanceClothTriangles(asset,target))for(const obstacle of obstacles){
      // Own yard/gaff/boom or actual luff stay is a sewn attachment. Every
      // other spar/shroud/stay is an obstacle; no masked interval is accepted.
      if(obstacle.surface===triangle.surface)continue;
      if([0,1,2].some(i=>triangle.min[i]>obstacle.max[i]||triangle.max[i]<obstacle.min[i]))continue;
      const q=clearanceTriangleAxis(...triangle.points,obstacle.a,obstacle.b),gap=q.distance-obstacle.radiusAt(q.t);
      if(gap<worst.clearance)worst={clearance:gap,surface:triangle.surface,obstacle:obstacle.name,triangle:triangle.triangle,yaw,set,points:triangle.points};
    }
    assert.ok(worst.clearance>=-3e-5,JSON.stringify(worst));
  }
});

test('clipper structural stay axes clear the actual independently braced finite yards',()=>{
  const d=LATER_SAIL_DESIGNS['flying-cloud'],context=laterSailRigContext(d.id);
  for(const yaw of [0,.67,-.67]){
    const boat=clearanceBoat(d,yaw),stays=context.supports.filter(s=>s.kind==='sail-stay');
    assert.equal(stays.length,8);
    for(const stay of stays)for(const surface of d.surfaces)for(const spar of surface.spars??[]){
      const p=rigSurfacePose(surface,boat.sailState),a=surfaceYardPoint(surface,spar.a,p),b=surfaceYardPoint(surface,spar.b,p),q=clearanceSegments(a,b,stay.a,stay.b),gap=q.distance-spar.radius*(1-.30*q.t)-stay.r;
      assert.ok(gap>=-3e-5,JSON.stringify({stay:stay.id,spar:spar.id,yaw,clearance:gap,a,b,stayA:stay.a,stayB:stay.b}));
    }
  }
});

test('clipper tier fittings occupy an actual open interval below all adjacent square canvas',()=>{
  const d=LATER_SAIL_DESIGNS['flying-cloud'],{asset,pose}=clearanceAsset(d),target=new Float32Array(asset.vertices),context=laterSailRigContext(d.id);
  pose(clearanceBoat(d,0),3.1,14,target);
  const triangles=clearanceClothTriangles(asset,target);
  for(const stay of context.supports.filter(s=>s.kind==='sail-stay')){
    const next=stay.upperFitting.nextSurface;
    for(const triangle of triangles.filter(t=>t.surface===next))for(const p of triangle.points){
      assert.ok(p[1]>stay.b[1]+stay.r-3e-5,'the actual posed next-tier cloth cannot hang down through the finite mast-stay termination');
    }
  }
});
