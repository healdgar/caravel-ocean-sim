// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Independent mixed-rig reconstructions. Every hull join follows this model's
// loft; only the nine-float construction primitives are shared with other ships.
import {createMeshWriter} from './mesh-writer.js';
import {additionalDesign,additionalHullWidth,additionalDeck,additionalStairFlights} from './models/additional.js';
import {hullLoftPoint,hullLoftBottom,hullLoftSheer} from './hull-loft.js';
import {additionalRigContext,additionalGunAttachments} from './additional-rig.js';
import {surfaceRestPoint,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint} from './rig-surface.js';

const additionalMeshAdd=(a,b)=>a.map((v,i)=>v+b[i]);
const additionalMeshSub=(a,b)=>a.map((v,i)=>v-b[i]);
const additionalMeshMul=(a,s)=>a.map(v=>v*s);
const additionalMeshDot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const additionalMeshCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function additionalMeshUnit(p,fallback=[0,1,0]){const n=Math.hypot(...p);return n>1e-12?additionalMeshMul(p,1/n):[...fallback];}
function additionalMeshClip(polygon,distance){
  const result=[];
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length],da=distance(a),db=distance(b);
    if(da>=-1e-10)result.push(a);
    if((da<0)!==(db<0)){const t=da/(da-db);result.push(a.map((v,j)=>v+(b[j]-v)*t));}
  }
  return result;
}
function additionalMeshFrame(axis,preferred){
  const direction=additionalMeshUnit(axis),reference=preferred??(Math.abs(direction[1])<.9?[0,1,0]:[1,0,0]);
  const across=preferred?additionalMeshUnit(additionalMeshSub(reference,additionalMeshMul(direction,additionalMeshDot(reference,direction))),additionalMeshUnit(additionalMeshCross(direction,[0,0,1]))):additionalMeshUnit(additionalMeshCross(direction,reference));
  return {direction,across,up:additionalMeshCross(direction,across)};
}

