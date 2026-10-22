import {createMeshWriter} from './mesh-writer.js';
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { VICTORY_DESIGN, VICTORY_MASTS, VICTORY_SAILS,VICTORY_STANDING_LINES,VICTORY_RUNNING_LINES,victoryShroud,
  victorySheer, victoryHullDeck, victoryVesselDeck, victoryHullHalfWidth,
  victoryDeckHalfWidth, victoryMastPoint, victoryAnchorCathead, victorySailPoint,victoryHatchPivot,victoryHullPoint } from './models/victory.js';

// A separate first-rate hull, decks, batteries and full rig. The nine-float
// vertex contract is shared with the caravel; its authored geometry is not.
export function createVictoryMesh({groups,parts}={}){
  const {out,add,sub,mul,cross,unit,tag,group,tri,quad,box,tube,rope,ring}=createMeshWriter({groups,parts});
  const zValues=new Set([...Array.from({length:49},(_,i)=>-6+i/4),...VICTORY_DESIGN.hull.stations]);
  for(const z of [VICTORY_DESIGN.decks.forecastle.end,VICTORY_DESIGN.decks.quarter.start,VICTORY_DESIGN.decks.poop.start])zValues.add(z);
  const portW=.235,portH=.21,batteries=VICTORY_DESIGN.gunDecks.filter(g=>['lower','middle','upper'].includes(g.id));
  const ports=batteries.flatMap(g=>Array.from({length:g.count/2},(_,i)=>({deck:g.id,y:g.centre,z:g.start+(g.end-g.start)*i/(g.count/2-1),calibre:g.calibre})));
  const upperPorts=VICTORY_DESIGN.gunDecks.filter(g=>!batteries.includes(g)).flatMap(g=>Array.from({length:g.count/2},(_,i)=>({y:g.centre,z:g.start+(g.end-g.start)*i/(g.count/2-1)})));
  for(const p of ports){zValues.add(p.z-portW/2);zValues.add(p.z+portW/2);}
  for(const p of upperPorts){zValues.add(p.z-portW/2);zValues.add(p.z+portW/2);}
  const zs=[...zValues].sort((a,b)=>a-b),ys=[-VICTORY_DESIGN.hull.draft,-1.7,-1.5,-1.25,-1,-.75,-.5,-.25,0,.07,.2,.58,.6,.67,.7,1.08,1.1,1.17,1.2,1.58,
    VICTORY_DESIGN.decks.forecastle.height,VICTORY_DESIGN.decks.quarter.height,VICTORY_DESIGN.decks.poop.height];
  for(const p of ports){ys.push(p.y-portH/2,p.y+portH/2);}
  const levels=[...new Set(ys)].sort((a,b)=>a-b);
  const hullPoint=(station,y,side)=>victoryHullPoint(station,y,side);
  const skinTop=z=>Math.max(1.58,victoryVesselDeck(z)-victorySheer(z));
  const hullMaterial=y=>y<-.13?22:((y>=.2&&y<=.58)||(y>=.7&&y<=1.08)||(y>=1.2&&y<=1.58))?21:20;
  function hullNormal(p,side){
    const e=.0001,wY=(victoryHullHalfWidth(p[2],p[1]+e)-victoryHullHalfWidth(p[2],p[1]-e))/(2*e),wZ=(victoryHullHalfWidth(p[2]+e,p[1])-victoryHullHalfWidth(p[2]-e,p[1]))/(2*e);
    return unit([side,-wY,-wZ]);
  }
  const hullStart=out.length;
  for(const side of [-1,1])for(let j=0;j<levels.length-1;j++)for(let i=0;i<zs.length-1;i++){
    const a=levels[j],b=levels[j+1],z=zs[i],Z=zs[i+1],cy=(a+b)/2,cz=(z+Z)/2;
    if(cy>skinTop(cz)+1e-8)continue;
    if(ports.some(p=>Math.abs(cz-p.z)<portW/2-1e-7&&Math.abs(cy-p.y)<portH/2-1e-7))continue;
    const material=hullMaterial(cy);
    const points=[[z,a],[Z,a],[Z,b],[z,b]].map(([s,y])=>hullPoint(s,y,side));
    // The curved stem needs finer vertical samples than a flat battery panel.
    // Keep the neighbouring frame edge linear so both strips share it exactly.
    const slices=i===0&&b>0?Math.max(1,Math.ceil((b-a)/.045)):1;
    for(let k=0;k<slices;k++){
      const t=k/slices,T=(k+1)/slices,lo=a+(b-a)*t,hi=a+(b-a)*T;
      const edge=q=>points[1].map((v,j)=>v+(points[2][j]-v)*q);
      const p=slices===1?points:[hullPoint(z,lo,side),edge(t),edge(T),hullPoint(z,hi,side)];
      quad(...p,material,p.map(p=>hullNormal(p,side)),[[lo*5,z*2],[lo*5,Z*2],[hi*5,Z*2],[hi*5,z*2]]);
    }
  }
  group('hull.planking','hull',hullStart);
  // The end skins share every raked station vertex with the side planking.
  // At a zero-width stem the sides already meet, so degenerate faces are omitted.
  for(const [name,station]of [['bow',-6],['stern',6]]){
    const start=out.length;
    for(let j=0;j<levels.length-1;j++){
      const a=levels[j],b=levels[j+1];if((a+b)/2>skinTop(station)+1e-8)continue;
      quad(hullPoint(station,a,-1),hullPoint(station,a,1),hullPoint(station,b,1),hullPoint(station,b,-1),hullMaterial((a+b)/2));
    }
    group('hull.closure.'+name,'hull',start);
  }
  // Copper plates have sparse dark seams and a restrained nail rhythm.
  const copperStart=out.length;
  for(const side of [-1,1])for(let y=-1.6;y<-.15;y+=.17)for(let z=-5.4;z<5.7;z+=.48){
    const a=hullPoint(z,y,side),b=hullPoint(Math.min(5.8,z+.47),y,side);
    if(Math.abs(a[0])>.08&&Math.abs(b[0])>.08){a[0]+=side*.0015;b[0]+=side*.0015;rope(a,b,.0018,20);}
  }
  group('hull.copper.seams','hull',copperStart);
  // Proud wales track exactly the same surface as the hull on both sides.
  // Match the actual planking grid, including gunport boundaries. A separate
  // coarser grid matched only the analytic hull, missing the triangulated skin
  // between joins and mostly burying return faces inside it.
  const waleZs=zs;
  for(const side of [-1,1]){
    const start=out.length;
    for(const h of [.035,.635,1.135])for(let i=0;i<waleZs.length-1;i++){
      const skin=[hullPoint(waleZs[i],h-.035,side),hullPoint(waleZs[i+1],h-.035,side),hullPoint(waleZs[i+1],h+.035,side),hullPoint(waleZs[i],h+.035,side)];
      const [a,b,c,d]=skin.map(p=>[p[0]+side*.023,p[1],p[2]]);
      quad(a,b,c,d,20,[hullNormal(a,side),hullNormal(b,side),hullNormal(c,side),hullNormal(d,side)]);
      quad(skin[0],skin[1],b,a,20);quad(d,c,skin[2],skin[3],20);
      if(i===0)quad(skin[0],a,d,skin[3],20);
      if(i===waleZs.length-2)quad(b,skin[1],skin[2],c,20);
    }
    group(`hull.wales.${side<0?'port':'starboard'}`,'hull',start);
  }
  // Three complete batteries: open cuts, red inner reveals, raised black lids,
  // and individual barrels. The far end is dark recess, not a solid yellow wall.
  for(const side of [-1,1])for(const [index,p]of ports.entries()){
    const start=out.length,y=p.y+victorySheer(p.z),x=side*victoryHullHalfWidth(p.z,y),a=p.z-portW/2,b=p.z+portW/2,lo=y-portH/2,hi=y+portH/2;
    const inset=x-side*.14,surface=(z,base,inside=false)=>{
      const Y=base+victorySheer(z);return [inside?inset:side*victoryHullHalfWidth(z,Y),Y,z];
    },low=p.y-portH/2,high=p.y+portH/2;
    quad(surface(a,low,true),surface(a,high,true),surface(b,high,true),surface(b,low,true),4);
    for(const z of [a,b])quad(surface(z,low),surface(z,high),surface(z,high,true),surface(z,low,true),24);
    for(const base of [low,high])quad(surface(a,base),surface(a,base,true),surface(b,base,true),surface(b,base),24);
    const recoilStart=out.length,gunId=(side<0?0:ports.length)+index;
    tube([inset-side*.10,y,p.z],[x+side*.19,y,p.z],p.calibre===32?.040:p.calibre===24?.035:.030,3,.026,8);
    tube([x+side*.192,y,p.z],[x+side*.195,y,p.z],.021,4,.021,8);
    group(`gunnery.recoil.${gunId}`,'hull',recoilStart,{type:'gun-recoil',gunId,axis:[side,0,0]});
    // The hinge and raised leaf retain the curved sheer and tumblehome of the
    // opening. A flat rectangle across the bow separated from its gunport.
    for(let i=0;i<3;i++){
      const z=a+(b-a)*i/3,Z=a+(b-a)*(i+1)/3;
      const hinge=q=>{const v=surface(q,high+.008);v[0]+=side*.004;return v;};
      const raised=q=>{const v=hinge(q);v[0]+=side*.17;v[1]+=.085;return v;};
      quad(hinge(z),raised(z),raised(Z),hinge(Z),20);
    }
    for(const z of [p.z-.068,p.z+.068])rope([x+side*.12,hi+.075,z],[x+side*.08,hi+.22,z],.004,3);
    group(`gun.${p.deck}.${side<0?'port':'starboard'}.${index}`,'hull',start);
  }
  function deck(firstStation,lastStation,height,node){
    // The stem moves forward with height. Deck strips and their edge samples
    // must use the skin's physical longitudinal coordinates at this level.
    const start=hullPoint(firstStation,height,1)[2],end=hullPoint(lastStation,height,1)[2];
    const skinZs=zs.map(station=>hullPoint(station,height,1)[2]);
    const begin=out.length,N=Math.ceil((end-start)/.5),edges=[];
    // Clip each plank against both sloping deck edges. Taking the narrower
    // endpoint for the entire strip left missing wedges along the curved bow.
    const clip=(polygon,distance)=>{
      const result=[];
      for(let i=0;i<polygon.length;i++){
        const a=polygon[i],b=polygon[(i+1)%polygon.length],da=distance(a),db=distance(b);
        if(da>=-1e-10)result.push(a);
        if((da<0)!==(db<0)){const t=da/(da-db);result.push(a.map((v,j)=>v+(b[j]-v)*t));}
      }
      return result;
    };
    for(let i=0;i<N;i++){
      const z=start+(end-start)*i/N,Z=start+(end-start)*(i+1)/N,y=height+victorySheer(z),Y=height+victorySheer(Z);
      const outer=victoryHullHalfWidth(z,y),Outer=victoryHullHalfWidth(Z,Y),w=Math.max(0,outer-.035),W=Math.max(0,Outer-.035);
      const stops=[z,...skinZs.filter(p=>p>z+1e-9&&p<Z-1e-9),Z];
      const breadthAt=p=>Math.max(0,victoryHullHalfWidth(p,height+victorySheer(p))-.035);
      const widths=stops.map(breadthAt),minimum=Math.min(...widths),maximum=Math.max(...widths);
      edges.push({z,Z,y,Y,w,W,outer,Outer,stops});
      for(let x=-1.8;x<1.8;x+=.054){
        if(x>maximum||x+.052< -maximum)continue;
        // Interior boards need only the gentle sheer samples. Edge boards
        // follow every skin station, including the changing stern flare.
        const cuts=x>=-minimum&&x+.052<=minimum?[z,Z]:stops;
        const offset=Math.sin(Math.round(x/.054)*13.4)*.4;
        for(let j=0;j<cuts.length-1;j++){
          const a=cuts[j],b=cuts[j+1],A=height+victorySheer(a),B=height+victorySheer(b),wa=breadthAt(a),wb=breadthAt(b);
          let polygon=[[x,A,a],[x,B,b],[x+.052,B,b],[x+.052,A,a]];
          const breadth=p=>wa+(wb-wa)*(p[2]-a)/(b-a);
          polygon=clip(clip(polygon,p=>p[0]+breadth(p)),p=>breadth(p)-p[0]);
          for(let k=1;k<polygon.length-1;k++){
            const points=[polygon[0],polygon[k],polygon[k+1]];
            tri(...points,0,null,points.map(p=>[p[0]*5+offset,p[2]*2]));
          }
        }
      }
    }
    group(node+'.planks',node,begin);
    const waterwayStart=out.length;
    // A continuous waterway closes the trimmed plank ends against the skin.
    for(const e of edges){
      const stops=e.stops;
      const point=(z,side,outer)=>{
        const y=height+victorySheer(z),skin=victoryHullHalfWidth(z,y),width=outer?skin:Math.max(0,skin-.035);
        return [side*width,y,z];
      };
      for(const side of [-1,1])for(let i=0;i<stops.length-1;i++)quad(point(stops[i],side,false),point(stops[i+1],side,false),point(stops[i+1],side,true),point(stops[i],side,true),0);
    }
    group(node+'.waterway',node,waterwayStart);
  }
  deck(-6,6,VICTORY_DESIGN.decks.main,'deck.main');deck(-6,VICTORY_DESIGN.decks.forecastle.end,VICTORY_DESIGN.decks.forecastle.height,'deck.forecastle');
  deck(VICTORY_DESIGN.decks.quarter.start,6,VICTORY_DESIGN.decks.quarter.height,'deck.quarter');deck(VICTORY_DESIGN.decks.poop.start,6,VICTORY_DESIGN.decks.poop.height,'deck.poop');
  // The waist has an open view down onto the upper deck; raised ends are
  // enclosed by joined bulkheads, not isolated floating deck plates.
  for(const [z,top,bottom]of [[VICTORY_DESIGN.decks.forecastle.end,VICTORY_DESIGN.decks.forecastle.height,VICTORY_DESIGN.decks.main],[VICTORY_DESIGN.decks.quarter.start,VICTORY_DESIGN.decks.quarter.height,VICTORY_DESIGN.decks.main],[VICTORY_DESIGN.decks.poop.start,VICTORY_DESIGN.decks.poop.height,VICTORY_DESIGN.decks.quarter.height]]){
    const start=out.length,steps=Math.max(2,Math.ceil((top-bottom)/.12));
    for(let i=0;i<steps;i++){
      const lo=bottom+(top-bottom)*i/steps,hi=bottom+(top-bottom)*(i+1)/steps;
      for(const face of [-1,1]){
        const Z=z+face*.015,y=lo+victorySheer(Z),Y=hi+victorySheer(Z),w=victoryHullHalfWidth(Z,y),W=victoryHullHalfWidth(Z,Y);
        quad([-w,y,Z],[w,y,Z],[W,Y,Z],[-W,Y,Z],23);
      }
      for(const side of [-1,1]){
        const p=(Y,Z)=>[side*victoryHullHalfWidth(Z,Y+victorySheer(Z)),Y+victorySheer(Z),Z];
        quad(p(lo,z-.015),p(lo,z+.015),p(hi,z+.015),p(hi,z-.015),23);
      }
    }
    for(const base of [bottom,top]){
      const a=z-.015,b=z+.015,A=base+victorySheer(a),B=base+victorySheer(b),w=victoryHullHalfWidth(a,A),W=victoryHullHalfWidth(b,B);
      quad([-w,A,a],[-W,B,b],[W,B,b],[w,A,a],23);
    }
    group('deck.bulkhead.'+z,'hull',start);
  }
  // Upper bulwarks, continuous black rail, and proper openings for the smaller
  // quarterdeck/forecastle battery, which completes the 104-gun total.
  for(const side of [-1,1]){
    const start=out.length,samples=[];
    for(let i=0;i<zs.length-1;i++){
      const z=zs[i],Z=zs[i+1],centre=(z+Z)/2;
      const base=victoryVesselDeck(centre)-victorySheer(centre),waist=centre>VICTORY_DESIGN.decks.forecastle.end&&centre<VICTORY_DESIGN.decks.quarter.start,h=waist?1.58-base:centre>=VICTORY_DESIGN.decks.poop.start?.19:.285;
      const bottom=hullPoint(z,base,side),nextBottom=hullPoint(Z,base,side);
      const top=hullPoint(z,base+h,side),nextTop=hullPoint(Z,base+h,side),gunPort=upperPorts.find(p=>Math.abs(centre-p.z)<portW/2-1e-7);
      if(!waist){
        const height=gunPort?Math.max(.03,gunPort.y-base-portH/2):h;
        quad(bottom,nextBottom,hullPoint(Z,base+height,side),hullPoint(z,base+height,side),20);
      }
      samples.push({i,bottom,top,nextTop});
    }
    group(`bulwark.${side}.skin`,'hull',start);
    const railStart=out.length;
    for(const s of samples)tube(s.top,s.nextTop,.025,20,.025,4,undefined,true);
    group(`bulwark.${side}.rail`,'hull',railStart);
    for(const s of samples)if(s.i%3===0){
      const postStart=out.length;
      // Both end rings are buried in the waterway/rail; hidden end caps add no
      // visible surface and would duplicate those joined timber interfaces.
      const inset=x=>x-side*Math.min(.018,Math.abs(x)*.5);
      tube([inset(s.bottom[0]),s.bottom[1],s.bottom[2]],[inset(s.top[0]),s.top[1],s.top[2]],.013,21,.013,6,undefined,true);
      group(`bulwark.${side}.stanchion.${s.i}`,'hull',postStart);
    }
    for(const [z,low,high]of [[VICTORY_DESIGN.decks.forecastle.end,1.58,VICTORY_DESIGN.decks.forecastle.height+.285],[VICTORY_DESIGN.decks.quarter.start,1.58,VICTORY_DESIGN.decks.quarter.height+.285],[VICTORY_DESIGN.decks.poop.start,VICTORY_DESIGN.decks.quarter.height+.285,VICTORY_DESIGN.decks.poop.height+.19]]){
      const point=base=>hullPoint(z,base,side);
      tube(point(low),point(high),.025,20,.025,4,undefined,true);
    }
    group(`bulwark.${side}`,'hull',start);
  }
  for(const g of VICTORY_DESIGN.gunDecks.filter(g=>!batteries.includes(g)))for(const side of [-1,1])for(let i=0;i<g.count/2;i++){
    const start=out.length,z=g.start+(g.end-g.start)*i/(g.count/2-1),floor=victoryVesselDeck(z),y=g.centre+victorySheer(z),x=side*(victoryHullHalfWidth(z,y)-.07),carronade=g.id==='forecastle'&&i===0;
    const gunId=88+(g.id==='quarter'?(side<0?0:6)+i:12+(side<0?0:2)+i);
    // Two cheeks, two axles and four discrete wooden trucks. Axles run along
    // Z, so the carriage wheels actually roll with the athwartships recoil.
    const rear=x-side*.25,front=x+side*.015,left=Math.min(rear,front),right=Math.max(rear,front);
    box([left,floor+.055,z-.082],[right,floor+.105,z+.082],24);
    for(const sign of[-1,1])box([left,floor+.09,z+sign*.073-.013],[right,floor+.18,z+sign*.073+.013],24);
    for(const ax of[x-side*.21,x-side*.005]){
      tube([ax,floor+.042,z-.12],[ax,floor+.042,z+.12],.013,3,.013,8);
      for(const sign of[-1,1])tube([ax,floor+.042,z+sign*.095],[ax,floor+.042,z+sign*.126],.042,1,.042,8);
    }
    const breech=[x-side*.15,y,z],muzzle=[x+side*(carronade?.21:.3),y,z],outer=carronade?.045:.025,bore=outer*.67;
    tube(breech,muzzle,carronade?.055:.032,3,outer,12,undefined,true);
    const inside=[muzzle[0]-side*.10,y,z];
    // A real annular muzzle and dark internal bore, without a solid metal cap.
    const point=(p,r,j)=>[p[0],p[1]+r*Math.cos(j*Math.PI/6),p[2]+r*Math.sin(j*Math.PI/6)];
    for(let j=0;j<12;j++){
      quad(point(muzzle,outer,j),point(muzzle,bore,j),point(muzzle,bore,j+1),point(muzzle,outer,j+1),3);
      quad(point(muzzle,bore,j),point(inside,bore,j),point(inside,bore,j+1),point(muzzle,bore,j+1),4);
      tri(inside,point(inside,bore,j+1),point(inside,bore,j),4);
      tri(breech,point(breech,carronade?.055:.032,j),point(breech,carronade?.055:.032,j+1),3);
    }
    group(`gunnery.recoil.${gunId}`,'hull',start,{type:'gun-recoil',gunId,axis:[side,0,0]});
    group(`gun.${g.id}.${side<0?'port':'starboard'}.${i}`,'hull',start);
  }
  // One gently arched, bowed and raked transom supports every gallery skin,
  // window and moulding. The square stern remains broad; its upper corners
  // turn inward rather than becoming three disconnected rectangular shelves.
  const sternStart=out.length;
  const rear=(fraction,baseY,outset=.21,extra=.12)=>{
    const t=Math.max(0,Math.min(1,(baseY-.84)/1.44)),arch=(.045+.055*t)*(1-fraction*fraction);
    const p=hullPoint(6,baseY+arch,1),round=Math.max(0,Math.min(1,(baseY-1.9)/.38));
    const corner=1-.035*round*round*(3-2*round)*fraction**8;
    return [fraction*(p[0]+extra)*corner,p[1],p[2]+outset-(.06*fraction*fraction+.055*(baseY-1))*outset/.21];
  };
  const gallerySegments=18;
  const rearPanel=(left,right,low,high,outset,material,rows=1)=>{
    for(let row=0;row<rows;row++)for(let i=0;i<gallerySegments;i++){
      const a=left+(right-left)*i/gallerySegments,b=left+(right-left)*(i+1)/gallerySegments;
      const y=low+(high-low)*row/rows,Y=low+(high-low)*(row+1)/rows;
      quad(rear(a,y,outset),rear(b,y,outset),rear(b,Y,outset),rear(a,Y,outset),material);
    }
  };
  for(const [level,y]of [1.03,1.55,2.05].entries()){
    const low=y-.19,high=y+.23;
    const rearStart=out.length;
    rearPanel(-1,1,low,high,.21,21,3);
    group(`stern.gallery.${level}.rear`,'hull',rearStart);
    const returnStart=out.length;
    for(const side of [-1,1])for(let i=0;i<3;i++){
      const a=low+(high-low)*i/3,b=low+(high-low)*(i+1)/3;
      quad(rear(side,a,0,0),rear(side,a),rear(side,b),rear(side,b,0,0),21);
    }
    for(const Y of [low,high])for(let i=0;i<gallerySegments;i++){
      const a=-1+2*i/gallerySegments,b=-1+2*(i+1)/gallerySegments;
      quad(rear(a,Y,0,0),rear(a,Y),rear(b,Y),rear(b,Y,0,0),21);
    }
    group(`stern.gallery.${level}.returns`,'hull',returnStart);
    rearPanel(-.985,.985,y-.15,y+.19,.212,20,2);
    const windowStart=out.length;
    for(let col=0;col<9;col++){
      const left=-1+col*2/9+.013,right=-1+(col+1)*2/9-.013;
      for(let i=0;i<2;i++){
        const a=left+(right-left)*i/2,b=left+(right-left)*(i+1)/2;
        quad(rear(a,y-.115,.216),rear(b,y-.115,.216),rear(b,y+.15,.216),rear(a,y+.15,.216),11);
        tube(rear(a,y+.015,.226),rear(b,y+.015,.226),.007,25,.007,5,undefined,true);
      }
      tube(rear(left,y-.14,.222),rear(left,y+.18,.222),.010,25,.010,5);
    }
    group(`stern.gallery.${level}.windows`,'hull',windowStart);
    const trimStart=out.length;
    for(const Y of [y-.20,y+.22])for(let i=0;i<gallerySegments;i++)tube(rear(-1+2*i/gallerySegments,Y,.235),rear(-1+2*(i+1)/gallerySegments,Y,.235),.025,25,.025,6,undefined,true);
    group(`stern.gallery.${level}.trim`,'hull',trimStart);
    for(const side of [-1,1]){
      const end=hullPoint(6,y,1)[2]+.21,point=(z,baseY,outset=.12)=>{
        const t=Math.max(0,Math.min(1,(z-5.28)/(end-5.28))),edge=rear(side,baseY,.21,outset);
        const Z=5.28+(edge[2]-5.28)*t,sampleZ=Math.min(Z,6),Y=baseY+victorySheer(sampleZ);
        const parent=hullPoint(6,baseY,1),correction=edge[0]-side*(parent[0]+outset);
        return [side*(victoryHullHalfWidth(sampleZ,Y)+outset)+correction*t*t,Y,Z];
      };
      for(let i=0;i<5;i++){
        const a=5.28+(end-5.28)*i/5,b=5.28+(end-5.28)*(i+1)/5;
        quad(point(a,y-.18),point(b,y-.18),point(b,y+.20),point(a,y+.20),21);
        for(const Y of [y-.18,y+.20])quad(point(a,Y,.002),point(b,Y,.002),point(b,Y),point(a,Y),21);
      }
      for(const z of [5.28,end])quad(point(z,y-.18,.002),point(z,y-.18),point(z,y+.20),point(z,y+.20,.002),21);
      for(let k=0;k<4;k++){
        const a=5.32+k*.19,b=a+.145;
        for(let i=0;i<2;i++){
          const z=a+(b-a)*i/2,Z=a+(b-a)*(i+1)/2;
          quad(point(z,y-.12,.123),point(z,y+.14,.123),point(Z,y+.14,.123),point(Z,y-.12,.123),11);
        }
        tube(point(a,y-.15,.13),point(a,y+.17,.13),.009,25,.009,5);
      }
      for(let i=0;i<5;i++)tube(point(5.28+(end-5.28)*i/5,y+.22,.15),point(5.28+(end-5.28)*(i+1)/5,y+.22,.15),.022,25,.022,6);
    }
  }
  // Gilded crest and simple carved scroll rhythm are authored ornaments.
  const crown=rear(0,2.28,.235),crestZ=crown[2];
  ring([0,crown[1]+.12,crestZ],.13,.028,25,'z',20);
  for(const side of [-1,1])for(let i=0;i<5;i++){
    const x=side*(.3+i*.19),roof=rear(x/(hullPoint(6,2.28,1)[0]+.12),2.28,.235);
    tube([x-.055,roof[1]-.015,roof[2]],[x+.055,roof[1]+.035,roof[2]],.021,25,.013,6);
  }
  group('stern.galleries','hull',sternStart);
  // A shaped sternpost/deadwood fillet joins the raked underwater transom to
  // the existing rudder stock. It belongs to the hull, not the moving rudder.
  const postStart=out.length,postLevels=[...levels.filter(y=>y<=.81),.81];
  for(let i=0;i<postLevels.length-1;i++){
    const a=postLevels[i],b=postLevels[i+1],point=(base,side,aft)=>{
      const p=hullPoint(6,base,side);return [side*.045,p[1],aft?Math.max(5.88,p[2]+.035):p[2]-.025];
    };
    for(const side of [-1,1])quad(point(a,side,false),point(a,side,true),point(b,side,true),point(b,side,false),20);
    for(const aft of [false,true])quad(point(a,-1,aft),point(a,1,aft),point(b,1,aft),point(b,-1,aft),20);
    if(i===0)quad(point(a,-1,false),point(a,-1,true),point(a,1,true),point(a,1,false),20);
    if(i===postLevels.length-2)quad(point(b,-1,false),point(b,1,false),point(b,1,true),point(b,-1,true),20);
  }
  group('hull.sternpost','hull',postStart);
  // Rudder and stem are substantial joined structures.
  const rudderStart=out.length;
  box([-.045,-1.68,5.84],[.045,.81,6.04],14);
  quad([-.045,-1.68,6.04],[-.045,-1.54,6.51],[-.045,.15,6.41],[-.045,.81,6.04],14);
  quad([.045,-1.68,6.04],[.045,.81,6.04],[.045,.15,6.41],[.045,-1.54,6.51],14);
  for(const y of [-1.3,-.65,0,.55])tube([-.06,y,5.86],[.06,y,5.86],.027,3,.027,8);
  group('helm.rudder','helm.rudder',rudderStart,{type:'rudder'});
  const bowStart=out.length;
  const cubic=(a,b,c,d,t)=>a.map((v,k)=>v*(1-t)**3+3*b[k]*t*(1-t)**2+3*c[k]*t*t*(1-t)+d[k]*t**3);
  // Swept rectangular timbers share a ring at every bend; these are shaped
  // head rails and knees, rather than sagged ropes stretched into a V.
  function curvedTimber(points,w,h,material){
    let across=[1,0,0];
    const rings=points.map((p,i)=>{
      const tangent=unit(sub(points[Math.min(points.length-1,i+1)],points[Math.max(0,i-1)]));
      // Parallel-transport the rectangular section. Switching a reference
      // axis at a slope threshold rotated neighbouring stem rings 90 degrees.
      const project=a=>sub(a,mul(tangent,a.reduce((n,v,k)=>n+v*tangent[k],0)));
      let normal=project(across);if(Math.hypot(...normal)<1e-6)normal=project([0,0,1]);
      across=unit(normal);const up=cross(across,tangent);
      return [[-1,-1],[-1,1],[1,1],[1,-1]].map(([a,b])=>add(p,add(mul(across,a*w/2),mul(up,b*h/2))));
    });
    for(let i=0;i<rings.length-1;i++)for(let k=0;k<4;k++)quad(rings[i][k],rings[i][(k+1)%4],rings[i+1][(k+1)%4],rings[i+1][k],material);
    quad(...rings[0].slice().reverse(),material);quad(...rings.at(-1),material);
  }
  const stemStart=out.length;
  const stemBases=[-1.5,-1.25,-1,-.75,-.5,-.25,0,.2,.4,.6,.8,1,1.2,1.4,1.6,1.8];
  const stem=stemBases.map(base=>{const p=hullPoint(-6,base,0);p[2]-=.018;return p;});
  curvedTimber(stem,.075,.08,20);
  group('bow.stem','hull',stemStart);
  const kneeStart=out.length;
  const kneeRoot=stem[stemBases.indexOf(.8)];
  const kneePoint=t=>cubic(kneeRoot,[0,1.4,-6.5],[0,1.7,-7.0],[0,2.22,-7.16],t);
  const knee=Array.from({length:17},(_,i)=>kneePoint(i/16));
  curvedTimber(knee,.10,.16,21);
  group('bow.knee','hull',kneeStart);
  group('bow.cutwater','hull',stemStart);
  for(const side of [-1,1]){
    const cat=victoryAnchorCathead(side);tube(cat.root,cat.tip,.055,21,.047,8);
    const railStart=out.length,rails=[];
    for(let i=0;i<3;i++){
      const start=out.length;
      const base=1.05+i*.25,z=-5.45,y=base+victorySheer(z),w=victoryHullHalfWidth(z,y),tip=kneePoint(.65+i*.15);tip[0]=side*.03;
      const curve=Array.from({length:17},(_,j)=>cubic([side*(w-.008),y,z],[side*w*.98,y-.06,-6.05],[side*.40,tip[1]-.30,-6.65],tip,j/16));
      curvedTimber(curve,.042,.055,21);rails.push(curve);
      group(`bow.headrail.${side}.${i}`,'hull',start);
    }
    group(`bow.headrails.${side}`,'hull',railStart);
    const frameStart=out.length;
    for(const index of [10,13]){
      const start=out.length;
      // Frame bends pass through every member they support, not just the two
      // outside rails; an independently drawn curve left false near-joints.
      curvedTimber(rails.map(rail=>rail[index]),.032,.045,20);
      group(`bow.headtimber.${side}.${index}`,'hull',start);
    }
    group(`bow.headtimbers.${side}`,'hull',frameStart);
  }
  const gratingStart=out.length;
  for(let i=0;i<10;i++){
    const t=i/9,z=-6.32-t*.64,w=.32*(1-t)+.10*t,y=1.62+.13*t;
    tube([-w,y,z],[w,y,z],.013,1,.013,4);
  }
  for(const side of [-1,1]){
    tube([side*.32,1.62,-6.13],[side*.32,1.62,-6.32],.024,20,.024,4);
    tube([side*.32,1.62,-6.32],[side*.10,1.75,-6.96],.024,20,.022,4);
  }
  tube([-.16,1.726,-6.84],[.16,1.726,-6.84],.021,20,.021,4);
  group('bow.grating','hull',gratingStart);
  // Bowsprit, jibboom and flying jibboom are stepped spars, not an oversize mast.
  tube([0,2.1,-4.8],[0,3.06,-8.25],.14,1,.075,16);
  tube([0,2.92,-7.75],[0,3.28,-10.56],.062,1,.022,12);
  tube([0,2.88,-8.0],[0,1.78,-8.0],.035,20,.025,8);
  for(const side of [-1,1])for(const end of [-8.2,-10.5]){
    const z=-5.55,y=.88+victorySheer(z),root=[side*victoryHullHalfWidth(z,y),y,z];
    rope(root,[0,end===-8.2?3.04:3.27,end],.011,20,6,.015);
  }
  // Compact heraldic shield and crown on the knee, replacing a floating ring.
  // Decoration remains an authored simplification of the 1803 royal arms.
  const armsStart=out.length,shield=[[-.13,2.23,-7.18],[-.14,2.43,-7.18],[.14,2.43,-7.18],[.13,2.23,-7.18],[0,2.12,-7.18]],centre=[0,2.30,-7.19];
  for(let i=0;i<shield.length;i++){tri(centre,shield[i],shield[(i+1)%shield.length],25);tube(shield[i],shield[(i+1)%shield.length],.012,25,.012,6);}
  for(const side of [-1,1]){
    tube([side*.11,2.45,-7.18],[side*.085,2.54,-7.18],.014,25,.009,6);
    tube([side*.085,2.54,-7.18],[0,2.56,-7.18],.009,25,.009,6);
  }
  tube([-.11,2.45,-7.18],[.11,2.45,-7.18],.018,25,.018,6);
  group('bow.arms','hull',armsStart);
  group('bow.structure','hull',bowStart);
  // Two wheels on a common spindle, binnacle, companionways, capstan and bitts.
  const wheelStart=out.length,wc=VICTORY_DESIGN.wheel.centre;
  for(const z of [wc[2]-.055,wc[2]+.055]){
    ring([wc[0],wc[1],z],VICTORY_DESIGN.wheel.radius,.014,7,'z',36);
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
  for(const [z,top,bottom]of [[VICTORY_DESIGN.decks.forecastle.end,VICTORY_DESIGN.decks.forecastle.height,VICTORY_DESIGN.decks.main],[VICTORY_DESIGN.decks.quarter.start,VICTORY_DESIGN.decks.quarter.height,VICTORY_DESIGN.decks.main],[VICTORY_DESIGN.decks.poop.start,VICTORY_DESIGN.decks.poop.height,VICTORY_DESIGN.decks.quarter.height]])for(const side of [-1,1]){
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
    const start=out.length,y=VICTORY_DESIGN.decks.main+.32,z=-1.15,half=.27,L=1.44;
    for(let i=0;i<20;i++)for(let j=0;j<7;j++){
      const point=(t,k)=>{const Z=-L+2*L*t,w=half*Math.sin(Math.PI*t)**.55,theta=k/7*Math.PI;return [x+Math.cos(theta)*w,y-Math.sin(theta)*.19,z+Z];};
      quad(point(i/20,j),point((i+1)/20,j),point((i+1)/20,j+1),point(i/20,j+1),23);
    }
    for(const side of [-1,1])for(let i=0;i<20;i++){
      const p=t=>[x+side*half*Math.sin(Math.PI*t)**.55,y,z-L+2*L*t];tube(p(i/20),p((i+1)/20),.016,1,.016,6);
    }
    for(let Z=z-1;Z<z+1.1;Z+=.38){const w=half*Math.sin(Math.PI*(Z-z+L)/(2*L))**.55;box([x-w+.02,y-.05,Z-.035],[x+w-.02,y-.025,Z+.035],1);}
    for(const Z of [z-.9,z+.9])box([x-.34,VICTORY_DESIGN.decks.main+.04,Z-.04],[x+.34,VICTORY_DESIGN.decks.main+.16,Z+.04],1);
    group('boat.waist.'+boatIndex,'deck.main',start);
  }
  // Lower masts, overlapping topmasts and topgallants, open fighting tops,
  // trestletrees, crosstrees and rope-rung shrouds.
  for(const [index,m]of VICTORY_MASTS.entries()){
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
  const crossjackControl=VICTORY_SAILS.find(s=>s.name==='mizzen-topsail').id;
  tube(add(crossjack,[-1.98,0,0]),crossjack,.026,tag(10,crossjackControl),.05,12);
  tube(crossjack,add(crossjack,[1.98,0,0]),.05,tag(10,crossjackControl),.026,12);
  group('yard.mizzen-crossjack','mast.mizzen',crossjackStart,{type:'victory-yard',sail:crossjackControl});
  for(const s of VICTORY_SAILS){
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
  for(const [index,m]of VICTORY_MASTS.entries()){
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
  for(let i=flagStart+1;i<out.length;i+=9)out[i]+=VICTORY_DESIGN.decks.poop.height-2.48;
  group('flag.ensign','hull',flagStart);
  return new Float32Array(out);
}
