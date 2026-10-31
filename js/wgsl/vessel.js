import { TILLER_PIVOT, HULL_VERTICAL_SCALE, hullDeck } from '../hull.js';
import { LATEEN_MOTION } from './lateen.js';
import {VICTORY_MOTION} from './victory.js';
import {VICTORY_DESIGN,VICTORY_SAILS,victoryHatchPivot} from '../models/victory.js';
import {createGunDefinitions} from '../gunnery-models.js';
import {ADDITIONAL_DESIGNS} from '../models/additional.js';
import {additionalGunAttachments} from '../additional-rig.js';
const additionalGunFlashWGSL=Object.values(ADDITIONAL_DESIGNS).map(d=>{
 const guns=additionalGunAttachments(d.id);return guns.length?`const gunFlashModel${d.modelCode}=array<vec3f,${guns.length}>(${guns.map(g=>'vec3f('+g.muzzleDesign.join(',')+')').join(',')});`:'';
}).join('\n');
// Shared deformation keeps visible geometry, wetness and shadow casters coincident.
export const VESSEL_RIG = /* wgsl */ `
struct Hull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f,
  sailSet:vec4f, sailTrim:vec4f, sailWind:vec4f, lateen:array<vec4f,3>, lateenPressure:vec4f };
fn rotateHull(p:vec3f)->vec3f { return hull.right.xyz*p.x+hull.up.xyz*p.y-hull.forward.xyz*p.z; }
const gunFlashNina=array<vec3f,4>(${createGunDefinitions('nina').map(g=>'vec3f('+g.muzzleDesign.join(',')+')').join(',')});
const gunFlashVictory=array<vec3f,104>(${createGunDefinitions('victory').map(g=>'vec3f('+g.muzzleDesign.join(',')+')').join(',')});
${additionalGunFlashWGSL}
fn gunFlashSurface(world:vec3f,n:vec3f,eye:vec3f,albedo:vec3f,rough:f32)->vec3f {
  var result=vec3f(0);
  let energy=abs(hull.up.w);
  if(energy>=.0001){
    let index=u32(max(0.0,hull.forward.w));
    var local=gunFlashNina[min(index,3u)];
    if(hull.rig.w>.5&&hull.rig.w<1.5){local=gunFlashVictory[min(index,103u)];}
    ${Object.values(ADDITIONAL_DESIGNS).map(d=>{const guns=additionalGunAttachments(d.id);return guns.length?`if(abs(hull.rig.w-${d.modelCode}.0)<.1){local=gunFlashModel${d.modelCode}[min(index,${guns.length-1}u)];}`:'';}).join('\n')}
    let scale=vec3f(hull.size.x/3.6,hull.right.w,hull.size.y/12.0);
    let light=hull.origin.xyz+rotateHull(local*scale);
    let delta=light-world;let d=max(.25,length(delta));let l=delta/d;
    let halfV=normalize(l+eye);let spec=pow(max(dot(n,halfV),0.0),mix(90.0,8.0,rough));
    // A finite, warm black-powder flash. Illumination falls with distance, lasts
    // less than a tenth of a second, and adds no persistent glow to the wood.
    result+=vec3f(1.0,.47,.12)*energy*90.0/(1.0+d*d)*(albedo*.31831*max(dot(n,l),0.0)+spec*.07);
  }
  let firePack=hull.lateenPressure.w;
  if(firePack>0.5){
    let fireInt=fract(firePack)*2.5;
    let fireDesignZ=(floor(firePack)-6.5)*(hull.size.y/12.0);
    let t=hull.origin.w;
    let flicker=0.82+0.12*sin(t*13.7)+0.08*cos(t*23.1)+0.05*sin(t*37.3);
    let fireLocal=vec3f(sin(t*7.1)*0.25,1.85*hull.right.w,fireDesignZ);
    let fireLight=hull.origin.xyz+rotateHull(fireLocal);
    let fDelta=fireLight-world;let fd=max(0.6,length(fDelta));let fl=fDelta/fd;
    let fHalf=normalize(fl+eye);let fSpec=pow(max(dot(n,fHalf),0.0),mix(64.0,6.0,rough));
    let ndl=max(dot(n,fl),0.0)*0.75+0.25;
    result+=vec3f(1.0,0.36,0.07)*(fireInt*flicker*38.0/(1.5+fd*fd*0.38))*(albedo*0.31831*ndl+fSpec*0.05);
  }
  return result;
}
${LATEEN_MOTION}
${VICTORY_MOTION}
struct RigVertex { position:vec3f, normal:vec3f, scale:vec3f };
fn rigVertex(position:vec3f,normal:vec3f,material:f32,uv:vec2f)->RigVertex {
  var scale=vec3f(hull.size.x/3.6,select(${HULL_VERTICAL_SCALE},hull.right.w,hull.right.w>0.0),hull.size.y/12.0);
  var local=position;var localN=normal;
  let hasBakedDamage=dot(normal,normal)>1.004;
  // Descriptor-driven models upload one authoritative CPU pose. Every consumer
  // reads this same vertex stream; the legacy rig must not deform it again.
  if(hull.rig.w>=1.5){return RigVertex(local,localN,scale);}
  if(hull.rig.w>.5){
    let base=u32(material);let id=u32(round(fract(material)*64.0));
    if(id>0u && id<=${VICTORY_SAILS.length}u){
      let sail=victorySails[id-1u];
      if(base==9u || base==13u || base==19u){
        let offsets=array<vec2f,5>(vec2f(0,0),vec2f(.0005,0),vec2f(-.0005,0),vec2f(0,.0005),vec2f(0,-.0005));
        var pts=array<vec3f,5>(vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0));
        let sampleCount=select(5u,1u,base==19u);
        for(var s=0u;s<sampleCount;s++){pts[s]=victorySailCloth(sail,uv+offsets[s]);}
        local=pts[0];
        let restCloth=victorySailRest(sail,uv);let clothDelta=position-restCloth;
        if(base==19u){local+=victorySailRotate(sail,clothDelta);localN=victorySailRotate(sail,normal);}
        else{
          let clothN=normalize(cross(pts[1]-pts[2],pts[3]-pts[4]));
          if(hasBakedDamage){
            local+=clothDelta;
            let dispMix=clamp(length(clothDelta)*1.2,0.0,0.85);
            localN=normalize(mix(clothN,normalize(normal),dispMix));
          }else{localN=clothN;}
        }
      }else if(base==10u){local=victorySailYard(sail,position);localN=victorySailRotate(sail,normal);}
    }else if(base==12u && uv.x>=100.0){
      let index=u32(round(uv.x-100.0));let line=victoryLines[index];let t=uv.y;
      let oldAxis=normalize(line.b.xyz-line.a.xyz);
      let a0=victoryRopePoint(index,0.0);let b1=victoryRopePoint(index,1.0);
      let newAxis=normalize(b1-a0);
      let lineDelta=position-mix(line.a.xyz,line.b.xyz,t);
      let bracedRope=mix(a0,b1,t)+ropeFrame(lineDelta,oldAxis,newAxis);
      let ropeMix=select(0.0,clamp(length(lineDelta)*1.5,0.0,1.0),hasBakedDamage);
      local=mix(bracedRope,position,ropeMix);
      localN=ropeFrame(normal,oldAxis,newAxis);
    }else if(base==7u || base==8u){
      let pivot=vec3f(${VICTORY_DESIGN.wheel.centre.join(',')});let a=hull.size.w*.07;let c=cos(a);let s=sin(a);let p=position-pivot;
      local=pivot+vec3f(c*p.x-s*p.y,s*p.x+c*p.y,p.z);localN=vec3f(c*normal.x-s*normal.y,s*normal.x+c*normal.y,normal.z);
    }else if(base==14u){
      let pivot=vec3f(${VICTORY_DESIGN.tiller.pivot.join(',')});let a=hull.size.w*.0174532925;let c=cos(a);let s=sin(a);let p=position-pivot;
      local=pivot+vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);localN=vec3f(c*normal.x+s*normal.z,normal.y,-s*normal.x+c*normal.z);
    }else if(base==18u){
      let pivot=vec3f(${victoryHatchPivot().join(',')});let p=position-pivot;
      let a=(1.0-clamp(hull.sailSet.w,0.0,1.0))*1.57079632679;let c=cos(a);let s=sin(a);
      local=pivot+vec3f(p.x,c*p.y+s*p.z,-s*p.y+c*p.z);
      localN=vec3f(normal.x,c*normal.y+s*normal.z,-s*normal.y+c*normal.z);
    }
    return RigVertex(local,localN,scale);
  }
  if(material==7.0 || material==8.0){
    let pivot=vec3f(${TILLER_PIVOT.join(',')});
    let angle=hull.size.w*0.0174532925;let c=cos(angle);let s=sin(angle);
    let q=position-pivot;
    local=vec3f(c*q.x+s*q.z,q.y,-s*q.x+c*q.z)+pivot;
    localN=vec3f(c*normal.x+s*normal.z,normal.y,-s*normal.x+c*normal.z);
  }
  if(material==18.0){
    let pivot=vec3f(0,${hullDeck(-2.65)+.085},-2.65);let q=position-pivot;
    let angle=(1.0-clamp(hull.sailSet.w,0.0,1.0))*1.5707963;
    let c=cos(angle);let s=sin(angle);
    local=vec3f(q.x,c*q.y-s*q.z,s*q.y+c*q.z)+pivot;
    localN=vec3f(normal.x,c*normal.y-s*normal.z,s*normal.y+c*normal.z);
  }
  if(material==14.0){
    // +X is starboard and +Z is aft: positive helm moves the trailing edge to starboard.
    let angle=hull.size.w*0.0174532925;let c=cos(angle);let s=sin(angle);
    let pivot=vec3f(0,-0.6,5.68);let q=position-pivot;
    local=vec3f(c*q.x+s*q.z,q.y,-s*q.x+c*q.z)+pivot;
    localN=vec3f(c*normal.x+s*normal.z,normal.y,-s*normal.x+c*normal.z);
  }
  let tag=u32(round(fract(material)*16.0));let id=tag&7u;let base=u32(material);
  if(base==12u && uv.x>=100.0){
    let index=u32(round(uv.x-100.0));let line=rigLines[index];let t=uv.y;
    let oldAxis=normalize(line.b.xyz-line.a.xyz);
    var rPts=array<vec3f,3>(vec3f(0),vec3f(0),vec3f(0));
    let rTs=array<f32,3>(t,min(1.0,t+.001),max(0.0,t-.001));
    for(var s=0u;s<3u;s++){rPts[s]=rigRopePoint(index,rTs[s]);}
    let newAxis=normalize(rPts[1]-rPts[2]);
    let lineDelta=position-mix(line.a.xyz,line.b.xyz,t);
    local=select(rPts[0]+ropeFrame(lineDelta,oldAxis,newAxis),position,hasBakedDamage && dot(lineDelta,lineDelta)>.01);
    localN=ropeFrame(normal,oldAxis,newAxis);
  }else if(id>0u && id<=3u){
    let isCloth=base==9u || base==13u;
    let sampleBase=select(base,13u,base==19u);
    let rest0=sailRestPoint(id,uv);
    let clothDelta=position-rest0;
    let isDamagedCloth=isCloth && hasBakedDamage && dot(clothDelta,clothDelta)>.01;
    let offsets=array<vec2f,5>(vec2f(0,0),vec2f(.0005,0),vec2f(-.0005,0),vec2f(0,.0005),vec2f(0,-.0005));
    var pts=array<vec3f,5>(vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0));
    let sampleCount=select(1u,5u,isCloth);
    for(var s=0u;s<sampleCount;s++){
      let suv=uv+offsets[s];
      let sp=select(select(position,rest0,base==19u || isDamagedCloth),sailRestPoint(id,suv),s>0u);
      pts[s]=sailPoint(sp,suv,id,sampleBase,false);
    }
    local=pts[0];
    if(base==19u){local+=clothRotation(id,clothDelta);}
    else if(isDamagedCloth){local+=clothDelta;}
    if(isCloth){localN=normalize(cross(pts[1]-pts[2],pts[3]-pts[4]));}
    else if(base==10u){localN=yardRotation(id,normal);}
    else{localN=clothRotation(id,normal);}
  }
  return RigVertex(local,localN,scale);
}
`;