export function createAdditionalShipMesh(modelId,{groups,parts}={}){
  const design=additionalDesign(modelId),profile=design.profile,context=additionalRigContext(modelId);
  const {out,add,sub,mul,unit,tag,group,tri,quad,box,tube,rope,ring}=createMeshWriter({groups,parts});
  const begin=profile.stations[0],end=profile.stations.at(-1),zones=design.deckZones,flights=additionalStairFlights(modelId);
  const zSet=new Set([...profile.stations,...Array.from({length:61},(_,i)=>begin+(end-begin)*i/60)]);
  const hatchLeft=design.hatch.centre[0]-design.hatch.size[0]/2,hatchRight=design.hatch.centre[0]+design.hatch.size[0]/2;
  const hatchFore=design.hatch.centre[2]-design.hatch.size[2]/2,hatchAft=design.hatch.centre[2]+design.hatch.size[2]/2;
  zSet.add(hatchFore);zSet.add(hatchAft);
  for(const flight of flights){zSet.add(flight.z0);zSet.add(flight.z1);}
  for(const d of zones)for(const z of d.bounds)zSet.add(z);
  for(const z of design.keel.bounds){
    zSet.add(z);
    zSet.add(z<0?z*begin/(begin+(profile.bowRake??0)):z*end/(end-(profile.sternRake??0)));
  }
  const zs=[...zSet].sort((a,b)=>a-b),waleHeights=[-.10,.32];
  const levels=[...new Set([...profile.levels,...zones.flatMap(d=>[d.height,d.height+design.barrier]),...waleHeights.flatMap(h=>[h-.035,h+.035]),
    ...Array.from({length:17},(_,i)=>profile.levels[0]+(profile.deck-profile.levels[0])*i/16)])].sort((a,b)=>a-b);
  const point=(station,base,side)=>hullLoftPoint(profile,station,base,side);
  const top=z=>additionalDeck(modelId,z)-hullLoftSheer(profile,z)+design.barrier;
  const normal=(p,side)=>{
    const e=.0001,dy=(additionalHullWidth(modelId,p[2],p[1]+e)-additionalHullWidth(modelId,p[2],p[1]-e))/(2*e),dz=(additionalHullWidth(modelId,p[2]+e,p[1])-additionalHullWidth(modelId,p[2]-e,p[1]))/(2*e);
    return unit([side,-dy,-dz]);
  };
  const hullStart=out.length;
  for(const side of [-1,1])for(let j=0;j<levels.length-1;j++)for(let i=0;i<zs.length-1;i++){
    const a=levels[j],b=levels[j+1],z=zs[i],Z=zs[i+1];
    if(a<profile.levels[0]-1e-8||(a+b)/2>top((z+Z)*.5)+1e-8)continue;
    const p=[point(z,a,side),point(Z,a,side),point(Z,b,side),point(z,b,side)];
    // Material 15 interprets uv.x*18 as a plank course. About .12 design
    // units gives broad hull planks instead of centimetre-scale veneer stripes.
    quad(...p,15,p.map(q=>normal(q,side)),[[a/(.12*18),z*.6],[a/(.12*18),Z*.6],[b/(.12*18),Z*.6],[b/(.12*18),z*.6]]);
  }
  group('hull.planking','hull',hullStart);
  for(const [name,z] of [['bow',begin],['stern',end]]){
    const start=out.length;
    for(let i=0;i<levels.length-1;i++){
      const a=levels[i],b=levels[i+1];if(a<profile.levels[0]-1e-8||(a+b)/2>top(z)+1e-8)continue;
      const p=[point(z,a,-1),point(z,a,1),point(z,b,1),point(z,b,-1)];
      quad(...p,15,null,p.map((q,i)=>[(i<2?a:b)/(.12*18),q[0]*.6]));
    }
    group('hull.closure.'+name,'hull',start);
  }
  // The full timber rectangle shares the loft's curved bottom at every ring.
  // Its width/depth/bounds are the same exposed solid used by hydrostatics.
  const keelStart=out.length,k=design.keel,keelZs=[...new Set([k.bounds[0],...zs.map(z=>point(z,profile.levels[0],0)[2]).filter(z=>z>k.bounds[0]+1e-8&&z<k.bounds[1]-1e-8),k.bounds[1]])].sort((a,b)=>a-b);
  const kp=(z,side,lower)=>[side*k.width*.5,hullLoftBottom(profile,z)-(lower?k.depth:0),z];
  for(let i=0;i<keelZs.length-1;i++){
    const z=keelZs[i],Z=keelZs[i+1];
    for(const side of [-1,1])quad(kp(z,side,false),kp(Z,side,false),kp(Z,side,true),kp(z,side,true),1);
    for(const lower of [false,true])quad(kp(z,-1,lower),kp(z,1,lower),kp(Z,1,lower),kp(Z,-1,lower),1);
  }
  for(const z of [keelZs[0],keelZs.at(-1)])quad(kp(z,-1,false),kp(z,-1,true),kp(z,1,true),kp(z,1,false),1);
  group('hull.keel','hull',keelStart);
  // Proud wales share their return edges with the triangulated skin grid.
  for(const side of [-1,1]){
    const start=out.length;
    for(const h of waleHeights)for(let i=0;i<zs.length-1;i++){
      const skin=[point(zs[i],h-.035,side),point(zs[i+1],h-.035,side),point(zs[i+1],h+.035,side),point(zs[i],h+.035,side)];
      const outer=skin.map(p=>[p[0]+side*.026,p[1],p[2]]);
      quad(...outer,1,outer.map(p=>normal(p,side)));quad(skin[0],skin[1],outer[1],outer[0],1);quad(outer[3],outer[2],skin[2],skin[3],1);
      if(i===0)quad(skin[0],outer[0],outer[3],skin[3],1);
      if(i===zs.length-2)quad(outer[1],skin[1],skin[2],outer[2],1);
    }
    group('hull.wales.'+(side<0?'port':'starboard'),'hull',start);
  }
  function deck(zone){
    const start=out.length,cuts=zs.filter(z=>z>=zone.bounds[0]&&z<=zone.bounds[1]);
    const xs=[...new Set([...Array.from({length:37},(_,i)=>-1.8+i*.1),hatchLeft,hatchRight,...flights.flatMap(f=>[f.x-f.width*.5,f.x+f.width*.5])])].sort((a,b)=>a-b);
    for(let i=0;i<cuts.length-1;i++){
      const z=cuts[i],Z=cuts[i+1],y=zone.height+hullLoftSheer(profile,z),Y=zone.height+hullLoftSheer(profile,Z),w=additionalHullWidth(modelId,z,y),W=additionalHullWidth(modelId,Z,Y);
      const width=p=>w+(W-w)*(p[2]-z)/(Z-z);
      for(let k=0;k<xs.length-1;k++){
        const x=xs[k],X=xs[k+1];
        if(zone.id==='main'&&z>=hatchFore-1e-8&&Z<=hatchAft+1e-8&&x>=hatchLeft-1e-8&&X<=hatchRight+1e-8)continue;
        const middle=(z+Z)*.5;
        if(flights.some(f=>middle>=f.z0&&middle<=f.z1&&x>=f.x-f.width*.5-1e-8&&X<=f.x+f.width*.5+1e-8&&
          zone.height+hullLoftSheer(profile,middle)>f.y0+(f.y1-f.y0)*(middle-f.z0)/(f.z1-f.z0)+.001))continue;
        let polygon=[[x,y,z],[x,Y,Z],[X,Y,Z],[X,y,z]];
        polygon=additionalMeshClip(additionalMeshClip(polygon,p=>p[0]+width(p)),p=>width(p)-p[0]);
        // Edge clipping introduces intermediate Z coordinates. Project those
        // intersections back to the actual sheer/width, not its segment chord.
        polygon=polygon.map(p=>{
          const y=zone.height+hullLoftSheer(profile,p[2]),w=additionalHullWidth(modelId,p[2],y);
          return [Math.max(-w,Math.min(w,p[0])),y,p[2]];
        });
        const offset=Math.sin(Math.round(x/.1)*13.4)*.4;
        const deckNormal=p=>unit([0,1,-(hullLoftSheer(profile,p[2]+.0001)-hullLoftSheer(profile,p[2]-.0001))/.0002]);
        for(let j=1;j<polygon.length-1;j++){const p=[polygon[0],polygon[j],polygon[j+1]];tri(...p,0,p.map(deckNormal),p.map(q=>[q[0]*5+offset,q[2]*2]));}
      }
    }
    group('deck.'+zone.id+'.planks','deck.'+zone.id,start);
  }
  for(const zone of zones)deck(zone);
  // Close raised deck fronts against the same width samples as the outer skin.
  for(const zone of zones.filter(d=>d.id!=='main')){
    const fore=zone.bounds[0]>begin,join=fore?zone.bounds[0]:zone.bounds[1],other=zones.filter(d=>d!==zone&&join>=d.bounds[0]&&join<=d.bounds[1]&&d.height<zone.height).sort((a,b)=>b.height-a.height)[0];
    const low=other?.height??profile.deck,start=out.length;
    const corridors=flights.filter(f=>f.zoneId===zone.id).map(f=>({...f,foot:f.y0+(f.y1-f.y0)*(join-f.z0)/(f.z1-f.z0)-hullLoftSheer(profile,join)-.025}));
    const ys=[...new Set([low,...levels.filter(y=>y>low&&y<zone.height),...corridors.map(f=>f.foot).filter(y=>y>low&&y<zone.height),zone.height])].sort((a,b)=>a-b);
    const xs=[...new Set([-1.8,1.8,...corridors.flatMap(f=>[f.x-f.width*.5,f.x+f.width*.5])])].sort((a,b)=>a-b);
    for(let j=0;j<ys.length-1;j++){
      const a=ys[j],b=ys[j+1],y=a+hullLoftSheer(profile,join),Y=b+hullLoftSheer(profile,join),w=additionalHullWidth(modelId,join,y),W=additionalHullWidth(modelId,join,Y);
      for(let i=0;i<xs.length-1;i++){
        const x=xs[i],X=xs[i+1];if(corridors.some(f=>(x+X)*.5>f.x-f.width*.5&&(x+X)*.5<f.x+f.width*.5&&(a+b)*.5>f.foot))continue;
        const width=p=>w+(W-w)*(p[1]-y)/(Y-y);
        let polygon=[[x,y,join],[X,y,join],[X,Y,join],[x,Y,join]];
        polygon=additionalMeshClip(additionalMeshClip(polygon,p=>p[0]+width(p)),p=>width(p)-p[0]);
        for(let k=1;k<polygon.length-1;k++)tri(polygon[0],polygon[k],polygon[k+1],1);
      }
    }
    group('deck.bulkhead.'+zone.id,'hull',start);
  }
  // These same flight endpoints, widths and lanes drive crew navigation.
  for(const {id,x,width,z0,z1,y0,y1} of flights){
    const start=out.length,steps=Math.max(3,Math.ceil(Math.abs(y1-y0)*design.frame.verticalScale/.19));
    for(let j=0;j<steps;j++){
      const z=z0+(z1-z0)*(j+.5)/steps,y=y0+(y1-y0)*(j+1)/steps;
      box([x-width*.5,y-.025,z-(z1-z0)/steps*.5],[x+width*.5,y,z+(z1-z0)/steps*.5],0);
    }
    for(const X of [x-width*.55,x+width*.55]){
      tube([X,y0,z0],[X,y1,z1],.014,1,.014,5);
      tube([X,y0+.38,z0],[X,y1+.38,z1],.010,1,.010,5);
      for(const t of [0,.5,1])tube([X,y0+(y1-y0)*t,z0+(z1-z0)*t],[X,y0+(y1-y0)*t+.38,z0+(z1-z0)*t],.010,1,.010,5);
    }
    group('deck.stairs.'+id,'hull',start);
  }
  for(const side of [-1,1]){
    const start=out.length;
    for(let i=0;i<zs.length-1;i++){
      const z=zs[i],Z=zs[i+1],base=additionalDeck(modelId,(z+Z)*.5)-hullLoftSheer(profile,(z+Z)*.5),a=point(z,base,side),b=point(Z,base,side),c=point(Z,base+design.barrier,side),d=point(z,base+design.barrier,side);
      const inset=p=>[p[0]-side*Math.min(.045,Math.abs(p[0])),p[1],p[2]],A=inset(a),B=inset(b),C=inset(c),D=inset(d);
      quad(A,D,C,B,1);quad(d,c,C,D,1);tube(d,c,.025,1,.025,5,undefined,true);
      const previous=i?additionalDeck(modelId,(zs[i-1]+z)*.5)-hullLoftSheer(profile,(zs[i-1]+z)*.5):NaN;
      const next=i<zs.length-2?additionalDeck(modelId,(Z+zs[i+2])*.5)-hullLoftSheer(profile,(Z+zs[i+2])*.5):NaN;
      if(i===0||Math.abs(previous-base)>1e-8)quad(a,d,D,A,1);
      if(i===zs.length-2||Math.abs(next-base)>1e-8)quad(b,B,C,c,1);
      if(i%4===0)tube(inset(a),inset(d),.016,1,.016,5,undefined,true);
    }
    group('bulwark.'+(side<0?'port':'starboard'),'hull',start);
  }
  // A continuous transom supports the windows; no floating gallery shelves.
  const sternStart=out.length,sternDeck=additionalDeck(modelId,end)-hullLoftSheer(profile,end),windowLow=Math.max(profile.deck+.07,sternDeck-.48),windowHigh=Math.min(sternDeck-.10,windowLow+.25);
  if(windowHigh>windowLow){
    const widthAt=y=>additionalHullWidth(modelId,end,y+hullLoftSheer(profile,end));
    const count=modelId==='santa-maria'?5:3;
    for(let j=0;j<count;j++){
      const f=-.75+1.5*(j+.5)/count,half=.085,w=widthAt((windowLow+windowHigh)*.5),x=f*w,z=end+.004;
      const y=windowLow+hullLoftSheer(profile,end),Y=windowHigh+hullLoftSheer(profile,end);
      box([x-half-.018,y-.018,end-.012],[x+half+.018,Y+.018,end+.006],1);
      quad([x-half,y,z+.004],[x+half,y,z+.004],[x+half,Y,z+.004],[x-half,Y,z+.004],11);
      for(const X of [x-half,x,x+half])tube([X,y,z+.011],[X,Y,z+.011],.008,1,.008,4);
      tube([x-half,(y+Y)*.5,z+.011],[x+half,(y+Y)*.5,z+.011],.008,1,.008,4);
    }
  }
  group('stern.windows','hull',sternStart);
  const frameStart=out.length;
  for(let i=3;i<zs.length-3;i+=5)for(const side of [-1,1]){
    const station=zs[i],base=additionalDeck(modelId,station)-hullLoftSheer(profile,station),samples=[profile.levels[0]+.025,...profile.levels.filter(y=>y>profile.levels[0]+.025&&y<base),base];
    for(let j=0;j<samples.length-1;j++){
      const a=point(station,samples[j],side),b=point(station,samples[j+1],side);a[0]-=side*.025;b[0]-=side*.025;tube(a,b,.022,1,.022,5,undefined,true);
    }
  }
  group('hull.frames','hull',frameStart);
  const stock=design.steering.pivot,postStart=out.length;
  for(let j=0;j<levels.length-1;j++){
    const lo=levels[j],hi=levels[j+1];if(lo<profile.levels[0]||hi>sternDeck)continue;
    const a=point(end,lo,0),b=point(end,hi,0),A=[0,a[1],stock[2]],B=[0,b[1],stock[2]];
    for(const side of [-1,1])quad([side*.045,a[1],a[2]],[side*.045,A[1],A[2]],[side*.045,B[1],B[2]],[side*.045,b[1],b[2]],1);
    quad([-.045,A[1],A[2]],[.045,A[1],A[2]],[.045,B[1],B[2]],[-.045,B[1],B[2]],1);
  }
  group('hull.sternpost','hull',postStart);
  const rudderStart=out.length,rudderBottom=profile.levels[0]-design.keel.depth,rudderTop=design.steering.handle[1],blade=[[rudderBottom,stock[2]], [rudderBottom+.07,stock[2]+.57],[.12,stock[2]+.54],[.38,stock[2]]];
  box([-.035,rudderBottom,stock[2]-.035],[.035,rudderTop,stock[2]+.055],14);
  for(const side of [-1,1])quad(...blade.map(([y,z])=>[side*.035,y,z]),14);
  for(let i=0;i<blade.length;i++){const a=blade[i],b=blade[(i+1)%blade.length];quad([-.035,...a],[.035,...a],[.035,...b],[-.035,...b],14);}
  group('helm.rudder','helm.rudder',rudderStart,{type:'rudder'});
  const tillerStart=out.length,handle=design.steering.handle;
  tube([0,handle[1],stock[2]],handle,.032,7,.022,8);
  tube(add(handle,[-.10,0,0]),add(handle,[.10,0,0]),.021,7,.021,6);
  group('helm.tiller','helm.tiller',tillerStart,{type:'tiller'});
  for(const side of [-1,1]){
    const start=out.length,cat=context.anchorCathead(side);tube(cat.root,cat.tip,.045,1,.038,8);
    // The shared anchor renderer owns the stowed/dropping iron and cable.
    group('anchor.'+(side<0?'port':'starboard'),'anchor.'+(side<0?'port':'starboard')+'.root',start);
  }
  const bowStart=out.length;tube(design.bowsprit.a,design.bowsprit.b,design.bowsprit.radius,1,design.bowsprit.radius*.58,12);
  tube([0,additionalDeck(modelId,-5.45),-5.45],design.bowsprit.a,.055,1,.045,8);
  group('bow.bowsprit','hull',bowStart);
  const coamingStart=out.length,hatchFloor=additionalDeck(modelId,design.hatch.centre[2]),coamingTop=design.hatch.centre[1]+.015;
  for(const x of [hatchLeft,hatchRight]){
    box([x-.025,hatchFloor-.03,hatchFore-.025],[x+.025,coamingTop,hatchAft+.025],1);
    quad([x,hatchFloor,hatchFore],[x,hatchFloor-.30,hatchFore],[x,hatchFloor-.30,hatchAft],[x,hatchFloor,hatchAft],4);
  }
  for(const z of [hatchFore,hatchAft])box([hatchLeft-.025,hatchFloor-.03,z-.025],[hatchRight+.025,coamingTop,z+.025],1);
  box([hatchLeft,hatchFloor-.32,hatchFore],[hatchRight,hatchFloor-.30,hatchAft],4);
  group('hatch.coaming','hatch.main',coamingStart);
  const hatchStart=out.length,h=design.hatch,hinge=[h.centre[0],h.centre[1],h.centre[2]-h.size[2]/2];
  box([h.centre[0]-h.size[0]/2,h.centre[1],hinge[2]],[h.centre[0]+h.size[0]/2,h.centre[1]+h.size[1],hinge[2]+h.size[2]],18);
  for(const z of [hinge[2]+.10,hinge[2]+h.size[2]-.10])box([h.centre[0]-h.size[0]/2,h.centre[1]+h.size[1],z-.025],[h.centre[0]+h.size[0]/2,h.centre[1]+h.size[1]+.025,z+.025],18);
  group('hatch.main','hatch.main',hatchStart,{type:'hatch',pivot:hinge});
  for(const gun of additionalGunAttachments(modelId)){
    const start=out.length,[x,y,z]=gun.centre,side=gun.sideSign;
    tube([x,gun.floorDesign,z],[x,y-.035,z],.025,3,.025,8);tube([x,y-.02,z-.065],[x,y-.02,z+.065],.018,3,.018,6);
    const recoilStart=out.length,breech=gun.breechDesign,muzzle=gun.muzzleDesign,axis=unit(gun.directionDesign),across=unit([-axis[1],axis[0],0]),inside=add(muzzle,mul(axis,-.08));
    tube(breech,muzzle,.033,3,gun.barrelRadius,10,undefined,true);
    const edge=(p,r,j)=>add(p,add(mul(across,r*Math.cos(j*Math.PI/5)),[0,0,r*Math.sin(j*Math.PI/5)]));
    for(let j=0;j<10;j++){
      quad(edge(muzzle,gun.barrelRadius,j),edge(muzzle,.018,j),edge(muzzle,.018,j+1),edge(muzzle,gun.barrelRadius,j+1),3);
      quad(edge(muzzle,.018,j),edge(inside,.018,j),edge(inside,.018,j+1),edge(muzzle,.018,j+1),4);
      tri(inside,edge(inside,.018,j+1),edge(inside,.018,j),4);tri(breech,edge(breech,.033,j),edge(breech,.033,j+1),3);
    }
    tube(add(breech,[-side*.03,0,0]),add(breech,[-side*.16,-.025,0]),.012,1,.010,6);
    group('gunnery.recoil.'+gun.id,'hull',recoilStart,{type:'gun-recoil',gunId:gun.id,axis:[...gun.directionDesign]});
    group('gun.'+gun.id,'hull',start);
  }
  for(const [index,m] of context.masts.entries()){
    const start=out.length;tube(m.foot,m.head,m.radius,1,.018,14);
    for(let y=m.foot[1]+.20;y<m.head[1]*.65;y+=.42)ring(context.mastPoint(index,y),m.radius*(1-(y-m.foot[1])/(m.head[1]-m.foot[1]))+.004,.008,2,'y',10);
    group('mast.'+m.id,'mast.'+m.id,start);
  }
  if(design.lookout){
    const start=out.length,p=context.mastPoint(design.lookout.mast,design.lookout.height),r=.34;
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8,b=(i+1)*Math.PI/8,A=add(p,[r*Math.cos(a),0,r*Math.sin(a)]),B=add(p,[r*Math.cos(b),0,r*Math.sin(b)]);
      tri(p,A,B,0);tube(A,B,.020,1,.020,6,undefined,true);tube(add(A,[0,.30,0]),add(B,[0,.30,0]),.017,1,.017,6,undefined,true);
      if(i%2===0)tube(A,add(A,[0,.30,0]),.015,1,.015,6);
      if(i%4===0)tube(context.mastPoint(design.lookout.mast,design.lookout.height-.3),A,.028,1,.022,6);
    }
    group('lookout.fore','lookout.fore',start);
  }
  for(const s of context.surfaces){
    const start=out.length,n=s.kind==='square'?20:22,material=tag(s.corners.length===3?13:9,s.id);
    const emit=uv=>{
      const points=uv.map(p=>surfaceRestPoint(s,...p)),norm=unit(additionalMeshCross(sub(s.corners[1],s.corners[0]),sub(s.corners.at(-1),s.corners[0])));
      if(uv.length===3)tri(...points,material,points.map(()=>norm),uv);else quad(...points,material,points.map(()=>norm),uv);
    };
    if(s.corners.length===3){
      for(let i=0;i<n;i++)for(let j=0;j<n-i;j++){
        emit([[i/n,j/n],[(i+1)/n,j/n],[i/n,(j+1)/n]]);
        if(j<n-i-1)emit([[(i+1)/n,j/n],[(i+1)/n,(j+1)/n],[i/n,(j+1)/n]]);
      }
    }else for(let i=0;i<n;i++)for(let j=0;j<n;j++)emit([[i/n,j/n],[(i+1)/n,j/n],[(i+1)/n,(j+1)/n],[i/n,(j+1)/n]]);
    group('sail.'+s.name,'sail.'+s.name,start,{type:'surface-cloth',surface:s.id});
    const yardStart=out.length,a=s.corners[0],b=s.corners[1],axis=unit(sub(b,a)),A=add(a,mul(axis,-.12)),B=add(b,mul(axis,.12)),middle=mul(add(a,b),.5);
    tube(A,middle,.023,tag(10,s.id),.046,10);tube(middle,B,.046,tag(10,s.id),.023,10);
    group('yard.'+s.name,'yard.'+s.name,yardStart,{type:'surface-yard',surface:s.id});
  }
  const standingStart=out.length;
  for(const line of context.lines.filter(l=>l.static))rope(line.a,line.b,line.r??.008,2,1,0);
  group('rig.standing','hull',standingStart);
  const runningStart=out.length;
  const restContext={...context,state:{},poses:new Map(context.surfaces.map(s=>[s.id,rigSurfacePose(s,{})])),time:0,wind:0};
  for(const [index,line] of context.lines.entries())if(!line.static){
    const segments=line.kind==='sheet'?10:5;
    for(let j=0;j<segments;j++){
      const t=j/segments,T=(j+1)/segments;
      tube(surfaceRopePoint(line,t,restContext),surfaceRopePoint(line,T,restContext),line.r??.007,12,line.r??.007,4,[[100+index,t],[100+index,T]],true);
    }
  }
  group('rig.running','hull',runningStart,{type:'surface-running-rigging'});
  return new Float32Array(out);
}

