// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Independent mixed-rig reconstructions. Every hull join follows this model's
// loft; only the nine-float construction primitives are shared with other ships.
import {createMeshWriter,OAK_ACROSS_PER_METRE,OAK_ALONG_PER_METRE,shipOakGrain} from './mesh-writer.js';
import {additionalDesign,additionalHullWidth,additionalDeck,additionalStairFlights} from './models/additional.js';
import {hullLoftPoint,hullLoftBottom,hullLoftSheer,hullLoftStem} from './hull-loft.js';
import {additionalRigContext,additionalGunAttachments} from './additional-rig.js';
import {surfaceRestPoint,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint,withRigPoseContext} from './rig-surface.js';
import {resolveVesselRopeChain} from './rope-wave.js';
import {ANCHOR_IRON} from './anchor-iron.js';

// The hull's own oak repeats and plank width in metres, taken from the Niña's hull.
const DECK_BOARD=.145,OAK_HULL_ALONG_PER_METRE=.36,PLANK_METRES=.26;

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
  const sx=design.runtime.beam/design.frame.beam,sy=design.frame.verticalScale,sz=design.runtime.length/design.frame.length;
  const {out,add,sub,mul,unit,tag,group,tri,quad,box,tube,rope,ring}=createMeshWriter({groups,parts,grain:shipOakGrain(sy,sz,sx)});
  const begin=profile.stations[0],end=profile.stations.at(-1),zones=design.deckZones,flights=additionalStairFlights(modelId);
  // The entry turns quickly, so the first stations sit closer together.
  const zSet=new Set([...profile.stations,...Array.from({length:61},(_,i)=>begin+(end-begin)*i/60),...Array.from({length:11},(_,i)=>begin+.1*i+.05)]);
  const hatchLeft=design.hatch.centre[0]-design.hatch.size[0]/2,hatchRight=design.hatch.centre[0]+design.hatch.size[0]/2;
  const hatchFore=design.hatch.centre[2]-design.hatch.size[2]/2,hatchAft=design.hatch.centre[2]+design.hatch.size[2]/2;
  zSet.add(hatchFore);zSet.add(hatchAft);
  for(const flight of flights){zSet.add(flight.z0);zSet.add(flight.z1);}
  for(const d of zones)for(const z of d.bounds)zSet.add(z);
  for(const z of design.keel.bounds){
    zSet.add(z);
    zSet.add(z<0?z*begin/(begin+(profile.bowRake??0)):z*end/(end-(profile.sternRake??0)));
  }
  const zs=[...zSet].sort((a,b)=>a-b);
  const levels=[...new Set([...profile.levels,...zones.flatMap(d=>[d.height,d.height+design.barrier]),...design.wales.flatMap(w=>[w.y-w.half,w.y+w.half]),
    ...Array.from({length:17},(_,i)=>profile.levels[0]+(profile.deck-profile.levels[0])*i/16)])].sort((a,b)=>a-b);
  const point=(station,base,side)=>hullLoftPoint(profile,station,base,side);
  // A point at a real length along the hull, for parts that must line up with
  // deck edges. The skin grid follows the raked sections instead.
  const onSide=(z,base,side)=>{const y=base+hullLoftSheer(profile,z);return [side*additionalHullWidth(modelId,z,y),y,z];};
  const top=z=>additionalDeck(modelId,z)-hullLoftSheer(profile,z)+design.barrier;
  const normal=(p,side)=>{
    const e=.0001,dy=(additionalHullWidth(modelId,p[2],p[1]+e)-additionalHullWidth(modelId,p[2],p[1]-e))/(2*e),dz=(additionalHullWidth(modelId,p[2]+e,p[1])-additionalHullWidth(modelId,p[2]-e,p[1]))/(2*e);
    return unit([side,-dy,-dz]);
  };
  // Material 15 reads uv.x*18 as a plank course. Courses count along the girth of
  // each section and every strake runs the full length, so strakes narrow into
  // the stem and sweep up to it the way the Niña's do, not as parallel bands.
  const girths=new Map(zs.map(station=>{
    const rows=new Map([[levels[0],0]]);let run=0;
    for(let j=0;j<levels.length-1;j++){
      const p=point(station,levels[j],1),q=point(station,levels[j+1],1);
      run+=Math.hypot((q[0]-p[0])*sx,(q[1]-p[1])*sy,(q[2]-p[2])*sz);rows.set(levels[j+1],run);
    }
    return [station,rows];
  }));
  const railLevel=profile.deck+design.barrier,courses=Math.round(girths.get(0).get(railLevel)/PLANK_METRES);
  const course=(station,base)=>{
    const rows=girths.get(station),here=rows.get(base),rail=rows.get(railLevel);
    return here<=rail?courses*here/rail:courses+(here-rail)/PLANK_METRES;
  };
  const hullUV=(station,base,p)=>[course(station,base)/18,p[2]*sz*OAK_HULL_ALONG_PER_METRE];
  const hullStart=out.length;
  for(const side of [-1,1])for(let j=0;j<levels.length-1;j++)for(let i=0;i<zs.length-1;i++){
    const a=levels[j],b=levels[j+1],z=zs[i],Z=zs[i+1];
    if(a<profile.levels[0]-1e-8||(a+b)/2>top((z+Z)*.5)+1e-8)continue;
    const p=[point(z,a,side),point(Z,a,side),point(Z,b,side),point(z,b,side)];
    quad(...p,15,p.map(q=>normal(q,side)),[hullUV(z,a,p[0]),hullUV(Z,a,p[1]),hullUV(Z,b,p[2]),hullUV(z,b,p[3])]);
  }
  group('hull.planking','hull',hullStart);
  for(const [name,z] of [['bow',begin],['stern',end]]){
    const start=out.length;
    for(let i=0;i<levels.length-1;i++){
      const a=levels[i],b=levels[i+1];if(a<profile.levels[0]-1e-8||(a+b)/2>top(z)+1e-8)continue;
      const p=[point(z,a,-1),point(z,a,1),point(z,b,1),point(z,b,-1)];
      quad(...p,15,null,p.map((q,i)=>[course(z,i<2?a:b)/18,q[0]*sx*OAK_HULL_ALONG_PER_METRE]));
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
  // The stem post is one tarred timber from the keel to the rail. It covers the
  // joint of the two sides and gives the raked profile its hard edge.
  const stemStart=out.length,stemHalf=.052,stemOut=.05,stemIn=.08,stemTopBase=profile.stemTop+.012;
  const stemLevels=[profile.levels[0]-k.depth,...levels.filter(y=>y>=profile.levels[0]&&y<stemTopBase),stemTopBase];
  const stemUV=(across,y)=>[across*OAK_ACROSS_PER_METRE*sx,y*OAK_ALONG_PER_METRE*sy];
  const stemCorner=(p,x,dz)=>[x*stemHalf,p[1],p[2]+dz];
  for(let j=0;j<stemLevels.length-1;j++){
    const a=hullLoftStem(profile,stemLevels[j]),b=hullLoftStem(profile,stemLevels[j+1]);
    quad(stemCorner(a,-1,-stemOut),stemCorner(a,1,-stemOut),stemCorner(b,1,-stemOut),stemCorner(b,-1,-stemOut),16,null,[stemUV(-stemHalf,a[1]),stemUV(stemHalf,a[1]),stemUV(stemHalf,b[1]),stemUV(-stemHalf,b[1])]);
    for(const side of [-1,1])quad(stemCorner(a,side,-stemOut),stemCorner(a,side,stemIn),stemCorner(b,side,stemIn),stemCorner(b,side,-stemOut),16,null,[stemUV(a[2]-stemOut,a[1]),stemUV(a[2]+stemIn,a[1]),stemUV(b[2]+stemIn,b[1]),stemUV(b[2]-stemOut,b[1])]);
  }
  for(const end of [hullLoftStem(profile,stemLevels[0]),hullLoftStem(profile,stemTopBase)])quad(stemCorner(end,-1,-stemOut),stemCorner(end,1,-stemOut),stemCorner(end,1,stemIn),stemCorner(end,-1,stemIn),16);
  group('hull.stem','hull',stemStart);
  // Proud tarred wales share their return edges with the triangulated skin grid.
  for(const side of [-1,1]){
    const start=out.length;
    const waleUV=p=>[p[1]*sy*OAK_ACROSS_PER_METRE,p[2]*sz*OAK_HULL_ALONG_PER_METRE];
    for(const {y:h,half}of design.wales)for(let i=0;i<zs.length-1;i++){
      const skin=[point(zs[i],h-half,side),point(zs[i+1],h-half,side),point(zs[i+1],h+half,side),point(zs[i],h+half,side)];
      const outer=skin.map(p=>[p[0]+side*.026,p[1],p[2]]);
      quad(...outer,16,outer.map(p=>normal(p,side)),outer.map(waleUV));quad(skin[0],skin[1],outer[1],outer[0],16);quad(outer[3],outer[2],skin[2],skin[3],16);
      if(i===0)quad(skin[0],outer[0],outer[3],skin[3],16);
      if(i===zs.length-2)quad(outer[1],skin[1],skin[2],outer[2],16);
    }
    group('hull.wales.'+(side<0?'port':'starboard'),'hull',start);
  }
  function deck(zone){
    // Cross-cuts land on the skin's own vertices at this deck's height, plus the
    // fixed edges of the zone, hatch and stairs, so the deck welds to the hull.
    const start=out.length,structural=[...zone.bounds,hatchFore,hatchAft,...flights.flatMap(f=>[f.z0,f.z1])];
    const cuts=[...new Set([...zs.map(s=>point(s,zone.height,0)[2]),...structural])].filter(z=>z>=zone.bounds[0]&&z<=zone.bounds[1]).sort((a,b)=>a-b);
    // One column per board, with the seams where the shader draws them.
    const xs=[...new Set([...Array.from({length:26},(_,i)=>-1.8+i*DECK_BOARD),hatchLeft,hatchRight,...flights.flatMap(f=>[f.x-f.width*.5,f.x+f.width*.5])])].sort((a,b)=>a-b);
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
        const offset=Math.sin(Math.floor(((x+X)*.5+1.8)/DECK_BOARD)*17.1)*.43;
        const deckNormal=p=>unit([0,1,-(hullLoftSheer(profile,p[2]+.0001)-hullLoftSheer(profile,p[2]-.0001))/.0002]);
        for(let j=1;j<polygon.length-1;j++){const p=[polygon[0],polygon[j],polygon[j+1]];tri(...p,0,p.map(deckNormal),p.map(q=>[q[0]*sx*OAK_ACROSS_PER_METRE+offset,q[2]*sz*OAK_ALONG_PER_METRE]));}
      }
    }
    group('deck.'+zone.id+'.planks','deck.'+zone.id,start);
  }
  for(const zone of zones)deck(zone);
  // Close raised deck fronts against the same width samples as the outer skin.
  for(const zone of zones.filter(d=>d.id!=='main')){
    const fore=zone.bounds[0]>begin,join=fore?zone.bounds[0]:zone.bounds[1],other=zones.filter(d=>d!==zone&&join>=d.bounds[0]&&join<=d.bounds[1]&&d.height<zone.height).sort((a,b)=>b.height-a.height)[0];
    const low=other?.height??profile.deck,start=out.length,sheer=hullLoftSheer(profile,join);
    const corridors=flights.filter(f=>f.zoneId===zone.id).map(f=>({...f,foot:f.y0+(f.y1-f.y0)*(join-f.z0)/(f.z1-f.z0)-sheer-.025}));
    const tillerY=design.steering.handle[1]-sheer,tillerPort=zone.id==='poop'&&tillerY>low+.05&&tillerY<zone.height-.05?[tillerY-.05,tillerY+.05]:[];
    const ys=[...new Set([low,...levels.filter(y=>y>low&&y<zone.height),...corridors.map(f=>f.foot).filter(y=>y>low&&y<zone.height),...tillerPort,zone.height])].sort((a,b)=>a-b);
    const xs=[...new Set([-1.8,1.8,...corridors.flatMap(f=>[f.x-f.width*.5,f.x+f.width*.5]),...(tillerPort.length?[-.09,.09]:[])])].sort((a,b)=>a-b);
    for(let j=0;j<ys.length-1;j++){
      const a=ys[j],b=ys[j+1],y=a+sheer,Y=b+sheer,w=additionalHullWidth(modelId,join,y),W=additionalHullWidth(modelId,join,Y);
      for(let i=0;i<xs.length-1;i++){
        const x=xs[i],X=xs[i+1],mx=(x+X)*.5,my=(a+b)*.5;
        if(corridors.some(f=>mx>f.x-f.width*.5&&mx<f.x+f.width*.5&&my>f.foot))continue;
        if(tillerPort.length&&Math.abs(mx)<.09&&my>tillerPort[0]&&my<tillerPort[1])continue;
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
      const z=zs[i],Z=zs[i+1],base=additionalDeck(modelId,(z+Z)*.5)-hullLoftSheer(profile,(z+Z)*.5),a=onSide(z,base,side),b=onSide(Z,base,side),c=onSide(Z,base+design.barrier,side),d=onSide(z,base+design.barrier,side);
      const inset=p=>[p[0]-side*Math.min(.045,Math.abs(p[0])),p[1],p[2]],A=inset(a),B=inset(b),C=inset(c),D=inset(d);
      quad(A,D,C,B,1);quad(d,c,C,D,1);
      // A broad cap rail, as on the Niña: it overhangs the planking and laps inboard.
      const cap=(p,offset,y)=>[side*Math.max(0,Math.abs(p[0])+offset),p[1]+y,p[2]];
      quad(cap(d,.024,.05),cap(c,.024,.05),cap(c,-.09,.05),cap(d,-.09,.05),17,[[0,1,0],[0,1,0],[0,1,0],[0,1,0]]);
      quad(cap(d,.024,-.03),cap(c,.024,-.03),cap(c,.024,.05),cap(d,.024,.05),17);
      quad(cap(d,-.09,-.03),cap(c,-.09,-.03),cap(c,-.09,.05),cap(d,-.09,.05),17);
      const previous=i?additionalDeck(modelId,(zs[i-1]+z)*.5)-hullLoftSheer(profile,(zs[i-1]+z)*.5):NaN;
      const next=i<zs.length-2?additionalDeck(modelId,(Z+zs[i+2])*.5)-hullLoftSheer(profile,(Z+zs[i+2])*.5):NaN;
      if(i===0||Math.abs(previous-base)>1e-8){quad(a,d,D,A,1);quad(cap(d,.024,-.03),cap(d,-.09,-.03),cap(d,-.09,.05),cap(d,.024,.05),17);}
      if(i===zs.length-2||Math.abs(next-base)>1e-8){quad(b,B,C,c,1);quad(cap(c,.024,-.03),cap(c,-.09,-.03),cap(c,-.09,.05),cap(c,.024,.05),17);}
      if(i%4===0)tube(inset(a),inset(d),.016,1,.016,5,undefined,true);
    }
    const sternBase=additionalDeck(modelId,end)-hullLoftSheer(profile,end),sternSheer=hullLoftSheer(profile,end),notch=design.steering.handle[1]>sternBase+sternSheer-.05&&design.steering.handle[1]<sternBase+sternSheer+design.barrier+.05,innerX=side*(notch?.09:0);
    const sA=[innerX,sternBase+sternSheer,end],sB=point(end,sternBase,side),sC=point(end,sternBase+design.barrier,side),sD=[innerX,sternBase+sternSheer+design.barrier,end],sIn=p=>[p[0],p[1],p[2]-.045];
    quad(sA,sB,sC,sD,1);quad(sIn(sA),sIn(sD),sIn(sC),sIn(sB),1);quad(sD,sC,sIn(sC),sIn(sD),1);
    if(notch)quad(sA,sD,sIn(sD),sIn(sA),1);
    tube(sD,sC,.025,1,.025,5,undefined,true);
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
      const a=point(station,samples[j],side),b=point(station,samples[j+1],side);
      // A rib would break through the planking where the section is this narrow.
      if(Math.min(Math.abs(a[0]),Math.abs(b[0]))<.075)continue;
      a[0]-=side*.025;b[0]-=side*.025;tube(a,b,.022,1,.022,5,undefined,true);
    }
  }
  group('hull.frames','hull',frameStart);
  const stock=design.steering.pivot,postStart=out.length,postLevels=levels.filter(y=>y>=profile.levels[0]&&y<=sternDeck);
  for(let j=0;j<postLevels.length-1;j++){
    const lo=postLevels[j],hi=postLevels[j+1],a=point(end,lo,0),b=point(end,hi,0),A=[0,a[1],Math.max(a[2]+.04,stock[2]-.035)],B=[0,b[1],Math.max(b[2]+.04,stock[2]-.035)];
    for(const side of [-1,1])quad([side*.045,a[1],a[2]],[side*.045,A[1],A[2]],[side*.045,B[1],B[2]],[side*.045,b[1],b[2]],1);
    quad([-.045,A[1],A[2]],[.045,A[1],A[2]],[.045,B[1],B[2]],[-.045,B[1],B[2]],1);
    if(j===0)quad([-.045,a[1],a[2]],[-.045,A[1],A[2]],[.045,A[1],A[2]],[.045,a[1],a[2]],1);
    if(j===postLevels.length-2)quad([-.045,b[1],b[2]],[.045,b[1],b[2]],[.045,B[1],B[2]],[-.045,B[1],B[2]],1);
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
    const start=out.length,cat=context.anchorCathead(side);
    tube(cat.root,cat.tip,.058,17,.05,8);
    // A knee carries the timber down onto the planking below the rail.
    const kneeZ=(cat.root[2]+cat.tip[2])*.5,kneeBase=cat.root[1]-.26-hullLoftSheer(profile,kneeZ);
    tube(onSide(kneeZ,kneeBase,side),add(cat.root,mul(sub(cat.tip,cat.root),.62)),.034,17,.04,6);
    // The working anchor to port belongs to the shared anchor renderer. The spare
    // to starboard is built in, as on the Niña, so that timber does not stand empty.
    if(side>0){
      const scale=design.equipment.anchorScale,eye=[cat.fairlead[0],cat.fairlead[1]-.65*scale/sy,cat.fairlead[2]];
      const corner=(i,k)=>add(eye,[ANCHOR_IRON[i+k*6]*scale/sx,ANCHOR_IRON[i+k*6+1]*scale/sy,ANCHOR_IRON[i+k*6+2]*scale/sz]);
      const facing=(i,k)=>unit([ANCHOR_IRON[i+k*6+3]*sx,ANCHOR_IRON[i+k*6+4]*sy,ANCHOR_IRON[i+k*6+5]*sz]);
      for(let i=0;i<ANCHOR_IRON.length;i+=18)tri(corner(i,0),corner(i,1),corner(i,2),3,[facing(i,0),facing(i,1),facing(i,2)]);
      tube(cat.fairlead,eye,.012,2,.012,5,undefined,true);
    }
    group('anchor.'+(side<0?'port':'starboard'),'anchor.'+(side<0?'port':'starboard')+'.root',start);
  }
  // The bowsprit heel stands on bitts on the forecastle deck, and the spar is
  // lashed down over the stem head with a gammoning, as on the Niña.
  const bowStart=out.length,sprit=design.bowsprit,spritAxis=sub(sprit.b,sprit.a),spritAt=t=>add(sprit.a,mul(spritAxis,t));
  tube(sprit.a,sprit.b,sprit.radius,1,sprit.radius*.5,16);
  const bittZ=sprit.a[2]+.02,bittDeck=additionalDeck(modelId,bittZ);
  for(const x of [-.13,.13])tube([x,bittDeck,bittZ],[x,sprit.a[1]+.05,bittZ],.042,17,.036,8);
  tube([-.20,sprit.a[1]-.075,bittZ],[.20,sprit.a[1]-.075,bittZ],.04,17,.04,8);
  const gammon=additionalMeshFrame(spritAxis),gammonT=(begin-sprit.a[2])/spritAxis[2];
  for(let turn=0;turn<7;turn++){
    const t=gammonT+(turn-2)*.012,centre=spritAt(t),r=sprit.radius*(1-.5*t)+.006;
    const around=q=>add(centre,add(mul(gammon.across,r*Math.cos(q*Math.PI/7)),mul(gammon.up,r*Math.sin(q*Math.PI/7))));
    for(let j=0;j<14;j++)tube(around(j),around(j+1),.012,2,.012,4,undefined,true);
  }
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
    const start=out.length;tube(m.foot,m.head,m.radius,1,m.radius*.4,16);
    for(let y=m.foot[1]+.45;y<m.head[1]*.65;y+=1.1)ring(context.mastPoint(index,y),m.radius*(1-(y-m.foot[1])/(m.head[1]-m.foot[1]))+.004,.008,2,'y',10);
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
    tube(A,middle,.03,tag(10,s.id),.058,12);tube(middle,B,.058,tag(10,s.id),.03,12);
    group('yard.'+s.name,'yard.'+s.name,yardStart,{type:'surface-yard',surface:s.id});
  }
  const standingStart=out.length;
  for(const line of context.lines.filter(l=>l.static))rope(line.a,line.b,line.r??.008,2,1,0);
  group('rig.standing','hull',standingStart);
  const runningStart=out.length;
  const restContext={...withRigPoseContext(context,{}),time:0,wind:0};
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
export function createAdditionalAssetPose(asset,options={}){
  // Optional descriptor injection reuses the exact pose algorithm for later
  // ships. Existing Pinta/Santa calls and construction output are unchanged.
  const id=asset.model?.id??asset.modelId,design=options.design??additionalDesign(id),context=options.context??additionalRigContext(id),source=asset.vertices;
  if(!(source instanceof Float32Array)||source.length%9)throw Error('Additional asset pose requires nine-float vertices');
  const surfaces=new Map(context.surfaces.map(s=>[s.id,s])),entries=[],cloth=new Map(),ropes=new Map();
  const restContext={...withRigPoseContext(context,{}),time:0,wind:0};
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
        sample={line,lineIndex,t,point,across:frame.across,frame};ropes.set(key,sample);
      }
      const offset=additionalMeshSub(p,sample.point),frame=sample.frame;
      entries.push({kind,at:i,sample,c:additionalMeshDot(offset,frame.across),s:additionalMeshDot(offset,frame.up),
        nc:additionalMeshDot(normal,frame.across),ns:additionalMeshDot(normal,frame.up)});continue;
    }
    if(kind===7||kind===14||kind===18||(kind===8&&surfaceId===1&&design.steering.wheel))entries.push({kind,at:i,p,normal});
  }
  const samples=[...cloth.values()],ropeSamples=[...ropes.values()],poses=new Map(),yardTransforms=new Map(),runtime={...context,poses,state:null,time:0,wind:0};
  function write(target,at,p,n){for(let k=0;k<3;k++){target[at+k]=p[k];target[at+3+k]=n[k];}}
  return (boat,time,wind,target)=>{
    if(!(target instanceof Float32Array)||target.length!==source.length)throw Error('Additional posed vertex buffer has wrong shape');
    runtime.state=boat.sailState??{};runtime.time=time;runtime.wind=wind;
    runtime.ropeChain=resolveVesselRopeChain(boat);
    for(const s of context.surfaces){
      const pose=rigSurfacePose(s,runtime.state);poses.set(s.id,pose);
      const origin=surfaceYardPoint(s,[0,0,0],pose),axes=[[1,0,0],[0,1,0],[0,0,1]].map(axis=>additionalMeshSub(surfaceYardPoint(s,axis,pose),origin));
      yardTransforms.set(s.id,{origin,axes});
    }
    runtime._surfaceActiveSupports=withRigPoseContext(context,runtime.state,poses)._surfaceActiveSupports;
    for(const sample of samples){
      const {surface:s,u,v}=sample,pose=poses.get(s.id),e=.0005,p=surfaceClothPoint(s,u,v,pose,runtime,time,wind);
      const du=additionalMeshSub(surfaceClothPoint(s,u+e,v,pose,runtime,time,wind),surfaceClothPoint(s,u-e,v,pose,runtime,time,wind));
      const dv=additionalMeshSub(surfaceClothPoint(s,u,v+e,pose,runtime,time,wind),surfaceClothPoint(s,u,v-e,pose,runtime,time,wind));
      const n=additionalMeshUnit(additionalMeshCross(du,dv));for(const at of sample.indices)write(target,at,p,n);
    }
    for(const sample of ropeSamples){
      const {line,lineIndex,t}=sample;runtime.lineIndex=lineIndex;
      const a=surfaceRopePoint(line,Math.max(0,t-.001),runtime),b=surfaceRopePoint(line,Math.min(1,t+.001),runtime);
      sample.point=surfaceRopePoint(line,t,runtime);sample.frame=additionalMeshFrame(additionalMeshSub(b,a),sample.across);
    }
    const angle=(boat.rudder??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),opening=(1-Math.max(0,Math.min(1,boat.hatchesClosed??0)))*Math.PI/2,hc=Math.cos(opening),hs=Math.sin(opening);
    const steeringPose=options.steeringPose?.(boat);
    for(const entry of entries){
      const {kind,at,p,normal:n}=entry;
      if(kind===10){
        const {origin,axes}=yardTransforms.get(entry.surface.id),transform=v=>[0,1,2].map(i=>axes[0][i]*v[0]+axes[1][i]*v[1]+axes[2][i]*v[2]);
        write(target,at,additionalMeshAdd(origin,transform(p)),additionalMeshUnit(transform(n)));
      }else if(kind===12){
        const q=entry.sample.point,frame=entry.sample.frame;
        write(target,at,additionalMeshAdd(q,additionalMeshAdd(additionalMeshMul(frame.across,entry.c),additionalMeshMul(frame.up,entry.s))),additionalMeshUnit(additionalMeshAdd(additionalMeshMul(frame.across,entry.nc),additionalMeshMul(frame.up,entry.ns))));
      }else if(kind===8){
        const wheel=design.steering.wheel,a=additionalMeshUnit(wheel.axis??[0,0,1]),turn=angle*(wheel.turnRatio??12),wc=Math.cos(turn),ws=Math.sin(turn);
        const rotate=v=>steeringPose?[0,1,2].map(i=>steeringPose.basis.reduce((sum,axis,j)=>sum+axis[i]*v[j],0)):additionalMeshAdd(additionalMeshAdd(additionalMeshMul(v,wc),additionalMeshMul(additionalMeshCross(a,v),ws)),additionalMeshMul(a,additionalMeshDot(a,v)*(1-wc)));
        write(target,at,additionalMeshAdd(wheel.centre,rotate(additionalMeshSub(p,wheel.centre))),additionalMeshUnit(rotate(n)));
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
