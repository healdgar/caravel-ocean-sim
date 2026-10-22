// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Model-owned standing supports and running leads shared by the mesh, cloth
// contact, force sampling, posed attachments and crew work.
import {deepFreeze} from './rig-definition.js';
import {additionalDesign,additionalDeck,additionalDeckWidth} from './models/additional.js';
const additionalRigCache=new Map();
const additionalGunCache=new Map();
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
  const context=deepFreeze({surfaces:d.surfaces,masts,supports,lines,mastPoint,anchorCathead});
  additionalRigCache.set(id,context);return context;
}