// Build the compact animation map once for each indexed immutable asset. Only
// these vertices change: fixed hull and gun recoil buffers retain their bytes.
export function createAdditionalAssetPose(asset){
  const id=asset.model?.id??asset.modelId,design=additionalDesign(id),context=additionalRigContext(id),source=asset.vertices;
  if(!(source instanceof Float32Array)||source.length%9)throw Error('Additional asset pose requires nine-float vertices');
  const surfaces=new Map(context.surfaces.map(s=>[s.id,s])),entries=[],cloth=new Map(),ropes=new Map();
  const restContext={...context,state:{},poses:new Map(context.surfaces.map(s=>[s.id,rigSurfacePose(s,{})])),time:0,wind:0};
  const hatch=design.hatch,hinge=[hatch.centre[0],hatch.centre[1],hatch.centre[2]-hatch.size[2]/2];
  for(let i=0;i<source.length;i+=9){
    const material=source[i+6],kind=Math.floor(material),surfaceId=Math.round((material-kind)*64),p=Array.from(source.subarray(i,i+3)),normal=Array.from(source.subarray(i+3,i+6));
    if((kind===9||kind===13)&&surfaces.has(surfaceId)){
      const u=source[i+7],v=source[i+8],key=surfaceId+'/'+u+'/'+v;
      let sample=cloth.get(key);if(!sample){sample={surface:surfaces.get(surfaceId),u,v,indices:[]};cloth.set(key,sample);}
      sample.indices.push(i);continue;
    }
    if(kind===10&&surfaces.has(surfaceId)){entries.push({kind,at:i,surface:surfaces.get(surfaceId),p,normal});continue;}
    if(kind===12&&source[i+7]>=100){
      const lineIndex=Math.round(source[i+7]-100),line=context.lines[lineIndex],t=source[i+8];if(!line||line.static)throw Error('Invalid additional running-rig vertex');
      const key=lineIndex+'/'+t;let sample=ropes.get(key);
      if(!sample){
        const point=surfaceRopePoint(line,t,restContext),a=surfaceRopePoint(line,Math.max(0,t-.001),restContext),b=surfaceRopePoint(line,Math.min(1,t+.001),restContext),frame=additionalMeshFrame(additionalMeshSub(b,a));
        sample={line,t,point,across:frame.across,frame};ropes.set(key,sample);
      }
      const offset=additionalMeshSub(p,sample.point),frame=sample.frame;
      entries.push({kind,at:i,sample,c:additionalMeshDot(offset,frame.across),s:additionalMeshDot(offset,frame.up),
        nc:additionalMeshDot(normal,frame.across),ns:additionalMeshDot(normal,frame.up)});continue;
    }
    if(kind===7||kind===14||kind===18)entries.push({kind,at:i,p,normal});
  }
  const samples=[...cloth.values()],ropeSamples=[...ropes.values()],poses=new Map(),yardTransforms=new Map(),runtime={...context,poses,state:null,time:0,wind:0};
  function write(target,at,p,n){for(let k=0;k<3;k++){target[at+k]=p[k];target[at+3+k]=n[k];}}
  return (boat,time,wind,target)=>{
    if(!(target instanceof Float32Array)||target.length!==source.length)throw Error('Additional posed vertex buffer has wrong shape');
    runtime.state=boat.sailState??{};runtime.time=time;runtime.wind=wind;
    for(const s of context.surfaces){
      const pose=rigSurfacePose(s,runtime.state);poses.set(s.id,pose);
      const origin=surfaceYardPoint(s,[0,0,0],pose),axes=[[1,0,0],[0,1,0],[0,0,1]].map(axis=>additionalMeshSub(surfaceYardPoint(s,axis,pose),origin));
      yardTransforms.set(s.id,{origin,axes});
    }
    for(const sample of samples){
      const {surface:s,u,v}=sample,pose=poses.get(s.id),e=.0005,p=surfaceClothPoint(s,u,v,pose,runtime,time,wind);
      const du=additionalMeshSub(surfaceClothPoint(s,u+e,v,pose,runtime,time,wind),surfaceClothPoint(s,u-e,v,pose,runtime,time,wind));
      const dv=additionalMeshSub(surfaceClothPoint(s,u,v+e,pose,runtime,time,wind),surfaceClothPoint(s,u,v-e,pose,runtime,time,wind));
      const n=additionalMeshUnit(additionalMeshCross(du,dv));for(const at of sample.indices)write(target,at,p,n);
    }
    for(const sample of ropeSamples){
      const {line,t}=sample,a=surfaceRopePoint(line,Math.max(0,t-.001),runtime),b=surfaceRopePoint(line,Math.min(1,t+.001),runtime);
      sample.point=surfaceRopePoint(line,t,runtime);sample.frame=additionalMeshFrame(additionalMeshSub(b,a),sample.across);
    }
    const angle=(boat.rudder??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),opening=(1-Math.max(0,Math.min(1,boat.hatchesClosed??0)))*Math.PI/2,hc=Math.cos(opening),hs=Math.sin(opening);
    for(const entry of entries){
      const {kind,at,p,normal:n}=entry;
      if(kind===10){
        const {origin,axes}=yardTransforms.get(entry.surface.id),transform=v=>[0,1,2].map(i=>axes[0][i]*v[0]+axes[1][i]*v[1]+axes[2][i]*v[2]);
        write(target,at,additionalMeshAdd(origin,transform(p)),additionalMeshUnit(transform(n)));
      }else if(kind===12){
        const q=entry.sample.point,frame=entry.sample.frame;
        write(target,at,additionalMeshAdd(q,additionalMeshAdd(additionalMeshMul(frame.across,entry.c),additionalMeshMul(frame.up,entry.s))),additionalMeshUnit(additionalMeshAdd(additionalMeshMul(frame.across,entry.nc),additionalMeshMul(frame.up,entry.ns))));
      }else if(kind===18){
        const q=additionalMeshSub(p,hinge);write(target,at,[p[0],hinge[1]+hc*q[1]+hs*q[2],hinge[2]-hs*q[1]+hc*q[2]],[n[0],hc*n[1]+hs*n[2],-hs*n[1]+hc*n[2]]);
      }else{
        const pivot=design.steering.pivot,q=additionalMeshSub(p,pivot);
        write(target,at,[pivot[0]+c*q[0]+s*q[2],p[1],pivot[2]-s*q[0]+c*q[2]],[c*n[0]+s*n[2],n[1],-s*n[0]+c*n[2]]);
      }
    }
    return true;
  };
}
