import { hullDeck, deckHalfWidth, HULL_DRAFT, HULL_BOW_RAKE, HULL_STERN_RAKE, hullHalfWidth, hullSurfacePoint, hullSheerAngle, vesselDeck, TILLER_PIVOT, TILLER_HANDLE,
  QUARTERDECK_START, QUARTERDECK_HEIGHT, HULL_VERTICAL_SCALE, anchorCathead } from './hull.js';
import { RIG_MASTS, mastPoint, shroudGeometry, SAIL_TACKLES, tacklePoint } from './rigging.js';
import { SAIL_PLAN, RIG_LINES, RIG_SEGMENTS, ropeParameter } from './lateen.js';

// Deduplicate complete vertex records by their float32 bits. Material, normal,
// UV seams and triangle order remain exact, including signed zero components.
export function indexCaravelMesh(mesh) {
  const bits=new Uint32Array(mesh.buffer,mesh.byteOffset,mesh.length);
  const compact=new Uint32Array(mesh.length),indices=new Uint32Array(mesh.length/9),seen=new Map();
  let count=0;
  for(let i=0;i<bits.length;i+=9){
    const record=bits.subarray(i,i+9),key=record.join(',');
    let index=seen.get(key);
    if(index===undefined){index=count++;seen.set(key,index);compact.set(record,index*9);}
    indices[i/9]=index;
  }
  return {vertices:new Float32Array(compact.slice(0,count*9).buffer),indices};
}

