// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Model-owned standing supports and running leads shared by the mesh, cloth
// contact, force sampling, posed attachments and crew work.
import {deepFreeze} from './rig-definition.js';
import {ADDITIONAL_DESIGNS,additionalDesign,additionalDeck,additionalDeckWidth} from './models/additional.js';
import {LATER_SAIL_DESIGNS,laterSailDesign,laterSailDeck,laterSailDeckWidth} from './models/later-sail.js';
import {ROWING_DESIGNS,rowingDesign,rowingHullDeck,rowingHullWidth,rowingRigContext} from './models/rowing.js';
import {withRigSupportCache} from './rig-surface.js';
const additionalRigCache=new Map();
const additionalGunCache=new Map();
const additionalPreparedRowContexts=new Map();
export function additionalGunAttachments(id){
  if(additionalGunCache.has(id))return additionalGunCache.get(id);
  const d=additionalDesign(id),guns=d.equipment.guns.map((g,index)=>{
    const sign=g.side,z=g.z,floor=additionalDeck(id,z),x=sign*(additionalDeckWidth(id,z)+.015),y=floor+.38;
    return {id:index,side:sign<0?'port':'starboard',sideSign:sign,deck:'quarter',
      centre:[x,y,z],muzzle:[x+sign*.32,y+.012,z],barrelRadius:.026,barrelLength:.52,
      meshGroup:'gun.'+index,muzzleDesign:[x+sign*.32,y+.012,z],breechDesign:[x-sign*.20,y,z],directionDesign:[sign*.52,.012,0],
      station:[x-sign*.30,floor,z-.12],floorDesign:floor,visibleCrew:true,weatherDeck:true,
      calibre:2,type:'swivel',kind:'swivel',recoilLength:.09,recoilDuration:.45,breechMass:180};
  });
  additionalGunCache.set(id,deepFreeze(guns));return additionalGunCache.get(id);
}
export function additionalRigContext(id){
  if(additionalRigCache.has(id))return additionalRigCache.get(id);
  const d=additionalDesign(id),supports=[],lines=[];
  const mastPoint=(index,y)=>{
    const m=d.masts[index];if(!m)throw Error('No '+id+' mast '+index);
    const floor=additionalDeck(id,m.z),t=(y-floor)/(m.height-floor);
    return [0,y,m.z+(m.rake??0)*t];
  };
  const anchorCathead=side=>{
    if(side!==-1&&side!==1)throw Error('Anchor side must be port or starboard');
    const z=-4.8,y=additionalDeck(id,z),x=side*additionalDeckWidth(id,z);
    return {root:[x-side*.06,y+.16,z+.12],tip:[x+side*.34,y+.26,z-.20],fairlead:[x+side*.33,y+.25,z-.19]};
  };
  const masts=d.masts.map((m,index)=>({...m,index,foot:mastPoint(index,additionalDeck(id,m.z)),head:mastPoint(index,m.height)}));
  for(const [index,m]of d.masts.entries()){
    const top=mastPoint(index,m.height*.72);
    for(const side of [-1,1])for(let j=0;j<4;j++){
      const z=Math.min(5.55,m.z+.28+j*.27),a=[side*(additionalDeckWidth(id,z)+.035),additionalDeck(id,z)+.05,z];
      supports.push({a,b:top,r:.010,mast:index,side,kind:'shroud'});
    }
    const stayZ=index===0?-7.8:d.masts[index-1].z-.45;
    supports.push({a:[0,index===0?1.5:additionalDeck(id,stayZ)+.07,stayZ],b:mastPoint(index,m.height*.95),r:.012,mast:index,side:0,kind:'stay'});
  }
  // Ratlines join actual adjacent shrouds at a human rung pitch after scaling.
  const rungStep=.32/d.frame.verticalScale;
  for(let mast=0;mast<d.masts.length;mast++)for(const side of [-1,1]){
    const shrouds=supports.filter(s=>s.mast===mast&&s.side===side&&s.kind==='shroud');
    const lo=Math.max(...shrouds.map(s=>s.a[1]))+.12,hi=shrouds[0].b[1]-.2;
    for(let y=lo;y<hi;y+=rungStep)for(let j=0;j<shrouds.length-1;j++){
      const point=s=>s.a.map((x,k)=>x+(s.b[k]-x)*(y-s.a[1])/(s.b[1]-s.a[1]));
      lines.push({a:point(shrouds[j]),b:point(shrouds[j+1]),kind:'ratline',r:.004,static:true,mast,side});
    }
  }
  for(const support of supports)lines.push({...support,static:true});
  for(const s of d.surfaces){
    const triangular=s.corners.length===3,clews=triangular?[[0,1]]:[[0,1],[1,1]];
    for(const side of [-1,1]){
      const uv=triangular?clews[0]:clews[side<0?0:1],corner=triangular?s.corners[2]:s.corners[side<0?3:2];
      const z=Math.max(-5.5,Math.min(5.55,corner[2]+.55));
      lines.push({a:{surface:s.id,uv},b:[side*Math.max(.10,additionalDeckWidth(id,z)-.12),additionalDeck(id,z)+.08,z],
        kind:'sheet',side,paired:triangular,sag:.025,lazySag:.25,r:.007,mast:s.mast});
    }
    const head=s.name==='spritsail'?d.bowsprit.b:masts[s.mast].head;
    lines.push({a:head,b:{surface:s.id,point:s.pivot},kind:'halyard',r:.010,sag:.015,mast:s.mast});
    if(s.kind==='lateen'){
      const z=Math.max(-5.65,Math.min(5.6,s.corners[1][2]-.25));
      lines.push({a:{surface:s.id,point:s.corners[1]},b:[0,additionalDeck(id,z)+.08,z],kind:'tack',r:.008,sag:.04,mast:s.mast});
    }
  }
  for(const [mast,m]of d.masts.entries()){
    const z=m.z+.50,side=mast===1?-1:1;
    lines.push({a:masts[mast].head,b:[side*.55,additionalDeck(id,z)+.08,z],kind:'working-fall',mast,side,r:.009,sag:.025});
  }
  const context=deepFreeze(withRigSupportCache({surfaces:d.surfaces,masts,supports,lines,mastPoint,anchorCathead}));
  additionalRigCache.set(id,context);return context;
}

