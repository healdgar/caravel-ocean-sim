// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { VICTORY_DESIGN as D, VICTORY_MASTS as MASTS, VICTORY_SAILS as SAILS,VICTORY_STANDING_LINES,VICTORY_RUNNING_LINES,victoryShroud,
  victorySheer, victoryHullDeck, victoryVesselDeck, victoryHullHalfWidth,
  victoryDeckHalfWidth, victoryMastPoint, victoryAnchorCathead, victorySailPoint,victoryHatchPivot } from './models/victory.js';

// A separate first-rate hull, decks, batteries and full rig. The nine-float
// vertex contract is shared with the caravel; its authored geometry is not.
export function createVictoryMesh({groups,parts}={}){
  const out=[];
  const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]),mul=(a,s)=>a.map(x=>x*s);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit=a=>mul(a,1/Math.max(1e-15,Math.hypot(...a)));
  const tag=(base,id)=>base+id/64;
  function group(id,node,start,motion){
    if(out.length<=start)return;
    groups?.push({id,nodeId:node,firstVertex:start/9,vertexCount:(out.length-start)/9,...(motion?{motion}:{})});
    parts?.set(id,new Float32Array(out.slice(start)));
  }
  function tri(a,b,c,m=1,ns,uv){
    const axis=cross(sub(b,a),sub(c,a));if(Math.hypot(...axis)<1e-11)return;
    const n=unit(axis);
    if(ns&&n.reduce((s,x,i)=>s+x*ns[0][i],0)<0){[b,c]=[c,b];ns=[ns[0],ns[2],ns[1]];if(uv)uv=[uv[0],uv[2],uv[1]];}
    for(const [i,p]of [a,b,c].entries()){
      const t=uv?.[i]??(Math.abs(n[1])>.65?[p[0]*5,p[2]*2]:[p[1]*5,p[2]*2]);
      out.push(...p,...(ns?.[i]??n),m,...t);
    }
  }
  function quad(a,b,c,d,m=1,ns,uv){
    tri(a,b,c,m,ns&&[ns[0],ns[1],ns[2]],uv&&[uv[0],uv[1],uv[2]]);
    tri(a,c,d,m,ns&&[ns[0],ns[2],ns[3]],uv&&[uv[0],uv[2],uv[3]]);
  }
  function box(a,b,m=1){
    const p=(x,y,z)=>[x?b[0]:a[0],y?b[1]:a[1],z?b[2]:a[2]];
    for(const f of [[[0,0,0],[0,1,0],[1,1,0],[1,0,0]],[[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
      [[0,0,0],[0,0,1],[0,1,1],[0,1,0]],[[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
      [[0,0,0],[1,0,0],[1,0,1],[0,0,1]],[[0,1,0],[0,1,1],[1,1,1],[1,1,0]]])quad(...f.map(q=>p(...q)),m);
  }
  function tube(a,b,r,m=2,r2=r,sides=8,uvEnds,open=false){
    const axis=unit(sub(b,a)),u=unit(cross(axis,Math.abs(axis[1])<.9?[0,1,0]:[1,0,0])),v=cross(axis,u);
    const n=i=>add(mul(u,Math.cos(i*2*Math.PI/sides)),mul(v,Math.sin(i*2*Math.PI/sides)));
    const pa=(i,end)=>add(end?b:a,mul(n(i),end?r2:r));
    for(let i=0;i<sides;i++){
      const j=i+1,na=n(i),nb=n(j),uv=uvEnds?[uvEnds[0],uvEnds[1],uvEnds[1],uvEnds[0]]:undefined;
      quad(pa(i,0),pa(i,1),pa(j,1),pa(j,0),m,[na,na,nb,nb],uv);
      if(!open)tri(a,pa(j,0),pa(i,0),m,null,uvEnds?[uvEnds[0],uvEnds[0],uvEnds[0]]:undefined);
      if(!open)tri(b,pa(i,1),pa(j,1),m,null,uvEnds?[uvEnds[1],uvEnds[1],uvEnds[1]]:undefined);
    }
  }
  function rope(a,b,r=.007,m=2,segments=1,sag=0){
    for(let i=0;i<segments;i++){
      const point=t=>{const p=a.map((x,j)=>x+(b[j]-x)*t);p[1]-=Math.sin(t*Math.PI)*sag;return p;};
      tube(point(i/segments),point((i+1)/segments),r,m,r,4,undefined,true);
    }
  }
  function ring(c,r,t,m=1,axis='y',segments=28){
    const p=a=>axis==='z'?[c[0]+Math.cos(a)*r,c[1]+Math.sin(a)*r,c[2]]:[c[0]+Math.cos(a)*r,c[1],c[2]+Math.sin(a)*r];
    for(let i=0;i<segments;i++)tube(p(i*2*Math.PI/segments),p((i+1)*2*Math.PI/segments),t,m,t,4,undefined,true);
  }
  const zValues=new Set([...Array.from({length:49},(_,i)=>-6+i/4),...D.hull.stations]);
  for(const z of [D.decks.forecastle.end,D.decks.quarter.start,D.decks.poop.start])zValues.add(z);
  const portW=.235,portH=.21,batteries=D.gunDecks.filter(g=>['lower','middle','upper'].includes(g.id));
  const ports=batteries.flatMap(g=>Array.from({length:g.count/2},(_,i)=>({deck:g.id,y:g.centre,z:g.start+(g.end-g.start)*i/(g.count/2-1),calibre:g.calibre})));
  const upperPorts=D.gunDecks.filter(g=>!batteries.includes(g)).flatMap(g=>Array.from({length:g.count/2},(_,i)=>({y:g.centre,z:g.start+(g.end-g.start)*i/(g.count/2-1)})));
  for(const p of ports){zValues.add(p.z-portW/2);zValues.add(p.z+portW/2);}
  for(const p of upperPorts){zValues.add(p.z-portW/2);zValues.add(p.z+portW/2);}
  const zs=[...zValues].sort((a,b)=>a-b),ys=[-D.hull.draft,-1.7,-1.5,-1.25,-1,-.75,-.5,-.25,0,.15,.2,.58,.65,.7,1.08,1.15,1.2,1.58];
  for(const p of ports){ys.push(p.y-portH/2,p.y+portH/2);}
  const levels=[...new Set(ys)].sort((a,b)=>a-b);
  function hullPoint(station,y,side){
    const depth=Math.max(0,-y/D.hull.draft),z=station*(1-(station<0?D.hull.bowRake:D.hull.sternRake)/6*depth*depth),h=y+victorySheer(z);
    return [side*victoryHullHalfWidth(z,h),h,z];
  }
  function hullNormal(p,side){
    const e=.0001,wY=(victoryHullHalfWidth(p[2],p[1]+e)-victoryHullHalfWidth(p[2],p[1]-e))/(2*e),wZ=(victoryHullHalfWidth(p[2]+e,p[1])-victoryHullHalfWidth(p[2]-e,p[1]))/(2*e);
    return unit([side,-wY,-wZ]);
  }
  const hullStart=out.length;
  for(const side of [-1,1])for(let j=0;j<levels.length-1;j++)for(let i=0;i<zs.length-1;i++){
    const a=levels[j],b=levels[j+1],z=zs[i],Z=zs[i+1],cy=(a+b)/2,cz=(z+Z)/2;
    if(ports.some(p=>Math.abs(cz-p.z)<portW/2-1e-7&&Math.abs(cy-p.y)<portH/2-1e-7))continue;
    const material=cy<-.13?22:((cy>=.2&&cy<=.58)||(cy>=.7&&cy<=1.08)||(cy>=1.2&&cy<=1.58))?21:20;
    const points=[[z,a],[Z,a],[Z,b],[z,b]].map(([s,y])=>hullPoint(s,y,side));
    quad(...points,material,points.map(p=>hullNormal(p,side)),[[a*5,z*2],[a*5,Z*2],[b*5,Z*2],[b*5,z*2]]);
  }
  group('hull.planking','hull',hullStart);
  // Copper plates have sparse dark seams and a restrained nail rhythm.
  const copperStart=out.length;
  for(const side of [-1,1])for(let y=-1.6;y<-.15;y+=.17)for(let z=-5.4;z<5.7;z+=.48){
    const a=hullPoint(z,y,side),b=hullPoint(Math.min(5.8,z+.47),y,side);
    if(Math.abs(a[0])>.08&&Math.abs(b[0])>.08){a[0]+=side*.0015;b[0]+=side*.0015;rope(a,b,.0018,20);}
  }
  group('hull.copper.seams','hull',copperStart);
  // Proud wales track exactly the same surface as the hull on both sides.
  for(const side of [-1,1]){
    const start=out.length;
    for(const h of [.035,.635,1.135])for(let i=0;i<zs.length-1;i++){
      const a=hullPoint(zs[i],h-.035,side),b=hullPoint(zs[i+1],h-.035,side),c=hullPoint(zs[i+1],h+.035,side),d=hullPoint(zs[i],h+.035,side);
      for(const p of [a,b,c,d])p[0]+=side*.023;
      quad(a,b,c,d,20,[hullNormal(a,side),hullNormal(b,side),hullNormal(c,side),hullNormal(d,side)]);
    }
    group(`hull.wales.${side<0?'port':'starboard'}`,'hull',start);
  }
  // Three complete batteries: open cuts, red inner reveals, raised black lids,
  // and individual barrels. The far end is dark recess, not a solid yellow wall.
  for(const side of [-1,1])for(const [index,p]of ports.entries()){
    const start=out.length,y=p.y+victorySheer(p.z),x=side*victoryHullHalfWidth(p.z,y),a=p.z-portW/2,b=p.z+portW/2,lo=y-portH/2,hi=y+portH/2;
    const outer=(z,Y)=>side*victoryHullHalfWidth(z,Y),inset=x-side*.14;
    quad([inset,lo,a],[inset,hi,a],[inset,hi,b],[inset,lo,b],4);
    for(const z of [a,b])quad([outer(z,lo),lo,z],[outer(z,hi),hi,z],[inset,hi,z],[inset,lo,z],24);
    for(const Y of [lo,hi])quad([outer(a,Y),Y,a],[inset,Y,a],[inset,Y,b],[outer(b,Y),Y,b],24);
    tube([inset-side*.10,y,p.z],[x+side*.19,y,p.z],p.calibre===32?.040:p.calibre===24?.035:.030,3,.026,8);
    tube([x+side*.192,y,p.z],[x+side*.195,y,p.z],.021,4,.021,8);
    quad([x,hi+.015,a],[x+side*.17,hi+.10,a],[x+side*.17,hi+.10,b],[x,hi+.015,b],20);
    for(const z of [p.z-.068,p.z+.068])rope([x+side*.12,hi+.075,z],[x+side*.08,hi+.22,z],.004,3);
    group(`gun.${p.deck}.${side<0?'port':'starboard'}.${index}`,'hull',start);
  }
  function deck(start,end,height,node){
    const begin=out.length,N=Math.ceil((end-start)/.26);
    for(let i=0;i<N;i++){
      const z=start+(end-start)*i/N,Z=start+(end-start)*(i+1)/N,y=height+victorySheer(z),Y=height+victorySheer(Z),w=victoryHullHalfWidth(z,y)-.035,W=victoryHullHalfWidth(Z,Y)-.035;
      for(let x=-1.8;x<1.8;x+=.054){
        const l=Math.max(x,-w,-W),r=Math.min(x+.052,w,W);if(r<=l)continue;
        const offset=Math.sin(Math.round(x/.054)*13.4)*.4;
        quad([l,y,z],[l,Y,Z],[r,Y,Z],[r,y,z],0,null,[[l*5+offset,z*2],[l*5+offset,Z*2],[r*5+offset,Z*2],[r*5+offset,z*2]]);
      }
    }
    group(node+'.planks',node,begin);
  }
  deck(-6,6,D.decks.main,'deck.main');deck(-5.9,D.decks.forecastle.end,D.decks.forecastle.height,'deck.forecastle');
  deck(D.decks.quarter.start,6,D.decks.quarter.height,'deck.quarter');deck(D.decks.poop.start,6,D.decks.poop.height,'deck.poop');
  // The waist has an open view down onto the upper deck; raised ends are
  // enclosed by joined bulkheads, not isolated floating deck plates.
  for(const [z,top,bottom]of [[D.decks.forecastle.end,D.decks.forecastle.height,D.decks.main],[D.decks.quarter.start,D.decks.quarter.height,D.decks.main],[D.decks.poop.start,D.decks.poop.height,D.decks.quarter.height]]){
    const start=out.length,w=victoryHullHalfWidth(z,top+victorySheer(z))-.04;
    box([-w,bottom+victorySheer(z),z-.015],[w,top+victorySheer(z),z+.015],23);
    group('deck.bulkhead.'+z,'hull',start);
  }
  // Upper bulwarks, continuous black rail, and proper openings for the smaller
  // quarterdeck/forecastle battery, which completes the 104-gun total.
  for(const side of [-1,1]){
    const start=out.length;
    for(let i=0;i<zs.length-1;i++){
      const z=zs[i],Z=zs[i+1],centre=(z+Z)/2;
      const base=victoryVesselDeck(centre)-victorySheer(centre),waist=centre>D.decks.forecastle.end&&centre<D.decks.quarter.start,h=waist?1.58-base:centre>=D.decks.poop.start?.19:.285;
      const y=base+victorySheer(z),Y=base+victorySheer(Z),w=side*victoryHullHalfWidth(z,y),W=side*victoryHullHalfWidth(Z,Y);
      const rail=side*victoryHullHalfWidth(z,y+h),Rail=side*victoryHullHalfWidth(Z,Y+h),gunPort=upperPorts.find(p=>Math.abs(centre-p.z)<portW/2-1e-7);
      if(!waist){
        const height=gunPort?Math.max(.03,gunPort.y-base-portH/2):h;
        quad([w,y,z],[W,Y,Z],[side*victoryHullHalfWidth(Z,Y+height),Y+height,Z],[side*victoryHullHalfWidth(z,y+height),y+height,z],20);
      }
      tube([rail,y+h,z],[Rail,Y+h,Z],.025,20,.025,4,undefined,true);
      if(i%3===0)tube([w-side*.018,y,z],[w-side*.018,y+h,z],.013,21,.013,6);
    }
    group(`bulwark.${side}`,'hull',start);
  }
  for(const g of D.gunDecks.filter(g=>!batteries.includes(g)))for(const side of [-1,1])for(let i=0;i<g.count/2;i++){
    const start=out.length,z=g.start+(g.end-g.start)*i/(g.count/2-1),floor=victoryVesselDeck(z),y=g.centre+victorySheer(z),x=side*(victoryHullHalfWidth(z,y)-.07),carronade=g.id==='forecastle'&&i===0;
    box([x-side*.14,floor+.015,z-.09],[x+side*.04,floor+.09,z+.09],24);
    tube([x-side*.15,y,z],[x+side*(carronade?.21:.3),y,z],carronade?.055:.032,3,carronade?.045:.025,12);
    for(const z1 of [z-.08,z+.08])tube([x-side*.12,floor+.035,z1],[x+side*.045,floor+.035,z1],.039,1,.039,8);
    group(`gun.${g.id}.${side<0?'port':'starboard'}.${i}`,'hull',start);
  }
  // Closing stern skin and the distinctive enclosed galleries of the 1803 refit.
  const sternStart=out.length;
  for(let y=-1.4;y<2.63;y+=.11){
    const Y=Math.min(2.63,y+.11),z=6+Math.max(0,y)*.07,w=victoryHullHalfWidth(6,Math.min(y,2.63))+.04,W=victoryHullHalfWidth(6,Math.min(Y,2.63))+.04;
    quad([-w,y,z],[w,y,z],[W,Y,z+.008],[-W,Y,z+.008],y<-.1?22:20);
  }
  for(const [level,y]of [1.03,1.55,2.05].entries()){
    const w=1.12-level*.035,z=6.17+y*.07;
    box([-w-.11,y-.19,z-.03],[w+.11,y+.23,z+.07],21);
    box([-w-.08,y-.15,z+.071],[w+.08,y+.19,z+.081],20);
    for(let col=0;col<9;col++){
      const x=-w+col*(2*w/9),r=x+2*w/9-.035;
      quad([x,y-.115,z+.085],[r,y-.115,z+.085],[r,y+.15,z+.085],[x,y+.15,z+.085],11);
      tube([x,y-.14,z+.09],[x,y+.18,z+.09],.010,25,.010,5);
      tube([x,y+.015,z+.095],[r,y+.015,z+.095],.007,25,.007,5);
    }
    for(const Y of [y-.20,y+.22])tube([-w-.15,Y,z+.11],[w+.15,Y,z+.11],.025,25,.025,6);
    for(const side of [-1,1]){
      const x=side*(w+.13);
      box([x-side*.12,y-.18,5.28],[x+side*.05,y+.20,z+.04],21);
      for(let k=0;k<4;k++){
        const a=5.32+k*.19,b=a+.145;
        quad([x+side*.055,y-.12,a],[x+side*.055,y+.14,a],[x+side*.055,y+.14,b],[x+side*.055,y-.12,b],11);
        tube([x+side*.06,y-.15,a],[x+side*.06,y+.17,a],.009,25,.009,5);
      }
      tube([x+side*.08,y+.22,5.2],[x+side*.08,y+.22,z+.11],.022,25,.022,6);
    }
  }
  // Gilded crest and simple carved scroll rhythm are authored ornaments.
  ring([0,2.57,6.37],.13,.028,25,'z',20);
  for(const side of [-1,1])for(let i=0;i<5;i++){
    const x=side*(.3+i*.19),y=2.51-.08*(i/4)**2;
    tube([x-.055,y,6.35],[x+.055,y+.04,6.35],.021,25,.013,6);
  }
  group('stern.galleries','hull',sternStart);
  // Rudder and stem are substantial joined structures.
  const rudderStart=out.length;
  box([-.045,-1.68,5.84],[.045,.81,6.04],14);
  quad([-.045,-1.68,6.04],[-.045,-1.54,6.51],[-.045,.15,6.41],[-.045,.81,6.04],14);
  quad([.045,-1.68,6.04],[.045,.81,6.04],[.045,.15,6.41],[.045,-1.54,6.51],14);
  for(const y of [-1.3,-.65,0,.55])tube([-.06,y,5.86],[.06,y,5.86],.027,3,.027,8);
  group('helm.rudder','helm.rudder',rudderStart,{type:'rudder'});
  const bowStart=out.length;
  for(const side of [-1,1]){
    const cat=victoryAnchorCathead(side);tube(cat.root,cat.tip,.055,21,.047,8);
    tube([side*.11,1.72,-5.9],[side*.12,2.11,-7.07],.045,21,.025,8);
    for(let i=0;i<4;i++){
      const y=1.48+i*.13;
      rope([side*.12,y,-6.85],[side*victoryDeckHalfWidth(-5.55),y+.19,-5.55],.024,21,8,.045);
    }
  }
  // Bowsprit, jibboom and flying jibboom are stepped spars, not an oversize mast.
  tube([0,2.1,-4.8],[0,3.06,-8.25],.14,1,.075,16);
  tube([0,2.92,-7.75],[0,3.28,-10.56],.062,1,.022,12);
  tube([0,2.88,-8.0],[0,1.78,-8.0],.035,20,.025,8);
  for(const side of [-1,1])for(const end of [-8.2,-10.5])rope([side*.75,.88,-5.55],[0,end===-8.2?3.04:3.27,end],.011,20,6,.015);
  tube([0,2.05,-6.65],[0,2.57,-7.03],.09,25,.055,10);
  ring([0,2.48,-7.06],.14,.025,25,'z',20);
  group('bow.structure','hull',bowStart);
  // Two wheels on a common spindle, binnacle, companionways, capstan and bitts.
  const wheelStart=out.length,wc=D.wheel.centre;
  for(const z of [wc[2]-.055,wc[2]+.055]){
    ring([wc[0],wc[1],z],D.wheel.radius,.014,7,'z',36);
    for(let i=0;i<10;i++){
      const a=i*2*Math.PI/10;
      tube([0,wc[1],z],[Math.cos(a)*.225,wc[1]+Math.sin(a)*.225,z],.009,7,.012,6);
    }
  }
  tube([0,wc[1],wc[2]-.16],[0,wc[1],wc[2]+.16],.034,3,.034,10);
  for(const z of [wc[2]-.11,wc[2]+.11])box([-.045,victoryVesselDeck(z),z-.025],[.045,wc[1]-.03,z+.025],1);
  group('helm.wheel','helm.wheel',wheelStart,{type:'wheel'});
  const fittingsStart=out.length;
  const binnacle=victoryVesselDeck(3.05);
  box([-.19,binnacle,2.89],[.19,binnacle+.28,3.16],1);box([-.205,binnacle+.27,2.88],[.205,binnacle+.305,3.17],25);
  for(const z of [-4.52,-1.5,.65,2.35,4.75]){
    const y=victoryVesselDeck(z),w=z===2.35?.29:.34;
    box([-w,y+.008,z-.35],[w,y+.12,z+.35],1);
    for(let x=-w+.04;x<w-.02;x+=.07)for(let Z=z-.3;Z<z+.31;Z+=.09)
      quad([x,y+.122,Z],[x,y+.122,Z+.045],[x+.035,y+.122,Z+.045],[x+.035,y+.122,Z],4);
  }
  for(const z of [-4.85,2.68]){
    const y=victoryVesselDeck(z);
    tube([0,y,z],[0,y+.25,z],.12,24,.1,16);ring([0,y+.23,z],.14,.017,1,'y',24);
    for(let i=0;i<8;i++){const a=i*Math.PI/4;tube([0,y+.21,z],[Math.cos(a)*.32,y+.21,z+Math.sin(a)*.32],.015,1,.015,6);}
  }
  for(const z of [-5.1,-3.95,1.8,4.22])for(const side of [-1,1]){
    const y=victoryVesselDeck(z),x=side*.65;
    box([x-.04,y,z-.06],[x+.04,y+.21,z+.06],1);
    tube([x-.13,y+.17,z],[x+.13,y+.17,z],.03,1,.03,8);
  }
  // Two flights connect each raised deck to the lower level.
  for(const [z,top,bottom]of [[D.decks.forecastle.end,D.decks.forecastle.height,D.decks.main],[D.decks.quarter.start,D.decks.quarter.height,D.decks.main],[D.decks.poop.start,D.decks.poop.height,D.decks.quarter.height]])for(const side of [-1,1]){
    const x=side*.9,sign=z<0?1:-1,lo=z+sign*.6;
    for(let i=0;i<7;i++){
      const Z=lo+(z-lo)*(i+.5)/7,y=bottom+(top-bottom)*(i+1)/7+victorySheer(z);
      box([x-.105,y-.025,Z-.047],[x+.105,y,Z+.047],0);
    }
    for(const X of [x-.12,x+.12])tube([X,bottom+victorySheer(z)+.03,lo],[X,top+victorySheer(z)+.03,z],.022,1,.022,6);
  }
  group('deck.fittings','hull',fittingsStart);
  const hatchStart=out.length,hatchPivot=victoryHatchPivot(),hatchY=hatchPivot[1];
  box([-.335,hatchY,-1.85],[.335,hatchY+.025,-1.15],18);
  for(const z of [-1.77,-1.24])box([-.35,hatchY+.025,z-.025],[.35,hatchY+.045,z+.025],18);
  group('hatch.main','hatch.main',hatchStart,{type:'hatch',pivot:hatchPivot});
  // Nested ship's boats on waist skids, with visible ribs and thwarts.
  for(const [boatIndex,x]of [-.43,.43].entries()){
    const start=out.length,y=D.decks.main+.32,z=-1.15,half=.27,L=1.44;
    for(let i=0;i<20;i++)for(let j=0;j<7;j++){
      const point=(t,k)=>{const Z=-L+2*L*t,w=half*Math.sin(Math.PI*t)**.55,theta=k/7*Math.PI;return [x+Math.cos(theta)*w,y-Math.sin(theta)*.19,z+Z];};
      quad(point(i/20,j),point((i+1)/20,j),point((i+1)/20,j+1),point(i/20,j+1),23);
    }
    for(const side of [-1,1])for(let i=0;i<20;i++){
      const p=t=>[x+side*half*Math.sin(Math.PI*t)**.55,y,z-L+2*L*t];tube(p(i/20),p((i+1)/20),.016,1,.016,6);
    }
    for(let Z=z-1;Z<z+1.1;Z+=.38){const w=half*Math.sin(Math.PI*(Z-z+L)/(2*L))**.55;box([x-w+.02,y-.05,Z-.035],[x+w-.02,y-.025,Z+.035],1);}
    for(const Z of [z-.9,z+.9])box([x-.34,D.decks.main+.04,Z-.04],[x+.34,D.decks.main+.16,Z+.04],1);
    group('boat.waist.'+boatIndex,'deck.main',start);
  }
  // Lower masts, overlapping topmasts and topgallants, open fighting tops,
  // trestletrees, crosstrees and rope-rung shrouds.
  for(const [index,m]of MASTS.entries()){
    const start=out.length,foot=victoryMastPoint(index,victoryVesselDeck(m.z));
    tube(foot,victoryMastPoint(index,m.platform+.48),m.radius,21,m.radius*.72,18);
    tube(victoryMastPoint(index,m.platform-.25),victoryMastPoint(index,m.topmastPlatform+.3),m.radius*.58,1,m.radius*.34,14);
    tube(victoryMastPoint(index,m.topmastPlatform-.22),victoryMastPoint(index,m.height),m.radius*.29,1,.015,10);
    for(let y=foot[1]+.25;y<m.platform;y+=.3){const p=victoryMastPoint(index,y);ring(p,m.radius*.97,.009,20,'y',12);}
    for(const [height,r]of [[m.platform,.53],[m.topmastPlatform,.29]]){
      const p=victoryMastPoint(index,height),corners=Array.from({length:8},(_,i)=>{const a=i*Math.PI/4;return [Math.cos(a)*r,height,p[2]+Math.sin(a)*r*.72];});
      for(let i=0;i<8;i++)tri(p,corners[i],corners[(i+1)%8],20);
      for(let i=0;i<8;i++)tube(corners[i],corners[(i+1)%8],.022,20,.022,6);
      for(const x of [-r*.55,r*.55])tube([x,height-.07,p[2]-.3],[x,height-.07,p[2]+.3],.025,1,.025,8);
      if(height===m.platform)for(let i=0;i<5;i++){
        const a=i/4*Math.PI,c=[Math.cos(a)*r,height,p[2]+Math.sin(a)*r*.72];
        tube(c,add(c,[0,.15,0]),.013,20,.013,5);
        if(i<4){const b=(i+1)/4*Math.PI;tube(add(c,[0,.15,0]),[Math.cos(b)*r,height+.15,p[2]+Math.sin(b)*r*.72],.012,20,.012,5);}
      }
    }
    group('mast.'+m.id,'mast.'+m.id,start);
    const rigStart=out.length;
    for(const side of [-1,1]){
      const top=victoryMastPoint(index,m.platform+.25),roots=[];
      for(let k=0;k<7;k++){
        const {root}=victoryShroud(index,side,k),[x,y,z]=root;roots.push(root);
        tube([x,y,z],[x,y+.07,z],.045,20,.045,8);
      }
      for(let rung=1;rung<29;rung++){
        const t=rung/29,a=roots[0].map((x,j)=>x+(top[j]-x)*t),b=roots.at(-1).map((x,j)=>x+(top[j]-x)*t);
        rope(a,b,.0047,2);
      }
      const upper=victoryMastPoint(index,m.topmastPlatform+.18),p=victoryMastPoint(index,m.platform);
      for(let rung=1;rung<18;rung++){
        const t=rung/18,root=p[2]+m.shrouds.upperStart,a=[side*.43*(1-t),p[1]+(upper[1]-p[1])*t,root+(upper[2]-root)*t],b=[...a];b[2]+=3*m.shrouds.upperStep*(1-t);rope(a,b,.004,2);
      }
    }
    for(const line of VICTORY_STANDING_LINES.filter(l=>l.mast===index))rope(line.a,line.b,line.radius,20);
    group('rig.standing.'+m.id,'mast.'+m.id,rigStart);
  }
  const crossjackStart=out.length,crossjack=victoryMastPoint(2,4.87);
  crossjack[2]-=.15;
  const crossjackControl=SAILS.find(s=>s.name==='mizzen-topsail').id;
  tube(add(crossjack,[-1.98,0,0]),crossjack,.026,tag(10,crossjackControl),.05,12);
  tube(crossjack,add(crossjack,[1.98,0,0]),.05,tag(10,crossjackControl),.026,12);
  group('yard.mizzen-crossjack','mast.mizzen',crossjackStart,{type:'victory-yard',sail:crossjackControl});
  for(const s of SAILS){
    const start=out.length,base=s.kind==='headsail'?13:9,steps=s.kind==='headsail'?15:18;
    if(s.kind==='headsail'){
      for(let i=0;i<steps;i++)for(let j=0;j<steps-i;j++){
        const uv=[[i/steps,j/steps],[(i+1)/steps,j/steps],[i/steps,(j+1)/steps]];
        tri(...uv.map(p=>victorySailPoint(s.id,...p)),tag(base,s.id),null,uv);
        if(j<steps-i-1){const q=[[(i+1)/steps,j/steps],[(i+1)/steps,(j+1)/steps],[i/steps,(j+1)/steps]];tri(...q.map(p=>victorySailPoint(s.id,...p)),tag(base,s.id),null,q);}
      }
    }else for(let i=0;i<steps;i++)for(let j=0;j<steps;j++){
      const uv=[[i/steps,j/steps],[(i+1)/steps,j/steps],[(i+1)/steps,(j+1)/steps],[i/steps,(j+1)/steps]];
      quad(...uv.map(p=>victorySailPoint(s.id,...p)),tag(base,s.id),null,uv);
    }
    group('sail.'+s.name,'sail.'+s.name,start,{type:'victory-cloth',sail:s.id});
    const yardStart=out.length;
    if(s.kind==='square'){
      const a=s.corners[0],b=s.corners[1],left=[a[0]-.16,a[1],a[2]],right=[b[0]+.16,b[1],b[2]];
      tube(left,s.pivot,.035,tag(10,s.id),.065,12);tube(s.pivot,right,.065,tag(10,s.id),.035,12);
    }else if(s.kind==='spanker'){
      tube(s.corners[0],add(s.corners[1],[0,.05,.16]),.037,tag(10,s.id),.022,10);
      tube(s.corners[3],add(s.corners[2],[0,-.05,.16]),.041,tag(10,s.id),.026,10);
    }
    group('yard.'+s.name,'yard.'+s.name,yardStart,{type:'victory-yard',sail:s.id});
    const hemStart=out.length,uvCorners=s.kind==='headsail'?[[0,0],[1,0],[0,1]]:[[0,0],[1,0],[1,1],[0,1]];
    for(let edge=0;edge<uvCorners.length;edge++)for(let i=0;i<18;i++){
      const a=uvCorners[edge],b=uvCorners[(edge+1)%uvCorners.length],uv=t=>a.map((x,k)=>x+(b[k]-x)*t),u=uv(i/18),v=uv((i+1)/18);
      tube(victorySailPoint(s.id,...u),victorySailPoint(s.id,...v),.0055,tag(19,s.id),.0055,4,[u,v],true);
    }
    group('sail.'+s.name+'.bolt-rope','sail.'+s.name,hemStart,{type:'victory-cloth',sail:s.id});
  }
  const runningStart=out.length;
  for(const [index,line]of VICTORY_RUNNING_LINES.entries()){
    const segments=2;
    for(let i=0;i<segments;i++){
      const a=line.a.map((x,k)=>x+(line.b[k]-x)*i/segments),b=line.a.map((x,k)=>x+(line.b[k]-x)*(i+1)/segments);
      tube(a,b,.0055,12,.0055,4,[[100+index,i/segments],[100+index,(i+1)/segments]],true);
    }
  }
  group('rig.running','hull',runningStart,{type:'victory-running-rigging'});
  for(const [index,m]of MASTS.entries()){
    const start=out.length,x=index===1?-1.13:1.13,z=m.z+.5,y=victoryVesselDeck(z);
    rope([x,y+.035,z],[x,y+.9,z],.006,2);
    rope([x,y+.9,z],victoryMastPoint(index,m.platform+.25),.006,2);
    tube([x-.025,y+.9,z],[x+.025,y+.9,z],.031,1,.031,8);
    tube([x-.07,y+.075,z],[x+.07,y+.075,z],.018,1,.018,6);
    group('rig.working.'+m.id,'rig.'+m.id+'.fall',start);
  }
  // Stern ensign on an aft staff. A small authored cloth flag keeps the ship's
  // national identity legible without adding another animated sail control.
  const flagStart=out.length;
  tube([0,2.565,5.92],[0,4.12,6.42],.017,1,.008,8);
  quad([0,4.02,6.43],[.63,3.97,6.43],[.63,3.60,6.43],[0,3.65,6.43],23);
  const canton=(u,v,z)=>[.27*u,4.02-.05/ .63*(.27*u)-.185*v,z];
  const flagQuad=(uv,m,z)=>quad(...uv.map(p=>canton(...p,z)),m);
  for(const side of [-1,1]){
    const z=6.43+side*.002;
    quad([.275,4.0,z],[.35,3.995,z],[.35,3.615,z],[.275,3.62,z],24);
    quad([0,3.85,z],[.63,3.80,z],[.63,3.735,z],[0,3.785,z],24);
    flagQuad([[0,0],[1,0],[1,1],[0,1]],26,z+side*.002);
    flagQuad([[0,0],[.14,0],[1,.86],[1,1]],23,z+side*.004);
    flagQuad([[0,1],[0,.86],[.86,0],[1,0]],23,z+side*.004);
    flagQuad([[0,0],[.06,0],[1,.94],[1,1]],24,z+side*.006);
    flagQuad([[0,1],[0,.94],[.94,0],[1,0]],24,z+side*.006);
    flagQuad([[.40,0],[.60,0],[.60,1],[.40,1]],23,z+side*.008);
    flagQuad([[0,.37],[1,.37],[1,.63],[0,.63]],23,z+side*.008);
    flagQuad([[.45,0],[.55,0],[.55,1],[.45,1]],24,z+side*.010);
    flagQuad([[0,.43],[1,.43],[1,.57],[0,.57]],24,z+side*.010);
  }
  for(let i=flagStart+1;i<out.length;i+=9)out[i]+=D.decks.poop.height-2.48;
  group('flag.ensign','hull',flagStart);
  return new Float32Array(out);
}