// Hull, rigging and crew share a light response; materials supply their own
// albedo and roughness. Environment sampling stays with each renderer.
export const VESSEL_LIGHTING = /* wgsl */ `
fn vesselFresnel(f0:vec3f,cosine:f32)->vec3f {
  // Dot products can exceed 1 by an ulp. Multiplication also avoids WGSL's
  // undefined pow(negative,5), which can produce an HDR firefly.
  let f=1.0-clamp(cosine,0.0,1.0);let f2=f*f;
  return f0+(1.0-f0)*f2*f2*f;
}
fn vesselSpecular(n:vec3f,v:vec3f,l:vec3f,rough:f32,f0:vec3f)->vec3f {
  // The half-vector is undefined when view and light oppose exactly.
  let h=(v+l)/max(length(v+l),0.00001);
  let nv=clamp(dot(n,v),0.001,1.0);let nl=clamp(dot(n,l),0.0,1.0);
  let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
  let a=rough*rough;let a2=a*a;
  let d=a2/(PI*pow(nh*nh*(a2-1.0)+1.0,2.0));
  let k=pow(rough+1.0,2.0)/8.0;
  let g=nv/(nv*(1.0-k)+k)*nl/(nl*(1.0-k)+k);
  return d*g*vesselFresnel(f0,vh)/(4.0*nv*max(nl,0.001));
}
fn vesselAmbient(n:vec3f,sky:vec3f,sea:vec3f)->vec3f {
  let skyVisibility=0.5+0.5*n.y;
  return sky*skyVisibility+sea*0.22*(1.0-skyVisibility);
}
fn vesselEnvironment(n:vec3f,v:vec3f,rough:f32,f0:vec3f)->vec3f {
  // Rough surfaces average many facet angles. Applying the smooth-surface
  // grazing limit to a blurred cube makes matte linen and timber shine white.
  let f=1.0-clamp(dot(n,v),0.001,1.0);let f2=f*f;
  return (f0+(max(vec3f(1.0-rough),f0)-f0)*f2*f2*f)*(1.0-rough*0.45);
}
`;

