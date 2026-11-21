// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared GPU anatomical diversity, child allometry, and proportion-smoothing field (AGENTS.md rules 1-3).
// Evaluated identically on every person's body skin, 3D hair, and 3D curve-pinned clothing from the exact same
// (personId, sex, childness, elderness) packed into ContinuumRecord.spare.zw, so clothing & hair conform
// automatically to every child, youth, adult, elder, build, and face shape with zero CPU loops and zero extra buffers.

// Bit layout of ContinuumRecord.spare.zw for humans (animals/horses leave spare.z == 0u and skip in 1 branch):
//   spare.z: ((identity & 0x3fffffffu) << 2u) | (select(0u, 2u, female)) | 1u
//   spare.w: childByte | (elderByte << 8u) | (select(0u, 1u, isRider) << 16u)
export const HUMAN_MORPH_WGSL = /* wgsl */`
fn humanMorphHash(v:u32)->u32 {
  var h=v*0x9e3779b1u+0x85ebca6bu;
  h=(h^(h>>15u))*0x2c1b3c6du;
  return h^(h>>13u);
}

// Uniform in [0, 1) from (seed, channel).
fn humanMorphU01(seed:u32,ch:u32)->f32 {
  return f32(humanMorphHash(seed*97u+ch*0x27d4eb2du+17u)&0xffffffu)*(1.0/16777216.0);
}

// Zero-mean Irwin-Hall bell-curve sample in [-1, 1] (clustered smoothly near 0, rare tails).
fn humanMorphBell(seed:u32,ch:u32)->f32 {
  let a=humanMorphU01(seed,ch*3u);
  let b=humanMorphU01(seed,ch*3u+1u);
  let c=humanMorphU01(seed,ch*3u+2u);
  return (a+b+c)*0.6666667-1.0;
}

// C2 quintic smoothstep for seam-free anatomical transitions.
fn humanMorphS5(a:f32,b:f32,x:f32)->f32 {
  let t=clamp((x-a)/max(b-a,1e-5),0.0,1.0);
  return t*t*t*(t*(t*6.0-15.0)+10.0);
}

// Deterministic life stage from stable person identity:
//   x = base uniform scale (height first, just as children scale down before allometric tweaks!)
//   y = childness in [0, 1] (0 = adult >=16yr, 1 = ~6yr child)
//   z = elderness in [0, 1] (0 = <=52yr, 1 = ~75yr elder)
//   w = ageYears (approximate age in years)
fn humanLifeStage(identity:u32,allowChildren:bool,isRider:bool)->vec4f {
  let rStage=humanMorphU01(identity,101u);
  let rSub=humanMorphU01(identity,102u);
  let rHeight=humanMorphBell(identity,103u);
  if(allowChildren&&!isRider){
    if(rStage<0.18){
      // Children (~6 to 12 years): simple base scale [0.64..0.82] + smooth child allometry!
      let age=6.0+rSub*6.5;
      let t=(age-6.0)/6.5;
      let scale=clamp(mix(0.64,0.82,t)+rHeight*0.025,0.61,0.85);
      let childness=clamp((15.5-age)/9.5,0.0,1.0);
      return vec4f(scale,childness,0.0,age);
    }
    if(rStage<0.30){
      // Youths (~13 to 17 years): base scale [0.85..0.95] + subtle youth allometry
      let age=12.5+rSub*4.5;
      let t=(age-12.5)/4.5;
      let scale=clamp(mix(0.85,0.95,t)+rHeight*0.025,0.83,0.97);
      let childness=clamp((16.5-age)/10.0,0.0,0.32);
      return vec4f(scale,childness,0.0,age);
    }
    if(rStage>0.85){
      // Elders (~54 to 75 years)
      let age=54.0+rSub*21.0;
      let elderness=clamp((age-52.0)/23.0,0.0,1.0);
      let scale=clamp(0.985-0.025*elderness+rHeight*0.055,0.90,1.05);
      return vec4f(scale,0.0,elderness,age);
    }
    // Adults (~18 to 53 years)
    let age=18.0+rSub*35.0;
    let scale=clamp(1.00+rHeight*0.068,0.92,1.09);
    return vec4f(scale,0.0,0.0,age);
  }
  // Ship crew / horseback riders: youths (cabin hands 15-18), adults (19-52), veteran elders (53-68)
  if(rStage<0.10&&!isRider){
    let age=15.0+rSub*3.0;
    let scale=clamp(0.90+rSub*0.04+rHeight*0.02,0.88,0.96);
    return vec4f(scale,clamp((17.0-age)/12.0,0.0,0.16),0.0,age);
  }
  if(rStage>0.86){
    let age=53.0+rSub*15.0;
    let elderness=clamp((age-52.0)/22.0,0.0,0.85);
    let scale=clamp(0.99-0.015*elderness+rHeight*0.055,0.92,1.06);
    return vec4f(scale,0.0,elderness,age);
  }
  let age=19.0+rSub*33.0;
  let scale=clamp(1.00+rHeight*0.065,0.93,1.08);
  return vec4f(scale,0.0,0.0,age);
}

// Exact board-age life stage when ageYears > 0 (from Castle & Commons soul age packed in walker flags bits 8..15),
// falling back cleanly to deterministic humanLifeStage for ship crews and procedural towns without board ages.
fn humanLifeStageFromAge(ageYears:u32,identity:u32,allowChildren:bool,isRider:bool)->vec4f {
  if(ageYears==0u){return humanLifeStage(identity,allowChildren,isRider);}
  let rHeight=humanMorphBell(identity,103u);
  let age=f32(ageYears);
  if(age<12.5&&!isRider){
    // Real child height scaling (e.g. age 6 ≈ 0.65x ~1.11m, age 10 ≈ 0.77x ~1.32m, age 12 ≈ 0.83x)
    let t=clamp((age-4.0)/8.5,0.0,1.0);
    let scale=clamp(mix(0.56,0.83,t)+rHeight*0.022,0.54,0.85);
    let childness=clamp((15.0-age)/9.0,0.0,1.0);
    return vec4f(scale,childness,0.0,age);
  }
  if(age<17.5&&!isRider){
    let t=clamp((age-12.5)/5.0,0.0,1.0);
    let scale=clamp(mix(0.84,0.96,t)+rHeight*0.025,0.82,0.98);
    let childness=clamp((16.5-age)/10.0,0.0,0.28);
    return vec4f(scale,childness,0.0,age);
  }
  if(age>=53.0){
    let elderness=clamp((age-52.0)/24.0,0.0,1.0);
    let scale=clamp(0.985-0.025*elderness+rHeight*0.048,0.91,1.04);
    return vec4f(scale,0.0,elderness,age);
  }
  let scale=clamp(1.00+rHeight*0.055,0.93,1.07);
  return vec4f(scale,0.0,0.0,age);
}

fn humanMorphPackZ(identity:u32,female:bool)->u32 {
  return ((identity&0x3fffffffu)<<2u)|select(0u,2u,female)|1u;
}
fn humanMorphPackW(childness:f32,elderness:f32,isRider:bool)->u32 {
  let cb=u32(clamp(round(childness*255.0),0.0,255.0));
  let eb=u32(clamp(round(elderness*255.0),0.0,255.0));
  return cb|(eb<<8u)|select(0u,1u<<16u,isRider);
}
const HUMAN_MORPH_BODY_INSET_BIT:u32=1u<<17u;

// Smooth watertight inward clearance inset strictly under upper/lower garment coverage on clothed body meshes
// (100% opaque & TBDR-safe; leaves head, neck, wrists, hands & feet y < 0.09 100% untouched!).
fn humanBodyUnderClothInset(p:vec3f,n:vec3f,spareZ:u32,spareW:u32)->vec3f {
  if((spareW&HUMAN_MORPH_BODY_INSET_BIT)==0u){return p;}
  let female=(spareZ&2u)!=0u;
  let shY=select(1.419,1.385,female);
  // Trunk + hips/thighs strictly covered by 1550 shirts/bodices/trousers/skirts.
  // Keep front neckline (n.z > 0.25) untouched above shY-0.06, while extending back/shoulder-blade clearance
  // (n.z <= 0.15) up to shY+0.03 so leaning walk strides never poke bare back skin through chemises/bodices.
  let backBias=1.0-humanMorphS5(0.05,0.35,n.z);
  let topCut=shY+mix(-0.04,0.035,backBias);
  let trunkY=humanMorphS5(0.44,0.56,p.y)*(1.0-humanMorphS5(topCut-0.04,topCut+0.03,p.y));
  let armX=1.0-humanMorphS5(0.24,0.34,abs(p.x));
  let trunkInset=select(0.024,0.028,female)*trunkY*armX;
  // Covered calves/shins (y in [0.09..0.60]): extra clearance on females so backward leg swing inside
  // blended-weight long skirts never pokes calf skin through the skirt back; feet y < 0.085 stay untouched!
  let calfMask=humanMorphS5(0.085,0.13,p.y)*(1.0-humanMorphS5(0.50,0.62,p.y))*(1.0-humanMorphS5(0.26,0.34,abs(p.x)));
  let calfInset=select(0.015,0.024,female)*calfMask;
  // Upper & mid arms covered by sleeves (|x| in [0.18..0.46]): smooth 1.2 cm inset; wrists & hands stay untouched!
  let armMaskY=humanMorphS5(1.16,1.25,p.y)*(1.0-humanMorphS5(shY+0.05,shY+0.12,p.y));
  let armMaskX=humanMorphS5(0.18,0.24,abs(p.x))*(1.0-humanMorphS5(0.42,0.48,abs(p.x)));
  let armInset=0.012*armMaskX*armMaskY;
  let insetAmt=max(trunkInset,max(calfInset,armInset));
  if(insetAmt<0.0002){return p;}
  return p-n*insetAmt;
}

// Smooth C2 anatomical displacement D(p) in canonical T-pose rest metres (+Y up, +Z front, +X left).
// Applied identically to body skin, 3D hair, and 3D curve-pinned clothing before 93-joint skinning!
fn humanMorphPoint(p:vec3f,spareZ:u32,spareW:u32)->vec3f {
  if((spareZ&1u)==0u){return p;}
  let female=(spareZ&2u)!=0u;
  let seed=spareZ>>2u;
  let childness=f32(spareW&255u)*(1.0/255.0);
  let elderness=f32((spareW>>8u)&255u)*(1.0/255.0);

  // Exact measured Tripo H3.1 Ultra landmarks (female vs male):
  let pelvisY=select(0.960,0.970,female);
  let shY=select(1.419,1.385,female);
  let neckY=select(1.475,1.431,female);
  let headY=select(1.579,1.530,female);
  let spineZ=select(-0.055,-0.015,female);
  let eyeY=select(1.662,1.591,female);
  let eyeZ=select(0.075,0.084,female);
  let noseY=select(1.616,1.550,female);
  let noseZ=select(0.116,0.121,female);
  let headCenter=vec3f(0.0,headY+0.025,select(-0.012,0.004,female));

  // Sample bell-curved DNA traits + proportion smoothing (tanh saturation + global L2 energy cap!)
  // Body traits (5): build, shoulders, hips, belly, waistTaper
  var b0=tanh(1.15*humanMorphBell(seed,1u));
  var b1=tanh(1.15*humanMorphBell(seed,2u));
  var b2=tanh(1.15*humanMorphBell(seed,3u));
  var b3=tanh(1.15*humanMorphBell(seed,4u));
  var b4=tanh(1.15*humanMorphBell(seed,5u));
  let bNorm=sqrt(b0*b0+b1*b1+b2*b2+b3*b3+b4*b4+1e-6);
  let bCap=min(1.0,1.30/bNorm)*(1.0-0.55*childness);
  let dBuild=b0*bCap;
  let dShoulders=b1*bCap;
  let dHips=b2*bCap;
  let dBelly=b3*bCap;
  let dWaist=b4*bCap;

  var q=p;

  // --- Stage 1: Smooth Body Somatotype & Child/Elder Proportions (feet at y<0.07 stay 100% locked!) ---
  let footLock=humanMorphS5(0.06,0.18,p.y);
  let armMask=1.0-humanMorphS5(0.18,0.34,abs(p.x));
  let belowNeck=1.0-humanMorphS5(neckY-0.04,neckY+0.05,p.y);
  let torsoMask=humanMorphS5(0.68,0.88,p.y)*belowNeck*armMask;
  // Strictly mask shBand by armMask so shoulder width never pulls T-pose forearms/hands off their wrist/finger bone pivots!
  let shBand=exp(-pow((p.y-shY)/0.13,2.0))*belowNeck*armMask;
  let hipBand=exp(-pow((p.y-(pelvisY-0.06))/0.16,2.0))*armMask;
  let waistBand=exp(-pow((p.y-(pelvisY+0.07))/0.15,2.0))*armMask;
  let legBand=humanMorphS5(0.14,0.35,p.y)*(1.0-humanMorphS5(0.76,0.92,p.y));

  // Center radial body expansion around anatomical spine line (0, y, spineZ) so clothes/belts follow!
  let relZ=p.z-spineZ;

  // Overall build (stout <-> lean) + genuinely slender child trunk/shoulders (never squat mini-bodybuilders!)
  let buildXZ=(dBuild*0.048-0.115*childness)*torsoMask+(dBuild*0.036-0.075*childness)*legBand;
  let shX=(dShoulders*0.042-0.135*childness)*shBand;
  let hipXZ=(dHips*0.038-0.095*childness)*hipBand;
  let waistXZ=(-dWaist*0.032)*waistBand;

  // Smooth lateral X & front/back Z proportion scaling
  q.x+=p.x*(buildXZ+shX+hipXZ+waistXZ)*footLock;
  q.z+=relZ*(buildXZ+hipXZ*0.70+waistXZ)*footLock;

  // Belly / midsection fullness (+ gentle elder fullness, front-weighted)
  let frontW=humanMorphS5(-0.02,0.08,relZ);
  let bellyAmt=max(-0.010,dBelly*0.014+max(0.0,dBuild)*0.008+elderness*0.013)*(1.0-0.90*childness);
  q.z+=bellyAmt*waistBand*frontW*footLock;

  // Upper-arm thickness follows build smoothly; fades to 0 before wrists/hands (|x| > 0.44) and NEVER shifts X off arm bones!
  let upperArm=humanMorphS5(0.18,0.28,abs(p.x))*(1.0-humanMorphS5(0.40,0.52,abs(p.x)))*humanMorphS5(1.18,1.30,p.y);
  if(upperArm>0.001){
    let armY=select(1.405,1.375,female);
    let armZ=select(-0.085,-0.065,female);
    let armScale=(dBuild*0.045-0.070*childness)*upperArm;
    q.y+=(p.y-armY)*armScale;
    q.z+=(p.z-armZ)*armScale;
  }

  // Gentle elder upper-back posture stoop (smooth, never breaks neck seam)
  if(elderness>0.01){
    let stoopMask=humanMorphS5(pelvisY+0.05,shY+0.06,p.y);
    q.z+=0.011*elderness*stoopMask;
    q.y-=0.006*elderness*stoopMask;
  }

  // --- Stage 2: Child Cranial Allometry + Bounded Facial Micro-Variations (evaluated ONLY near/above neck!) ---
  let headBlend=humanMorphS5(neckY-0.035,neckY+0.055,p.y);
  if(headBlend>0.0005){
    // Natural subtle child cranial proportion (+16% relative head ratio after scaling down, never bobblehead!)
    if(childness>0.005){
      let headGrow=0.16*childness*headBlend;
      // Scale smoothly around neck/base-of-skull pivot so neck stays seated on shoulders!
      let pivot=vec3f(0.0,neckY+0.015,headCenter.z);
      q+=(q-pivot)*headGrow;
    }

    // Face micro-variation DNA (7 traits), damped on children & L2 energy-capped so nobody ever looks warped!
    var f0=tanh(1.10*humanMorphBell(seed,11u)); // face width
    var f1=tanh(1.10*humanMorphBell(seed,12u)); // face length
    var f2=tanh(1.10*humanMorphBell(seed,13u)); // cheekbone prominence
    var f3=tanh(1.10*humanMorphBell(seed,14u)); // jaw width
    var f4=tanh(1.10*humanMorphBell(seed,15u)); // chin projection/height
    var f5=tanh(1.10*humanMorphBell(seed,16u)); // nose length/tip
    var f6=tanh(1.10*humanMorphBell(seed,17u)); // nose width / brow ridge
    let fNorm=sqrt(f0*f0+f1*f1+f2*f2+f3*f3+f4*f4+f5*f5+f6*f6+1e-6);
    let fCap=min(1.0,1.25/fNorm)*(1.0-0.70*childness);
    f0*=fCap; f1*=fCap; f2*=fCap; f3*=fCap; f4*=fCap; f5*=fCap; f6*=fCap;

    // Eye-socket safety guard: strictly 0.0 inside 2.0 cm of left & right eyeballs/eyelids!
    let eyeL=vec3f(0.034,eyeY,eyeZ);
    let eyeR=vec3f(-0.034,eyeY,eyeZ);
    let dEye=min(length(p-eyeL),length(p-eyeR));
    let eyeSafe=humanMorphS5(0.020,0.036,dEye);
    let hRel=p-headCenter;

    // 1. Global subtle cranial width & height ratio (gentle, keeps eyes seated smoothly)
    let fMask=headBlend*eyeSafe;
    q.x+=hRel.x*(f0*0.034+dBuild*0.018)*headBlend;
    q.y+=hRel.y*(f1*0.028-0.025*childness)*headBlend;

    // 2. Cheekbones (symmetrical bilateral Gaussian RBF)
    let cheekPos=vec3f(0.048,eyeY-0.032,eyeZ-0.008);
    let dCheek=length(vec3f(abs(p.x),p.y,p.z)-cheekPos);
    let wCheek=exp(-dCheek*dCheek/(2.0*0.026*0.026))*fMask;
    q.x+=sign(p.x)*(f2*0.0028+dBuild*0.0016)*wCheek;
    q.z+=(f2*0.0024)*wCheek;

    // 3. Jaw corners (bilateral; children get softer narrower jaw!)
    let jawPos=vec3f(0.045,eyeY-0.095,eyeZ-0.036);
    let dJaw=length(vec3f(abs(p.x),p.y,p.z)-jawPos);
    let wJaw=exp(-dJaw*dJaw/(2.0*0.032*0.032))*fMask;
    q.x+=sign(p.x)*(f3*0.0034-0.0065*childness+dBuild*0.0020)*wJaw;

    // 4. Chin depth & vertical length (children get softer shorter chin!)
    let chinPos=vec3f(0.0,eyeY-0.112,eyeZ+0.008);
    let dChin=length(p-chinPos);
    let wChin=exp(-dChin*dChin/(2.0*0.028*0.028))*fMask;
    q.z+=(f4*0.0030-0.0045*childness)*wChin;
    q.y+=(-f4*0.0024+0.0045*childness)*wChin;

    // 5. Nose bridge/tip projection, length & width (strictly eyeSafe!)
    let nosePos=vec3f(0.0,noseY,noseZ-0.010);
    let dNose=length(p-nosePos);
    let wNose=exp(-dNose*dNose/(2.0*0.020*0.020))*fMask;
    q.z+=(f5*0.0030-0.0030*childness)*wNose;
    q.y+=(-f5*0.0020+0.0020*childness)*wNose;
    q.x+=p.x*(f6*0.09)*wNose;

    // 6. Brow ridge & forehead height
    let browPos=vec3f(0.0,eyeY+0.026,eyeZ+0.008);
    let dBrow=length(p-browPos);
    let wBrow=exp(-dBrow*dBrow/(2.0*0.026*0.026))*fMask;
    q.z+=(f6*0.0024-0.0025*childness)*wBrow;
  }

  return q;
}

// Morph both rest position and rest normal using exact finite-difference Jacobian cofactor so specular
// lighting across varied cheekbones, noses, jaws, and builds stays physically crisp!
struct HumanMorphed { pos:vec3f, nrm:vec3f };
fn humanMorphPosNrm(p:vec3f,n:vec3f,spareZ:u32,spareW:u32)->HumanMorphed {
  if((spareZ&1u)==0u){return HumanMorphed(p,n);}
  let p0=humanMorphPoint(p,spareZ,spareW);
  let eps=0.004;
  let j0=(humanMorphPoint(p+vec3f(eps,0.0,0.0),spareZ,spareW)-p0)*(1.0/eps);
  let j1=(humanMorphPoint(p+vec3f(0.0,eps,0.0),spareZ,spareW)-p0)*(1.0/eps);
  let j2=(humanMorphPoint(p+vec3f(0.0,0.0,eps),spareZ,spareW)-p0)*(1.0/eps);
  let c0=cross(j1,j2);
  let c1=cross(j2,j0);
  let c2=cross(j0,j1);
  let mn=c0*n.x+c1*n.y+c2*n.z;
  let ml=length(mn);
  return HumanMorphed(p0,select(n,mn/ml,ml>1e-5));
}
`;
