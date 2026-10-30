// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Independent clipper/yacht construction. Published dimensions are retained in
// the design ledger; loft offsets, structures and working rope leads are authored.
import {createMeshWriter} from './mesh-writer.js';
import {hullLoftPoint,hullLoftBottom,hullLoftSheer} from './hull-loft.js';
import {laterSailDesign,laterSailHullWidth,laterSailDeck,laterSailDeckWidth,laterSailKeelHalfWidth,laterSailStairFlights} from './models/later-sail.js';
import {laterSailRigContext,laterSailSteeringPose} from './additional-rig.js';
import {surfaceRestPoint,rigSurfacePose,surfaceRopePoint,withRigPoseContext} from './rig-surface.js';
import {createAdditionalAssetPose} from './additional-ships.js';

const laterMeshAdd=(a,b)=>a.map((v,i)=>v+b[i]);
const laterMeshSub=(a,b)=>a.map((v,i)=>v-b[i]);
const laterMeshMul=(a,s)=>a.map(v=>v*s);
const laterMeshCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const laterMeshUnit=p=>{const n=Math.hypot(...p);return n>1e-12?laterMeshMul(p,1/n):[0,1,0];};
function laterMeshClip(polygon,distance){
  const result=[];
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length],da=distance(a),db=distance(b);
    if(da>=-1e-10)result.push(a);
    if((da<0)!==(db<0)){const t=da/(da-db);result.push(a.map((v,j)=>v+(b[j]-v)*t));}
  }
  return result;
}
function laterMeshInside(rect,x,z){return x>rect.x0+1e-10&&x<rect.x1-1e-10&&z>rect.z0+1e-10&&z<rect.z1-1e-10;}

