// Procedural bottlenose proportions, metres. No external model or texture fetch.
export function createDolphinMesh(){
  const vertices=[],indices=[];
  const add=(p,n,color)=>{const k=vertices.length/9;vertices.push(...p,...n,...color);return k;};
  const normal=(a,b,c)=>{const u=b.map((v,i)=>v-a[i]),v=c.map((q,i)=>q-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],l=Math.hypot(...n)||1;return n.map(q=>q/l);};
  const tri=(a,b,c,color)=>{const n=normal(a,b,c),k=add(a,n,color);add(b,n,color);add(c,n,color);indices.push(k,k+1,k+2);};
  const profile=[[-1.58,.012,-.045],[-1.48,.065,-.035],[-1.19,.095,-.02],[-1.08,.19,.045],[-.9,.30,.065],[-.6,.36,.025],[-.15,.365,0],[.3,.29,-.035],[.75,.15,-.075],[1.12,.065,-.10],[1.4,.025,-.10]];
  const sample=z=>{let k=0;while(k<profile.length-2&&profile[k+1][0]<z)k++;const a=profile[k],b=profile[k+1],t=(z-a[0])/(b[0]-a[0]);return [a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t,(b[1]-a[1])/(b[0]-a[0]),(b[2]-a[2])/(b[0]-a[0])];};
  const rings=44,sectors=24;
  for(let r=0;r<=rings;r++){
    const z=profile[0][0]+r/rings*(profile.at(-1)[0]-profile[0][0]),[radius,y,dr,dy]=sample(z);
    for(let s=0;s<=sectors;s++){
      const theta=s/sectors*Math.PI*2,x=Math.cos(theta),v=Math.sin(theta),n=[x,v,-dr-v*dy],length=Math.hypot(...n);
      const belly=Math.max(0,Math.min(1,(-v-.05)/.8)),side=Math.max(0,1-Math.abs(v))*.025;
      add([x*radius,y+v*radius*.9,z],n.map(q=>q/length),[.095+belly*.25+side,.13+belly*.27+side,.155+belly*.27+side]);
    }
  }
  for(let r=0;r<rings;r++)for(let s=0;s<sectors;s++){const a=r*(sectors+1)+s,b=a+sectors+1;indices.push(a,a+1,b,a+1,b+1,b);}
  function fin(outline,axis,thickness,color){
    const centre=[0,0,0];for(const p of outline)for(let j=0;j<3;j++)centre[j]+=p[j]/outline.length;
    for(const side of [-1,1])for(let i=0;i<outline.length;i++){
      const c=[...centre],a=[...outline[i]],b=[...outline[(i+1)%outline.length]];
      c[axis]+=side*thickness;a[axis]+=side*thickness*.12;b[axis]+=side*thickness*.12;
      if(side<0)tri(c,b,a,color);else tri(c,a,b,color);
    }
    for(let i=0;i<outline.length;i++){
      const j=(i+1)%outline.length,a=[...outline[i]],b=[...outline[j]],c=[...b],d=[...a];
      a[axis]-=thickness*.12;b[axis]-=thickness*.12;c[axis]+=thickness*.12;d[axis]+=thickness*.12;
      tri(a,b,c,color);tri(a,c,d,color);
    }
  }
  fin([[0,.27,-.2],[0,.6,-.015],[0,.83,.17],[0,.82,.25],[0,.46,.32],[0,.24,.55]],0,.055,[.10,.14,.16]);
  for(const side of [-1,1]){
    fin([[side*.25,-.035,-.55],[side*.47,-.08,-.39],[side*.87,-.26,.04],[side*.96,-.29,.19],[side*.68,-.17,.17],[side*.29,-.06,-.15]],1,.025,[.105,.14,.16]);
    fin([[0,-.10,1.32],[side*.16,-.10,1.16],[side*.65,-.10,1.03],[side*.81,-.10,1.11],[side*.68,-.10,1.31],[side*.36,-.10,1.52],[side*.075,-.10,1.51]],1,.045,[.115,.15,.17]);
    // Small eyes and a restrained mouth seam; do not sculpt a human smile.
    const eye=[side*.286,.105,-.91],eyeRadius=.028;
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4,b=(i+1)*Math.PI/4;
      tri(eye,[eye[0]+side*.008,eye[1]+Math.sin(a)*eyeRadius,eye[2]+Math.cos(a)*eyeRadius],[eye[0]+side*.008,eye[1]+Math.sin(b)*eyeRadius,eye[2]+Math.cos(b)*eyeRadius],[.008,.012,.013]);
    }
    for(let i=0;i<10;i++){
      const za=-1.48+i*.048,zb=za+.048,ra=sample(za)[0]*.97,rb=sample(zb)[0]*.97;
      tri([side*ra,-.054,za],[side*rb,-.054,zb],[side*rb,-.06,zb],[.035,.045,.05]);
      tri([side*ra,-.054,za],[side*rb,-.06,zb],[side*ra,-.06,za],[.035,.045,.05]);
    }
  }
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices)};
}