// Timber in the original 12 x 3.6 design frame; the shared hull transform makes
// the default vessel 20 x 6 m, with matching height, draft and sail dimensions.
export function createCaravelMesh({parts,groups}={}) {
  const out=[];
  // Optional local inspection data; the renderer keeps the original flat mesh.
  // Groups are named, potentially nested inspection ranges, not a complete
  // partition. Ranges address raw vertices (nine floats each). Indexing retains
  // triangle order, so the same first/count become index-buffer offsets.
  const group=(id,nodeId,start,motion)=>{
    if(groups && out.length>start)groups.push({id,nodeId,firstVertex:start/9,vertexCount:(out.length-start)/9,...(motion&&{motion})});
  };
  const part=(name,start)=>{if(parts)parts.set(name,new Float32Array(out.slice(start)));group(name,'hull',start);};
  const mastNames=['fore','main','mizzen'];
  const add=(a,b)=>a.map((v,i)=>v+b[i]);
  const sub=(a,b)=>a.map((v,i)=>v-b[i]);
  const mul=(a,s)=>a.map(v=>v*s);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>mul(a,1/Math.hypot(...a));
  function tri(a,b,c,m=0,normals,uvs) {
    const face=cross(sub(b,a),sub(c,a));
    if(Math.hypot(...face)<1e-10)return;
    const n=norm(face);
    if(normals && n.reduce((v,x,i)=>v+x*normals[0][i],0)<0){ [b,c]=[c,b]; normals=[normals[0],normals[2],normals[1]]; if(uvs)uvs=[uvs[0],uvs[2],uvs[1]]; }
    for(const [i,p] of [a,b,c].entries()) {
      // Face projection must not collapse on vertical planking. Board offsets
      // belong to whole boards, never individual corners of the same triangle.
      const uv=uvs?uvs[i]:Math.abs(n[1])>.7?[p[0]*1.6,p[2]*.55]
        :Math.abs(n[0])>Math.abs(n[2])?[p[1]*1.6,p[2]*.55]:[p[1]*1.6,p[0]*.55];
      out.push(...p,...(normals?normals[i]:n),m,...uv);
    }
  }
  function quad(a,b,c,d,m=0,ns,uvs) {
    tri(a,b,c,m,ns&&[ns[0],ns[1],ns[2]],uvs&&[uvs[0],uvs[1],uvs[2]]);
    tri(a,c,d,m,ns&&[ns[0],ns[2],ns[3]],uvs&&[uvs[0],uvs[2],uvs[3]]);
  }
  function deckBoard(l,r,y,z,Y,Z,board){
    const offset=Math.sin(board*17.1)*.43;
    quad([l,y,z],[r,y,z],[r,Y,Z],[l,Y,Z],0,null,
      [[l*1.6+offset,z*.55],[r*1.6+offset,z*.55],[r*1.6+offset,Z*.55],[l*1.6+offset,Z*.55]]);
  }
  // Continuous joined longitudinal timber; each station shares one cross section.
  function railSweep(stations,centre,w,d,m){
    const c=Math.min(w,d)*.14,x=w/2,y=d/2;
    const ring=[[-x+c,-y],[x-c,-y],[x,-y+c],[x,y-c],[x-c,y],[-x+c,y],[-x,y-c],[-x,-y+c]];
    const point=(z,j)=>add(centre(z),[ring[j][0],ring[j][1],0]);
    for(let i=0;i<stations.length-1;i++)for(let j=0;j<8;j++){
      const z=stations[i],Z=stations[i+1],k=(j+1)%8;
      quad(point(z,j),point(Z,j),point(Z,k),point(z,k),m,null,[[j*.1,z*.6],[j*.1,Z*.6],[(j+1)*.1,Z*.6],[(j+1)*.1,z*.6]]);
    }
    for(const z of [stations[0],stations.at(-1)])for(let j=0;j<8;j++)tri(centre(z),point(z,j),point(z,(j+1)%8),m);
  }
  // Beveled timbers have eight sides, with no coplanar overlapping faces.
  function beam(a,b,w,d=w,m=1) {
    const axis=norm(sub(b,a)),u=norm(cross(axis,Math.abs(axis[1])<0.9?[0,1,0]:[1,0,0])),v=cross(axis,u);
    const c=Math.min(w,d)*0.14, x=w/2,y=d/2;
    const ring=[[-x+c,-y],[x-c,-y],[x,-y+c],[x,y-c],[x-c,y],[-x+c,y],[-x,y-c],[-x,-y+c]];
    const pts=p=>ring.map(([s,t])=>add(p,add(mul(u,s),mul(v,t))));
    const aa=pts(a),bb=pts(b),length=Math.hypot(...sub(b,a));
    const uv=(i,end)=>[i/8*0.8+a[0]*0.31+a[2]*0.071,end*length*0.65];
    for(let i=0;i<8;i++){let j=(i+1)%8;quad(aa[i],bb[i],bb[j],aa[j],m,null,[uv(i,0),uv(i,1),uv(i+1,1),uv(i+1,0)]);tri(a,aa[j],aa[i],m);tri(b,bb[i],bb[j],m);}
  }
  function tube(a,b,r,m=2,r2=r,sides=12,motion=null,clothUV=null,open=false) {
    const axis=norm(sub(b,a)),u=norm(cross(axis,Math.abs(axis[1])<0.9?[0,1,0]:[1,0,0])),v=cross(axis,u);
    const n=i=>add(mul(u,Math.cos(i*2*Math.PI/sides)),mul(v,Math.sin(i*2*Math.PI/sides)));
    for(let i=0;i<sides;i++){
      const na=n(i),nb=n(i+1),length=Math.hypot(...sub(b,a));
      const uv=(u,end)=>clothUV?clothUV[end]:[u,motion?motion[end]:end*length*.75];
      quad(add(a,mul(na,r)),add(b,mul(na,r2)),add(b,mul(nb,r2)),add(a,mul(nb,r)),m,[na,na,nb,nb],[uv(i/sides*.7,0),uv(i/sides*.7,1),uv((i+1)/sides*.7,1),uv((i+1)/sides*.7,0)]);
      if(!open)tri(a,add(a,mul(nb,r)),add(a,mul(na,r)),m,null,motion||clothUV?[uv(0,0),uv(0,0),uv(0,0)]:undefined);
      if(!open)tri(b,add(b,mul(na,r2)),add(b,mul(nb,r2)),m,null,motion||clothUV?[uv(0,1),uv(0,1),uv(0,1)]:undefined);
    }
  }
  function torus(center,r,tubeR,m=2,axis='z',segments=64,sides=10) {
    const direction=Array.isArray(axis)?norm(axis):null;
    const u=direction?norm(cross(direction,Math.abs(direction[1])<.9?[0,1,0]:[1,0,0])):null,v=direction?cross(direction,u):null;
    const radial=a=>add(mul(u,Math.sin(a)),mul(v,Math.cos(a)));
    const point=(a,b)=>direction?add(center,add(mul(radial(a),r+tubeR*Math.cos(b)),mul(direction,tubeR*Math.sin(b)))):axis==='z'
      ?add(center,[(r+tubeR*Math.cos(b))*Math.sin(a),(r+tubeR*Math.cos(b))*Math.cos(a),tubeR*Math.sin(b)])
      :add(center,[(r+tubeR*Math.cos(b))*Math.sin(a),tubeR*Math.sin(b),(r+tubeR*Math.cos(b))*Math.cos(a)]);
    const normal=(a,b)=>direction?add(mul(radial(a),Math.cos(b)),mul(direction,Math.sin(b))):axis==='z'?[Math.cos(b)*Math.sin(a),Math.cos(b)*Math.cos(a),Math.sin(b)]:[Math.cos(b)*Math.sin(a),Math.sin(b),Math.cos(b)*Math.cos(a)];
    for(let i=0;i<segments;i++)for(let j=0;j<sides;j++){
      const a=i*2*Math.PI/segments,A=(i+1)*2*Math.PI/segments,b=j*2*Math.PI/sides,B=(j+1)*2*Math.PI/sides;
      quad(point(a,b),point(A,b),point(A,B),point(a,B),m,[normal(a,b),normal(A,b),normal(A,B),normal(a,B)],[[b/6.283, a*r],[b/6.283,A*r],[B/6.283,A*r],[B/6.283,a*r]]);
    }
  }
  const width=deckHalfWidth;
  const deck=hullDeck;
  const stations=[...Array.from({length:113},(_,i)=>-6.4+i*12/112),QUARTERDECK_START].sort((a,b)=>a-b);
  // Fine individual deck boards with a recessed continuous caulk bed.
  const deckPlanksStart=out.length;
  for(let x=-1.8;x<1.8;x+=0.145)for(let z=5.6;z>-6.4;z-=0.16){
    const end=Math.max(-6.4,z-0.16),l=Math.max(x,-width(z)+.075,-width(end)+.075),r=Math.min(x+.140,width(z)-.075,width(end)-.075);
    if(r>l)deckBoard(l,r,deck(z),z,deck(end),end,Math.round((x+1.8)/.145));
  }
  group('deck.main.planks','deck.main',deckPlanksStart);
  const deckBedStart=out.length;
  for(let i=0;i<stations.length-1;i++){
    const z0=stations[i+1],z1=stations[i];
    quad([-width(z0),deck(z0)-0.025,z0],[width(z0),deck(z0)-0.025,z0],[width(z1),deck(z1)-0.025,z1],[-width(z1),deck(z1)-0.025,z1],4);
  }
  group('deck.main.bed','deck.main',deckBedStart);
  for(const side of [-1,1]){
    // Continuous beveled cap rail sweep: no overlapping end-caps at joints.
    const railRing=[[-0.095,-0.035],[-0.08,-0.055],[0.08,-0.055],[0.105,-0.03],[0.105,0.035],[0.08,0.055],[-0.08,0.055],[-0.095,0.035]];
    const bulwarkStart=out.length;
    for(let i=0;i<stations.length-1;i++){
      const z0=stations[i+1],z1=stations[i],middle=(z0+z1)*.5;
      if(middle>=QUARTERDECK_START)continue; // the cabin replaces these bulwarks
      const floor=deck;
      const rail=(z,k)=>[side*(width(z)+railRing[k][0]*(hullHalfWidth(z,deck(z))-width(z))/.105),floor(z)+.66+railRing[k][1],z];
      const x0=side*width(z0),x1=side*width(z1);
      const outer0=side*hullHalfWidth(z0,deck(z0)),outer1=side*hullHalfWidth(z1,deck(z1));
      // Waterway closes the margin between deck boards and the bulwark.
      const inner=z=>side*Math.max(0,width(z)-.075),outer=z=>side*(width(z)+.018);
      quad([inner(z0),floor(z0)+.002,z0],[outer(z0),floor(z0)+.002,z0],
        [outer(z1),floor(z1)+.002,z1],[inner(z1),floor(z1)+.002,z1],1);
      for(let j=0;j<8;j++)quad(rail(z0,j),rail(z1,j),rail(z1,(j+1)%8),rail(z0,(j+1)%8),1,null,[[j*0.1,z0*0.6],[j*0.1,z1*0.6],[(j+1)*0.1,z1*0.6],[(j+1)*0.1,z0*0.6]]);
      for(const z of [z0,z1])if(z===QUARTERDECK_START || z===stations[0])
        for(let j=0;j<8;j++)tri([side*width(z),floor(z)+.66,z],rail(z,j),rail(z,(j+1)%8),1);
      // Recessed caulking, with the bottom strake deliberately open at scuppers.
      const scupper=Math.abs((((5.3-middle)/.82)%1+1)%1-.5)<.17;
      const caulkBottom=scupper?.123:.119;
      quad([(x0+outer0)/2,floor(z0)+caulkBottom,z0],[(x1+outer1)/2,floor(z1)+caulkBottom,z1],
        [(x1+outer1)/2,floor(z1)+.615,z1],[(x0+outer0)/2,floor(z0)+.615,z0],4);
      for(let row=0;row<5;row++){
        // Open scuppers between posts, aligned with the deck-water drain field.
        if(row===0 && scupper)continue;
        const a=floor(z0)+row*0.123,b=floor(z1)+row*0.123;
        quad([x0,a,z0],[x1,b,z1],[x1,b+0.119,z1],[x0,a+0.119,z0],1,null,[[a*1.7,z0*0.6],[b*1.7,z1*0.6],[(b+0.119)*1.7,z1*0.6],[(a+0.119)*1.7,z0*0.6]]);
        quad([outer0,a,z0],[outer0,a+.119,z0],[outer1,b+.119,z1],[outer1,b,z1],1,null,[[a*1.7,z0*.6],[(a+.119)*1.7,z0*.6],[(b+.119)*1.7,z1*.6],[b*1.7,z1*.6]]);
        // Real thickness is visible around drain openings and exposed ends.
        for(const h of row===0?[0,.119]:row===1?[0]:[])quad([x0,a+h,z0],[outer0,a+h,z0],[outer1,b+h,z1],[x1,b+h,z1],1);
        if(row===0)for(const [x,X,y,z]of [[x0,outer0,a,z0],[x1,outer1,b,z1]])quad([x,y,z],[X,y,z],[X,y+.119,z],[x,y+.119,z],1);
      }

    }
    part(`bulwark:${side}`,bulwarkStart);
    const bulwarkFramesStart=out.length;
    for(let z=5.3;z>-6.15;z-=0.82){
      if(z>=QUARTERDECK_START)continue;
      const x=side*(width(z)-0.065),y=vesselDeck(z);
      beam([x,y+0.015,z],[x,y+0.71,z],0.095,0.11,5);
      for(const h of [0.16,0.48])tube([x-side*0.062,y+h,z],[x-side*0.07,y+h,z],0.014,3,0.014,10);
      // Iron knee straps and small wooden cleats.
      beam([x-side*0.045,y+0.04,z],[x-side*0.045,y+0.12,z],0.105,0.118,3);
      if(z>-4.6){
        beam([x,y+.4,z],[x-side*.12,y+.4,z],.065,.065,5);
        beam([x-side*0.12,y+0.4,z],[x-side*0.12,y+0.5,z],0.065,0.065,5);
        tube([x-side*0.12,y+0.5,z-0.1],[x-side*0.12,y+0.5,z+0.1],0.026,1,0.02);
      }
    }
    group(`bulwark.frames:${side}`,'hull',bulwarkFramesStart);
  }
  // Continuous foredeck follows the sheer, as in the reconstruction plan.
  const bowStart=out.length;
  beam([0,.65,-6.35],[0,deck(-6.4)+.7,-6.48],.12,.16,5);
  tube([0,1.17,-4.9],[0,2.05,-8.4],0.145,1,0.045,28);
  for(const side of [-1,1]){
    tube([side*width(-4.8),deck(-4.8)+0.65,-4.8],[0,2.03,-8.3],0.016,2,0.016,12);
    tube([side*0.32,0.9,-6.0],[0,2.03,-8.3],0.012,2,0.012,10);
  }
  for(let i=0;i<9;i++){
    const t=(6.1+i*.038-4.9)/3.5;
    torus([0,1.17+t*.88,-6.1-i*.038],.145-.1*t+.004,.015,2,[0,.88,-3.5],32,8);
  }
  for(let turn=0;turn<5;turn++)torus([0.86,deck(-3.2)+0.025,-3.2],0.13+turn*0.028,0.013,2,'y',48);
  group('bow.structure','hull',bowStart);
  // Main-deck grating and its weathered frame.
  const hatchFrameStart=out.length;
  for(const x of [-0.48,0.48])beam([x,deck(-3.0)+0.03,-2.65],[x,deck(-3.6)+0.03,-3.65],0.075,0.09,1);
  for(const z of [-2.65,-3.65])beam([-0.48,deck(z)+0.03,z],[0.48,deck(z)+0.03,z],0.075,0.09,6);
  for(let x=-0.4;x<0.45;x+=0.10)beam([x,deck(-2.68),-2.68],[x,deck(-3.62),-3.62],0.027,0.035,1);
  for(let z=-2.75;z>-3.65;z-=0.12)beam([-0.43,deck(z)+0.016,z],[0.43,deck(z)+0.016,z],0.025,0.025,6);
  group('hatch.frame','deck.main',hatchFrameStart);
  const hatchCoverStart=out.length;
  quad([-.44,deck(-2.65)+.085,-2.65],[.44,deck(-2.65)+.085,-2.65],
    [.44,deck(-2.65)+.085,-3.61],[-.44,deck(-2.65)+.085,-3.61],18);
  group('hatch.cover','hull',hatchCoverStart,{type:'hatch'});
  const foreBittsStart=out.length;
  for(const x of [-0.35,0.35])beam([x,vesselDeck(-4.8),-4.8],[x,vesselDeck(-4.8)+0.36,-4.8],0.11,0.11,5);
  beam([-0.5,vesselDeck(-4.8)+0.28,-4.8],[0.5,vesselDeck(-4.8)+0.28,-4.8],0.1,0.1,6);
  group('deck.fore.bitts','deck.main',foreBittsStart);
  // Direct wooden tiller: rigidly keyed to the rudder stock, below quarterdeck.
  const tillerStart=out.length;
  tube([0,.95,TILLER_PIVOT[2]],TILLER_PIVOT,.065,3,.065,16);
  beam(TILLER_PIVOT,TILLER_HANDLE,.105,.09,7);
  tube([-.09,TILLER_PIVOT[1],TILLER_PIVOT[2]],
    [.09,TILLER_PIVOT[1],TILLER_PIVOT[2]],.045,8,.045,12);
  group('helm.tiller','helm.tiller',tillerStart,{type:'tiller'});

  // Full planked hull, from the sharp stem to the square transom.
  const hullPoint=hullSurfacePoint;
  const sectionAngles=new Map(stations.map(z=>[z,[hullSheerAngle(z,-.275),hullSheerAngle(z,-.425)]]));
  const sectionAngle=(z,k)=>k===1?sectionAngles.get(z)[0]:k===2?sectionAngles.get(z)[1]
    :k===22?Math.PI-sectionAngles.get(z)[1]:k===23?Math.PI-sectionAngles.get(z)[0]:k*Math.PI/24;
  const hullNormal=(z,a)=>{
    const tangent=sub(hullPoint(z,Math.min(Math.PI,a+0.001)),hullPoint(z,Math.max(0,a-0.001)));
    const longitudinal=sub(hullPoint(Math.min(5.6,z+0.001),a),hullPoint(Math.max(-6.4,z-0.001),a));
    const n=norm(cross(longitudinal,tangent)); return n[0]*Math.cos(a)<0?mul(n,-1):n;
  };
  const hullStart=out.length;
  for(let j=0;j<stations.length-1;j++)for(let k=0;k<24;k++){
    const z0=stations[j],z1=stations[j+1],a=sectionAngle(z0,k),b=sectionAngle(z0,k+1),A=sectionAngle(z1,k),B=sectionAngle(z1,k+1);
    quad(hullPoint(z0,a),hullPoint(z1,A),hullPoint(z1,B),hullPoint(z0,b),15,
      [hullNormal(z0,a),hullNormal(z1,A),hullNormal(z1,B),hullNormal(z0,b)],
      [[a*.8,z0*.6],[A*.8,z1*.6],[B*.8,z1*.6],[b*.8,z0*.6]]);
  }
  part('hull',hullStart);
  // Two proud, tarred wales emphasize the sheer and fuller hull sections.
  for(const side of [-1,1])for(const offset of [-0.35,0.25]){
    const start=out.length;
    const wale=(z,dy,proud=.035)=>{
      const angle=offset<0?sectionAngles.get(z)[dy>0?0:1]:0;
      const p=hullPoint(z,side>0?angle:Math.PI-angle);
      if(offset>0)p[1]+=offset+dy;
      p[0]+=side*proud;return p;
    };
    for(let i=0;i<stations.length-1;i++){
      const z=stations[i],Z=stations[i+1];
      const a=wale(z,-.075),b=wale(Z,-.075),c=wale(Z,.075),d=wale(z,.075);
      quad(a,b,c,d,16,null,[[a[1]*1.6,z*.6],[b[1]*1.6,Z*.6],[c[1]*1.6,Z*.6],[d[1]*1.6,z*.6]]);
      for(const dy of [-0.075,0.075]){
        const a=wale(z,dy),b=wale(Z,dy);
        quad(a,b,wale(Z,dy,0),wale(z,dy,0),16);
      }
    }
    for(const z of [stations[0],stations.at(-1)])quad(wale(z,-.075),wale(z,.075),wale(z,.075,0),wale(z,-.075,0),16);
    part(`wale:${side}:${offset}`,start);
  }
  // Close the narrow raked stem between the port and starboard planking.
  const keelStart=out.length;
  for(let k=0;k<12;k++){
    const a=sectionAngle(-6.4,k),b=sectionAngle(-6.4,k+1);
    quad(hullPoint(-6.4,a),hullPoint(-6.4,Math.PI-a),hullPoint(-6.4,Math.PI-b),hullPoint(-6.4,b),16);
  }
  // Keel, transom planking, and working rudder. Cabin replaces the old stern rail.
  beam([0,-HULL_DRAFT,-6.4+HULL_BOW_RAKE],[0,-HULL_DRAFT,5.6-HULL_STERN_RAKE],.13,.15,16);
  for(let i=0;i<24;i++){
    const stem=t=>{const p=hullPoint(-6.4,t*Math.PI/2);return [0,p[1],p[2]-.025];};
    beam(stem(i/24),stem((i+1)/24),.09,.13,16);
  }
  group('hull.keel-stem','hull',keelStart);
  const transomStart=out.length;
  for(let k=0;k<24;k++){
    const a=sectionAngle(stations.at(-1),k),b=sectionAngle(stations.at(-1),k+1);
    tri([0,deck(5.6),5.6],hullPoint(5.6,a),hullPoint(5.6,b),1);
  }
  part('transom',transomStart);
  const rudderStart=out.length;
  tube([0,-HULL_DRAFT-.05,5.68],[0,0.95,5.68],0.055,3,0.055,16);
  beam([0,-HULL_DRAFT+.10,6.05],[0,-0.1,6.05],0.72,0.075,14);
  group('helm.rudder','hull',rudderStart,{type:'rudder'});
  const sternFramesStart=out.length;
  for(let i=0;i<24;i++){
    const stern=t=>{const p=hullPoint(5.6,t*Math.PI/2);return [0,p[1],p[2]+.025];};
    beam(stern(i/24),stern((i+1)/24),.12,.13,16);
  }
  for(const y of [-0.9,-0.1,0.45]){
    let low=0,high=Math.PI/2;
    for(let i=0;i<24;i++){const mid=(low+high)/2;if(hullPoint(5.6,mid)[1]>y)low=mid;else high=mid;}
    const z=hullPoint(5.6,(low+high)/2)[2];
    beam([-.12,y,z+.025],[.12,y,z+.025],.07,.07,3);
    for(const side of [-1,1])beam([side*.065,y,z+.025],[side*.065,y,5.68],.045,.055,3);
    torus([0,y,5.68],.058,.015,3,'y',16);
  }
  group('hull.stern-frames','hull',sternFramesStart);

  // A broad raised stern follows the hull's taper; all ornament is real geometry.
  const cabinStart=out.length;
  const zFront=QUARTERDECK_START,zBack=5.6,roof=QUARTERDECK_HEIGHT;
  const cabinWidth=z=>width(z)+0.105;
  for(const [a,b] of [[-cabinWidth(zFront),-.55],[.55,cabinWidth(zFront)]])
    quad([a,deck(zFront),zFront],[b,deck(zFront),zFront],[b,roof,zFront],[a,roof,zFront],1);
  quad([-.55,1.99,zFront],[.55,1.99,zFront],[.55,roof,zFront],[-.55,roof,zFront],1);
  const cabinStations=Array.from({length:25},(_,i)=>zFront+(zBack-zFront)*i/24);
  for(const side of [-1,1]){
    for(const y of [1.13,2.22])railSweep(cabinStations,z=>[side*(cabinWidth(z)+.035),y,z],.07,.07,16);
    railSweep(cabinStations,z=>[side*(cabinWidth(z)-.04),roof+.49,z],.1,.08,17);
    railSweep(cabinStations,z=>[side*(cabinWidth(z)-.04),roof+.23,z],.055,.055,16);
    railSweep(cabinStations,z=>[side*(cabinWidth(z)-.04),roof-.035,z],.17,.07,1);
  }
  // The afterdeck is planking over a solid caulk bed, with a ceiling and rim.
  const afterdeckBedStart=out.length;
  for(let i=0;i<cabinStations.length-1;i++){
    const z=cabinStations[i],Z=cabinStations[i+1];
    for(const [y,mat]of [[roof-.018,4],[roof-.075,1]])quad([-cabinWidth(z),y,z],[cabinWidth(z),y,z],[cabinWidth(Z),y,Z],[-cabinWidth(Z),y,Z],mat);
  }
  for(const z of [zFront,zBack]){
    beam([-cabinWidth(z),roof-.04,z],[cabinWidth(z),roof-.04,z],.09,.08,1);
  }
  group('deck.quarter.bed','hull',afterdeckBedStart);
  const afterdeckPlanksStart=out.length;
  for(let x=-1.7;x<1.7;x+=.145)for(let z=zFront+.045;z<zBack-.045;z+=.15){
    const Z=Math.min(zBack-.045,z+.15),edge=Math.min(cabinWidth(z),cabinWidth(Z))-.125;
    const l=Math.max(-edge,x),r=Math.min(edge,x+.14);
    if(r>l)deckBoard(l,r,roof,z,roof,Z,Math.round((x+1.7)/.145));
  }
  group('deck.quarter.planks','hull',afterdeckPlanksStart);
  // Wall panels stop at each rectangular light. Glazing is recessed 8 cm;
  // neither solid planking nor the former main-deck rail crosses the openings.
  function windowWall(start,end,centers,point,floor,steeringPort=false){
    const cy=1.69,r=.14,bottom=cy-.14;
      const panel=(a,b,lowA,lowB,highA,highB)=>quad(point(a,lowA),point(b,lowB),point(b,highB),point(a,highA),1,null,
        [[lowA*1.6,a*.55],[lowB*1.6,b*.55],[highB*1.6,b*.55],[highA*1.6,a*.55]]);
    const solid=(a,b)=>{
      const steps=Math.ceil((b-a)/.12);
      for(let i=0;i<steps;i++){
        const u=a+(b-a)*i/steps,U=a+(b-a)*(i+1)/steps;
        if(steeringPort && u<.13 && U>-.13){
          const l=Math.max(u,-.13),r=Math.min(U,.13);
          if(u<l)panel(u,l,floor(u),floor(l),roof,roof);
          panel(l,r,floor(l),floor(r),1.22,1.22);panel(l,r,1.54,1.54,roof,roof);
          if(r<U)panel(r,U,floor(r),floor(U),roof,roof);
        }else panel(u,U,floor(u),floor(U),roof,roof);
      }
    };
    let previous=start;
    for(const center of centers){
      solid(previous,center-r);
      const arch=Array.from({length:11},(_,i)=>{
        const a=Math.PI-i*Math.PI/10;return [center+r*Math.cos(a),cy+.14];
      });
      for(let i=0;i<10;i++){
        const [u,y]=arch[i],[U,Y]=arch[i+1];
        panel(u,U,floor(u),floor(U),bottom,bottom);
        panel(u,U,y,Y,roof,roof);
      }
      const rim=[[center-r,bottom],[center+r,bottom],...arch.slice().reverse()];
      for(let i=0;i<rim.length;i++){
        const [u,y]=rim[i],[U,Y]=rim[(i+1)%rim.length];
        quad(point(u,y),point(U,Y),point(U,Y,-.085),point(u,y,-.085),16);
        tri(point(center,cy,-.08),point(u,y,-.08),point(U,Y,-.08),11);
        tube(point(u,y,.022),point(U,Y,.022),.03,17,.03,8);
      }
      beam(point(center,bottom,.018),point(center,cy+.14,.018),.024,.024,17);
      beam(point(center-r,cy+.06,.018),point(center+r,cy+.06,.018),.024,.024,17);
      previous=center+r;
    }
    solid(previous,end);
  }
  windowWall(-cabinWidth(zBack),cabinWidth(zBack),[-.48,.48],
    (x,y,inset=0)=>[x,y,zBack+inset],()=>deck(zBack),true);
  for(const side of [-1,1]){
    windowWall(zFront,zBack,[],
      (z,y,inset=0)=>[side*(cabinWidth(z)+inset),y,z],deck);
    for(const z of [...Array.from({length:6},(_,i)=>zFront+i*.48),zBack]){
      const x=side*(cabinWidth(z)-.04);
      beam([x,roof,z],[x,roof+.49,z],.06,.07,17);
    }
    beam([side*.59,deck(zFront),zFront-.025],[side*.59,2.04,zFront-.025],.08,.08,17);
  }
  beam([-.63,2.04,zFront-.025],[.63,2.04,zFront-.025],.08,.08,17);
  for(const y of [roof+.23,roof+.49])beam([-cabinWidth(zBack)+.04,y,zBack],[cabinWidth(zBack)-.04,y,zBack],.09,.07,17);
  for(const x of [-.65,0,.65])beam([x,roof,zBack],[x,roof+.49,zBack],.06,.07,17);
  group('cabin','hull',cabinStart);
  // Museum Nina reconstruction: four small swivel falconets on the poop rail.
  // Dimensions below are authored at human scale, converted to design units.
  for(const side of [-1,1])for(const z of [3.25,4.9]){
    const gunStart=out.length;
    const x=side*(cabinWidth(z)-.04),y=roof+.61;
    tube([x,roof,z],[x,y-.08,z],.035,3,.035,10);
    beam([x,y-.14,z-.10],[x,y-.14,z+.10],.04,.045,3);
    for(const dz of [-.10,.10])beam([x,y-.16,z+dz],[x,y+.035,z+dz],.035,.035,3);
    tube([x,y,z-.13],[x,y,z+.13],.028,3,.028,10);
    const recoilStart=out.length,gunId=(side<0?0:2)+(z===3.25?0:1);
    const breech=[x-side*.24,y,z],muzzle=[x+side*.49,y+.025,z];
    // Barrel sides only: a dark recessed bore replaces the usual tube end cap.
    const axis=norm(sub(muzzle,breech)),up=norm(cross(axis,[0,0,1])),across=cross(axis,up);
    const ring=(p,r,i)=>add(p,add(mul(up,r*Math.cos(i*Math.PI/8)),mul(across,r*Math.sin(i*Math.PI/8))));
    for(let i=0;i<16;i++){
      quad(ring(breech,.065,i),ring(muzzle,.047,i),ring(muzzle,.047,i+1),ring(breech,.065,i+1),3);
      quad(ring(muzzle,.047,i),ring(muzzle,.031,i),ring(muzzle,.031,i+1),ring(muzzle,.047,i+1),3);
      const deep=add(muzzle,mul(axis,-.10));
      quad(ring(muzzle,.031,i),ring(deep,.031,i),ring(deep,.031,i+1),ring(muzzle,.031,i+1),4);
      tri(deep,ring(deep,.031,i+1),ring(deep,.031,i),4);
      tri(breech,ring(breech,.065,i+1),ring(breech,.065,i),3);
    }
    for(const t of [.15,.35,.72]){const p=add(breech,mul(sub(muzzle,breech),t));tube(add(p,mul(axis,-.018)),add(p,mul(axis,.018)),.068-t*.02,3,.068-t*.02,12);}
    beam(breech,[x-side*.52,y-.10,z],.028,.028,3);
    beam([x-side*.13,y-.065,z],[x-side*.13,y+.075,z],.07,.10,3);
    group(`gunnery.recoil.${gunId}`,'hull',recoilStart,{type:'gun-recoil',gunId,axis:[side*.73,.025,0]});
    group(`gun:${side}:${z}`,'hull',gunStart);
  }

  // Companionway steps clear the mizzen and mainmast shrouds.
  const stairsStart=out.length;
  const aftStepFloor=deck(1.5),aftSteps=Math.ceil((roof-aftStepFloor)*HULL_VERTICAL_SCALE/.23);
  for(const x of [.72,1.20]){
    const start=out.length;
    beam([x,aftStepFloor+.015,1.41],[x,roof-.045,zFront+.025],.07,.14,6);
    part(`stair:stringer:${x}`,start);
  }
  for(let i=0;i<aftSteps;i++){
    const y=aftStepFloor+(roof-aftStepFloor)*(i+1)/aftSteps-.02,z=1.5+i*1.14/(aftSteps-1);
    const start=out.length;
    beam([.7,y,z],[1.22,y,z],1.14/aftSteps+.025,.04,6);
    part(`stair:tread:${i}`,start);
  }
  group('stairs','hull',stairsStart);
  // Both catheads remain part of the hull. The working port anchor/rode is a
  // separate animated object; the starboard anchor remains a secured spare.
  for(const side of [-1,1]){
    const attachment=anchorCathead(side),[x,,z]=attachment.tip,start=out.length;
    beam(attachment.root,attachment.tip,.11,.13,17);
    part(`anchor:cathead:${side}`,start);
    if(side===-1)continue;
    const spareStart=out.length;
    tube([x,vesselDeck(z)+.76,z],[x,.7,z],.023,12,.023,8);
    beam([x,.83,z],[x,-.02,z],.065,.065,3);
    beam([x,.66,z-.3],[x,.66,z+.3],.085,.09,16);
    for(const dz of [-1,1]){
      beam([x,0,z],[x,.17,z+dz*.31],.06,.06,3);
      tri([x-.11,.17,z+dz*.31],[x+.11,.17,z+dz*.31],[x,.39,z+dz*.4],3);
    }
    part('anchor:spare',spareStart);
  }

  // Single masts, stays and Mediterranean runners; geometry follows the selected plan.
  // Fractional material bits identify moving sails without widening the vertex buffer.
  function squareSail({id,z,top,width:w,height:h,belly}){
    const name=mastNames[id-1],canvasStart=out.length;
    const tag=id/16;
    const columns=28,rows=20;
    const point=(u,v)=>{
      const sideShape=1.0-0.11*Math.sin(v*Math.PI)+0.025*v;
      return [(u-0.5)*w*sideShape,top-v*h+0.28*Math.sin(u*Math.PI)*v*v,
        z-belly*Math.sin(u*Math.PI)*Math.sin(v*Math.PI*.88)];
    };
    const normal=(u,v)=>{
      const du=sub(point(u+0.001,v),point(u-0.001,v)),dv=sub(point(u,v+0.001),point(u,v-0.001));
      return norm(cross(du,dv));
    };
    for(let i=0;i<columns;i++)for(let j=0;j<rows;j++){
      const u=i/columns,U=(i+1)/columns,v=j/rows,V=(j+1)/rows;
      quad(point(u,v),point(U,v),point(U,V),point(u,V),9+tag,[normal(u,v),normal(U,v),normal(U,V),normal(u,V)],[[u,v],[U,v],[U,V],[u,V]]);
    }
    group(`sail.${name}.canvas`,`sail.${name}`,canvasStart,{type:'square-cloth',sail:id});
    const yardStart=out.length;
    tube([-w*0.56,top+0.035,z],[w*0.56,top+0.035,z],0.066,10+tag,0.045,18);
    group(`yard.${name}`,`yard.${name}`,yardStart,{type:'square-yard',sail:id});
    const edgeStart=out.length;
    for(const u of [0,1])for(let j=0;j<rows;j++)tube(point(u,j/rows),point(u,(j+1)/rows),0.013,19+tag,0.013,8,null,[[u,j/rows],[u,(j+1)/rows]]);
    for(let i=0;i<columns;i++)tube(point(i/columns,1),point((i+1)/columns,1),0.014,19+tag,0.014,8,null,[[i/columns,1],[(i+1)/columns,1]]);
    group(`sail.${name}.edge`,`sail.${name}`,edgeStart,{type:'sail-edge',sail:id});
  }
  for(const [mast,{z,height,r}] of RIG_MASTS.entries()){
    const mastStart=out.length;
    tube(mastPoint(mast,deck(z)),mastPoint(mast,height),r,10,r*0.35,24);
    for(let y=1.5;y<height;y+=1.4)torus(mastPoint(mast,y),r*(1-.65*(y-deck(z))/(height-deck(z)))+.003,.012,3,sub(mastPoint(mast,y+1),mastPoint(mast,y)),24,6);
    for(const side of [-1,1]){
      const {feet}=shroudGeometry(mast,side);
      for(const foot of [...feet,feet[0].map((v,i)=>(v+feet[1][i])*.5)]){
        beam(add(foot,[side*.025,-.4,0]),add(foot,[side*.025,.02,0]),.045,.035,3);
        tube(add(foot,[-side*.025,0,0]),add(foot,[side*.025,0,0]),.065,16,.065,12);
      }
    }
    group(`mast.${mastNames[mast]}`,`mast.${mastNames[mast]}`,mastStart);
  }
  for(const t of SAIL_TACKLES){
    const tackleStart=out.length;
    const bottom=tacklePoint(t.mast,-10);
    tube(add(bottom,[-.07,0,0]),add(bottom,[.07,0,0]),.065,16,.065,12);
    beam(add(bottom,[0,-.25,0]),add(bottom,[0,.06,0]),.075,.09,5);
    group(`tackle.${mastNames[t.mast]}`,`mast.${mastNames[t.mast]}`,tackleStart);
  }
  // Lower stay attachments at the waterways, without channels.
  const stayAttachmentsStart=out.length;
  for(const {a:foot,side} of RIG_LINES.filter(line=>line.kind==='stay')){
    tube(add(foot,[-side*.035,0,0]),add(foot,[side*.035,0,0]),.055,16,.055,12);
    beam(add(foot,[0,-.07,0]),add(foot,[0,.015,0]),.045,.05,3);
  }
  group('rig.stay-attachments','hull',stayAttachmentsStart);
  // No round tops or oversized lookout baskets in this reconstruction.
  for(const sail of SAIL_PLAN)if(sail.kind==='square')squareSail(sail);
  // Lateen courses: the long oblique yard defines the triangular silhouette.
  // The foot clears the open deck; steering takes place below the quarterdeck.
  for(const sail of SAIL_PLAN.filter(s=>s.kind==='lateen')){
    const name=mastNames[sail.mast],canvasStart=out.length;
    const [la,lb,lc]=sail.corners,resolution=26,lateenTag=sail.id/16;
    const lateen=(u,v)=>{
      const p=add(la,add(mul(sub(lb,la),u),mul(sub(lc,la),v)));
      p[0]+=sail.belly*27*u*v*(1-u-v);
      return p;
    };
    const ln=(u,v)=>norm(cross(sub(lateen(u+.0001,v),lateen(u-.0001,v)),sub(lateen(u,v+.0001),lateen(u,v-.0001))));
    function lateenTri(points){tri(...points.map(([u,v])=>lateen(u,v)),13+lateenTag,points.map(([u,v])=>ln(u,v)),points);}
    for(let i=0;i<resolution;i++)for(let j=0;j<resolution-i;j++){
      const u=i/resolution,v=j/resolution,d=1/resolution;
      lateenTri([[u,v],[u+d,v],[u,v+d]]);
      if(i+j<resolution-1)lateenTri([[u+d,v],[u+d,v+d],[u,v+d]]);
    }
    group(`sail.${name}.canvas`,`sail.${name}`,canvasStart,{type:'lateen-cloth',sail:sail.id});
    const yardStart=out.length;
    tube(add(la,[0,.14,.12]),add(lb,[0,-.12,-.1]),.07,10+lateenTag,.045,18);
    group(`yard.${name}`,`yard.${name}`,yardStart,{type:'lateen-yard',sail:sail.id});
    const edgeStart=out.length;
    for(const [a,b] of [[[0,0],[1,0]],[[1,0],[0,1]],[[0,1],[0,0]]])for(let i=0;i<resolution;i++){
      const u=a.map((v,j)=>v+(b[j]-v)*i/resolution),v=a.map((v,j)=>v+(b[j]-v)*(i+1)/resolution);
      tube(lateen(...u),lateen(...v),.015,19+lateenTag,.015,10,null,[u,v],true);
    }
    group(`sail.${name}.edge`,`sail.${name}`,edgeStart,{type:'sail-edge',sail:sail.id});
  }
  for(const [index,line] of RIG_LINES.entries()){
    const ropeStart=out.length;
    for(let j=0;j<RIG_SEGMENTS;j++){
      const {a,b,r,r2}=line,t=ropeParameter(line,j),u=ropeParameter(line,j+1);
      const point=t=>a.map((v,i)=>v+(b[i]-v)*t),radius=t=>r+(r2-r)*t;
      tube(point(t),point(u),radius(t),12,radius(u),6,null,[[100+index,t],[100+index,u]],true);
    }
    group(`rope.${index}.${line.kind}`,`mast.${mastNames[line.mast]}`,ropeStart,{type:'rig-rope',line:index,kind:line.kind});
  }
  return new Float32Array(out);
}
