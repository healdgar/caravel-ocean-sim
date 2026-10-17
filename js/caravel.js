// Timber geometry in metres, authored for a 12 x 3.6 m hull.
export const WHEEL_CENTER = [0, 1.43, -1.7];
export function createCaravelMesh() {
  const out=[];
  const add=(a,b)=>a.map((v,i)=>v+b[i]);
  const sub=(a,b)=>a.map((v,i)=>v-b[i]);
  const mul=(a,s)=>a.map(v=>v*s);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>mul(a,1/Math.hypot(...a));
  function tri(a,b,c,m=0,normals,uvs) {
    const n=norm(cross(sub(b,a),sub(c,a)));
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
  const deck=z=>z<0?0.7+0.47*Math.pow(-z/6.4,3):0.7+0.18*Math.pow(z/5.6,2);
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
    const rail=(z,k)=>[side*(width(z)+railRing[k][0]),deck(z)+0.66+railRing[k][1],z];
    for(let i=0;i<96;i++){
      const z0=5.6-i*12/96,z1=5.6-(i+1)*12/96,x0=side*width(z0),x1=side*width(z1);
      for(let j=0;j<8;j++)quad(rail(z0,j),rail(z1,j),rail(z1,(j+1)%8),rail(z0,(j+1)%8),1,null,[[j*0.1,z0*0.6],[j*0.1,z1*0.6],[(j+1)*0.1,z1*0.6],[(j+1)*0.1,z0*0.6]]);
      for(let row=0;row<5;row++){
        const a=deck(z0)+row*0.123,b=deck(z1)+row*0.123;
        quad([x0,a,z0],[x1,b,z1],[x1,b+0.119,z1],[x0,a+0.119,z0],1,null,[[a*1.7,z0*0.6],[b*1.7,z1*0.6],[(b+0.119)*1.7,z1*0.6],[(a+0.119)*1.7,z0*0.6]]);
        quad([x0+side*0.105,a,z0],[x0+side*0.105,a+0.119,z0],[x1+side*0.105,b+0.119,z1],[x1+side*0.105,b,z1],1);
      }

    }
    for(let z=5.3;z>-6.15;z-=0.82){
      const x=side*(width(z)-0.065),y=deck(z);
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
  beam([0,0.65,-6.35],[0,1.94,-6.48],0.16,0.2,5);
  tube([0,1.17,-4.9],[0,2.65,-10.7],0.145,1,0.045,28);
  for(const side of [-1,1]){
    tube([side*width(-4.8),deck(-4.8)+0.65,-4.8],[0,2.6,-10.5],0.016,2,0.016,12);
    tube([side*0.32,0.9,-6.0],[0,2.6,-10.5],0.012,2,0.012,10);
  }
  for(let i=0;i<9;i++)torus([0,1.17+(6.1+i*0.038-4.9)/5.8*1.48,-6.1-i*0.038],0.13,0.015,2,'z',32);
  for(let turn=0;turn<5;turn++)torus([0.86,deck(-3.2)+0.025,-3.2],0.13+turn*0.028,0.013,2,'y',48);
  // Recessed grating and its weathered frame; moved ahead of the helm.
  for(const x of [-0.48,0.48])beam([x,deck(-3.0)+0.03,-2.65],[x,deck(-3.6)+0.03,-3.65],0.075,0.09,1);
  for(const z of [-2.65,-3.65])beam([-0.48,deck(z)+0.03,z],[0.48,deck(z)+0.03,z],0.075,0.09,6);
  for(let x=-0.4;x<0.45;x+=0.10)beam([x,deck(-2.68),-2.68],[x,deck(-3.62),-3.62],0.027,0.035,1);
  for(let z=-2.75;z>-3.65;z-=0.12)beam([-0.43,deck(z)+0.016,z],[0.43,deck(z)+0.016,z],0.025,0.025,6);
  for(const x of [-0.35,0.35])beam([x,deck(-4.8),-4.8],[x,deck(-4.8)+0.36,-4.8],0.11,0.11,5);
  beam([-0.5,deck(-4.8)+0.28,-4.8],[0.5,deck(-4.8)+0.28,-4.8],0.1,0.1,6);
  // A working ship's wheel. Material 7/8 vertices rotate together in the shader.
  const c=WHEEL_CENTER;
  beam([0,0.7,c[2]-0.18],[0,1.46,c[2]-0.18],0.19,0.21,5);
  tube([0,c[1],c[2]-0.25],[0,c[1],c[2]+0.035],0.085,3,0.085,20);
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
  const hullPoint=(z,a)=>[(width(z)+0.105)*Math.cos(a),deck(z)-(deck(z)+1.45)*Math.sin(a),z];
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
  // Keel, transom planking, stern rail, and working rudder.
  beam([0,-1.43,-6.1],[0,-1.43,5.55],0.13,0.18,1);
  for(let k=0;k<24;k++){
    const a=k*Math.PI/24,b=(k+1)*Math.PI/24;
    tri([0,deck(5.6),5.6],hullPoint(5.6,a),hullPoint(5.6,b),1);
  }
  for(let row=0;row<5;row++)beam([-width(5.6),deck(5.6)+row*0.123+0.06,5.6],[width(5.6),deck(5.6)+row*0.123+0.06,5.6],0.12,0.12,6);
  beam([-width(5.6)-0.1,deck(5.6)+0.66,5.6],[width(5.6)+0.1,deck(5.6)+0.66,5.6],0.18,0.1,6);
  tube([0,-1.6,5.68],[0,0.95,5.68],0.055,3,0.055,16);
  beam([0,-1.25,6.05],[0,-0.1,6.05],0.72,0.075,14);
  for(const y of [-0.9,-0.1,0.45])beam([-0.12,y,5.64],[0.12,y,5.64],0.06,0.06,3);

  // Stern cabin and raised quarterdeck, leaving a working passage at the helm.
  const cabinX=1.08,zFront=3.05,zBack=5.5,roof=1.75;
  quad([-cabinX,0.78,zFront],[cabinX,0.78,zFront],[cabinX,roof,zFront],[-cabinX,roof,zFront],1);
  for(const side of [-1,1])quad([side*cabinX,0.78,zFront],[side*cabinX,0.85,zBack],[side*cabinX,roof,zBack],[side*cabinX,roof,zFront],1);
  quad([-cabinX,0.85,zBack],[cabinX,0.85,zBack],[cabinX,roof,zBack],[-cabinX,roof,zBack],1);
  for(let x=-cabinX;x<cabinX;x+=0.145)quad([x,roof,zFront],[Math.min(cabinX,x+0.14),roof,zFront],[Math.min(cabinX,x+0.14),roof,zBack],[x,roof,zBack],0);
  // Door, carved framing, and dark glazed windows.
  beam([-0.31,0.8,zFront-0.04],[-0.31,1.58,zFront-0.04],0.065,0.065,5);
  beam([0.31,0.8,zFront-0.04],[0.31,1.58,zFront-0.04],0.065,0.065,5);
  beam([-0.34,1.58,zFront-0.04],[0.34,1.58,zFront-0.04],0.065,0.065,6);
  for(const x of [-0.74,0.74]){
    quad([x-0.19,1.03,zFront-0.009],[x+0.19,1.03,zFront-0.009],[x+0.19,1.43,zFront-0.009],[x-0.19,1.43,zFront-0.009],11);
    for(const dx of [-0.2,0,0.2])beam([x+dx,1.01,zFront-0.025],[x+dx,1.45,zFront-0.025],0.03,0.035,5);
    for(const y of [1.01,1.23,1.45])beam([x-0.22,y,zFront-0.025],[x+0.22,y,zFront-0.025],0.03,0.035,6);
  }
  for(const side of [-1,1]){
    for(let z=3.12;z<5.6;z+=0.48)beam([side*1.14,roof,z],[side*1.14,roof+0.48,z],0.065,0.065,5);
    beam([side*1.14,roof+0.5,3.05],[side*1.14,roof+0.5,5.6],0.11,0.08,1);
    beam([side*1.14,roof+0.23,3.05],[side*1.14,roof+0.23,5.6],0.06,0.05,1);
  }
  beam([-1.14,roof+0.5,5.6],[1.14,roof+0.5,5.6],0.11,0.08,6);
  for(let i=0;i<4;i++){
    const y=0.7+i*0.25,z=2.35+i*0.18;
    beam([0.64,y,z],[1.08,y,z],0.14,0.045,6);
  }

  // Square rig: shaped canvas panels, yards, masts, stays, and shroud ladders.
  function squareSail(z,top,w,h,belly){
    const columns=28,rows=20;
    const point=(u,v)=>{
      const sideShape=1.0-0.08*Math.sin(v*Math.PI);
      return [(u-0.5)*w*sideShape,top-v*h-0.16*Math.sin(u*Math.PI)*v*v,
        z-belly*Math.sin(u*Math.PI)*Math.sin(v*Math.PI)];
    };
    const normal=(u,v)=>{
      const du=sub(point(u+0.001,v),point(u-0.001,v)),dv=sub(point(u,v+0.001),point(u,v-0.001));
      return norm(cross(du,dv));
    };
    for(let i=0;i<columns;i++)for(let j=0;j<rows;j++){
      const u=i/columns,U=(i+1)/columns,v=j/rows,V=(j+1)/rows;
      quad(point(u,v),point(U,v),point(U,V),point(u,V),9,[normal(u,v),normal(U,v),normal(U,V),normal(u,V)],[[u,v],[U,v],[U,V],[u,V]]);
    }
    tube([-w*0.56,top+0.035,z],[w*0.56,top+0.035,z],0.066,10,0.045,18);
    for(const u of [0,1])for(let j=0;j<rows;j++)tube(point(u,j/rows),point(u,(j+1)/rows),0.013,12,0.013,8);
    for(let i=0;i<columns;i++)tube(point(i/columns,1),point((i+1)/columns,1),0.014,12,0.014,8);
    for(const side of [-1,1]){
      tube([side*w*0.5,top-h,z],[side*1.5,1.1,z+1.3],0.013,12,0.013,8);
      tube([side*w*0.56,top,z],[side*1.5,1.1,z+1.7],0.011,12,0.011,8);
    }
  }
  const masts=[{z:-4.15,height:9.3,r:0.115},{z:0.85,height:11.5,r:0.15},{z:4.15,height:8.0,r:0.095}];
  for(const {z,height,r} of masts){
    tube([0,deck(z),z],[0,height,z],r,10,r*0.35,24);
    for(let y=1.5;y<height;y+=1.4)torus([0,y,z],r*(1-(y/height)*0.6)+0.004,0.012,3,'y',24);
    for(const side of [-1,1])for(const dz of [-0.65,0.65]){
      const foot=[side*(width(z)-0.08),deck(z)+0.55,z+dz],head=[side*0.11,height*0.78,z];
      tube(foot,head,0.017,12,0.012,10);
    }
    for(const side of [-1,1])for(let j=1;j<15;j++){
      const t=j/16,y=(deck(z)+0.55)*(1-t)+height*0.78*t,x=side*((width(z)-0.08)*(1-t)+0.11*t),span=0.65*(1-t);
      tube([x,y,z-span],[x,y,z+span],0.008,12,0.008,6);
    }
    tube([0,height*0.9,z],[0,1.3,z<0?-6.3:Math.min(5.6,z+3.0)],0.016,12,0.012,10);
    tube([0,height*0.87,z],[0,1.1,z>3?0.8:z+3.7],0.014,12,0.011,10);
  }
  squareSail(-4.15,6.65,4.4,2.9,0.55);
  squareSail(-4.15,8.85,3.05,1.85,0.36);
  squareSail(0.85,8.0,5.25,3.25,0.7);
  squareSail(0.85,10.9,3.7,2.45,0.45);
  squareSail(4.15,7.3,2.85,2.45,0.4);
  return new Float32Array(out);

}
