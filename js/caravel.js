import { hullDeck, deckHalfWidth, HULL_DRAFT, HULL_BOW_RAKE, HULL_STERN_RAKE, hullHalfWidth, hullSurfacePoint, vesselDeck, TILLER_PIVOT, TILLER_HANDLE,
  QUARTERDECK_START, QUARTERDECK_HEIGHT, HULL_VERTICAL_SCALE } from './hull.js';
import { RIG_MASTS, mastPoint, shroudGeometry, SAIL_TACKLES, tacklePoint, standingRiggingLines } from './rigging.js';
import { SAIL_PLAN, runningRiggingLines } from './sailing.js';

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
export function createCaravelMesh() {
  const out=[];
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
      const board=Math.floor((p[0]+1.8)/0.145);
      const uv=uvs?uvs[i]:[p[0]*1.6+Math.sin(board*17.1)*0.43,p[2]*0.55];
      out.push(...p,...(normals?normals[i]:n),m,...uv);
    }
  }
  function quad(a,b,c,d,m=0,ns,uvs) {
    tri(a,b,c,m,ns&&[ns[0],ns[1],ns[2]],uvs&&[uvs[0],uvs[1],uvs[2]]);
    tri(a,c,d,m,ns&&[ns[0],ns[2],ns[3]],uvs&&[uvs[0],uvs[2],uvs[3]]);
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
  function tube(a,b,r,m=2,r2=r,sides=12,motion=null,clothUV=null) {
    const axis=norm(sub(b,a)),u=norm(cross(axis,Math.abs(axis[1])<0.9?[0,1,0]:[1,0,0])),v=cross(axis,u);
    const n=i=>add(mul(u,Math.cos(i*2*Math.PI/sides)),mul(v,Math.sin(i*2*Math.PI/sides)));
    for(let i=0;i<sides;i++){
      const na=n(i),nb=n(i+1),length=Math.hypot(...sub(b,a));
      const uv=(u,end)=>clothUV?clothUV[end]:[u,motion?motion[end]:end*length*.75];
      quad(add(a,mul(na,r)),add(b,mul(na,r2)),add(b,mul(nb,r2)),add(a,mul(nb,r)),m,[na,na,nb,nb],[uv(i/sides*.7,0),uv(i/sides*.7,1),uv((i+1)/sides*.7,1),uv((i+1)/sides*.7,0)]);
      tri(a,add(a,mul(nb,r)),add(a,mul(na,r)),m,null,motion||clothUV?[uv(0,0),uv(0,0),uv(0,0)]:undefined);
      tri(b,add(b,mul(na,r2)),add(b,mul(nb,r2)),m,null,motion||clothUV?[uv(0,1),uv(0,1),uv(0,1)]:undefined);
    }
  }
  function torus(center,r,tubeR,m=2,axis='z',segments=64) {
    const point=(a,b)=>axis==='z'
      ?add(center,[(r+tubeR*Math.cos(b))*Math.sin(a),(r+tubeR*Math.cos(b))*Math.cos(a),tubeR*Math.sin(b)])
      :add(center,[(r+tubeR*Math.cos(b))*Math.sin(a),tubeR*Math.sin(b),(r+tubeR*Math.cos(b))*Math.cos(a)]);
    const normal=(a,b)=>axis==='z'?[Math.cos(b)*Math.sin(a),Math.cos(b)*Math.cos(a),Math.sin(b)]:[Math.cos(b)*Math.sin(a),Math.sin(b),Math.cos(b)*Math.cos(a)];
    for(let i=0;i<segments;i++)for(let j=0;j<10;j++){
      const a=i*2*Math.PI/segments,A=(i+1)*2*Math.PI/segments,b=j*2*Math.PI/10,B=(j+1)*2*Math.PI/10;
      quad(point(a,b),point(A,b),point(A,B),point(a,B),m,[normal(a,b),normal(A,b),normal(A,B),normal(a,B)],[[b/6.283, a*r],[b/6.283,A*r],[B/6.283,A*r],[B/6.283,a*r]]);
    }
  }
  const width=deckHalfWidth;
  const deck=hullDeck;
  // Fine individual deck boards with a recessed continuous caulk bed.
  for(let x=-1.8;x<1.8;x+=0.145)for(let z=5.6;z>-6.4;z-=0.16){
    const end=Math.max(-6.4,z-0.16),l=Math.max(x,-width(z)+0.04,-width(end)+0.04),r=Math.min(x+0.140,width(z)-0.04,width(end)-0.04);
    if(r>l)quad([l,deck(z),z],[r,deck(z),z],[r,deck(end),end],[l,deck(end),end],0);
  }
  for(let i=0;i<96;i++){
    const z0=5.6-i*12/96,z1=5.6-(i+1)*12/96;
    quad([-width(z0),deck(z0)-0.025,z0],[width(z0),deck(z0)-0.025,z0],[width(z1),deck(z1)-0.025,z1],[-width(z1),deck(z1)-0.025,z1],4);
  }
  for(const side of [-1,1]){
    // Continuous beveled cap rail sweep: no overlapping end-caps at joints.
    const railRing=[[-0.095,-0.035],[-0.08,-0.055],[0.08,-0.055],[0.105,-0.03],[0.105,0.035],[0.08,0.055],[-0.08,0.055],[-0.095,0.035]];
    const stations=[...Array.from({length:97},(_,i)=>5.6-i*12/96),QUARTERDECK_START].sort((a,b)=>b-a);
    for(let i=0;i<stations.length-1;i++){
      const z0=stations[i],z1=stations[i+1],middle=(z0+z1)*.5;
      if(middle>=QUARTERDECK_START)continue; // the cabin replaces these bulwarks
      const floor=deck;
      const rail=(z,k)=>[side*(width(z)+railRing[k][0]),floor(z)+0.66+railRing[k][1],z];
      const x0=side*width(z0),x1=side*width(z1);
      for(let j=0;j<8;j++)quad(rail(z0,j),rail(z1,j),rail(z1,(j+1)%8),rail(z0,(j+1)%8),1,null,[[j*0.1,z0*0.6],[j*0.1,z1*0.6],[(j+1)*0.1,z1*0.6],[(j+1)*0.1,z0*0.6]]);
      for(let row=0;row<5;row++){
        // Open scuppers between posts, aligned with the deck-water drain field.
        if(row===0 && Math.abs((((5.3-(z0+z1)*0.5)/0.82)%1+1)%1-0.5)<0.17)continue;
        const a=floor(z0)+row*0.123,b=floor(z1)+row*0.123;
        quad([x0,a,z0],[x1,b,z1],[x1,b+0.119,z1],[x0,a+0.119,z0],1,null,[[a*1.7,z0*0.6],[b*1.7,z1*0.6],[(b+0.119)*1.7,z1*0.6],[(a+0.119)*1.7,z0*0.6]]);
        quad([x0+side*0.105,a,z0],[x0+side*0.105,a+0.119,z0],[x1+side*0.105,b+0.119,z1],[x1+side*0.105,b,z1],1,null,[[a*1.7,z0*.6],[(a+.119)*1.7,z0*.6],[(b+.119)*1.7,z1*.6],[b*1.7,z1*.6]]);
      }

    }
    for(let z=5.3;z>-6.15;z-=0.82){
      if(z>=QUARTERDECK_START)continue;
      const x=side*(width(z)-0.065),y=vesselDeck(z);
      beam([x,y+0.015,z],[x,y+0.71,z],0.095,0.11,5);
      for(const h of [0.16,0.48])tube([x-side*0.062,y+h,z],[x-side*0.07,y+h,z],0.014,3,0.014,10);
      // Iron knee straps and small wooden cleats.
      beam([x-side*0.045,y+0.04,z],[x-side*0.045,y+0.12,z],0.105,0.118,3);
      if(z>-4.6){
        beam([x-side*0.12,y+0.4,z],[x-side*0.12,y+0.5,z],0.065,0.065,5);
        tube([x-side*0.12,y+0.5,z-0.1],[x-side*0.12,y+0.5,z+0.1],0.026,1,0.02);
      }
    }
  }
  // Continuous foredeck follows the sheer, as in the reconstruction plan.
  beam([0,.65,-6.35],[0,deck(-6.4)+.7,-6.48],.12,.16,5);
  tube([0,1.17,-4.9],[0,2.05,-8.4],0.145,1,0.045,28);
  for(const side of [-1,1]){
    tube([side*width(-4.8),deck(-4.8)+0.65,-4.8],[0,2.03,-8.3],0.016,2,0.016,12);
    tube([side*0.32,0.9,-6.0],[0,2.03,-8.3],0.012,2,0.012,10);
  }
  for(let i=0;i<9;i++)torus([0,1.17+(6.1+i*0.038-4.9)/3.5*.88,-6.1-i*0.038],0.13,0.015,2,'z',32);
  for(let turn=0;turn<5;turn++)torus([0.86,deck(-3.2)+0.025,-3.2],0.13+turn*0.028,0.013,2,'y',48);
  // Main-deck grating and its weathered frame.
  for(const x of [-0.48,0.48])beam([x,deck(-3.0)+0.03,-2.65],[x,deck(-3.6)+0.03,-3.65],0.075,0.09,1);
  for(const z of [-2.65,-3.65])beam([-0.48,deck(z)+0.03,z],[0.48,deck(z)+0.03,z],0.075,0.09,6);
  for(let x=-0.4;x<0.45;x+=0.10)beam([x,deck(-2.68),-2.68],[x,deck(-3.62),-3.62],0.027,0.035,1);
  for(let z=-2.75;z>-3.65;z-=0.12)beam([-0.43,deck(z)+0.016,z],[0.43,deck(z)+0.016,z],0.025,0.025,6);
  quad([-.44,deck(-2.65)+.085,-2.65],[.44,deck(-2.65)+.085,-2.65],
    [.44,deck(-2.65)+.085,-3.61],[-.44,deck(-2.65)+.085,-3.61],18);
  for(const x of [-0.35,0.35])beam([x,vesselDeck(-4.8),-4.8],[x,vesselDeck(-4.8)+0.36,-4.8],0.11,0.11,5);
  beam([-0.5,vesselDeck(-4.8)+0.28,-4.8],[0.5,vesselDeck(-4.8)+0.28,-4.8],0.1,0.1,6);
  // Direct wooden tiller: rigidly keyed to the rudder stock, below quarterdeck.
  tube([0,.95,TILLER_PIVOT[2]],TILLER_PIVOT,.065,3,.065,16);
  beam(TILLER_PIVOT,TILLER_HANDLE,.105,.09,7);
  tube([-.09,TILLER_PIVOT[1],TILLER_PIVOT[2]],
    [.09,TILLER_PIVOT[1],TILLER_PIVOT[2]],.045,8,.045,12);

  // Full planked hull, from the sharp stem to the square transom.
  const hullPoint=hullSurfacePoint;
  const hullNormal=(z,a)=>{
    const tangent=sub(hullPoint(z,Math.min(Math.PI,a+0.001)),hullPoint(z,Math.max(0,a-0.001)));
    const longitudinal=sub(hullPoint(Math.min(5.6,z+0.001),a),hullPoint(Math.max(-6.4,z-0.001),a));
    const n=norm(cross(longitudinal,tangent)); return n[0]*Math.cos(a)<0?mul(n,-1):n;
  };
  for(let j=0;j<112;j++)for(let k=0;k<24;k++){
    const z0=-6.4+j*12/112,z1=-6.4+(j+1)*12/112,a=k*Math.PI/24,b=(k+1)*Math.PI/24;
    quad(hullPoint(z0,a),hullPoint(z1,a),hullPoint(z1,b),hullPoint(z0,b),15,
      [hullNormal(z0,a),hullNormal(z1,a),hullNormal(z1,b),hullNormal(z0,b)],
      [[a*0.8,z0*0.6],[a*0.8,z1*0.6],[b*0.8,z1*0.6],[b*0.8,z0*0.6]]);
  }
  // Two proud, tarred wales emphasize the sheer and fuller hull sections.
  for(const side of [-1,1])for(const offset of [-0.35,0.25]){
    const wale=(z,dy)=>[side*(hullHalfWidth(z,deck(z)+offset+dy)+0.025),deck(z)+offset+dy,z];
    for(let i=0;i<96;i++){
      const z=-6.32+i*11.92/96,Z=-6.32+(i+1)*11.92/96;
      quad(wale(z,-0.075),wale(Z,-0.075),wale(Z,0.075),wale(z,0.075),16);
      for(const dy of [-0.075,0.075]){
        const a=wale(z,dy),b=wale(Z,dy);
        quad(a,b,add(b,[-side*0.06,0,0]),add(a,[-side*0.06,0,0]),16);
      }
    }
  }
  // Close the narrow raked stem between the port and starboard planking.
  for(let k=0;k<12;k++){
    const a=k*Math.PI/24,b=(k+1)*Math.PI/24;
    quad(hullPoint(-6.4,a),hullPoint(-6.4,Math.PI-a),hullPoint(-6.4,Math.PI-b),hullPoint(-6.4,b),16);
  }
  // Keel, transom planking, and working rudder. Cabin replaces the old stern rail.
  beam([0,-HULL_DRAFT,-6.4+HULL_BOW_RAKE],[0,-HULL_DRAFT,5.6-HULL_STERN_RAKE],.13,.15,16);
  for(let i=0;i<24;i++){
    const stem=t=>{const p=hullPoint(-6.4,t*Math.PI/2);return [0,p[1],p[2]-.025];};
    beam(stem(i/24),stem((i+1)/24),.09,.13,16);
  }
  for(let k=0;k<24;k++){
    const a=k*Math.PI/24,b=(k+1)*Math.PI/24;
    tri([0,deck(5.6),5.6],hullPoint(5.6,a),hullPoint(5.6,b),1);
  }
  tube([0,-HULL_DRAFT-.05,5.68],[0,0.95,5.68],0.055,3,0.055,16);
  beam([0,-HULL_DRAFT+.10,6.05],[0,-0.1,6.05],0.72,0.075,14);
  for(const y of [-0.9,-0.1,0.45])beam([-0.12,y,5.64],[0.12,y,5.64],0.06,0.06,3);

  // A broad raised stern follows the hull's taper; all ornament is real geometry.
  const zFront=QUARTERDECK_START,zBack=5.6,roof=QUARTERDECK_HEIGHT;
  const cabinWidth=z=>width(z)+0.105;
  for(const [a,b] of [[-cabinWidth(zFront),-.55],[.55,cabinWidth(zFront)]])
    quad([a,deck(zFront),zFront],[b,deck(zFront),zFront],[b,roof,zFront],[a,roof,zFront],1);
  quad([-.55,1.99,zFront],[.55,1.99,zFront],[.55,roof,zFront],[-.55,roof,zFront],1);
  for(const side of [-1,1])for(let j=0;j<24;j++){
    const z=zFront+(zBack-zFront)*j/24,Z=zFront+(zBack-zFront)*(j+1)/24;
    for(const y of [1.13,2.22])beam([side*(cabinWidth(z)+.035),y,z],[side*(cabinWidth(Z)+.035),y,Z],.07,.07,16);
    beam([side*(cabinWidth(z)+.06),roof+.49,z],[side*(cabinWidth(Z)+.06),roof+.49,Z],.1,.08,17);
  }
  for(let x=-1.7;x<1.7;x+=.145)for(let z=zFront;z<zBack;z+=.15){
    const Z=Math.min(zBack,z+.15),edge=Math.min(cabinWidth(z),cabinWidth(Z));
    const l=Math.max(-edge,x),r=Math.min(edge,x+.14);
    if(r>l)quad([l,roof,z],[l,roof,Z],[r,roof,Z],[r,roof,z],0);
  }
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
    for(let z=zFront;z<=zBack+.01;z+=.48){
      const x=side*(cabinWidth(z)+.06);
      beam([x,roof,z],[x,roof+.49,z],.06,.07,17);
      beam([x,roof+.23,z],[side*(cabinWidth(Math.min(z+.48,zBack))+.06),roof+.23,Math.min(z+.48,zBack)],.055,.055,16);
    }
    beam([side*.59,deck(zFront),zFront-.025],[side*.59,2.04,zFront-.025],.08,.08,17);
  }
  beam([-.63,2.04,zFront-.025],[.63,2.04,zFront-.025],.08,.08,17);
  for(const y of [roof+.23,roof+.49])beam([-cabinWidth(zBack)-.06,y,zBack],[cabinWidth(zBack)+.06,y,zBack],.09,.07,17);
  for(const x of [-.65,0,.65])beam([x,roof,zBack],[x,roof+.49,zBack],.06,.07,17);
  // Museum Nina reconstruction: four small swivel falconets on the poop rail.
  // Dimensions below are authored at human scale, converted to design units.
  for(const side of [-1,1])for(const z of [3.25,4.9]){
    const x=side*(cabinWidth(z)+.02),y=roof+.61;
    tube([x,roof,z],[x,y-.08,z],.035,3,.035,10);
    for(const dz of [-.10,.10])beam([x,y-.16,z+dz],[x,y+.035,z+dz],.035,.035,3);
    tube([x,y,z-.13],[x,y,z+.13],.028,3,.028,10);
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
  }

  // Companionway steps clear the mizzen and mainmast shrouds.
  const aftStepFloor=deck(1.5),aftSteps=Math.ceil((roof-aftStepFloor)*HULL_VERTICAL_SCALE/.23);
  for(let i=0;i<aftSteps;i++){
    const y=aftStepFloor+(roof-aftStepFloor)*(i+1)/aftSteps-.02,z=1.5+i*1.14/(aftSteps-1);
    beam([.7,y,z],[1.22,y,z],1.14/aftSteps+.025,.04,6);
  }
  // Two iron anchors hang from short catheads, clear of the bow's water contacts.
  for(const side of [-1,1]){
    const x=side*(width(-4.8)+.27),z=-4.8;
    beam([side*(width(z)-.15),vesselDeck(z)+.58,z],[x,vesselDeck(z)+.78,z],.11,.13,17);
    tube([x,vesselDeck(z)+.76,z],[x,.7,z],.023,12,.023,8);
    beam([x,.83,z],[x,-.02,z],.065,.065,3);
    beam([x,.66,z-.3],[x,.66,z+.3],.085,.09,16);
    for(const dz of [-1,1]){
      beam([x,0,z],[x,.17,z+dz*.31],.06,.06,3);
      tri([x-.11,.17,z+dz*.31],[x+.11,.17,z+dz*.31],[x,.39,z+dz*.4],3);
    }
  }

  // Single masts, stays and Mediterranean runners; geometry follows the selected plan.
  // Fractional material bits identify moving sails without widening the vertex buffer.
  function squareSail({id,z,top,width:w,height:h,belly}){
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
    tube([-w*0.56,top+0.035,z],[w*0.56,top+0.035,z],0.066,10+tag,0.045,18);
    for(const u of [0,1])for(let j=0;j<rows;j++)tube(point(u,j/rows),point(u,(j+1)/rows),0.013,19+tag,0.013,8,null,[[u,j/rows],[u,(j+1)/rows]]);
    for(let i=0;i<columns;i++)tube(point(i/columns,1),point((i+1)/columns,1),0.014,19+tag,0.014,8,null,[[i/columns,1],[(i+1)/columns,1]]);
  }
  for(const [mast,{z,height,r}] of RIG_MASTS.entries()){
    tube(mastPoint(mast,deck(z)),mastPoint(mast,height),r,10,r*0.35,24);
    for(let y=1.5;y<height;y+=1.4)torus(mastPoint(mast,y),r*(1-(y/height)*0.6)+0.004,0.012,3,'y',24);
    for(const side of [-1,1]){
      const {feet}=shroudGeometry(mast,side);
      for(const foot of feet){
        beam(add(foot,[side*.025,-.4,0]),add(foot,[side*.025,.02,0]),.045,.035,3);
        tube(add(foot,[-side*.025,0,0]),add(foot,[side*.025,0,0]),.065,16,.065,12);
      }
    }
  }
  for(const t of SAIL_TACKLES){
    const bottom=tacklePoint(t.mast,-10);
    tube(add(bottom,[-.07,0,0]),add(bottom,[.07,0,0]),.065,16,.065,12);
    beam(add(bottom,[0,-.25,0]),add(bottom,[0,.06,0]),.075,.09,5);
  }
  // Lower stays and paired runners, led to the waterways without channels.
  for(const {a,b,r,r2,sides} of standingRiggingLines())tube(a,b,r,12,r2,sides);
  for(const side of [-1,1])for(const [mast,footZ] of [[0,-1.7],[1,2.3],[2,5.2]]){
    const foot=[side*(width(footZ)-.04),vesselDeck(footZ)+.35,footZ];
    tube(add(foot,[-side*.035,0,0]),add(foot,[side*.035,0,0]),.075,16,.075,12);
  }
  // No round tops or oversized lookout baskets in this reconstruction.
  for(const sail of SAIL_PLAN)if(sail.kind==='square')squareSail(sail);
  // Lateen courses: the long oblique yard defines the triangular silhouette.
  // The foot clears the open deck; steering takes place below the quarterdeck.
  for(const sail of SAIL_PLAN.filter(s=>s.kind==='lateen')){
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
    tube(add(la,[0,.14,.12]),add(lb,[0,-.12,-.1]),.07,10+lateenTag,.045,18);
    for(const [a,b] of [[[0,0],[1,0]],[[1,0],[0,1]],[[0,1],[0,0]]])for(let i=0;i<resolution;i++){
      const u=a.map((v,j)=>v+(b[j]-v)*i/resolution),v=a.map((v,j)=>v+(b[j]-v)*(i+1)/resolution);
      tube(lateen(...u),lateen(...v),.015,19+lateenTag,.015,10,null,[u,v]);
    }
  }
  for(const {a,b,r,r2,sides,id,weights} of runningRiggingLines())tube(a,b,r,12+(id+8)/16,r2,sides,weights);
  return new Float32Array(out);
}