const laterRigCache=new Map();
// Authored working leads, not recovered period rope plans. Every moving end
// binds actual cloth UVs or an actual descriptor spar; no hidden rope sections.
export function laterSailRigContext(id){
  if(laterRigCache.has(id))return laterRigCache.get(id);
  const d=laterSailDesign(id),supports=[],lines=[],controlStations={},sx=d.runtime.beam/d.frame.beam,sy=d.frame.verticalScale;
  const mastPoint=(index,y)=>{
    const m=d.masts[index];if(!m)throw Error('No '+id+' mast '+index);
    const floor=laterSailDeck(id,m.z),t=(y-floor)/(m.height-floor);
    return [0,y,m.z+(m.rake??0)*t];
  };
  const masts=d.masts.map((m,index)=>({...m,index,tipRadius:m.radius*.24,climbable:id==='flying-cloud',foot:mastPoint(index,laterSailDeck(id,m.z)),head:mastPoint(index,m.height)}));
  const spars=d.surfaces.flatMap(s=>(s.spars??[]).map(spar=>({...spar,surface:s.id,mast:s.mast,controlGroup:s.controlGroup})));
  for(const [index,m]of masts.entries()){
    const floor=m.foot[1],high=floor+(m.height-floor)*(id==='flying-cloud'?.47:.92),top=mastPoint(index,high);
    const count=id==='flying-cloud'?4:2;
    for(const side of [-1,1])for(let j=0;j<count;j++){
      const z=Math.min(5.55,m.z+.28+j*.24),x=side*laterSailDeckWidth(id,z),y=laterSailDeck(id,z,x);
      supports.push({a:[x,y+.045/sy,z],b:top,r:(id==='flying-cloud'?.025:.006)/sx,mast:index,side,kind:'shroud'});
    }
    const z=index===0?(d.bowsprit?.b[2]??-5.55):d.masts[index-1].z+.20;
    const triatic=id==='gipsy-moth-iv'&&index>0;
    const a=triatic?[...masts[index-1].head]:index===0&&d.bowsprit?[...d.bowsprit.b]:[0,laterSailDeck(id,z)+.08/sy,z];
    supports.push({a,b:mastPoint(index,m.height*.96),r:.012/sx,mast:index,side:0,kind:triatic?'triatic-stay':'stay'});
    if(id==='flying-cloud'){
      // Separate topmast shrouds land on a real mast platform, not at a
      // fictitious fourth mast or a shared all-canvas transform.
      const platform=mastPoint(index,high);
      // Topmast shrouds land in the side-and-aft quadrants of the real top.
      // A forward platform lead threads the fore-hung topsail itself.
      for(const side of [-1,1])for(const dz of [.08,.20])supports.push({a:[side*.22,platform[1],platform[2]+dz],b:mastPoint(index,m.height*.80),r:.012/sx,mast:index,side,kind:'topmast-shroud'});
      const shrouds=supports.filter(s=>s.mast===index&&s.kind==='shroud');
      for(const side of [-1,1]){
        const same=shrouds.filter(s=>s.side===side),lo=Math.max(...same.map(s=>s.a[1]))+.20/sy,hi=top[1]-.20/sy;
        for(let y=lo;y<hi;y+=.32/sy)for(let j=0;j<same.length-1;j++){
          const at=line=>line.a.map((v,k)=>v+(line.b[k]-v)*(y-line.a[1])/(line.b[1]-line.a[1]));
          lines.push({a:at(same[j]),b:at(same[j+1]),kind:'ratline',r:.007/sx,static:true,mast:index,side});
        }
      }
    }
  }
  for(const support of supports)lines.push({...support,static:true});
  for(const s of d.surfaces){
    const triangle=s.corners.length===3;
    const perimeter=triangle?[[0,0],[1,0],[0,1]]:[[0,0],[1,0],[1,1],[0,1]];
    for(let j=0;j<perimeter.length;j++)lines.push({surface:s.id,clothEdge:[perimeter[j],perimeter[(j+1)%perimeter.length]],
      kind:'bolt-rope',r:.008/sx,mast:s.mast,controlGroup:s.controlGroup});
    if(s.kind==='headsail')lines.push({a:s.corners[0],b:s.corners[1],kind:'luff-stay',r:.008/sx,static:true,mast:s.mast,surface:s.id});
    for(const side of [-1,1]){
      const corner=s.corners[triangle?2:side<0?3:2],uv=triangle?[0,1]:[side<0?0:1,1];
      let z=Math.max(-5.25,Math.min(5.45,corner[2]+.28));
      // Yacht sheets are led aft of the cabin to actual side-deck/cockpit
      // hardware. They do not end at a starboard-only universal deck point.
      if(id==='gipsy-moth-iv')z=s.controlGroup==='fore'?1.52:s.controlGroup==='main'?3.4:4.50;
      const x=side*Math.max(.10,laterSailDeckWidth(id,z)-.10/sx),y=laterSailDeck(id,z,x)+.10/sy;
      lines.push({a:{surface:s.id,uv},b:[x,y,z],kind:'sheet',side,paired:triangle,
        sag:.035/sy,lazySag:.30/sy,r:.010/sx,mast:s.mast,controlGroup:s.controlGroup});
      if(s.kind==='square'){
        const spar=s.spars.find(p=>p.kind==='yard'),point=side<0?spar.a:spar.b;
        const deckZ=Math.min(5.45,d.masts[s.mast].z+1.05),deckX=side*Math.max(.1,laterSailDeckWidth(id,deckZ)-.10/sx);
        lines.push({a:{surface:s.id,point},b:[deckX,laterSailDeck(id,deckZ,deckX)+.10/sy,deckZ],kind:'brace',side,sag:.06/sy,r:.010/sx,mast:s.mast,controlGroup:s.controlGroup});
      }
    }
    const head=masts[s.mast].head;
    // Bermudan/head sails have a halyard at the actual head. A square's
    // halyard lifts its yard sling; gaff canvas lifts the gaff, not a luff yard.
    const liftSpar=s.spars?.find(p=>p.kind===(s.kind==='square'?'yard':'gaff'));
    const liftPoint=liftSpar?(s.kind==='square'?liftSpar.a.map((v,i)=>(v+liftSpar.b[i])*.5):liftSpar.b):s.pivot;
    const attachment=['bermudan','headsail'].includes(s.kind)?{surface:s.id,uv:[1,0]}:{surface:s.id,point:liftPoint};
    lines.push({a:head,b:attachment,kind:'halyard',r:.012/sx,sag:.02/sy,mast:s.mast,controlGroup:s.controlGroup});
  }
  for(const group of ['fore','main','mizzen']){
    const surface=d.surfaces.find(s=>s.controlGroup===group);if(!surface)continue;
    const mast=surface.mast,m=masts[mast],side=group==='main'?-1:1;
    // Both headsail and main working falls belay aft of the yacht cabin, on
    // opposite sides, matching the headsail sheets. A singlehander need not
    // squeeze through an impassable cabin-side passage to handle the jib.
    const z=id==='gipsy-moth-iv'?({fore:1.45,main:1.45,mizzen:3.20}[group]):Math.min(5.30,m.z+.48);
    const x=id==='gipsy-moth-iv'&&group==='mizzen'?side*.18/sx:side*Math.min(laterSailDeckWidth(id,z)-.32/sx,.55/sx);
    const floor=laterSailDeck(id,z,x),lead=[x,floor+.14/sy,z],position=[x+side*.18/sx,floor,z+.20/sy];
    const lineIndex=lines.length;
    lines.push({a:m.head,b:lead,kind:'working-fall',mast,controlGroup:group,side,r:.012/sx,sag:.025/sy});
    controlStations[group]={id:'haul.'+group,mast,controlGroup:group,kind:'haul',position,lead,lineIndex};
  }
  const anchorCathead=side=>{
    if(!d.equipment.anchors)throw Error('No anchor equipment on '+id);
    if(side!==-1&&side!==1)throw Error('Anchor side must be port or starboard');
    const z=id==='flying-cloud'?-5.18:-5.35,x=side*laterSailDeckWidth(id,z),y=laterSailDeck(id,z,x);
    if(id==='gipsy-moth-iv')return {root:[x*.45,y,z+.08],tip:[x*.45,y+.08/sy,z-.12],fairlead:[x*.45,y+.06/sy,z-.11]};
    return {root:[x-side*.08,y+.12,z+.12],tip:[x+side*.28,y+.22,z-.16],fairlead:[x+side*.27,y+.21,z-.15]};
  };
  const runnerPoint=(index,side,step=0)=>{
    const m=masts[index];if(!m?.climbable)throw Error('No climbable '+id+' mast '+index);
    if(![-1,1].includes(side))throw Error('Runner requires port/starboard side');
    const shrouds=supports.filter(s=>s.mast===index&&s.side===side&&s.kind==='shroud'),lo=Math.max(...shrouds.map(s=>s.a[1]))+.20/sy,hi=shrouds[0].b[1]-.20/sy;
    const y=Math.min(hi,lo+Math.max(0,step)*.32/sy),point=line=>line.a.map((v,k)=>v+(line.b[k]-v)*(y-line.a[1])/(line.b[1]-line.a[1]));
    const a=point(shrouds[0]),b=point(shrouds[1]);return a.map((v,k)=>(v+b[k])*.5);
  };
  for(const [index,m]of masts.entries())if(m.climbable){
    const shrouds=supports.filter(s=>s.mast===index&&s.kind==='shroud'),lo=Math.max(...shrouds.map(s=>s.a[1]))+.20/sy,hi=shrouds[0].b[1]-.20/sy;
    m.rungs=Math.max(1,Math.floor((hi-lo)*sy/.32));m.platform=mastPoint(index,m.foot[1]+(m.height-m.foot[1])*.47);
  }
  const context=deepFreeze(withRigSupportCache({surfaces:d.surfaces,masts,spars,supports,lines,controlStations,mastPoint,runnerPoint,anchorCathead}));
  laterRigCache.set(id,context);return context;
}

