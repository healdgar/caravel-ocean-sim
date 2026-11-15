// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Dynamic Wind for Nanite/cluster foliage: GPU hierarchical bone spring-damper simulation,
// mesh-derived cumulative mass & aerodynamic drag load, vortex-shedding petiole flutter,
// shared directional wind lanes + promoted individual close/force-touched instances,
// propagating Friedlander blast waves, and contact push capsules.

export const FOREST_WIND_BONES = 32;
export const FOREST_WIND_BONE_FLOATS = 16;
export const FOREST_WIND_SHARED_BEARINGS = 8;
export const FOREST_WIND_SHARED_PHASES = 2;
export const FOREST_WIND_SHARED_LANES = FOREST_WIND_SHARED_BEARINGS * FOREST_WIND_SHARED_PHASES;
export const FOREST_WIND_MAX_PROMOTED = 256;
export const FOREST_WIND_MAX_FORCES = 16;
export const FOREST_WIND_MAX_CAPSULES = 16;
export const FOREST_WIND_PROMOTE_RADIUS_M = 48.0;
export const FOREST_WIND_DEMOTE_GRACE_SECONDS = 3.0;

export const FOREST_WIND_BASIS_RADIAL = 0;
export const FOREST_WIND_BASIS_DIRECTIONAL = 1;
export const FOREST_WIND_BASIS_SWIRL = 2;
export const FOREST_WIND_BASIS_CONE = 3;

export const FOREST_WIND_EVENT_CONTINUOUS = 0;
export const FOREST_WIND_EVENT_FRIEDLANDER = 1;
export const FOREST_WIND_EVENT_PULSE = 2;
export const FOREST_WIND_EVENT_BURST = 3;

// Literal paths so build.mjs discovers and publishes them automatically.
export const FOREST_WIND_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/saba/wind/manifest.json',
  'bones.bin.gz': 'assets/forest-scenery/saba/wind/bones.bin.gz',
  'weights.bin.gz': 'assets/forest-scenery/saba/wind/weights.bin.gz',
});
export const SUBTROPICAL_FOREST_WIND_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/wind/manifest.json',
  'bones.bin.gz': 'assets/forest-scenery/subtropical/wind/bones.bin.gz',
  'weights.bin.gz': 'assets/forest-scenery/subtropical/wind/weights.bin.gz',
});
export const PORTUGAL_FOREST_WIND_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/wind/manifest.json',
  'bones.bin.gz': 'assets/forest-scenery/portugal/wind/bones.bin.gz',
  'weights.bin.gz': 'assets/forest-scenery/portugal/wind/weights.bin.gz',
});

const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));

export function packForestWindWeight({ bone0 = 0, bone1 = 0, weight0 = 1, phase = 0 }) {
  const b0 = clampByte(bone0) & 31;
  const b1 = clampByte(bone1) & 31;
  const w0 = clampByte(weight0 * 255);
  const ph = clampByte(phase * 255);
  return (b0 | (b1 << 8) | (w0 << 16) | (ph << 24)) >>> 0;
}

export function unpackForestWindWeight(word) {
  const u = word >>> 0;
  return {
    bone0: u & 31,
    bone1: (u >>> 8) & 31,
    weight0: ((u >>> 16) & 255) / 255,
    phase: ((u >>> 24) & 255) / 255,
  };
}

// Friedlander blast wave pressure (Pa) at distance r from origin at elapsed time t:
// positive shock front propagating at waveSpeed followed by exponential suction tail.
export function evaluateFriedlanderWave(distance, elapsed, waveSpeed = 280, radius = 36, peakPressurePa = 900) {
  if (!(elapsed >= 0) || distance > radius * 1.35 || radius <= 0) return 0;
  const arrival = distance / Math.max(waveSpeed, 10);
  const duration = Math.max(0.09, radius / Math.max(waveSpeed * 1.6, 20));
  const localT = (elapsed - arrival) / duration;
  if (localT < -0.15 || localT > 4.5) return 0;
  const rise = localT < 0 ? Math.exp(localT * 14) : (1 - localT) * Math.exp(-localT);
  const atten = Math.max(0, 1 - distance / (radius * 1.35));
  return peakPressurePa * rise * (0.35 + 0.65 * atten * atten);
}

export function validateForestWindManifest(manifest) {
  if (
    !manifest ||
    manifest.format !== 'waterworld.forest-wind' ||
    manifest.version !== 1 ||
    manifest.bonesPerPrototype !== FOREST_WIND_BONES ||
    manifest.boneFloats !== FOREST_WIND_BONE_FLOATS ||
    !Array.isArray(manifest.prototypes) ||
    !manifest.prototypes.length
  ) {
    throw Error('Invalid forest dynamic wind manifest');
  }
  for (let i = 0; i < manifest.prototypes.length; i++) {
    const p = manifest.prototypes[i];
    if (p.id !== i || !(p.boneCount >= 1 && p.boneCount <= FOREST_WIND_BONES) || !(p.totalMassKg > 0) || !(p.totalDragAreaM2 >= 0)) {
      throw Error(`Malformed forest wind prototype ${i}`);
    }
  }
  return manifest;
}