export function createLaterSailShipMesh(id,{groups,parts}={}){
  const d=laterSailDesign(id),p=d.profile,context=laterSailRigContext(id),cloud=id==='flying-cloud',flights=laterSailStairFlights(id);
  const {out,tri,quad,box,tube,rope,ring,group,tag}=createMeshWriter({groups,parts}),sx=d.runtime.beam/d.frame.beam,sy=d.frame.verticalScale,sz=d.runtime.length/d.frame.length;
  const begin=p.stations[0],end=p.stations.at(-1),h=d.hatch,c=d.cockpit;
  const hatch={x0:h.centre[0]-h.size[0]/2,x1:h.centre[0]+h.size[0]/2,z0:h.centre[2]-h.size[2]/2,z1:h.centre[2]+h.size[2]/2};
  const structures=d.structures.map(s=>({...s,x0:s.centre[0]-s.size[0]/2,x1:s.centre[0]+s.size[0]/2,z0:s.centre[2]-s.size[2]/2,z1:s.centre[2]+s.size[2]/2}));
  const cuts=new Set([...p.stations,...Array.from({length:81},(_,i)=>begin+(end-begin)*i/80),hatch.z0,hatch.z1,
    ...structures.flatMap(s=>[s.z0,s.z1]),...d.deckZones.flatMap(z=>z.bounds),...flights.flatMap(f=>[f.z0,f.z1]),...(c?c.bounds:[])]);
  const zs=[...cuts].filter(z=>z>=begin&&z<=end).sort((a,b)=>a-b),wale=cloud?[.30,.53]:[];
  const opaqueRail=cloud?d.barrier:0;
  const levels=[...new Set([...p.levels,...d.deckZones.flatMap(z=>[z.height,z.height+opaqueRail]),...wale.flatMap(y=>[y-.018,y+.018]),
    ...Array.from({length:22},(_,i)=>p.levels[0]+(p.deck-p.levels[0])*i/21)])].sort((a,b)=>a-b);
  const deckBase=z=>Math.max(...d.deckZones.filter(zone=>z>=zone.bounds[0]-1e-10&&z<=zone.bounds[1]+1e-10).map(zone=>zone.height),p.deck);
  const point=(z,y,side)=>hullLoftPoint(p,z,y,side);
  const hullNormal=(q,side)=>{
    const e=.0001,dy=(laterSailHullWidth(id,q[2],q[1]+e)-laterSailHullWidth(id,q[2],q[1]-e))/(2*e),dz=(laterSailHullWidth(id,q[2]+e,q[1])-laterSailHullWidth(id,q[2]-e,q[1]))/(2*e);
    return laterMeshUnit([side,-dy,-dz]);
  };
  const hullMaterial=cloud?20:23,hullStart=out.length;
  for(const side of [-1,1])for(let j=0;j<levels.length-1;j++)for(let i=0;i<zs.length-1;i++){
    const a=levels[j],b=levels[j+1],z=zs[i],Z=zs[i+1];
    if((a+b)/2>deckBase((z+Z)/2)+opaqueRail+1e-10)continue;
    const q=[point(z,a,side),point(Z,a,side),point(Z,b,side),point(z,b,side)];
    quad(...q,hullMaterial,q.map(v=>hullNormal(v,side)),q.map(v=>[v[1]/(.22/sy*18),v[2]*.6]));
  }
  group('hull.planking','hull',hullStart);
  for(const [name,z]of [['bow',begin],['stern',end]]){
    const start=out.length;
    for(let j=0;j<levels.length-1;j++){
      const a=levels[j],b=levels[j+1];if((a+b)/2>deckBase(z)+opaqueRail+1e-10)continue;
      quad(point(z,a,-1),point(z,a,1),point(z,b,1),point(z,b,-1),hullMaterial);
    }
    group('hull.closure.'+name,'hull',start);
  }
  const bottomStart=out.length;
  for(let i=0;i<zs.length-1;i++)quad(point(zs[i],p.levels[0],-1),point(zs[i+1],p.levels[0],-1),point(zs[i+1],p.levels[0],1),point(zs[i],p.levels[0],1),hullMaterial);
  group('hull.bottom','hull',bottomStart);

  const keelStart=out.length,k=d.keel;
  if(k?.kind==='profiled-ballast-fin'){
    // The same exact NACA thickness/fore-aft section evaluator feeds hydro and
    // lateral resistance. This is a finite faired appendage, not a long timber.
    const finPoint=(section,u,side)=>{
      const z=section.zFore+(section.zAft-section.zFore)*u;
      return [side*laterSailKeelHalfWidth(id,z,section.y),section.y,z];
    };
    for(let j=0;j<k.sections.length-1;j++)for(let i=0;i<32;i++)for(const side of [-1,1]){
      const u=(1-Math.cos(i*Math.PI/32))*.5,U=(1-Math.cos((i+1)*Math.PI/32))*.5;
      quad(finPoint(k.sections[j],u,side),finPoint(k.sections[j+1],u,side),finPoint(k.sections[j+1],U,side),finPoint(k.sections[j],U,side),23);
    }
    for(const section of [k.sections[0],k.sections.at(-1)])for(let i=0;i<32;i++){
      const u=i/32,U=(i+1)/32;quad(finPoint(section,u,-1),finPoint(section,U,-1),finPoint(section,U,1),finPoint(section,u,1),23);
    }
  }else if(k){
    const kz=[k.bounds[0],...zs.filter(z=>z>k.bounds[0]&&z<k.bounds[1]),k.bounds[1]],at=(z,side,lower)=>[side*k.width/2,hullLoftBottom(p,z)-(lower?k.depth:0),z];
    for(let i=0;i<kz.length-1;i++){
      for(const side of [-1,1])quad(at(kz[i],side,false),at(kz[i],side,true),at(kz[i+1],side,true),at(kz[i+1],side,false),1);
      for(const lower of [false,true])quad(at(kz[i],-1,lower),at(kz[i+1],-1,lower),at(kz[i+1],1,lower),at(kz[i],1,lower),1);
    }
    for(const z of [kz[0],kz.at(-1)])quad(at(z,-1,false),at(z,1,false),at(z,1,true),at(z,-1,true),1);
  }
  group('hull.keel','hull',keelStart);

  for(const side of [-1,1]){
    const start=out.length;
    for(const y of wale)for(let i=0;i<zs.length-1;i++){
      const skin=[point(zs[i],y-.018,side),point(zs[i+1],y-.018,side),point(zs[i+1],y+.018,side),point(zs[i],y+.018,side)],outer=skin.map(q=>laterMeshAdd(q,[side*.012,0,0]));
      quad(...outer,20,outer.map(q=>hullNormal(q,side)));quad(skin[0],skin[1],outer[1],outer[0],20);quad(outer[3],outer[2],skin[2],skin[3],20);
      if(i===0)quad(skin[0],outer[0],outer[3],skin[3],20);if(i===zs.length-2)quad(outer[1],skin[1],skin[2],outer[2],20);
    }
    group('hull.wales.'+(side<0?'port':'starboard'),'hull',start);
  }
  const xs=[...new Set([...Array.from({length:45},(_,i)=>-1.8+i*3.6/44),hatch.x0,hatch.x1,
    ...structures.flatMap(s=>[s.x0,s.x1]),...flights.flatMap(f=>[f.x-f.width/2,f.x+f.width/2]),...(c?[-c.halfWidth,c.halfWidth]:[])])].sort((a,b)=>a-b);
  const deckNormal=z=>laterMeshUnit([0,1,-(hullLoftSheer(p,z+.0001)-hullLoftSheer(p,z-.0001))/.0002]);
  for(const zone of d.deckZones){
    const start=out.length;
    for(let i=0;i<zs.length-1;i++)for(let j=0;j<xs.length-1;j++){
      const z=zs[i],Z=zs[i+1],x=xs[j],X=xs[j+1],mid=(z+Z)/2,mx=(x+X)/2;
      if(mid<zone.bounds[0]||mid>zone.bounds[1])continue;
      if(d.deckZones.some(other=>other.height>zone.height&&mid>other.bounds[0]&&mid<other.bounds[1]))continue;
      if(structures.some(s=>laterMeshInside(s,mx,mid)))continue;
      if(Math.abs(zone.height-h.centre[1])<.12/sy&&laterMeshInside(hatch,mx,mid))continue;
      if(c&&mid>c.bounds[0]&&mid<c.bounds[1]&&Math.abs(mx)<c.halfWidth)continue;
      if(flights.some(f=>mid>f.z0&&mid<f.z1&&Math.abs(mx-f.x)<f.width/2&&zone.height+hullLoftSheer(p,mid)>f.y0+(f.y1-f.y0)*(mid-f.z0)/(f.z1-f.z0)+.025/sy))continue;
      const width=Z=>laterSailHullWidth(id,Z,zone.height+hullLoftSheer(p,Z));
      let polygon=[[x,0,z],[x,0,Z],[X,0,Z],[X,0,z]];
      polygon=laterMeshClip(laterMeshClip(polygon,q=>q[0]+width(q[2])),q=>width(q[2])-q[0]);
      polygon=polygon.map(q=>[Math.max(-width(q[2]),Math.min(width(q[2]),q[0])),zone.height+hullLoftSheer(p,q[2]),q[2]]);
      for(let n=1;n<polygon.length-1;n++){const q=[polygon[0],polygon[n],polygon[n+1]];tri(...q,0,q.map(v=>deckNormal(v[2])),q.map(v=>[v[0]*sx*3,v[2]*sz*.7]));}
    }
    group('deck.'+zone.id+'.planks','deck.'+zone.id,start);
  }
  // Raised weather-deck fronts have real openings at the same stair corridors
  // crew routing consumes; no vertical wall is silently traversed.
  for(const zone of d.deckZones.filter(z=>z.id!=='main')){
    const start=out.length,join=zone.bounds[0]<=begin?zone.bounds[1]:zone.bounds[0],corridors=flights.filter(f=>f.zoneId===zone.id),width=laterSailHullWidth(id,join,zone.height+hullLoftSheer(p,join));
    const split=[-width,...corridors.flatMap(f=>[f.x-f.width/2,f.x+f.width/2]),width].sort((a,b)=>a-b);
    for(let i=0;i<split.length-1;i++){
      const x=split[i],X=split[i+1],mx=(x+X)/2;if(Math.abs(mx)>width||corridors.some(f=>Math.abs(mx-f.x)<f.width/2))continue;
      const y=p.deck+hullLoftSheer(p,join),Y=zone.height+hullLoftSheer(p,join);quad([x,y,join],[X,y,join],[X,Y,join],[x,Y,join],23);
    }
    group('deck.bulkhead.'+zone.id,'hull',start);
  }
  if(c){
    const start=out.length,zsCockpit=zs.filter(z=>z>=c.bounds[0]&&z<=c.bounds[1]);
    for(let i=0;i<zsCockpit.length-1;i++){
      const z=zsCockpit[i],Z=zsCockpit[i+1],y=c.floorHeight+hullLoftSheer(p,z),Y=c.floorHeight+hullLoftSheer(p,Z);
      quad([-c.halfWidth,y,z],[-c.halfWidth,Y,Z],[c.halfWidth,Y,Z],[c.halfWidth,y,z],0);
      for(const side of [-1,1])quad([side*c.halfWidth,y,z],[side*c.halfWidth,Y,Z],[side*c.halfWidth,c.coamingHeight+hullLoftSheer(p,Z),Z],[side*c.halfWidth,c.coamingHeight+hullLoftSheer(p,z),z],1);
    }
    for(const z of c.bounds){
      const flight=flights.find(f=>f.zoneId==='cockpit'&&z>=f.z0&&z<=f.z1),gap=flight?flight.width/2:0,ys=hullLoftSheer(p,z);
      for(const [x,X]of gap?[[-c.halfWidth,-gap],[gap,c.halfWidth]]:[[-c.halfWidth,c.halfWidth]])quad([x,c.floorHeight+ys,z],[X,c.floorHeight+ys,z],[X,p.deck+ys,z],[x,p.deck+ys,z],1);
    }
    // Separate side benches leave the central standing/helm well open.
    for(const side of [-1,1])box([side<0?-c.halfWidth:.37,c.floorHeight+.28/sy,c.bounds[0]+.25/sz],[side<0?-.37:c.halfWidth,c.floorHeight+.36/sy,c.bounds[1]-.18/sz],0);
    group('deck.cockpit','deck.cockpit',start);
  }
  for(const f of flights){
    const start=out.length,steps=Math.max(3,Math.ceil(Math.abs(f.y1-f.y0)*sy/.18));
    for(let j=0;j<steps;j++){
      const a=j/steps,b=(j+1)/steps,z=f.z0+(f.z1-f.z0)*a,Z=f.z0+(f.z1-f.z0)*b,y=f.y0+(f.y1-f.y0)*(f.y1>f.y0?b:a);
      box([f.x-f.width/2,y-.10/sy,z],[f.x+f.width/2,y,Z],0);
    }
    for(const side of [-1,1]){
      const x=f.x+side*(f.width/2+.035/sx);
      tube([x,f.y0+.80/sy,f.z0],[x,f.y1+.80/sy,f.z1],.024/sx,cloud?25:3,.024/sx,6);
      for(const t of [0,1]){const z=f.z0+(f.z1-f.z0)*t,y=f.y0+(f.y1-f.y0)*t;tube([x,y,z],[x,y+.80/sy,z],.020/sx,cloud?25:3,.020/sx,6);}
    }
    group('deck.stairs.'+f.id,'hull',start);
  }
  for(const s of structures){
    const start=out.length,low=s.centre[1]-s.size[1]/2,top=s.centre[1]+s.size[1]/2;
    const floor=z=>laterSailDeck(id,z,s.x0);
    for(const side of [-1,1]){
      const x=side<0?s.x0:s.x1;
      for(let j=0;j<4;j++){
        const zA=s.z0+(s.z1-s.z0)*(j/4),zB=s.z0+(s.z1-s.z0)*((j+1)/4);
        quad([x,floor(zA),zA],[x,floor(zB),zB],[x,top,zB],[x,top,zA],23);
        const z=s.z0+(s.z1-s.z0)*(j+.5)/4,w=Math.min(.18/sz,(s.z1-s.z0)/12),y=low+(top-low)*.58,Y=y+.17/sy;
        quad([x+side*.003,y,z-w],[x+side*.003,y,z+w],[x+side*.003,Y,z+w],[x+side*.003,Y,z-w],11);
      }
    }
    for(const z of [s.z0,s.z1]){
      for(let k=0;k<4;k++){
        const xA=s.x0+(s.x1-s.x0)*(k/4),xB=s.x0+(s.x1-s.x0)*((k+1)/4);
        quad([xA,floor(z),z],[xB,floor(z),z],[xB,top,z],[xA,top,z],23);
      }
    }
    const roofZ=[...new Set([s.z0,s.z0+(s.z1-s.z0)*.25,s.z0+(s.z1-s.z0)*.5,s.z0+(s.z1-s.z0)*.75,...[hatch.z0,hatch.z1].filter(z=>z>s.z0&&z<s.z1),s.z1])].sort((a,b)=>a-b);
    const roofX=[...new Set([s.x0,s.x0+(s.x1-s.x0)*.25,0,s.x0+(s.x1-s.x0)*.75,...[hatch.x0,hatch.x1].filter(x=>x>s.x0&&x<s.x1),s.x1])].sort((a,b)=>a-b);
    for(let i=0;i<roofZ.length-1;i++)for(let j=0;j<roofX.length-1;j++){
      const z=roofZ[i],Z=roofZ[i+1],x=roofX[j],X=roofX[j+1];if(laterMeshInside(hatch,(x+X)/2,(z+Z)/2)&&Math.abs(top-h.centre[1])<.15/sy)continue;
      quad([x,top,z],[x,top,Z],[X,top,Z],[X,top,z],cloud?0:23);
    }
    group('structure.'+s.id,'hull',start);
  }
  // Bulwark inner returns / yacht open lifelines. Hull skin and rail share
  // section samples; no detached boards fill a silhouette gap.
  for(const side of [-1,1]){
    const start=out.length;
    for(let i=0;i<zs.length-1;i++){
      const z=zs[i],Z=zs[i+1],base=deckBase((z+Z)/2),a=point(z,base,side),b=point(Z,base,side),A=point(z,base+(cloud?d.barrier:0),side),B=point(Z,base+(cloud?d.barrier:0),side);
      if(cloud){
        const inset=q=>laterMeshAdd(q,[-side*.045/sx,0,0]);quad(inset(a),inset(A),inset(B),inset(b),23);quad(A,B,inset(B),inset(A),1);tube(A,B,.05/sx,1,.05/sx,6,undefined,true);
      }else{
        for(const height of [d.barrier*.52,d.barrier])tube(laterMeshAdd(a,[0,height,0]),laterMeshAdd(b,[0,height,0]),.0035/sx,3,.0035/sx,4,undefined,true);
        if(i%7===0)tube(a,laterMeshAdd(a,[0,d.barrier,0]),.018/sx,3,.018/sx,6);
      }
    }
    group('rail.'+(side<0?'port':'starboard'),'hull',start);
  }
  const rudderStart=out.length,r=d.steering.rudder,stock=d.steering.pivot;
  // Actual model-owned blade outline, thickness and stock; it is not a
  // re-scaled caravel rectangle or Victory's first-rate rudder.
  for(const side of [-1,1])for(let i=1;i<r.outline.length-1;i++)tri([side*r.thickness/2,...r.outline[0]],[side*r.thickness/2,...r.outline[i]],[side*r.thickness/2,...r.outline[i+1]],14);
  for(let i=0;i<r.outline.length;i++){const a=r.outline[i],b=r.outline[(i+1)%r.outline.length];quad([-r.thickness/2,...a],[r.thickness/2,...a],[r.thickness/2,...b],[-r.thickness/2,...b],14);}
  tube(stock,[stock[0],d.steering.handle[1],stock[2]],.035/sx,14,.035/sx,8);
  group('helm.rudder','helm.rudder',rudderStart,{type:'rudder'});
  if(d.steering.wheel){
    const start=out.length,w=d.steering.wheel,material=tag(8,1);
    ring(w.centre,w.radius,.035/sx,material,'z',32);
    for(let i=0;i<8;i++){const a=i*Math.PI/4;tube(w.centre,laterMeshAdd(w.centre,[Math.cos(a)*w.radius*1.14,Math.sin(a)*w.radius*1.14,0]),.025/sx,material,.025/sx,6);}
    tube(laterMeshAdd(w.centre,[0,0,-.08]),laterMeshAdd(w.centre,[0,0,.08]),.065/sx,material,.065/sx,8);
    group('helm.wheel','helm.tiller',start,{type:'wheel'});
    const pedestalStart=out.length,base=laterSailDeck(id,w.centre[2]);box([-.10,base,w.centre[2]-.10],[.10,w.centre[1]-.12/sy,w.centre[2]+.10],1);
    group('helm.pedestal','hull',pedestalStart);
  }else{
    const start=out.length,handle=d.steering.handle;tube([stock[0],handle[1],stock[2]],handle,.035/sx,7,.022/sx,8);
    group('helm.tiller','helm.tiller',start,{type:'tiller'});
  }
  if(d.bowsprit){
    const start=out.length; tube(d.bowsprit.a,d.bowsprit.b,d.bowsprit.radius,1,d.bowsprit.radius*.30,12);
    for(const side of [-1,1])rope(d.bowsprit.b,[side*laterSailDeckWidth(id,-5),laterSailDeck(id,-5),-5],.020/sx,2);
    group('bow.bowsprit','hull',start);
  }
  if(d.equipment.anchors)for(const side of [-1,1]){
    const start=out.length,a=context.anchorCathead(side);tube(a.root,a.tip,(cloud?.20:.025)/sx,cloud?1:3,(cloud?.16:.025)/sx,8);
    group('anchor.'+(side<0?'port':'starboard'),'anchor.'+(side<0?'port':'starboard')+'.root',start);
  }
  const coamingStart=out.length;
  for(const x of [hatch.x0,hatch.x1])box([x-.035/sx,h.centre[1]-.06/sy,hatch.z0-.025/sz],[x+.035/sx,h.centre[1]+.02/sy,hatch.z1+.025/sz],1);
  for(const z of [hatch.z0,hatch.z1])box([hatch.x0,h.centre[1]-.06/sy,z-.025/sz],[hatch.x1,h.centre[1]+.02/sy,z+.025/sz],1);
  group('hatch.coaming','hull',coamingStart);
  const hatchStart=out.length;box([hatch.x0,h.centre[1],hatch.z0],[hatch.x1,h.centre[1]+h.size[1],hatch.z1],18);
  group('hatch.main','hatch.main',hatchStart,{type:'hatch',pivot:[h.centre[0],h.centre[1],hatch.z0]});
  for(const [index,m]of context.masts.entries()){
    const start=out.length;tube(m.foot,m.head,m.radius,cloud?1:3,m.tipRadius,16);
    if(cloud){
      const platform=context.mastPoint(index,m.foot[1]+(m.height-m.foot[1])*.47),radius=.34;
      for(let j=0;j<16;j++){const a=j*Math.PI/8,b=(j+1)*Math.PI/8,A=laterMeshAdd(platform,[radius*Math.cos(a),0,radius*Math.sin(a)]),B=laterMeshAdd(platform,[radius*Math.cos(b),0,radius*Math.sin(b)]);tri(platform,A,B,1);tube(A,B,.025/sx,1,.025/sx,6);}
    }
    group('mast.'+m.id,'mast.'+m.id,start);
  }
  for(const s of context.surfaces){
    const start=out.length,n=s.kind==='square'?20:22,material=tag(s.corners.length===3?13:9,s.id),normal=laterMeshUnit(laterMeshCross(laterMeshSub(s.corners[1],s.corners[0]),laterMeshSub(s.corners.at(-1),s.corners[0])));
    const emit=uv=>{const points=uv.map(q=>surfaceRestPoint(s,...q));if(uv.length===3)tri(...points,material,points.map(()=>normal),uv);else quad(...points,material,points.map(()=>normal),uv);};
    if(s.corners.length===3)for(let i=0;i<n;i++)for(let j=0;j<n-i;j++){
      emit([[i/n,j/n],[(i+1)/n,j/n],[i/n,(j+1)/n]]);if(j<n-i-1)emit([[(i+1)/n,j/n],[(i+1)/n,(j+1)/n],[i/n,(j+1)/n]]);
    }else for(let i=0;i<n;i++)for(let j=0;j<n;j++)emit([[i/n,j/n],[(i+1)/n,j/n],[(i+1)/n,(j+1)/n],[i/n,(j+1)/n]]);
    group('sail.'+s.name,'sail.'+s.name,start,{type:'surface-cloth',surface:s.id});
    for(const spar of s.spars??[]){
      const begin=out.length;tube(spar.a,spar.b,spar.radius,tag(10,s.id),spar.radius*.70,12);
      group('spar.'+spar.id,'spar.'+spar.id,begin,{type:'surface-yard',surface:s.id});
      if(spar.kind==='yard')group('yard.'+s.name,'yard.'+s.name,begin,{type:'surface-yard',surface:s.id});
    }
  }
  const standingStart=out.length;for(const line of context.lines.filter(line=>line.static))rope(line.a,line.b,line.r??.008,2);
  group('rig.standing','hull',standingStart);
  for(const surface of d.surfaces)if(surface.stay)for(const fitting of [surface.stay.lowerFitting,surface.stay.upperFitting]){
    const start=out.length;tube(fitting.body,fitting.position,surface.stay.r*1.25,3,surface.stay.r*1.25,6);
    group('fitting.'+fitting.id,'stay.'+surface.name+'.'+(fitting===surface.stay.lowerFitting?'lower':'upper'),start);
  }
  const rest={...withRigPoseContext(context,{}),time:0,wind:0},runningStart=out.length;
  for(const [index,line]of context.lines.entries())if(!line.static){
    const segments=line.kind==='bolt-rope'?22:line.kind==='sheet'?10:6;
    for(let j=0;j<segments;j++){
      const t=j/segments,T=(j+1)/segments;tube(surfaceRopePoint(line,t,rest),surfaceRopePoint(line,T,rest),line.r??.007,12,line.r??.007,4,[[100+index,t],[100+index,T]],true);
    }
  }
  group('rig.running','hull',runningStart,{type:'surface-running-rigging'});
  return new Float32Array(out);
}

export function createLaterSailAssetPose(asset){
  const id=asset.model?.id??asset.modelId;
  return createAdditionalAssetPose(asset,{design:laterSailDesign(id),context:laterSailRigContext(id),steeringPose:laterSailSteeringPose});
}