export function proceduralRigContext(id){
  if(Object.hasOwn(ADDITIONAL_DESIGNS,id))return additionalRigContext(id);
  if(Object.hasOwn(ROWING_DESIGNS,id)){
    if(!additionalPreparedRowContexts.has(id))additionalPreparedRowContexts.set(id,deepFreeze(withRigSupportCache(rowingRigContext(id))));
    return additionalPreparedRowContexts.get(id);
  }
  if(Object.hasOwn(LATER_SAIL_DESIGNS,id))return laterSailRigContext(id);
  throw Error('No procedural rig context for '+id);
}

export function laterSailSteeringPose(boat){
  const d=laterSailDesign(boat.modelId),angle=(boat.rudder??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),pivot=d.steering.pivot;
  const rudderBasis=[[c,0,-s],[0,1,0],[s,0,c]],tillerPoint=p=>[pivot[0]+c*(p[0]-pivot[0])+s*(p[2]-pivot[2]),p[1],pivot[2]-s*(p[0]-pivot[0])+c*(p[2]-pivot[2])];
  if(!d.steering.wheel){
    const handle=tillerPoint(d.steering.handle),stock=tillerPoint([pivot[0],d.steering.handle[1],pivot[2]]),scale=[(boat.beam??d.runtime.beam)/d.frame.beam,d.frame.verticalScale,(boat.length??d.runtime.length)/d.frame.length];
    const along=stock.map((v,i)=>(v-handle[i])*scale[i]),length=Math.hypot(...along);if(length<1e-12)throw Error('Degenerate tiller grip axis');
    const second=handle.map((v,i)=>v+along[i]/length*.14/scale[i]);
    return {kind:'tiller',pivot:[...pivot],handle,grips:[handle,second],basis:rudderBasis,rudderBasis};
  }
  const wheel=d.steering.wheel,axis=wheel.axis??[0,0,1],length=Math.hypot(...axis);if(length<1e-12)throw Error('Degenerate wheel axis');
  const a=axis.map(v=>v/length),turn=angle*(wheel.turnRatio??12),C=Math.cos(turn),S=Math.sin(turn);
  const rotate=v=>{const dot=v.reduce((sum,x,i)=>sum+x*a[i],0),cross=[a[1]*v[2]-a[2]*v[1],a[2]*v[0]-a[0]*v[2],a[0]*v[1]-a[1]*v[0]];return v.map((x,i)=>x*C+cross[i]*S+a[i]*dot*(1-C));};
  const basis=[[1,0,0],[0,1,0],[0,0,1]].map(rotate),grips=[-1,1].map(side=>{const q=rotate([side*wheel.radius,0,0]);return wheel.centre.map((v,i)=>v+q[i]);});
  return {kind:'wheel',pivot:[...pivot],handle:grips[0],grips,basis,rudderBasis,wheel:{centre:[...wheel.centre],radius:wheel.radius,axis:a,angle:turn}};
}

export function rowingAnchorFitting(id,side){
  const d=rowingDesign(id);if(!d.equipment.anchor)throw Error('No anchor fitting on '+id);
  if(![-1,1].includes(side))throw Error('Anchor side must be port or starboard');
  const sx=d.runtime.beam/d.frame.beam,sy=d.frame.verticalScale,z=-5.10,y=rowingHullDeck(id,z),x=side*rowingHullWidth(id,z,y);
  return {root:[x-side*.05/sx,y,z+.08],tip:[x+side*.05/sx,y+.05/sy,z-.06],fairlead:[x+side*.045/sx,y+.04/sy,z-.05]};
}

export function rowingSurfaceSpar(surface){
  if(surface.kind!=='square')throw Error('No authored rowing spar for '+surface.kind);
  const a=surface.corners[0],b=surface.corners[1],delta=b.map((v,i)=>v-a[i]),length=Math.hypot(...delta);
  if(!(length>1e-12))throw Error('Degenerate rowing yard');
  const arm=delta.map(v=>v/length*.10);
  return {id:surface.name+'-yard',kind:'yard',a:a.map((v,i)=>v-arm[i]),b:b.map((v,i)=>v+arm[i]),radius:.035,radiusEnd:.025};
}