export async function loadForestWind({ assets = PORTUGAL_FOREST_WIND_ASSETS, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Forest dynamic wind unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = validateForestWindManifest(await (await get('manifest.json')).json());
  const stream = async (name) => {
    const receipt = manifest.files?.[name];
    if (!receipt?.gzip?.file) throw Error(`Missing forest wind stream receipt: ${name}`);
    const response = await get(receipt.gzip.file);
    const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== receipt.bytes) throw Error(`Forest wind stream has wrong size: ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('');
    if (hex !== receipt.sha256) throw Error(`Forest wind stream failed verification: ${name}`);
    return bytes;
  };
  const [bones, weights] = await Promise.all(['bones.bin', 'weights.bin'].map(stream));
  return { manifest, bones, weights };
}

// Vertex-stage quaternion & dual-bone skinning helpers shared by clusters, crowns, and native streams.
export const FOREST_WIND_SKIN_WGSL = /* wgsl */`
@group(3)@binding(8)var<storage,read>forestWindPoses:array<vec4f>;
@group(3)@binding(9)var<storage,read>forestWindWeights:array<u32>;

struct ForestSkinnedVertex {pos:vec3f,normal:vec3f};

fn forestQuatRotate(q:vec4f,v:vec3f)->vec3f{
 let t=2.0*cross(q.xyz,v);
 return v+q.w*t+cross(q.xyz,t);
}
fn forestWindSharedSkeleton(r:ForestRoot,tree:u32,protoCount:u32)->u32{
 let pi=min(u32(max(r.identity.x,0.)),max(protoCount,1u)-1u);
 let downwind=F.windP[0].xy;
 let dLen=length(downwind);
 let wDir=select(vec2f(1.,0.),downwind/max(dLen,1e-5),dLen>1e-4);
 let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 // Wind direction in prototype space: transpose of tree yaw rotation.
 let wp=vec2f(c*wDir.x+s*wDir.y,-s*wDir.x+c*wDir.y);
 let ang=fract(atan2(wp.y,wp.x)*0.15915494+1.0625);
 let bearing=min(u32(floor(ang*${FOREST_WIND_SHARED_BEARINGS}.0)),${FOREST_WIND_SHARED_BEARINGS - 1}u);
 let phase=(forestCoverageHash(tree^0x6c8e9cf5u)&1u);
 let lane=bearing*${FOREST_WIND_SHARED_PHASES}u+phase;
 return pi*${FOREST_WIND_SHARED_LANES}u+lane;
}
fn forestWindBonePose(skelIdx:u32,boneIdx:u32,poseBase:u32)->array<vec4f,2>{
 let at=poseBase+(skelIdx*${FOREST_WIND_BONES}u+boneIdx)*2u;
 return array<vec4f,2>(forestWindPoses[at],forestWindPoses[at+1u]);
}
fn forestWindEvalSkeleton(skelIdx:u32,b0:u32,b1:u32,w0:f32,posIn:vec3f,normIn:vec3f,poseBase:u32)->ForestSkinnedVertex{
 let p0=forestWindBonePose(skelIdx,b0,poseBase);
 var q=p0[0];var tr=p0[1].xyz;
 var outP=forestQuatRotate(q,posIn)+tr;
 var outN=forestQuatRotate(q,normIn);
 if(b1!=b0&&w0<0.998){
  let p1=forestWindBonePose(skelIdx,b1,poseBase);
  let altP=forestQuatRotate(p1[0],posIn)+p1[1].xyz;
  let altN=forestQuatRotate(p1[0],normIn);
  outP=mix(altP,outP,w0);
  outN=mix(altN,outN,w0);
 }
 var res:ForestSkinnedVertex;
 res.pos=outP;
 res.normal=normalize(outN);
 return res;
}
fn forestWindSkinCluster(r:ForestRoot,tree:u32,posProto:vec3f,normProto:vec3f,vertex:u32,uv:vec2f,isLeaf:bool)->ForestSkinnedVertex{
 let hdr=bitcast<vec4u>(forestWindPoses[0]);
 let poseBase=hdr.x;let protoCount=hdr.y;
 if(protoCount==0u){
  var plain:ForestSkinnedVertex;plain.pos=posProto;plain.normal=normProto;return plain;
 }
 let wWord=forestWindWeights[vertex];
 let b0=wWord&31u;let b1=(wWord>>8u)&31u;
 let w0=f32((wWord>>16u)&255u)/255.;
 let shootPhase=f32((wWord>>24u)&255u)/255.*6.2831853;
 var pIn=posProto;var nIn=normProto;
 let speed=F.windP[0].z;
 let isFelled=r.identity.w<0.;
 // Vortex-shedding petiole flutter & torsion around exact bark attachment foot v1 (uv = [0, 0.5], where both alongU == 0 and wingV == 0).
 if(isLeaf&&!isFelled){
  let alongU=clamp(uv.x,0.,1.);
  let wingV=clamp(uv.y-0.5,-0.5,0.5);
  // Epic Dynamic Wind Flutter Ramp: always alive in light breeze (baseline 0.22), ramping 3..20 m/s in frequency and strength.
  let ramp=clamp((speed-3.0)/17.0,0.,1.);
  let alive=smoothstep(0.08,1.4,speed);
  let freqScale=mix(0.32,1.0,ramp);
  let ampScale=alive*mix(0.22,1.0,ramp);
  let t=F.camPos.w;
  let treePhase=r.rootScale.x*0.17+r.rootScale.z*0.13;
  let omegaVortex=(9.5+6.5*fract(shootPhase*0.3183))*freqScale;
  let ph=t*omegaVortex+shootPhase+treePhase;
  let invScale=1./max(r.rootScale.w,0.85);
  let pitchShed=sin(ph)+0.38*sin(ph*2.17+1.1);
  let rollShed=cos(ph*1.31+0.7);
  let flutterAmp=ampScale*0.032*invScale;
  let lift=flutterAmp*(alongU*0.85*pitchShed+wingV*(0.32+0.68*alongU)*rollShed*1.35);
  let upRef=select(vec3f(0.,1.,0.),vec3f(1.,0.,0.),abs(nIn.y)>0.9);
  let sideAx=normalize(cross(nIn,upRef));
  let midAx=cross(sideAx,nIn);
  pIn+=nIn*lift+sideAx*(flutterAmp*0.28*alongU*rollShed);
  nIn=normalize(nIn+midAx*(pitchShed*ampScale*0.20*alongU)+sideAx*(rollShed*ampScale*0.26*(0.35+0.65*alongU)));
 }
 if(isFelled){
  var felledOut:ForestSkinnedVertex;felledOut.pos=pIn;felledOut.normal=nIn;return felledOut;
 }
 let sharedSkel=forestWindSharedSkeleton(r,tree,protoCount);
 var res=forestWindEvalSkeleton(sharedSkel,b0,b1,w0,pIn,nIn,poseBase);
 let slotWord=bitcast<u32>(forestWindPoses[1u+(tree>>2u)][tree&3u]);
 let promoSlot=slotWord&65535u;
 if(promoSlot>0u){
  let promoBlend=f32(slotWord>>16u)/65535.;
  let promoSkel=protoCount*${FOREST_WIND_SHARED_LANES}u+(promoSlot-1u);
  let indiv=forestWindEvalSkeleton(promoSkel,b0,b1,w0,pIn,nIn,poseBase);
  res.pos=mix(res.pos,indiv.pos,promoBlend);
  res.normal=normalize(mix(res.normal,indiv.normal,promoBlend));
 }
 return res;
}
fn forestWindCrownPos(r:ForestRoot,tree:u32,posProto:vec3f)->vec3f{
 let hdr=bitcast<vec4u>(forestWindPoses[0]);
 let poseBase=hdr.x;let protoCount=hdr.y;
 if(protoCount==0u||r.identity.w<0.){return posProto;}
 let sharedSkel=forestWindSharedSkeleton(r,tree,protoCount);
 // Upper trunk / crown-core bone (bone 3) carries the cumulative crown lean for far continuum shells & splats.
 let crownBone=min(3u,${FOREST_WIND_BONES - 1}u);
 let heightWeight=clamp(posProto.y/max(posProto.y+2.5,4.0),0.,1.);
 var sk=forestWindEvalSkeleton(sharedSkel,crownBone,0u,heightWeight,posProto,vec3f(0.,1.,0.),poseBase).pos;
 let slotWord=bitcast<u32>(forestWindPoses[1u+(tree>>2u)][tree&3u]);
 let promoSlot=slotWord&65535u;
 if(promoSlot>0u){
  let promoBlend=f32(slotWord>>16u)/65535.;
  let promoSkel=protoCount*${FOREST_WIND_SHARED_LANES}u+(promoSlot-1u);
  let indiv=forestWindEvalSkeleton(promoSkel,crownBone,0u,heightWeight,posProto,vec3f(0.,1.,0.),poseBase).pos;
  sk=mix(sk,indiv,promoBlend);
 }
 return sk;
}
`;

export const FOREST_WIND_SIM_WGSL = (FRAME_WGSL) => FRAME_WGSL + /* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
struct ForestWindBone {pivot:vec4f,axis:vec4f,aero:vec4f,spring:vec4f};
// Force: originRadius=(x,y,z,radius), dirStrength=(dx,dy,dz,strengthPa), timing=(startTime,waveSpeed,lobeOrSwirl,coneCos), flags=(basis,eventType,isLive,0)
struct ForestWindForce {originRadius:vec4f,dirStrength:vec4f,timing:vec4f,flags:vec4f};
// Push capsule: aRadius=(ax,ay,az,radius), bStrength=(bx,by,bz,strengthN), params=(falloffPower,active,startTime,duration)
struct ForestWindCapsule {aRadius:vec4f,bStrength:vec4f,params:vec4f};
struct ForestWindConfig {counts:vec4u,tuning:vec4f,overrideWind:vec4f};

@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<uniform>cfg:ForestWindConfig;
@group(0)@binding(2)var<storage,read>roots:array<ForestRoot>;
@group(0)@binding(3)var<storage,read>bones:array<ForestWindBone>;
@group(0)@binding(4)var<storage,read>forces:array<ForestWindForce>;
@group(0)@binding(5)var<storage,read>capsules:array<ForestWindCapsule>;
@group(0)@binding(6)var<storage,read_write>simState:array<vec4f>;
@group(0)@binding(7)var<storage,read_write>poses:array<vec4f>;
@group(0)@binding(8)var<storage,read_write>promoTable:array<atomic<u32>>;

// simState layout:
//   [0]: (prevTime, smoothWindDirX, smoothWindDirZ, smoothSpeedTimesAmp)
//   [1]: (simDt, initStage, smoothRawVelX, smoothRawVelZ)
//   [2 .. 2 + MAX_PROMOTED - 1]: per-promoted-slot metadata (float(treeId), lastTouchTime, blendWeight, protoId)
//   [boneStateBase ..]: 2 vec4f per bone across (protoCount * SHARED_LANES + MAX_PROMOTED) * 32 bones:
//     even: (theta.x, theta.y, theta.z, 0)
//     odd:  (omega.x, omega.y, omega.z, 0)
// promoTable layout (atomic<u32>):
//   [0]: allocation cursor / active count this frame
//   [1 .. MAX_PROMOTED]: owner treeId + 1 (0 = free)
//   [1 + MAX_PROMOTED .. 1 + MAX_PROMOTED + maxRoots]: packed rootSlot u32 per root (copied into poses[1..])

const WIND_BONES=${FOREST_WIND_BONES}u;
const SHARED_BEARINGS=${FOREST_WIND_SHARED_BEARINGS}u;
const SHARED_PHASES=${FOREST_WIND_SHARED_PHASES}u;
const SHARED_LANES=${FOREST_WIND_SHARED_LANES}u;
const MAX_PROMOTED=${FOREST_WIND_MAX_PROMOTED}u;
const MAX_FORCES=${FOREST_WIND_MAX_FORCES}u;
const MAX_CAPSULES=${FOREST_WIND_MAX_CAPSULES}u;
const PROMO_META_BASE=2u;
const BONE_STATE_BASE=2u+${FOREST_WIND_MAX_PROMOTED}u;

fn windHash(v:u32)->u32{var x=v;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}
fn quatFromRotVec(rv:vec3f)->vec4f{
 let angle=length(rv);
 if(angle<1e-6){return vec4f(rv*0.5,1.0);}
 let halfA=angle*0.5;
 let s=sin(halfA)/angle;
 return vec4f(rv*s,cos(halfA));
}
fn quatMul(a:vec4f,b:vec4f)->vec4f{
 return vec4f(
  a.w*b.xyz+b.w*a.xyz+cross(a.xyz,b.xyz),
  a.w*b.w-dot(a.xyz,b.xyz)
 );
}
fn quatRot(q:vec4f,v:vec3f)->vec3f{
 let t=2.0*cross(q.xyz,v);
 return v+q.w*t+cross(q.xyz,t);
}
fn evalForceAtWorld(f:ForestWindForce,worldPos:vec3f,now:f32)->vec3f{
 if(f.flags.z<0.5){return vec3f(0.);}
 let rel=worldPos-f.originRadius.xyz;
 let dist=length(rel);
 let radius=max(f.originRadius.w,0.25);
 let eventType=u32(f.flags.y+0.5);
 var pressure=f.dirStrength.w;
 let elapsed=now-f.timing.x;
 if(eventType==1u){
  // Propagating Friedlander blast wave + negative suction phase.
  let waveSpeed=max(f.timing.y,15.0);
  if(elapsed<0.||dist>radius*1.35){return vec3f(0.);}
  let arrival=dist/waveSpeed;
  let tau=max(0.09,radius/(waveSpeed*1.6));
  let lt=(elapsed-arrival)/tau;
  if(lt<-0.15||lt>4.5){return vec3f(0.);}
  let wave=select((1.0-lt)*exp(-lt),exp(lt*14.0),lt<0.);
  let atten=clamp(1.0-dist/(radius*1.35),0.,1.);
  pressure*=wave*(0.35+0.65*atten*atten);
 }else if(eventType==2u||eventType==3u){
  let dur=max(f.timing.y,0.18);
  if(elapsed<0.||elapsed>dur||dist>radius){return vec3f(0.);}
  let u=elapsed/dur;
  let env=select(sin(u*3.14159265),exp(-u*3.2)*(1.0-exp(-u*18.0)),eventType==3u);
  let atten=clamp(1.0-dist/radius,0.,1.);
  pressure*=env*atten*atten;
 }else{
  if(dist>radius){return vec3f(0.);}
  let atten=clamp(1.0-dist/radius,0.,1.);
  pressure*=atten*atten;
 }
 let basis=u32(f.flags.x+0.5);
 let outDir=select(vec3f(1.,0.,0.),rel/max(dist,1e-4),dist>1e-4);
 let fwd=normalize(select(vec3f(1.,0.,0.),f.dirStrength.xyz,length(f.dirStrength.xyz)>1e-4));
 if(basis==0u){
  let lobe=clamp(f.timing.z,0.,1.);
  let dir=normalize(mix(outDir,fwd,lobe*0.65));
  return dir*pressure;
 }
 if(basis==1u){return fwd*pressure;}
 if(basis==2u){
  let swirlDir=normalize(select(vec3f(-outDir.z,0.,outDir.x),cross(vec3f(0.,1.,0.),outDir),length(outDir.xz)>1e-4));
  let core=max(f.timing.z,0.5);
  let swirlGain=min(dist/core,core/max(dist,0.25));
  return (swirlDir*0.88+outDir*0.22)*(pressure*swirlGain);
 }
 let cosAng=dot(outDir,fwd);
 if(cosAng<f.timing.w){return vec3f(0.);}
 let coneW=clamp((cosAng-f.timing.w)/max(1.0-f.timing.w,1e-3),0.,1.);
 return outDir*(pressure*coneW);
}
fn evalCapsulePushAtWorld(cap:ForestWindCapsule,worldPos:vec3f,now:f32)->vec3f{
 if(cap.params.y<0.5){return vec3f(0.);}
 if(cap.params.w>0.&&(now<cap.params.z||now>cap.params.z+cap.params.w)){return vec3f(0.);}
 let a=cap.aRadius.xyz;let b=cap.bStrength.xyz;let rad=max(cap.aRadius.w,0.1);
 let ab=b-a;let ab2=dot(ab,ab);
 let t=select(0.,clamp(dot(worldPos-a,ab)/ab2,0.,1.),ab2>1e-6);
 let closest=a+ab*t;
 let delta=worldPos-closest;
 let d=length(delta);
 if(d>=rad){return vec3f(0.);}
 let pen=clamp(1.0-d/rad,0.,1.);
 let pwr=max(cap.params.x,0.5);
 let mag=cap.bStrength.w*pow(pen,pwr);
 let pushDir=select(vec3f(0.,1.,0.),delta/max(d,1e-4),d>1e-4);
 return pushDir*mag;
}

@compute @workgroup_size(1)fn forestWindStepHeader(){
 let now=F.camPos.w;
 let prev=simState[0].x;
 let firstFrame=(simState[1].y==0.);
 let dt=select(clamp(now-prev,0.,0.05),0.016,firstFrame||now<prev);
 let rawDir=F.windP[0].xy;
 let rawSpeed=select(F.windP[0].z,cfg.overrideWind.x,cfg.overrideWind.x>=0.);
 let amp=select(cfg.tuning.x,cfg.overrideWind.y,cfg.overrideWind.y>=0.);
 let dLen=length(rawDir);
 let dirUnit=select(vec2f(1.,0.),rawDir/max(dLen,1e-5),dLen>1e-4);
 let blend=select(1.0-exp(-dt*2.5),1.0,firstFrame);
 let curW=mix(simState[1].zw,dirUnit*rawSpeed,blend);
 let smoothSpd=length(curW);
 let smoothDir=select(dirUnit,curW/max(smoothSpd,1e-5),smoothSpd>1e-4);
 simState[0]=vec4f(now,smoothDir.x,smoothDir.y,smoothSpd*amp);
 simState[1]=vec4f(dt,select(2.0,1.0,firstFrame),curW.x,curW.y);
 poses[0]=bitcast<vec4f>(vec4u(cfg.counts.z,cfg.counts.y,WIND_BONES,SHARED_LANES));
 atomicStore(&promoTable[0],0u);
 // Age promoted slots and release slots whose DemoteGracePeriod has expired.
 for(var s=0u;s<MAX_PROMOTED;s++){
  var slotInfo=simState[PROMO_META_BASE+s];
  let ownerPlus1=atomicLoad(&promoTable[1u+s]);
  if(ownerPlus1==0u){continue;}
  let age=now-slotInfo.y;
  if(age>${FOREST_WIND_DEMOTE_GRACE_SECONDS.toFixed(2)}){
   atomicStore(&promoTable[1u+s],0u);
   simState[PROMO_META_BASE+s]=vec4f(-1.,0.,0.,0.);
  }else{
   let graceBlend=1.0-smoothstep(${(FOREST_WIND_DEMOTE_GRACE_SECONDS * 0.35).toFixed(2)},${FOREST_WIND_DEMOTE_GRACE_SECONDS.toFixed(2)},max(age,0.));
   slotInfo.z=min(slotInfo.z+dt*3.5,1.0)*graceBlend;
   simState[PROMO_META_BASE+s]=slotInfo;
  }
 }
}

@compute @workgroup_size(64)fn forestWindClearRootSlots(@builtin(global_invocation_id)id:vec3u){
 let vecCount=(cfg.counts.x+3u)>>2u;
 if(id.x>=vecCount){return;}
 poses[1u+id.x]=vec4f(0.);
}

@compute @workgroup_size(64)fn forestWindPromoteRoots(@builtin(global_invocation_id)id:vec3u){
 let rootCount=cfg.counts.x;let protoCount=cfg.counts.y;
 if(id.x>=rootCount||protoCount==0u){return;}
 let r=roots[id.x];
 if(r.rootScale.w<=0.||r.identity.w<0.){return;}
 let now=simState[0].x;
 let worldPos=r.rootScale.xyz;
 let camDist=length(worldPos-F.camPos.xyz);
 var touched=(camDist<${FOREST_WIND_PROMOTE_RADIUS_M.toFixed(1)});
 if(!touched){
  for(var fi=0u;fi<MAX_FORCES;fi++){
   let f=forces[fi];
   if(f.flags.z>0.5&&length(worldPos-f.originRadius.xyz)<f.originRadius.w*1.35+8.0){touched=true;break;}
  }
 }
 if(!touched){
  for(var ci=0u;ci<MAX_CAPSULES;ci++){
   let cap=capsules[ci];
   if(cap.params.y>0.5&&length(worldPos-0.5*(cap.aRadius.xyz+cap.bStrength.xyz))<cap.aRadius.w+length(cap.bStrength.xyz-cap.aRadius.xyz)*0.5+6.0){touched=true;break;}
  }
 }
 // Check if this tree already owns a promoted slot (either still touched or within its grace period).
 var mySlot=0xffffffffu;
 for(var s=0u;s<MAX_PROMOTED;s++){
  if(atomicLoad(&promoTable[1u+s])==id.x+1u){mySlot=s;break;}
 }
 if(mySlot==0xffffffffu&&touched){
  // Claim a free slot deterministically using hash probe + atomicCompareExchangeWeak.
  let start=windHash(id.x)%MAX_PROMOTED;
  for(var p=0u;p<MAX_PROMOTED;p++){
   let cand=(start+p)%MAX_PROMOTED;
   let ex=atomicCompareExchangeWeak(&promoTable[1u+cand],0u,id.x+1u);
   if(ex.exchanged){
    mySlot=cand;
    // Initialize promoted bone state seamlessly from this tree's matching shared lane so promotion has zero pop!
    let pi=min(u32(max(r.identity.x,0.)),protoCount-1u);
    let smoothDir=simState[0].yz;
    let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
    let wp=vec2f(c*smoothDir.x+s*smoothDir.y,-s*smoothDir.x+c*smoothDir.y);
    let ang=fract(atan2(wp.y,wp.x)*0.15915494+1.0625);
    let bearing=min(u32(floor(ang*f32(SHARED_BEARINGS))),SHARED_BEARINGS-1u);
    let phase=(windHash(id.x^0x6c8e9cf5u)&1u);
    let sharedSkel=pi*SHARED_LANES+(bearing*SHARED_PHASES+phase);
    let promoSkel=protoCount*SHARED_LANES+cand;
    for(var b=0u;b<WIND_BONES;b++){
     simState[BONE_STATE_BASE+(promoSkel*WIND_BONES+b)*2u]=simState[BONE_STATE_BASE+(sharedSkel*WIND_BONES+b)*2u];
     simState[BONE_STATE_BASE+(promoSkel*WIND_BONES+b)*2u+1u]=simState[BONE_STATE_BASE+(sharedSkel*WIND_BONES+b)*2u+1u];
    }
    simState[PROMO_META_BASE+cand]=vec4f(f32(id.x),now,1.0,f32(pi));
    break;
   }
  }
 }else if(mySlot!=0xffffffffu&&touched){
  var slotInfo=simState[PROMO_META_BASE+mySlot];
  slotInfo.y=now;
  // Smoothly ramp blend weight back to 1 when re-touched.
  let closeFade=1.0-smoothstep(${(FOREST_WIND_PROMOTE_RADIUS_M * 0.78).toFixed(1)},${FOREST_WIND_PROMOTE_RADIUS_M.toFixed(1)},camDist);
  slotInfo.z=max(slotInfo.z,max(closeFade,0.85));
  simState[PROMO_META_BASE+mySlot]=slotInfo;
 }
 if(mySlot!=0xffffffffu){
  let blendQ=u32(clamp(simState[PROMO_META_BASE+mySlot].z,0.,1.)*65535.);
  let packed=(mySlot+1u)|(blendQ<<16u);
  atomicStore(&promoTable[1u+MAX_PROMOTED+id.x],packed);
 }else{
  atomicStore(&promoTable[1u+MAX_PROMOTED+id.x],0u);
 }
}

@compute @workgroup_size(64)fn forestWindPackRootSlots(@builtin(global_invocation_id)id:vec3u){
 let rootCount=cfg.counts.x;
 let vecCount=(rootCount+3u)>>2u;
 if(id.x>=vecCount){return;}
 let base=id.x*4u;
 let w0=select(0u,atomicLoad(&promoTable[1u+MAX_PROMOTED+base]),base<rootCount);
 let w1=select(0u,atomicLoad(&promoTable[1u+MAX_PROMOTED+base+1u]),base+1u<rootCount);
 let w2=select(0u,atomicLoad(&promoTable[1u+MAX_PROMOTED+base+2u]),base+2u<rootCount);
 let w3=select(0u,atomicLoad(&promoTable[1u+MAX_PROMOTED+base+3u]),base+3u<rootCount);
 poses[1u+id.x]=bitcast<vec4f>(vec4u(w0,w1,w2,w3));
}

fn stepSkeletonBones(skelIdx:u32,protoId:u32,windProtoDir:vec3f,windSpeed:f32,gustFactor:f32,phaseSeed:f32,isPromoted:bool,treeRoot:ForestRoot){
 let now=simState[0].x;
 let dt=clamp(simState[1].x,0.,0.05);
 let isInit=(simState[1].y<1.5);
 let subDt=dt*0.5;
 let poseBase=cfg.counts.z;
 // Quadratic aerodynamic dynamic pressure q = 0.5 * rho_air * v^2 (rho_air = 1.225 kg/m^3): doubling speed pushes 4x as hard!
 let effSpeed=windSpeed*gustFactor;
 let dynPressure=0.6125*effSpeed*effSpeed;
 let flutterRamp=clamp((effSpeed-3.0)/17.0,0.,1.);
 let flutterAlive=smoothstep(0.08,1.4,effSpeed);
 let flutterFreqScale=mix(0.30,1.0,flutterRamp);
 let flutterAmpScale=flutterAlive*mix(0.24,1.0,flutterRamp);

 var qWorld:array<vec4f,32>;
 var transWorld:array<vec3f,32>;
 let cYaw=cos(treeRoot.yawColour.x);let sYaw=sin(treeRoot.yawColour.x);
 let treeScale=max(treeRoot.rootScale.w,0.25);

 for(var b=0u;b<WIND_BONES;b++){
  let bone=bones[protoId*WIND_BONES+b];
  let metaCode=u32(bone.pivot.w+0.5);
  let parent=i32(metaCode&63u)-1;
  let group=(metaCode>>6u)&3u;
  let isLive=(metaCode>>8u)&1u;
  if(isLive==0u){
   qWorld[b]=vec4f(0.,0.,0.,1.);
   transWorld[b]=vec3f(0.);
   poses[poseBase+(skelIdx*WIND_BONES+b)*2u]=vec4f(0.,0.,0.,1.);
   poses[poseBase+(skelIdx*WIND_BONES+b)*2u+1u]=vec4f(0.);
   continue;
  }
  let sAt=BONE_STATE_BASE+(skelIdx*WIND_BONES+b)*2u;
  var theta=simState[sAt].xyz;
  var omegaVel=simState[sAt+1u].xyz;

  let stiffness=max(bone.spring.x,1.0);
  let natOmega=clamp(bone.spring.y,0.8,18.0);
  let dampingRatio=clamp(bone.spring.z,0.10,0.85);
  let packedLim=u32(bone.spring.w+0.5);
  let maxBendRad=max(0.02,f32(packedLim&65535u)/65535.*1.5707963);
  let chainT=f32((packedLim>>16u)&65535u)/65535.;
  let inertia=stiffness/(natOmega*natOmega);

  // Spatially coherent turbulent eddy variation by 3D bone pivot position so neighbouring branches sway organically in phase without tearing.
  let bPhase=phaseSeed+dot(bone.pivot.xyz,vec3f(0.32,0.21,0.29));
  let eddy=1.0+0.26*sin(now*(0.85+0.18*natOmega)+bPhase)+0.14*cos(now*(1.65+0.25*natOmega)-bPhase*1.3);
  let crossEddy=0.20*sin(now*(1.25+0.22*natOmega)+bPhase*1.7);
  let sideWind=vec3f(-windProtoDir.z,0.12*sin(now*1.4+bPhase),windProtoDir.x);
  let localFlowDir=normalize(windProtoDir*eddy+sideWind*crossEddy+vec3f(0.,-0.06*effSpeed/14.0,0.));
  var forceProto=localFlowDir*(dynPressure*bone.aero.w);

  if(isPromoted){
   // Evaluate world-space DynamicWindForces & DynamicWindPushCapsules at this bone's center of pressure!
   let copProto=bone.pivot.xyz+bone.aero.xyz*0.65;
   let copWorld=treeRoot.rootScale.xyz+vec3f(cYaw*copProto.x-sYaw*copProto.z,copProto.y,sYaw*copProto.x+cYaw*copProto.z)*treeScale;
   var worldPressForce=vec3f(0.);
   for(var fi=0u;fi<MAX_FORCES;fi++){
    let pVec=evalForceAtWorld(forces[fi],copWorld,now);
    worldPressForce+=pVec*bone.aero.w;
   }
   var worldCapForce=vec3f(0.);
   for(var ci=0u;ci<MAX_CAPSULES;ci++){
    worldCapForce+=evalCapsulePushAtWorld(capsules[ci],copWorld,now);
   }
   let totalWorldF=worldPressForce+worldCapForce;
   // Rotate world force into prototype space.
   let fProto=vec3f(cYaw*totalWorldF.x+sYaw*totalWorldF.z,totalWorldF.y,-sYaw*totalWorldF.x+cYaw*totalWorldF.z);
   forceProto+=fProto;
  }

  let torque=cross(bone.aero.xyz,forceProto);
  let axis=bone.axis.xyz;
  if(isInit){
   // Start at steady aerodynamic equilibrium lean so frame 0 has zero pop.
   var eq=torque/stiffness;
   eq-=axis*(dot(eq,axis)*0.55);
   let eqMag=length(eq);
   if(eqMag>1e-5){eq*=(maxBendRad*tanh(eqMag/maxBendRad))/eqMag;}
   theta=eq;
   omegaVel=vec3f(0.);
  }else if(subDt>0.){
   for(var step=0u;step<2u;step++){
    // Wood resists axial torsion ~2.2x more strongly than transverse bending.
    let twistComp=axis*dot(theta,axis);
    let effTheta=theta+twistComp*1.2;
    let accel=(torque/inertia)-(natOmega*natOmega)*effTheta-(2.0*dampingRatio*natOmega)*omegaVel;
    omegaVel+=accel*subDt;
    theta+=omegaVel*subDt;
    let mag=length(theta);
    if(mag>1e-5){
     let sat=maxBendRad*tanh(mag/maxBendRad);
     if(mag>maxBendRad*0.85){
      let radDir=theta/mag;
      let outV=dot(omegaVel,radDir);
      if(outV>0.){omegaVel-=radDir*(outV*(1.0-sat/mag));}
     }
     theta*=sat/mag;
    }
   }
  }
  simState[sAt]=vec4f(theta,0.);
  simState[sAt+1u]=vec4f(omegaVel,0.);

  // Combine spring-damper Sway with branch vortex-shedding Flutter rotation per bone.
  var flutterRot=vec3f(0.);
  if(group>=1u){
   let fltFreq=natOmega*(2.6+1.8*chainT)*flutterFreqScale;
   let fltPh=now*fltFreq+bPhase*2.3;
   let shedAxisA=normalize(cross(axis,select(vec3f(0.,1.,0.),vec3f(1.,0.,0.),abs(axis.y)>0.9)));
   let shedAxisB=cross(axis,shedAxisA);
   let fltMag=flutterAmpScale*(0.005+0.024*chainT*chainT)*select(0.55,1.0,group==2u);
   flutterRot=(shedAxisA*sin(fltPh)+shedAxisB*(0.65*cos(fltPh*1.37+0.8)))*fltMag;
  }
  let qLocal=quatFromRotVec(theta+flutterRot);
  var pivWorld=bone.pivot.xyz;
  var qCombined=qLocal;
  if(parent>=0){
   let pIdx=u32(parent);
   pivWorld=quatRot(qWorld[pIdx],bone.pivot.xyz)+transWorld[pIdx];
   qCombined=normalize(quatMul(qWorld[pIdx],qLocal));
  }
  let tr=pivWorld-quatRot(qCombined,bone.pivot.xyz);
  qWorld[b]=qCombined;
  transWorld[b]=tr;
  poses[poseBase+(skelIdx*WIND_BONES+b)*2u]=qCombined;
  poses[poseBase+(skelIdx*WIND_BONES+b)*2u+1u]=vec4f(tr,chainT);
 }
}

@compute @workgroup_size(64)fn forestWindStepShared(@builtin(global_invocation_id)id:vec3u){
 let protoCount=cfg.counts.y;
 let totalShared=protoCount*SHARED_LANES;
 if(id.x>=totalShared){return;}
 let protoId=id.x/SHARED_LANES;
 let lane=id.x%SHARED_LANES;
 let bearing=lane/SHARED_PHASES;
 let phaseIdx=lane%SHARED_PHASES;
 let angle=(f32(bearing)/f32(SHARED_BEARINGS))*6.2831853-3.14159265;
 let windProtoDir=vec3f(cos(angle),0.,sin(angle));
 let now=simState[0].x;
 let speed=simState[0].w;
 let gustPhase=f32(phaseIdx)*2.4+f32(protoId)*0.61;
 let gust=0.72+0.22*sin(now*0.62+gustPhase)+0.12*sin(now*1.47-gustPhase*1.3);
 var dummyRoot:ForestRoot;
 dummyRoot.rootScale=vec4f(0.,0.,0.,1.);
 dummyRoot.yawColour=vec4f(0.,1.,1.,1.);
 stepSkeletonBones(id.x,protoId,windProtoDir,speed,max(gust,0.15),gustPhase,false,dummyRoot);
}

@compute @workgroup_size(64)fn forestWindStepPromoted(@builtin(global_invocation_id)id:vec3u){
 let protoCount=cfg.counts.y;
 if(id.x>=MAX_PROMOTED||protoCount==0u){return;}
 let ownerPlus1=atomicLoad(&promoTable[1u+id.x]);
 if(ownerPlus1==0u){return;}
 let treeId=ownerPlus1-1u;
 let r=roots[treeId];
 let pi=min(u32(max(r.identity.x,0.)),protoCount-1u);
 let now=simState[0].x;
 let worldDir=simState[0].yz;
 let speed=simState[0].w;
 let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let wp=vec3f(c*worldDir.x+s*worldDir.y,0.,-s*worldDir.x+c*worldDir.y);
 // Travelling 2D spatial wind gust field across the landscape at actual wind velocity!
 let front=(dot(r.rootScale.xz,worldDir)-now*max(speed,2.0))*0.032;
 let across=dot(r.rootScale.xz,vec2f(-worldDir.y,worldDir.x))*0.021;
 let gust=0.68+0.24*sin(front)+0.14*sin(front*2.35+across);
 let phaseSeed=r.rootScale.x*0.13+r.rootScale.z*0.11;
 let skelIdx=protoCount*SHARED_LANES+id.x;
 stepSkeletonBones(skelIdx,pi,normalize(select(vec3f(1.,0.,0.),wp,length(wp)>1e-4)),speed,max(gust,0.12),phaseSeed,true,r);
}
`;

export async function createForestWind({ device, shader, frameWGSL, frameUBO, windSource = null, roots, maxRoots, prototypes }) {
  const B = GPUBufferUsage, owned = [];
  const make = (size, usage, label, initData = null) => {
    const buffer = device.createBuffer({ label, size: Math.max(16, size), usage: usage | B.COPY_DST });
    owned.push(buffer);
    if (initData) device.queue.writeBuffer(buffer, 0, initData);
    return buffer;
  };
  const protoCount = windSource ? prototypes.length : 0;
  const rootVecCount = Math.ceil(Math.max(1, maxRoots) / 4);
  const poseVec4Base = 1 + rootVecCount;
  const totalSkeletons = protoCount * FOREST_WIND_SHARED_LANES + FOREST_WIND_MAX_PROMOTED;
  const totalPoseVec4s = poseVec4Base + Math.max(1, totalSkeletons) * FOREST_WIND_BONES * 2;
  const posesBuffer = make(totalPoseVec4s * 16, B.STORAGE | B.COPY_SRC, 'forest dynamic wind poses');

  if (!windSource) {
    // Clean zero-prototype header so vertex shaders gracefully fall back when wind stream is absent.
    device.queue.writeBuffer(posesBuffer, 0, new Uint32Array([poseVec4Base, 0, FOREST_WIND_BONES, FOREST_WIND_SHARED_LANES]));
    const weightsBuffer = make(16, B.STORAGE, 'forest dynamic wind empty weights', new Uint32Array(4));
    return {
      enabled: false,
      posesBuffer,
      weightsBuffer,
      stats: { enabled: false },
      encode() {},
      emitForce() {},
      setPushCapsule() {},
      clearPushCapsule() {},
      setWindOverride() {},
      updateRoots() {},
      destroy() { for (const b of owned) b.destroy(); },
    };
  }

  const bonesBuffer = make(windSource.bones.byteLength, B.STORAGE, 'forest dynamic wind bones', windSource.bones);
  const weightsBuffer = make(windSource.weights.byteLength, B.STORAGE, 'forest dynamic wind weights', windSource.weights);
  const forcesCpu = new Float32Array(FOREST_WIND_MAX_FORCES * 16);
  const capsulesCpu = new Float32Array(FOREST_WIND_MAX_CAPSULES * 12);
  const forcesBuffer = make(forcesCpu.byteLength, B.STORAGE, 'forest dynamic wind forces', forcesCpu);
  const capsulesBuffer = make(capsulesCpu.byteLength, B.STORAGE, 'forest dynamic wind push capsules', capsulesCpu);

  const simVec4Count = 2 + FOREST_WIND_MAX_PROMOTED + totalSkeletons * FOREST_WIND_BONES * 2;
  const simStateBuffer = make(simVec4Count * 16, B.STORAGE, 'forest dynamic wind sim state');
  const promoWordsCount = 1 + FOREST_WIND_MAX_PROMOTED + Math.max(4, maxRoots);
  const promoTableBuffer = make(promoWordsCount * 4, B.STORAGE, 'forest dynamic wind promotion table');

  let activeRootCount = Math.min(maxRoots, prototypes.reduce((s, p) => Math.max(s, (p.firstRoot ?? 0) + (p.rootCount ?? 0)), 0) || maxRoots);
  let windAmplitude = 1.0, overrideSpeed = -1.0, overrideAmplitude = -1.0;
  let forceCursor = 0;

  const cfgData = new ArrayBuffer(48);
  const cfgU = new Uint32Array(cfgData, 0, 4);
  const cfgF = new Float32Array(cfgData, 16, 8);
  const writeConfig = (dt = 0.016) => {
    cfgU[0] = activeRootCount >>> 0;
    cfgU[1] = protoCount >>> 0;
    cfgU[2] = poseVec4Base >>> 0;
    cfgU[3] = 0;
    cfgF[0] = windAmplitude;
    cfgF[1] = dt;
    cfgF[2] = 0;
    cfgF[3] = 0;
    cfgF[4] = overrideSpeed;
    cfgF[5] = overrideAmplitude;
    cfgF[6] = 0;
    cfgF[7] = 0;
    device.queue.writeBuffer(configBuffer, 0, cfgData);
  };
  const configBuffer = make(48, B.UNIFORM, 'forest dynamic wind config');
  writeConfig(0.016);

  // Initialize identity quaternions in posesBuffer so frame 0 before first compute is valid bind pose.
  const initPoses = new Float32Array(totalPoseVec4s * 4);
  new Uint32Array(initPoses.buffer, 0, 4).set([poseVec4Base, protoCount, FOREST_WIND_BONES, FOREST_WIND_SHARED_LANES]);
  for (let i = poseVec4Base; i < totalPoseVec4s; i += 2) initPoses[i * 4 + 3] = 1.0;
  device.queue.writeBuffer(posesBuffer, 0, initPoses);

  let bindGroupLayout = device.createBindGroupLayout({
    label: 'forest dynamic wind sim layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pipeLayout = device.createPipelineLayout({ label: 'forest dynamic wind pipeline layout', bindGroupLayouts: [bindGroupLayout] });
  const simModule = await shader(FOREST_WIND_SIM_WGSL(frameWGSL), 'forest dynamic wind simulation');
  const [headerPipe, clearSlotsPipe, promotePipe, packSlotsPipe, sharedPipe, promotedPipe] = await Promise.all([
    device.createComputePipelineAsync({ label: 'forest wind header', layout: pipeLayout, compute: { module: simModule, entryPoint: 'forestWindStepHeader' } }),
    device.createComputePipelineAsync({ label: 'forest wind clear slots', layout: pipeLayout, compute: { module: simModule, entryPoint: 'forestWindClearRootSlots' } }),
    device.createComputePipelineAsync({ label: 'forest wind promote', layout: pipeLayout, compute: { module: simModule, entryPoint: 'forestWindPromoteRoots' } }),
    device.createComputePipelineAsync({ label: 'forest wind pack slots', layout: pipeLayout, compute: { module: simModule, entryPoint: 'forestWindPackRootSlots' } }),
    device.createComputePipelineAsync({ label: 'forest wind shared step', layout: pipeLayout, compute: { module: simModule, entryPoint: 'forestWindStepShared' } }),
    device.createComputePipelineAsync({ label: 'forest wind promoted step', layout: pipeLayout, compute: { module: simModule, entryPoint: 'forestWindStepPromoted' } }),
  ]);

  const simGroup = device.createBindGroup({
    label: 'forest dynamic wind sim group',
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: frameUBO } },
      { binding: 1, resource: { buffer: configBuffer } },
      { binding: 2, resource: { buffer: roots } },
      { binding: 3, resource: { buffer: bonesBuffer } },
      { binding: 4, resource: { buffer: forcesBuffer } },
      { binding: 5, resource: { buffer: capsulesBuffer } },
      { binding: 6, resource: { buffer: simStateBuffer } },
      { binding: 7, resource: { buffer: posesBuffer } },
      { binding: 8, resource: { buffer: promoTableBuffer } },
    ],
  });

  const stats = {
    enabled: true,
    bonesPerPrototype: FOREST_WIND_BONES,
    sharedLanes: FOREST_WIND_SHARED_LANES,
    maxPromotedInstances: FOREST_WIND_MAX_PROMOTED,
    promoteRadiusMetres: FOREST_WIND_PROMOTE_RADIUS_M,
    demoteGraceSeconds: FOREST_WIND_DEMOTE_GRACE_SECONDS,
    prototypes: windSource.manifest.prototypes,
  };

  return {
    enabled: true,
    posesBuffer,
    weightsBuffer,
    stats,
    encode(pass) {
      if (!activeRootCount) return;
      pass.setBindGroup(0, simGroup);
      pass.setPipeline(headerPipe);
      pass.dispatchWorkgroups(1);

      pass.setPipeline(clearSlotsPipe);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil(activeRootCount / 4) / 64));

      pass.setPipeline(promotePipe);
      pass.dispatchWorkgroups(Math.ceil(activeRootCount / 64));

      pass.setPipeline(packSlotsPipe);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil(activeRootCount / 4) / 64));

      pass.setPipeline(sharedPipe);
      pass.dispatchWorkgroups(Math.ceil((protoCount * FOREST_WIND_SHARED_LANES) / 64));

      pass.setPipeline(promotedPipe);
      pass.dispatchWorkgroups(Math.ceil(FOREST_WIND_MAX_PROMOTED / 64));
    },
    emitForce({
      x = 0, y = 2, z = 0, radius = 28, strengthPa = 650,
      dx = 1, dy = 0, dz = 0,
      basis = FOREST_WIND_BASIS_RADIAL,
      eventType = FOREST_WIND_EVENT_FRIEDLANDER,
      now = 0,
      waveSpeed = 260,
      lobe = 0,
      coneAngleDeg = 35,
    } = {}) {
      const slot = forceCursor % FOREST_WIND_MAX_FORCES;
      forceCursor++;
      const at = slot * 16;
      forcesCpu.set([
        x, y, z, Math.max(0.5, radius),
        dx, dy, dz, strengthPa,
        now, waveSpeed, lobe, Math.cos((coneAngleDeg * Math.PI) / 180),
        basis, eventType, 1, 0,
      ], at);
      device.queue.writeBuffer(forcesBuffer, at * 4, forcesCpu, at, 16);
      return slot;
    },
    setPushCapsule(slot, {
      ax = 0, ay = 0, az = 0,
      bx = 0, by = 2, bz = 0,
      radius = 1.6,
      strength = 1000,
      falloff = 1.0,
      now = 0,
      duration = 0,
    } = {}) {
      const s = ((slot | 0) % FOREST_WIND_MAX_CAPSULES + FOREST_WIND_MAX_CAPSULES) % FOREST_WIND_MAX_CAPSULES;
      const at = s * 12;
      capsulesCpu.set([
        ax, ay, az, Math.max(0.15, radius),
        bx, by, bz, strength,
        Math.max(0.5, falloff), 1, now, Math.max(0, duration),
      ], at);
      device.queue.writeBuffer(capsulesBuffer, at * 4, capsulesCpu, at, 12);
      return s;
    },
    clearPushCapsule(slot) {
      const s = ((slot | 0) % FOREST_WIND_MAX_CAPSULES + FOREST_WIND_MAX_CAPSULES) % FOREST_WIND_MAX_CAPSULES;
      const at = s * 12;
      capsulesCpu.fill(0, at, at + 12);
      device.queue.writeBuffer(capsulesBuffer, at * 4, capsulesCpu, at, 12);
    },
    setWindOverride({ speed = -1, amplitude = -1, globalAmplitude = 1 } = {}) {
      overrideSpeed = Number.isFinite(speed) ? speed : -1;
      overrideAmplitude = Number.isFinite(amplitude) ? amplitude : -1;
      if (Number.isFinite(globalAmplitude) && globalAmplitude >= 0) windAmplitude = globalAmplitude;
      writeConfig(0.016);
    },
    updateRoots(nextCount) {
      activeRootCount = Math.max(0, Math.min(maxRoots, nextCount | 0));
      writeConfig(0.016);
    },
    destroy() {
      for (const b of owned) b.destroy();
    },
  };
}
