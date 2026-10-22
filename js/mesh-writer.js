// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared nine-float construction primitives. The Victory projection preset
// preserves its original normals, UVs, winding and triangle ordering exactly.
// Geometry and semantic attachments remain owned by each ship builder.
export function createMeshWriter({groups,parts}={}){
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
  return {out,add,sub,mul,cross,unit,tag,group,tri,quad,box,tube,rope,ring};
}
