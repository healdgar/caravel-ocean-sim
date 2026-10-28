// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shape-preserving section loft for independently authored hulls. Meshes,
// hydrostatics and contact queries consume these same offsets and datums.
const loftClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function loftTangent(h0,h1,d0,d1){
  if(d0*d1<=0)return 0;
  const a=2*h1+h0,b=h1+2*h0;return (a+b)/(a/d0+b/d1);
}
export function loftEndTangent(h0,h1,d0,d1){
  const m=((2*h0+h1)*d0-h0*d1)/(h0+h1);
  return m*d0<=0?0:d0*d1<0&&Math.abs(m)>3*Math.abs(d0)?3*d0:m;
}
export function loftCubic(a,b,ma,mb,span,t){
  return (2*t*t*t-3*t*t+1)*a+(t*t*t-2*t*t+t)*span*ma+(-2*t*t*t+3*t*t)*b+(t*t*t-t*t)*span*mb;
}
export function loftTangents(xs,ys){
  if(xs.length!==ys.length||xs.length<3||!xs.every(Number.isFinite)||!ys.every(Number.isFinite)||xs.some((x,i)=>i&&x<=xs[i-1]))throw Error('Invalid hull offset curve');
  const n=xs.length,ds=xs.slice(1).map((x,i)=>(ys[i+1]-ys[i])/(x-xs[i]));
  return ys.map((_,i)=>i===0?loftEndTangent(xs[1]-xs[0],xs[2]-xs[1],ds[0],ds[1]):i===n-1?loftEndTangent(xs[n-1]-xs[n-2],xs[n-2]-xs[n-3],ds[n-2],ds[n-3]):loftTangent(xs[i]-xs[i-1],xs[i+1]-xs[i],ds[i-1],ds[i]));
}
export function loftCurve(xs,ys,slopes,x){
  let i=0;while(i<xs.length-2&&x>xs[i+1])i++;
  const span=xs[i+1]-xs[i],t=loftClamp((x-xs[i])/span,0,1);
  return loftCubic(ys[i],ys[i+1],slopes[i],slopes[i+1],span,t);
}

export function prepareHullLoft({stations,levels,sections,...rest}){
  if(!Array.isArray(sections)||sections.length!==levels.length||sections.some(row=>row.length!==stations.length||row.some(w=>!Number.isFinite(w)||w<0)))throw Error('Invalid hull loft sections');
  // Validate both axes even when a row is identically zero at the keel.
  loftTangents(levels,levels);
  const fore=rest.sheerFore??0,aft=rest.sheerAft??0;
  if(![fore,aft].every(x=>Number.isFinite(x)&&x>=0))throw Error('Invalid hull sheer');
  const a=Math.cbrt(fore),b=Math.cbrt(aft),t=a+b?a/(a+b):.5;
  const sheerDatum=fore*(1-t)**4+aft*t**4;
  return {...rest,sheerDatum,stations:[...stations],levels:[...levels],sections:sections.map(row=>[...row]),tangents:sections.map(row=>loftTangents(stations,row))};
}

export function hullLoftSheer(profile,z){
  const t=loftClamp((z-profile.stations[0])/(profile.stations.at(-1)-profile.stations[0]),0,1);
  return (profile.sheerFore??0)*(1-t)**4+(profile.sheerAft??0)*t**4-(profile.sheerDatum??0);
}
export function hullLoftDeck(profile,z){return profile.deck+hullLoftSheer(profile,z);}
export function hullLoftBottom(profile,z){return profile.levels[0]+hullLoftSheer(profile,z);}
export function hullLoftWidth(profile,z,y){
  const base=y-hullLoftSheer(profile,z),ys=profile.levels;
  if(base<ys[0]-1e-8||base>ys.at(-1)+1e-8)return 0;
  const depth=loftClamp(-base/-ys[0],0,1),first=profile.stations[0],last=profile.stations.at(-1);
  const fore=first+(profile.bowRake??0)*depth*depth,aft=last-(profile.sternRake??0)*depth*depth;
  if(z<fore-1e-8||z>aft+1e-8)return 0;
  const station=z<0?z*first/fore:z*last/aft;
  let j=0;while(j<ys.length-2&&base>ys[j+1])j++;
  const row=k=>loftCurve(profile.stations,profile.sections[k],profile.tangents[k],station);
  const a=row(j),b=row(j+1),span=ys[j+1]-ys[j],d=(b-a)/span;
  const before=row(Math.max(0,j-1)),after=row(Math.min(ys.length-1,j+2));
  const left=j?loftTangent(ys[j]-ys[j-1],span,(a-before)/(ys[j]-ys[j-1]),d):loftEndTangent(span,ys[2]-ys[1],d,(after-b)/(ys[2]-ys[1]));
  const right=j<ys.length-2?loftTangent(span,ys[j+2]-ys[j+1],d,(after-b)/(ys[j+2]-ys[j+1])):loftEndTangent(span,ys[j]-ys[j-1],d,(a-before)/(ys[j]-ys[j-1]));
  return Math.max(0,loftCubic(a,b,left,right,span,loftClamp((base-ys[j])/span,0,1)));
}
export function hullLoftPoint(profile,station,baseY,side){
  const depth=loftClamp(-baseY/-profile.levels[0],0,1),first=profile.stations[0],last=profile.stations.at(-1);
  const fore=first+(profile.bowRake??0)*depth*depth,aft=last-(profile.sternRake??0)*depth*depth;
  const z=station*(station<0?fore/first:aft/last),y=baseY+hullLoftSheer(profile,z);
  return [side*hullLoftWidth(profile,z,y),y,z];
}

