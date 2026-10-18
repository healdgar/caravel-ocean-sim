import { hullDeck, hullHalfWidth, hullSurfacePoint, vesselDeck, WHEEL_CENTER,
  FORECASTLE_END, FORECASTLE_HEIGHT, QUARTERDECK_START, QUARTERDECK_HEIGHT } from './hull.js';
import { SAIL_PLAN, LATEEN_CORNERS } from './sailing.js';

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

// Timber geometry in metres, authored for a 12 x 3.6 m hull.
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
  function tube(a,b,r,m=2,r2=r,sides=12) {
    const axis=norm(sub(b,a)),u=norm(cross(axis,Math.abs(axis[1])<0.9?[0,1,0]:[1,0,0])),v=cross(axis,u);
    const n=i=>add(mul(u,Math.cos(i*2*Math.PI/sides)),mul(v,Math.sin(i*2*Math.PI/sides)));
    for(let i=0;i<sides;i++){
      const na=n(i),nb=n(i+1),length=Math.hypot(...sub(b,a));
      quad(add(a,mul(na,r)),add(b,mul(na,r2)),add(b,mul(nb,r2)),add(a,mul(nb,r)),m,[na,na,nb,nb],[[i/sides*0.7,0],[i/sides*0.7,length*0.75],[(i+1)/sides*0.7,length*0.75],[(i+1)/sides*0.7,0]]);
      tri(a,add(a,mul(nb,r)),add(a,mul(na,r)),m);
      tri(b,add(b,mul(na,r2)),add(b,mul(nb,r2)),m);
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
  const width=z=>1.8*Math.sqrt(Math.max(0.0006,1-Math.pow(z<0?-z/6.4:z/7.4,2)));
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
    const stations=[...Array.from({length:97},(_,i)=>5.6-i*12/96),FORECASTLE_END,QUARTERDECK_START].sort((a,b)=>b-a);
    for(let i=0;i<stations.length-1;i++){
      const z0=stations[i],z1=stations[i+1],middle=(z0+z1)*.5;
      if(middle>=QUARTERDECK_START)continue; // the cabin replaces these bulwarks
      const floor=z=>middle<FORECASTLE_END?FORECASTLE_HEIGHT:deck(z);
      const rail=(z,k)=>[side*(width(z)+railRing[k][0]),floor(z)+0.66+railRing[k][1],z];
      const x0=side*width(z0),x1=side*width(z1);
      if(middle<FORECASTLE_END){
        quad([x0+side*.105,deck(z0),z0],[x1+side*.105,deck(z1),z1],
          [x1+side*.105,FORECASTLE_HEIGHT,z1],[x0+side*.105,FORECASTLE_HEIGHT,z0],1,null,
          [[deck(z0)*1.6,z0*.55],[deck(z1)*1.6,z1*.55],[FORECASTLE_HEIGHT*1.6,z1*.55],[FORECASTLE_HEIGHT*1.6,z0*.55]]);
        beam([x0+side*.11,FORECASTLE_HEIGHT-.08,z0],[x1+side*.11,FORECASTLE_HEIGHT-.08,z1],.12,.08,16);
      }
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
  // A low forecastle, with an aft bulkhead and a port-side companion ladder.
  for(let x=-1.5;x<1.5;x+=.145)for(let z=-6.4;z<FORECASTLE_END;z+=.125){
    const Z=Math.min(FORECASTLE_END,z+.125),edge=Math.min(width(z),width(Z))-.025;
    const l=Math.max(x,-edge),r=Math.min(x+.14,edge);
    if(r>l)quad([l,FORECASTLE_HEIGHT,z],[l,FORECASTLE_HEIGHT,Z],[r,FORECASTLE_HEIGHT,Z],[r,FORECASTLE_HEIGHT,z],0);
  }
  const fw=width(FORECASTLE_END);
  quad([-fw,deck(FORECASTLE_END),FORECASTLE_END],[fw,deck(FORECASTLE_END),FORECASTLE_END],
    [fw,FORECASTLE_HEIGHT,FORECASTLE_END],[-fw,FORECASTLE_HEIGHT,FORECASTLE_END],1);
  beam([-fw,FORECASTLE_HEIGHT,FORECASTLE_END],[fw,FORECASTLE_HEIGHT,FORECASTLE_END],.12,.1,16);
  for(let i=0;i<5;i++){
    const y=deck(-3)+(FORECASTLE_HEIGHT-deck(-3))*(i+1)/5,z=-3.04-i*.19;
    beam([-1.18,y,z],[-.63,y,z],.21,.055,6);
  }
  for(const x of [-1.23,-.58]){
    beam([x,deck(-3.04),-3.04],[x,FORECASTLE_HEIGHT,-3.84],.075,.09,1);
    beam([x,deck(-3.04)+.55,-3.04],[x,FORECASTLE_HEIGHT+.55,-3.84],.05,.05,17);
    for(const z of [-3.04,-3.84])beam([x,z===-3.84?FORECASTLE_HEIGHT:deck(z),z],
      [x,(z===-3.84?FORECASTLE_HEIGHT:deck(z))+.55,z],.05,.05,17);
  }
  // Aft rail leaves the ladder opening clear.
  for(const [a,b] of [[-fw,-1.25],[-.56,fw]]){
    beam([a,FORECASTLE_HEIGHT+.55,FORECASTLE_END],[b,FORECASTLE_HEIGHT+.55,FORECASTLE_END],.07,.07,17);
    for(const x of [a,b])beam([x,FORECASTLE_HEIGHT,FORECASTLE_END],[x,FORECASTLE_HEIGHT+.55,FORECASTLE_END],.065,.065,5);
  }
  beam([0,0.65,-6.35],[0,FORECASTLE_HEIGHT+.7,-6.48],0.16,0.2,5);
  tube([0,1.17,-4.9],[0,2.65,-10.7],0.145,1,0.045,28);
  for(const side of [-1,1]){
    tube([side*width(-4.8),deck(-4.8)+0.65,-4.8],[0,2.6,-10.5],0.016,2,0.016,12);
    tube([side*0.32,0.9,-6.0],[0,2.6,-10.5],0.012,2,0.012,10);
  }
  for(let i=0;i<9;i++)torus([0,1.17+(6.1+i*0.038-4.9)/5.8*1.48,-6.1-i*0.038],0.13,0.015,2,'z',32);
  for(let turn=0;turn<5;turn++)torus([0.86,deck(-3.2)+0.025,-3.2],0.13+turn*0.028,0.013,2,'y',48);
  // Main-deck grating and its weathered frame.
  for(const x of [-0.48,0.48])beam([x,deck(-3.0)+0.03,-2.65],[x,deck(-3.6)+0.03,-3.65],0.075,0.09,1);
  for(const z of [-2.65,-3.65])beam([-0.48,deck(z)+0.03,z],[0.48,deck(z)+0.03,z],0.075,0.09,6);
  for(let x=-0.4;x<0.45;x+=0.10)beam([x,deck(-2.68),-2.68],[x,deck(-3.62),-3.62],0.027,0.035,1);
  for(let z=-2.75;z>-3.65;z-=0.12)beam([-0.43,deck(z)+0.016,z],[0.43,deck(z)+0.016,z],0.025,0.025,6);
  for(const x of [-0.35,0.35])beam([x,vesselDeck(-4.8),-4.8],[x,vesselDeck(-4.8)+0.36,-4.8],0.11,0.11,5);
  beam([-0.5,vesselDeck(-4.8)+0.28,-4.8],[0.5,vesselDeck(-4.8)+0.28,-4.8],0.1,0.1,6);
  // A working ship's wheel. Material 7/8 vertices rotate together in the shader.
  const c=WHEEL_CENTER;
  beam([0,QUARTERDECK_HEIGHT,c[2]+0.18],[0,c[1]+.03,c[2]+0.18],0.19,0.21,5);
  tube([0,c[1],c[2]-.035],[0,c[1],c[2]+0.25],0.085,3,0.085,20);
  torus(c,0.48,0.041,7,'z',96);
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4,d=[Math.sin(a),Math.cos(a),0];
    tube(add(c,mul(d,0.09)),add(c,mul(d,0.47)),0.025,7,0.019,12);
    tube(add(c,mul(d,0.47)),add(c,mul(d,0.62)),0.025,7,0.031,12);
    tube(add(c,mul(d,0.62)),add(c,mul(d,0.64)),0.031,7,0.02,12);
  }
  tube(add(c,[0,0,-0.04]),add(c,[0,0,0.06]),0.10,8,0.10,32);
  torus(add(c,[0,0,0.064]),0.07,0.009,8,'z',32);

  // Full planked hull, from the sharp stem to the square transom.
  const hullPoint=hullSurfacePoint;
  const hullNormal=(z,a)=>{
    const tangent=sub(hullPoint(z,Math.min(Math.PI,a+0.001)),hullPoint(z,Math.max(0,a-0.001)));
    const longitudinal=sub(hullPoint(Math.min(5.6,z+0.001),a),hullPoint(Math.max(-6.4,z-0.001),a));
    const n=norm(cross(longitudinal,tangent)); return n[1]>0?mul(n,-1):n;
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
  beam([0,-1.54,-5.5],[0,-1.54,5.35],0.13,0.18,16);
  beam([0,-1.48,-5.5],[0,1.85,-6.46],0.16,0.20,16);
  for(let k=0;k<24;k++){
    const a=k*Math.PI/24,b=(k+1)*Math.PI/24;
    tri([0,deck(5.6),5.6],hullPoint(5.6,a),hullPoint(5.6,b),1);
  }
  tube([0,-1.6,5.68],[0,0.95,5.68],0.055,3,0.055,16);
  beam([0,-1.25,6.05],[0,-0.1,6.05],0.72,0.075,14);
  for(const y of [-0.9,-0.1,0.45])beam([-0.12,y,5.64],[0.12,y,5.64],0.06,0.06,3);

  // A broad raised stern follows the hull's taper; all ornament is real geometry.
  const zFront=QUARTERDECK_START,zBack=5.6,roof=QUARTERDECK_HEIGHT;
  const cabinWidth=z=>width(z)+0.105;
  quad([-cabinWidth(zFront),deck(zFront),zFront],[cabinWidth(zFront),deck(zFront),zFront],
    [cabinWidth(zFront),roof,zFront],[-cabinWidth(zFront),roof,zFront],1);
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
  // Wall panels stop at each arch. Reveals lead to glazing recessed 8 cm;
  // neither solid planking nor the former main-deck rail crosses the openings.
  function windowWall(start,end,centers,point,floor){
    const cy=1.69,r=.22,bottom=cy-.25;
      const panel=(a,b,lowA,lowB,highA,highB)=>quad(point(a,lowA),point(b,lowB),point(b,highB),point(a,highA),1,null,
        [[lowA*1.6,a*.55],[lowB*1.6,b*.55],[highB*1.6,b*.55],[highA*1.6,a*.55]]);
    const solid=(a,b)=>{
      const steps=Math.ceil((b-a)/.12);
      for(let i=0;i<steps;i++){
        const u=a+(b-a)*i/steps,U=a+(b-a)*(i+1)/steps;
        panel(u,U,floor(u),floor(U),roof,roof);
      }
    };
    let previous=start;
    for(const center of centers){
      solid(previous,center-r);
      const arch=Array.from({length:11},(_,i)=>{
        const a=Math.PI-i*Math.PI/10;return [center+r*Math.cos(a),cy+.12+r*Math.sin(a)];
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
      beam(point(center,bottom,.018),point(center,cy+.33,.018),.024,.024,17);
      beam(point(center-r,cy+.06,.018),point(center+r,cy+.06,.018),.024,.024,17);
      previous=center+r;
    }
    solid(previous,end);
  }
  windowWall(-cabinWidth(zBack),cabinWidth(zBack),[-.7,0,.7],
    (x,y,inset=0)=>[x,y,zBack+inset],()=>deck(zBack));
  for(const side of [-1,1]){
    windowWall(zFront,zBack,[3.4,4.35,5.18],
      (z,y,inset=0)=>[side*(cabinWidth(z)+inset),y,z],deck);
    for(let z=zFront;z<=zBack+.01;z+=.48){
      const x=side*(cabinWidth(z)+.06);
      beam([x,roof,z],[x,roof+.49,z],.06,.07,17);
      beam([x,roof+.23,z],[side*(cabinWidth(Math.min(z+.48,zBack))+.06),roof+.23,Math.min(z+.48,zBack)],.055,.055,16);
    }
    beam([side*.33,deck(zFront),zFront-.025],[side*.33,2.06,zFront-.025],.08,.08,17);
  }
  beam([-.37,2.06,zFront-.025],[.37,2.06,zFront-.025],.08,.08,17);
  quad([-.28,.83,zFront-.012],[.28,.83,zFront-.012],[.28,2.01,zFront-.012],[-.28,2.01,zFront-.012],16);
  for(const y of [roof+.23,roof+.49])beam([-cabinWidth(zBack)-.06,y,zBack],[cabinWidth(zBack)+.06,y,zBack],.09,.07,17);
  for(const x of [-.65,0,.65])beam([x,roof,zBack],[x,roof+.49,zBack],.06,.07,17);
  // Companionway steps clear the mizzen and mainmast shrouds.
  for(let i=0;i<7;i++){
    const y=.83+(roof-.83)*(i+1)/7,z=1.5+i*.19;
    beam([.7,y,z],[1.22,y,z],.21,.05,6);
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

  // Square rig: shaped canvas panels, yards, masts, stays, and shroud ladders.
  // Fractional material bits identify moving sails without widening the vertex buffer.
  function squareSail({id,z,top,width:w,height:h,belly}){
    const tag=id/16,anchored=(id+8)/16;
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
    for(const u of [0,1])for(let j=0;j<rows;j++)tube(point(u,j/rows),point(u,(j+1)/rows),0.013,12+tag,0.013,8);
    for(let i=0;i<columns;i++)tube(point(i/columns,1),point((i+1)/columns,1),0.014,12+tag,0.014,8);
    for(const side of [-1,1]){
      tube([side*w*0.5,top-h,z],[side*1.5,vesselDeck(z+1.3)+.5,z+1.3],0.013,12+anchored,0.013,8);
      tube([side*w*0.56,top,z],[side*1.5,vesselDeck(z+1.7)+.5,z+1.7],0.011,12+anchored,0.011,8);
    }
  }
  const masts=[{z:-4.15,height:9.3,r:0.115},{z:0.85,height:11.5,r:0.15},{z:4.15,height:8.0,r:0.095}];
  for(const {z,height,r} of masts){
    tube([0,deck(z),z],[0,height,z],r,10,r*0.35,24);
    for(let y=1.5;y<height;y+=1.4)torus([0,y,z],r*(1-(y/height)*0.6)+0.004,0.012,3,'y',24);
    for(const side of [-1,1]){
      const head=[side*.11,height*.78,z];
      const feet=[-.65,.65].map(dz=>[side*(width(z+dz)-.04),vesselDeck(z+dz)+.55,z+dz]);
      for(const foot of feet){
        tube(foot,head,.022,12,.016,10);
        beam(add(foot,[side*.025,-.4,0]),add(foot,[side*.025,.02,0]),.045,.035,3);
        tube(add(foot,[-side*.025,0,0]),add(foot,[side*.025,0,0]),.065,16,.065,12);
      }
      for(let j=1;j<20;j++){
        const t=j/21,ends=feet.map(foot=>add(mul(foot,1-t),mul(head,t)));
        tube(ends[0],ends[1],.009,12,.009,6);
      }
    }
  }
  // Standing rigging carries load fore-and-aft as well as across the beam.
  // Lower stays land below the forward sail; topmast stays pass above its yard.
  for(const [a,b,r] of [
    [[0,7.05,-4.15],[0,2.42,-9.8],.032],
    [[0,9.12,-4.15],[0,2.63,-10.55],.024],
    [[0,8.27,.85],[0,FORECASTLE_HEIGHT+.28,-5.3],.036],
    [[0,11.25,.85],[0,9.12,-4.15],.027],
    [[-.10,7.8,4.15],[-.10,6.75,.85],.028],
  ])tube(a,b,r,12,r*.78,12);
  // Paired backstays lead outboard, avoiding the centreline helm and canvas.
  for(const side of [-1,1])for(const [z,y,footZ] of [[-4.15,8.95,-1.7],[.85,11.2,3.05]]){
    const foot=[side*(width(footZ)+.04),vesselDeck(footZ)+.35,footZ];
    tube([side*.12,y,z],foot,.024,12,.024,10);
    tube(add(foot,[-side*.035,0,0]),add(foot,[side*.035,0,0]),.075,16,.075,12);
  }
  // Foremast working top; the mainmast carries the larger lookout basket.
  for(const [z,y] of [[-4.15,6.97]]){
    tube([0,y,z],[0,y+.07,z],.38,1,.38,24);
    torus([0,y+.27,z],.37,.023,17,'y',32);
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4,x=.37*Math.cos(a),dz=.37*Math.sin(a);
      tube([x,y,z+dz],[x,y+.27,z+dz],.018,17,.018,8);
    }
  }
  const nestZ=.85,nestFloor=8.38;
  tube([0,nestFloor-.11,nestZ],[0,nestFloor,nestZ],.69,0,.72,32);
  for(const side of [-1,1]){
    beam([0,nestFloor-.72,nestZ],[side*.65,nestFloor-.1,nestZ],.1,.11,1);
    beam([0,nestFloor-.72,nestZ],[0,nestFloor-.1,nestZ+side*.65],.1,.11,1);
  }
  for(let i=0;i<18;i++){
    const a=i*Math.PI/9,A=(i+1)*Math.PI/9;
    const p=(angle,r,y)=>[Math.cos(angle)*r,y,nestZ+Math.sin(angle)*r];
    beam(p(a,.71,nestFloor),p(a,.8,nestFloor+.72),.045,.05,17);
    // Waist-high planking and an open upper rail read as a lookout basket.
    quad(p(a+.012,.715,nestFloor+.05),p(A-.012,.715,nestFloor+.05),
      p(A-.012,.76,nestFloor+.4),p(a+.012,.76,nestFloor+.4),1);
  }
  torus([0,nestFloor+.4,nestZ],.76,.025,16,'y',48);
  torus([0,nestFloor+.72,nestZ],.8,.035,17,'y',48);
  for(const sail of SAIL_PLAN)squareSail(sail);
  // Lateen mizzen: the long oblique yard defines the triangular silhouette.
  // The foot clears a standing helmsman on the quarterdeck.
  const [la,lb,lc]=LATEEN_CORNERS,resolution=26,lateenTag=5/16;
  const lateen=(u,v)=>{
    const p=add(la,add(mul(sub(lb,la),u),mul(sub(lc,la),v)));
    p[0]+=.8*27*u*v*(1-u-v);
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
  for(const [a,b] of [[la,lb],[lb,lc],[lc,la]])tube(a,b,.015,12+lateenTag,.015,10);
  tube(lc,[1.1,roof+.3,5.5],.016,12+13/16,.016,8);
  // The halyard's mast end stays fixed; its yard end rotates with the lateen.
  tube([0,7.6,4.15],la,.014,12+13/16,.014,8);
  return new Float32Array(out);
}
