// Geometry-only checks shared by CPU audits and GPU readback fixtures. No
// visibility flags, fragment masks or material opacity participate in clearance.
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clamp=x=>Math.max(0,Math.min(1,x));
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
function pointSegment(p,a,b){const d=sub(b,a),t=clamp(dot(sub(p,a),d)/Math.max(1e-12,dot(d,d)));const q=sub(p,mix(a,b,t));return dot(q,q);}
export function segmentDistance(a,b,c,d){
  const u=sub(b,a),v=sub(d,c),w=sub(a,c),uu=dot(u,u),vv=dot(v,v),uv=dot(u,v),uw=dot(u,w),vw=dot(v,w),det=uu*vv-uv*uv;
  let distance=Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));
  if(det>1e-12){const s=(uv*vw-vv*uw)/det,t=(uu*vw-uv*uw)/det;
    if(s>=0&&s<=1&&t>=0&&t<=1){const q=sub(mix(a,b,s),mix(c,d,t));distance=Math.min(distance,dot(q,q));}}
  return Math.sqrt(Math.max(0,distance));
}
function inside(p,a,b,c){
  const u=sub(b,a),v=sub(c,a),w=sub(p,a),uu=dot(u,u),vv=dot(v,v),uv=dot(u,v),wu=dot(w,u),wv=dot(w,v),det=uu*vv-uv*uv;
  if(det<1e-14)return false;const s=(wu*vv-wv*uv)/det,t=(wv*uu-wu*uv)/det;
  return s>=0&&t>=0&&s+t<=1;
}
function pointTriangle(p,a,b,c){
  const n=cross(sub(b,a),sub(c,a)),nn=dot(n,n),q=dot(sub(p,a),n)/Math.max(1e-14,nn),plane=p.map((v,i)=>v-n[i]*q);
  return inside(plane,a,b,c)?q*q*nn:Math.min(pointSegment(p,a,b),pointSegment(p,b,c),pointSegment(p,c,a));
}
export function segmentTriangleDistance(a,b,c,d,e){
  const n=cross(sub(b,a),sub(c,a)),den=dot(sub(e,d),n);
  if(Math.abs(den)>1e-12){const t=dot(sub(a,d),n)/den;if(t>=0&&t<=1&&inside(mix(d,e,t),a,b,c))return 0;}
  return Math.min(Math.sqrt(pointTriangle(d,a,b,c)),Math.sqrt(pointTriangle(e,a,b,c)),segmentDistance(d,e,a,b),segmentDistance(d,e,b,c),segmentDistance(d,e,c,a));
}
export function rigClearance(triangles,segments,margin=.003){
  const failures={};let minimum=Infinity;
  for(const tri of triangles){
    const [a,b,c]=tri.points,lo=a.map((v,k)=>Math.min(v,b[k],c[k])),hi=a.map((v,k)=>Math.max(v,b[k],c[k]));
    for(const line of segments){
      if(line.kind==='edge'&&line.mast===tri.mast||line.kind==='yard'&&line.mast===tri.mast)continue;
      let d=line.a,e=line.b;const radius=line.r+margin;
      // Only a small physical attachment neighbourhood is exempt. The rest
      // of that very same sheet/tack/halyard must clear its own canvas too.
      if(line.mast===tri.mast && line.attachment){
        const length=Math.hypot(...sub(e,d)),trim=Math.min(1,.12/Math.max(length,1e-9));
        if(line.attachment==='a')d=mix(d,e,trim);else e=mix(e,d,trim);
      }
      if(lo.some((v,k)=>Math.max(d[k],e[k])+radius<v||Math.min(d[k],e[k])-radius>hi[k]))continue;
      const clearance=segmentTriangleDistance(a,b,c,d,e)-line.r;minimum=Math.min(minimum,clearance);
      if(clearance<margin-1e-5){const key=`sail${tri.mast}/${line.name}`;failures[key]=Math.min(failures[key]??Infinity,clearance);}
    }
  }
  return {minimum,failures};
}