// One emitted evaluator per model avoids runtime storage bindings for static
// offsets. Match the CPU interpolation instead of approximating contact with a
// waterline prism or another vessel's profile.
export function hullLoftWGSL(profile,prefix){
  if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix))throw Error('Invalid hull shader prefix');
  const nx=profile.stations.length,ny=profile.levels.length,n=nx*ny;
  const numbers=xs=>xs.map(x=>Number(x).toPrecision(12)).join(',');
  return `
const ${prefix}X=array<f32,${nx}>(${numbers(profile.stations)});
const ${prefix}Y=array<f32,${ny}>(${numbers(profile.levels)});
const ${prefix}W=array<f32,${n}>(${numbers(profile.sections.flat())});
const ${prefix}M=array<f32,${n}>(${numbers(profile.tangents.flat())});
fn ${prefix}Sheer(z:f32)->f32 {
  let t=clamp((z-(${profile.stations[0]}))/${profile.stations.at(-1)-profile.stations[0]},0.0,1.0);
  return ${profile.sheerFore??0}*pow(1.0-t,4.0)+${profile.sheerAft??0}*pow(t,4.0)-${profile.sheerDatum??0};
}
fn ${prefix}Row(j:u32,z:f32)->f32 {
  var i=0u;while(i<${nx-2}u&&z>${prefix}X[i+1u]){i++;}
  let h=${prefix}X[i+1u]-${prefix}X[i];let t=clamp((z-${prefix}X[i])/h,0.0,1.0);let k=j*${nx}u+i;
  return victoryCubic(${prefix}W[k],${prefix}W[k+1u],${prefix}M[k],${prefix}M[k+1u],h,t);
}
fn ${prefix}Width(z:f32,y:f32)->f32 {
  let base=y-${prefix}Sheer(z);if(base<${profile.levels[0]}-.00000001||base>${profile.levels.at(-1)}+.00000001){return 0.0;}
  let depth=clamp(-base/${-profile.levels[0]},0.0,1.0);
  let fore=${profile.stations[0]}+${profile.bowRake??0}*depth*depth;let aft=${profile.stations.at(-1)}-${profile.sternRake??0}*depth*depth;
  if(z<fore-.00000001||z>aft+.00000001){return 0.0;}
  let station=select(z*${profile.stations.at(-1)}/aft,z*${profile.stations[0]}/fore,z<0.0);
  var j=0u;while(j<${ny-2}u&&base>${prefix}Y[j+1u]){j++;}
  var rows=array<f32,4>(0.0,0.0,0.0,0.0);
  for(var r=0u;r<4u;r++){rows[r]=${prefix}Row(u32(clamp(i32(j)+i32(r)-1,0,${ny-1})),station);}
  let before=rows[0];let a=rows[1];let b=rows[2];let after=rows[3];let span=${prefix}Y[j+1u]-${prefix}Y[j];let d=(b-a)/span;var left:f32;var right:f32;
  if(j>0u){let h=${prefix}Y[j]-${prefix}Y[j-1u];left=victoryTangent(h,span,(a-before)/h,d);}
  else{let h=${prefix}Y[2]-${prefix}Y[1];left=victoryEndTangent(span,h,d,(after-b)/h);}
  if(j<${ny-2}u){let h=${prefix}Y[j+2u]-${prefix}Y[j+1u];right=victoryTangent(span,h,d,(after-b)/h);}
  else{let h=${prefix}Y[j]-${prefix}Y[j-1u];right=victoryEndTangent(span,h,d,(a-before)/h);}
  return max(0.0,victoryCubic(a,b,left,right,span,clamp((base-${prefix}Y[j])/span,0.0,1.0)));
}
`;
}
