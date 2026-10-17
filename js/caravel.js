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
  const width=z=>1.8*Math.sqrt(Math.max(0.0006,1-Math.pow(Math.max(0,-z)/6.4,2)));
  const deck=z=>0.7+0.47*Math.pow(Math.max(0,-z)/6.4,3);
  // Fine individual deck boards with a recessed continuous caulk bed.
  for(let x=-1.8;x<1.8;x+=0.145)for(let z=0.95;z>-6.4;z-=0.16){
    const end=Math.max(-6.4,z-0.16),l=Math.max(x,-width(z)+0.04,-width(end)+0.04),r=Math.min(x+0.140,width(z)-0.04,width(end)-0.04);
    if(r>l)quad([l,deck(z),z],[r,deck(z),z],[r,deck(end),end],[l,deck(end),end],0);
  }
  for(let i=0;i<96;i++){
    const z0=0.95-i*7.35/96,z1=0.95-(i+1)*7.35/96;
    quad([-width(z0),deck(z0)-0.025,z0],[width(z0),deck(z0)-0.025,z0],[width(z1),deck(z1)-0.025,z1],[-width(z1),deck(z1)-0.025,z1],4);
  }
  for(const side of [-1,1]){
    // Continuous beveled cap rail sweep: no overlapping end-caps at joints.
    const railRing=[[-0.095,-0.035],[-0.08,-0.055],[0.08,-0.055],[0.105,-0.03],[0.105,0.035],[0.08,0.055],[-0.08,0.055],[-0.095,0.035]];
    const rail=(z,k)=>[side*(width(z)+railRing[k][0]),deck(z)+0.66+railRing[k][1],z];
    for(let i=0;i<96;i++){
      const z0=0.95-i*7.35/96,z1=0.95-(i+1)*7.35/96,x0=side*width(z0),x1=side*width(z1);
      for(let j=0;j<8;j++)quad(rail(z0,j),rail(z1,j),rail(z1,(j+1)%8),rail(z0,(j+1)%8),1,null,[[j*0.1,z0*0.6],[j*0.1,z1*0.6],[(j+1)*0.1,z1*0.6],[(j+1)*0.1,z0*0.6]]);
      for(let row=0;row<5;row++){
        const a=deck(z0)+row*0.123,b=deck(z1)+row*0.123;
        quad([x0,a,z0],[x1,b,z1],[x1,b+0.119,z1],[x0,a+0.119,z0],1,null,[[a*1.7,z0*0.6],[b*1.7,z1*0.6],[(b+0.119)*1.7,z1*0.6],[(a+0.119)*1.7,z0*0.6]]);
        quad([x0+side*0.105,a,z0],[x0+side*0.105,a+0.119,z0],[x1+side*0.105,b+0.119,z1],[x1+side*0.105,b,z1],1);
      }
      quad([x0+side*0.105,deck(z0)-0.01,z0],[x1+side*0.105,deck(z1)-0.01,z1],[x1*0.58,-0.85,z1],[x0*0.58,-0.85,z0],1);
    }
    for(let z=0.5;z>-6.15;z-=0.82){
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
  return new Float32Array(out);
}