export const CANVAS_OPTICS = /* wgsl */ `
// Reduced fibre/medium index contrast lowers scattering when damp. This modest
// optical adjustment is authored, not a measured historical canvas coefficient.
fn canvasWetDepth(wet:f32)->f32 {return 1.0-0.18*clamp(wet,0.0,1.0);}
fn canvasThickness(uv:vec2f,material:u32)->f32 {
  let seamDistance=abs(fract(uv.x*10.0)-0.5);
  let seam=1.0-smoothstep(0.004,0.013+max(fwidth(seamDistance),0.001),seamDistance);
  let squareEdge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let triangleEdge=min(min(uv.x,uv.y),(1.0-uv.x-uv.y)*0.70710678);
  let edge=select(squareEdge,triangleEdge,material==13u);
  let hem=1.0-smoothstep(0.006,0.014+max(fwidth(edge),0.0005),edge);
  let fold=pow(0.5+0.5*cos(uv.x*62.83185+sin(uv.y*9.0)*0.35),8.0);
  let weave=sin(uv.x*1400.0)*sin(uv.y*1800.0)*(1.0-smoothstep(0.0004,0.003,max(fwidth(uv.x+uv.y),0.001)));
  return 1.0+0.95*seam+0.85*hem+0.18*fold+0.035*weave;
}
fn canvasTransmission(thickness:f32,incidence:f32)->vec3f {
  return exp(-vec3f(0.90,1.15,1.60)*thickness/max(incidence,0.12));
}
`;
