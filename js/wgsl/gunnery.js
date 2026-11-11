// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';

export const GUNNERY_CROWN_SEGMENTS=32;
export const GUNNERY_CROWN_ROWS=7;
export const GUNNERY_DROP_COUNT=32;
export const GUNNERY_RING_SEGMENTS=64;
export const GUNNERY_RING_COUNT=6;
export const GUNNERY_EARTH_COUNT=420;
export const GUNNERY_DUST_COUNT=36;

// Each fire is drawn as two flame volumes and six parcels of its smoke.
const GUNNERY_FIRE_FLAMES=2,GUNNERY_FIRE_PARCELS=6;
export const GUNNERY_FIRE_VOLUMES=GUNNERY_FIRE_FLAMES+GUNNERY_FIRE_PARCELS;
export const GUNNERY_FIRE_RECORD_FLOATS=12;
// The volumes a bank of powder smoke is drawn as. One: every volume more is drawn over the others, and the
// billows it is carved from give a bank its form, not the count of its volumes.
export const GUNNERY_BANK_LOBES=1;
export const GUNNERY_SMOKE_RECORD_FLOATS=12;
// Seconds: a muzzle flash, the jet a gun throws, the longest a bank hangs (in a dead calm).
export const GUNNERY_SMOKE_SECONDS=Object.freeze({flash:.085,jet:2.8,bank:52});
// A bank hangs that long in still air and half as long in this much wind, metres a second: the wind tears it up.
const GUNNERY_BANK_WIND=9;
// How long a bank can be seen in a wind of this speed. The GPU draws it no longer, and its record is kept no longer.
export const gunneryBankSeconds=windSpeed=>GUNNERY_SMOKE_SECONDS.bank/(1+Math.max(0,windSpeed)/GUNNERY_BANK_WIND);
// The frame's clock starts again at this many seconds (SIM_CLOCK_LOOP_S); ages allow for it.
const GUNNERY_CLOCK_LOOP=600;
// Where each kind of volume lives in the one list that is sorted and drawn. Iron striking timber, stone, earth or
// water makes no volume: its splinters, dust and spray are drawn from the contacts.
export function gunneryVolumeSlots({shots,banks,fires}){
  const flashes=shots,bankLobes=flashes+shots,fireVolumes=bankLobes+banks*GUNNERY_BANK_LOBES;
  return {jets:0,flashes,banks:bankLobes,fires:fireVolumes,total:fireVolumes+fires*GUNNERY_FIRE_VOLUMES};
}

// Everything drawn as a volume is laid out here, on the GPU, from small records and the frame's clock and wind.
//
// Fires: one record each, rewritten only when the fire changes.
//   anchor: xyz metres, in the hull's own frame when w names a hull, else in the world (w < 0)
//   burn:   x clock when intensity was y, y that intensity, z its change per second, w clock at ignition
//   state:  x seed, y 1 while the fire lives
// Powder smoke: one record a shot and one a bank (the guns that fired together from one stretch of her side),
// written when the gun fires and never again. The wind's carry is kept here too: gunnerySmokeAdvance adds up
// how far the air has moved, and notes that sum against each record the first time it sees it, so smoke goes
// where the wind has blown since its own gun fired, whatever the wind has done meanwhile.
//   shot: muzzle xyz + clock at firing; aim xyz + size (cube root of the charge); seed, generation
//   bank: middle xyz + clock at its first gun; aim xyz + strength (sum of size cubed); seed, generation, guns, half its length along her side
export function GUNNERY_BUILD({shots,banks,fires}){
  const slot=gunneryVolumeSlots({shots,banks,fires}),T=GUNNERY_SMOKE_SECONDS;
  return FRAME_WGSL+/* wgsl */ `
const GUNNERY_PI:f32=3.14159265358979;
const GUNNERY_SHOTS:u32=${shots}u;
const GUNNERY_BANKS:u32=${banks}u;
const GUNNERY_FIRES:u32=${fires}u;
const GUNNERY_FIRE0:u32=${slot.fires}u;
const GUNNERY_VOLUMES:u32=${slot.total}u;
const GUNNERY_CLOCK_LOOP:f32=${GUNNERY_CLOCK_LOOP}.0;
// The air's carry is kept within a span the noise repeats in exactly, so it never grows too large to add to.
const GUNNERY_DRIFT_LOOP:f32=4096.0;
struct GunneryVolume{centre:vec4f,axisX:vec4f,axisY:vec4f,axisZ:vec4f,optical:vec4f};
struct GunneryFire{anchor:vec4f,burn:vec4f,state:vec4f};
struct GunneryHull{right:vec4f,up:vec4f,forward:vec4f,size:vec4f,origin:vec4f,rig:vec4f};
// depthGroups: the workgroups that cover the scene's depth, eight pixels square each.
struct GunneryCounts{fires:u32,drawLimit:u32,depthGroups:vec2u};
struct GunneryFireLights{lights:array<vec4f,2>,hulls:array<f32>};
struct GunneryShot{muzzle:vec4f,aim:vec4f,mark:vec4f};
struct GunneryBank{centre:vec4f,aim:vec4f,mark:vec4f};
// What the sort leaves for the passes that follow: the volumes' indirect draw, then the workgroups the snapshot
// of the scene's depth is dispatched with (none when no volume is in view).
struct GunneryDraw{vertices:u32,instances:u32,firstVertex:u32,firstInstance:u32,depthGroups:vec3u,pad:u32};
// drift: how far the air has gone, xyz, and the clock it was last added to. roll: how far the billows have
// turned over, coarse and fine. born: for each shot, then each bank, the drift when it fired and its generation
// (negative once it has blown away).
struct GunnerySmokeState{drift:vec4f,roll:vec4f,born:array<vec4f>};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>gunneryFires:array<GunneryFire>;
@group(0)@binding(2)var<storage,read>gunneryHulls:array<GunneryHull>;
@group(0)@binding(3)var<storage,read_write>gunneryVolumes:array<GunneryVolume>;
@group(0)@binding(4)var<uniform>gunneryCounts:GunneryCounts;
@group(0)@binding(5)var<storage,read_write>gunneryOrder:array<u32>;
@group(0)@binding(6)var<storage,read_write>gunneryDraw:GunneryDraw;
@group(0)@binding(7)var<storage,read_write>gunneryFireLights:GunneryFireLights;
@group(0)@binding(8)var<storage,read>gunneryShots:array<GunneryShot>;
@group(0)@binding(9)var<storage,read>gunneryBanks:array<GunneryBank>;
@group(0)@binding(11)var<storage,read_write>gunnerySmokeState:GunnerySmokeState;
// How long a bank lasts in the wind there is: gunneryBankSeconds, for the frame's wind.
fn gunneryBankLife()->f32{return ${T.bank}.0/(1.0+F.windP[0].z/${GUNNERY_BANK_WIND}.0);}
fn gunneryAge(birth:f32)->f32{let age=F.camPos.w-birth;return select(age,age+GUNNERY_CLOCK_LOOP,age<-1.0);}
fn gunneryWind()->vec3f{return vec3f(F.windP[0].x,0.0,F.windP[0].y)*F.windP[0].z;}
fn gunneryDriftWrap(d:vec3f)->vec3f{return d-GUNNERY_DRIFT_LOOP*floor(d/GUNNERY_DRIFT_LOOP+.5);}
// A volume whose long axis lies along a direction, as a gun's smoke lies along its shot.
fn gunneryAligned(centre:vec3f,direction:vec3f,radii:vec3f,kind:f32,optical:vec4f)->GunneryVolume{
  var right=vec3f(direction.z,0.0,-direction.x);let span=length(right);
  if(span<1e-6){right=vec3f(1.0,0.0,0.0);}else{right/=span;}
  return GunneryVolume(vec4f(centre,kind),vec4f(right,radii.x),vec4f(cross(direction,right),radii.y),vec4f(direction,radii.z),optical);
}
// The air moves on, and each new shot and bank is given the place the air had reached when it fired.
@compute @workgroup_size(1)fn gunnerySmokeAdvance(){
  var dt=F.camPos.w-gunnerySmokeState.drift.w;if(dt<-1.0){dt+=GUNNERY_CLOCK_LOOP;}dt=clamp(dt,0.0,.25);
  let wind=gunneryWind();
  let drift=gunneryDriftWrap(gunnerySmokeState.drift.xyz+wind*dt);
  gunnerySmokeState.drift=vec4f(drift,F.camPos.w);
  // Billows turn over as they rise: the coarse field climbs slowly, the fine one faster, and the bank's edge is never still.
  gunnerySmokeState.roll=vec4f(fract((gunnerySmokeState.roll.xy+vec2f(.21,.62)*dt)/GUNNERY_DRIFT_LOOP)*GUNNERY_DRIFT_LOOP,0.0,0.0);
  for(var i=0u;i<GUNNERY_SHOTS+GUNNERY_BANKS;i++){
    var generation=0.0;var age=0.0;var life=${T.jet};
    if(i<GUNNERY_SHOTS){generation=gunneryShots[i].mark.y;age=gunneryAge(gunneryShots[i].muzzle.w);}
    else{generation=gunneryBanks[i-GUNNERY_SHOTS].mark.y;age=gunneryAge(gunneryBanks[i-GUNNERY_SHOTS].centre.w);life=gunneryBankLife();}
    let seen=gunnerySmokeState.born[i];
    if(generation!=abs(seen.w)){gunnerySmokeState.born[i]=vec4f(gunneryDriftWrap(drift-wind*max(age,0.0)),generation);}
    // Blown away is for good: a lull afterwards does not bring it back, and its record can be dropped.
    else if(seen.w>0.0&&age>=life){gunnerySmokeState.born[i].w=-seen.w;}
  }
}
// How far the wind has carried record k. Smoke leaves the muzzle with the gun's blast, not the wind's speed,
// and is caught up by the air over a second or so; after that it goes exactly as the wind goes.
fn gunnerySmokeDrift(k:u32,age:f32)->vec3f{
  let carried=gunneryDriftWrap(gunnerySmokeState.drift.xyz-gunnerySmokeState.born[k].xyz);
  return carried-gunneryWind()*1.35*(1.0-exp(-age/1.35));
}
@compute @workgroup_size(64)fn gunneryBuildSmoke(@builtin(global_invocation_id)id:vec3u){
  let index=id.x;let speed=F.windP[0].z;
  if(index<GUNNERY_SHOTS){
    // The jet a gun throws: fast out of the muzzle, slowing, swelling, and handing its smoke to the bank.
    let shot=gunneryShots[index];let age=gunneryAge(shot.muzzle.w);let size=shot.aim.w;let aim=shot.aim.xyz;
    let live=shot.mark.y>0.0&&gunnerySmokeState.born[index].w==shot.mark.y&&age>=0.0;
    var jet=GunneryVolume();var flash=GunneryVolume();
    if(live&&age<${T.jet}){
      // No two guns throw alike. Each jet has its own quickness, girth, length and lean, so a broadside's jets
      // do not stand along her side like a row of beads.
      let own=fract(sin(vec3f(shot.mark.x)*vec3f(127.1,311.7,74.7))*43758.5453);
      let side=normalize(vec3f(aim.z,0.0,-aim.x)+vec3f(1e-5,0.0,0.0));
      let lean=normalize(aim+side*(own.y-.5)*.36+vec3f(0.0,(own.z-.4)*.32,0.0));
      let t=age*(.72+.56*own.x);
      let reach=(.42+10.4*(1.0-exp(-t/.26)))*size*(.8+.4*own.z);
      let across=(.5+2.5*pow(t,.62))*size*(.78+.44*own.y);let along=(.9+min(t,.48)*7.6+t*.9)*size*(.82+.4*own.x);
      let phase=shot.mark.x*37.0;let eddy=across*min(1.0,t*.85)*.22;
      let centre=shot.muzzle.xyz+lean*reach+gunnerySmokeDrift(index,age)+side*sin(phase)*eddy+vec3f(0.0,(.5*t+.5*(1.0-exp(-t/.8)))*size+cos(phase)*eddy*.6,0.0);
      let extinction=118.0*size*size*size/(across*across*along)*(1.0-smoothstep(1.3,${T.jet},age));
      if(extinction>.01){jet=gunneryAligned(centre,lean,vec3f(across,across*(.96+.24*own.z),along),0.0,vec4f(extinction,age,shot.mark.x*79.0,mix(.72,.86,age/${T.jet})));}
    }
    if(live&&age<${T.flash}){
      let t=age/${T.flash};let swell=sin(t*GUNNERY_PI);
      flash=gunneryAligned(shot.muzzle.xyz+aim*(.55+1.1*t)*size,aim,vec3f(.12+.35*swell,.12+.28*swell,.6+1.1*swell)*size,1.0,vec4f(1.0-t,age,shot.mark.x*79.0,0.0));
    }
    gunneryVolumes[index]=jet;gunneryVolumes[${slot.flashes}u+index]=flash;return;
  }
  if(index<GUNNERY_SHOTS+GUNNERY_BANKS){
    // The bank: what the guns of one stretch of her side leave between them. It swells as it thins, rises a
    // little, and the wind carries it off, spreading and tearing it faster the harder it blows.
    let k=index-GUNNERY_SHOTS;let bank=gunneryBanks[k];let age=gunneryAge(bank.centre.w);
    let live=bank.mark.y>0.0&&gunnerySmokeState.born[index].w==bank.mark.y&&age>=0.0;
    let guns=max(1.0,bank.mark.z);let size=pow(max(bank.aim.w,.01)/guns,1.0/3.0);
    let life=gunneryBankLife();
    for(var lobe=0u;lobe<${GUNNERY_BANK_LOBES}u;lobe++){
      // n places a lobe between the bank's foot (0) and its head (1): one lobe stands midway and is the whole bank.
      var volume=GunneryVolume();let n=(f32(lobe)+.5)*${2/GUNNERY_BANK_LOBES}-.5;let t=age-n*.35;
      if(live&&t>0.0&&age<life){
        let reach=(4.6+3.2*n)*size*(1.0-exp(-t/.55));
        let rise=((1.1+2.3*n)*(1.0-exp(-t/2.5))+(.18+.2*n)*t)*size/(1.0+speed*.08);
        let puff=(.95+1.5*pow(t,.55)*(1.0+speed*.035))*size*(1.0+.22*log2(guns))*${GUNNERY_BANK_LOBES===1?1.1:1};
        let phase=bank.mark.x*41.0+n*2.4;
        // A higher lobe rides faster air.
        let centre=bank.centre.xyz+bank.aim.xyz*reach+gunnerySmokeDrift(index,age)*(1.0+(n*2.0-1.0)*.06)
          +vec3f(sin(phase)*.12*puff,rise,cos(phase)*.12*puff);
        let radii=vec3f(bank.mark.w+puff,puff*(1.0+.3*n),puff*1.1)/.72;
        let fade=smoothstep(.15,1.6,t)*exp(-age/(life*.55))*(1.0-smoothstep(life*.72,life,age));
        let extinction=440.0*bank.aim.w/f32(${GUNNERY_BANK_LOBES})/(radii.x*radii.y*radii.z)*fade;
        if(extinction>.003){volume=gunneryAligned(centre,bank.aim.xyz,radii,0.0,vec4f(extinction,age,bank.mark.x*79.0+n*11.0,mix(.56,.94,smoothstep(0.0,1.0,age/life))));}
      }
      gunneryVolumes[${slot.banks}u+k*${GUNNERY_BANK_LOBES}u+lobe]=volume;
    }
  }
}
fn gunneryFireIntensity(f:GunneryFire)->f32{
  if(f.state.y<.5){return 0.0;}
  return clamp(f.burn.y+f.burn.z*(F.camPos.w-f.burn.x),0.0,1.65);
}
// A fire aboard goes where her hull goes, by the same transform her timbers are drawn with.
fn gunneryFirePosition(f:GunneryFire)->vec3f{
  if(f.anchor.w<0.0){return f.anchor.xyz;}
  let hull=gunneryHulls[min(u32(f.anchor.w),arrayLength(&gunneryHulls)-1u)];
  return hull.origin.xyz+hull.right.xyz*f.anchor.x+hull.up.xyz*f.anchor.y-hull.forward.xyz*f.anchor.z;
}
// An upright volume: its long axis is the world's up, as flame and its smoke rise.
fn gunneryUpright(centre:vec3f,across:f32,tall:f32,kind:f32,extinction:f32,age:f32,seed:f32,subtype:f32)->GunneryVolume{
  return GunneryVolume(vec4f(centre,kind),vec4f(1.0,0.0,0.0,across),vec4f(0.0,0.0,-1.0,across),vec4f(0.0,1.0,0.0,tall),vec4f(extinction,age,seed,subtype));
}
@compute @workgroup_size(64)fn gunneryBuildFires(@builtin(global_invocation_id)id:vec3u){
  let index=id.x;if(index>=min(gunneryCounts.fires,GUNNERY_FIRES)){return;}
  let slot=GUNNERY_FIRE0+index*${GUNNERY_FIRE_VOLUMES}u;
  let fire=gunneryFires[index];let raw=gunneryFireIntensity(fire);
  if(raw<=.02){for(var k=0u;k<${GUNNERY_FIRE_VOLUMES}u;k++){gunneryVolumes[slot+k].optical=vec4f(0.0);}return;}
  let pos=gunneryFirePosition(fire);let heat=clamp(raw,.05,1.6);let seed=fire.state.x;
  let age=max(0.0,F.camPos.w-fire.burn.w);
  let wind=gunneryWind();
  let pulse=.88+.14*sin(age*11.3+seed*19.0)+.08*cos(age*19.7-seed*7.3);
  let across=(.56+.60*heat)*pulse;let tall=(.98+1.18*heat)*pulse;
  // The roaring body of the flame.
  gunneryVolumes[slot]=gunneryUpright(vec3f(pos.x+wind.x*.03,pos.y+.38*tall,pos.z+wind.z*.03),across,tall*1.05,1.0,.92+.74*heat,age,seed*53.0,1.0);
  // Tongues flickering above it, and the embers they throw up.
  let tongue=.84+.24*sin(age*15.4+seed*31.0);
  gunneryVolumes[slot+1u]=gunneryUpright(vec3f(pos.x+wind.x*.12+sin(age*6.3+seed*13.0)*.24*heat,pos.y+.96*tall,pos.z+wind.z*.12+cos(age*5.7+seed*17.0)*.24*heat),
    across*.84*tongue,tall*.96*tongue,1.0,(.76+.62*heat)*tongue,age*1.35+1.7,seed*71.0+13.0,1.30);
  // A column of pitch smoke: parcels that rise, lean downwind, swell and thin in turn.
  let period=6.4;let grow=1.05+.88*heat;
  for(var parcel=0u;parcel<${GUNNERY_FIRE_PARCELS}u;parcel++){
    let n=f32(parcel);let phase=fract((age+n*(period/${GUNNERY_FIRE_PARCELS}.0)+seed*2.1)/period);let swell=pow(max(sin(phase*GUNNERY_PI),0.0),.62);
    if(swell<.04){gunneryVolumes[slot+${GUNNERY_FIRE_FLAMES}u+parcel].optical=vec4f(0.0);continue;}
    let lean=phase*(1.1+phase*3.4);let wide=(1.48+phase*4.15)*grow;
    gunneryVolumes[slot+${GUNNERY_FIRE_FLAMES}u+parcel]=gunneryUpright(
      vec3f(pos.x+wind.x*lean+sin(phase*6.28+seed*11.0+n)*.55*grow,pos.y+(1.35+phase*18.8)*grow,pos.z+wind.z*lean+cos(phase*6.28+seed*17.0+n)*.55*grow),
      wide,(1.85+phase*4.75)*grow,0.0,(26.0+22.0*heat)*swell,age*.45+n*3.1,seed*97.0+n*29.0,2.0+phase*.8);
  }
}
// The four sides of what the eye sees, each a plane through the eye: xyz points inward, measured from the eye.
fn gunneryViewSides()->array<vec3f,4>{
  let m=F.viewProj;let x=vec3f(m[0].x,m[1].x,m[2].x);let y=vec3f(m[0].y,m[1].y,m[2].y);let w=vec3f(m[0].w,m[1].w,m[2].w);
  return array<vec3f,4>(normalize(w+x),normalize(w-x),normalize(w+y),normalize(w-y));
}
// A volume is drawn if there is anything in it (smoke that has blown away and fires that are out are left as
// volumes of nothing) and any of it can be in view.
fn gunneryVolumeDrawn(index:u32,sides:array<vec3f,4>)->bool{
  let v=gunneryVolumes[index];if(!(v.optical.x>0.0)){return false;}
  let d=v.centre.xyz-F.camPos.xyz;let reach=-length(vec3f(v.axisX.w,v.axisY.w,v.axisZ.w));
  return dot(d,sides[0])>=reach&&dot(d,sides[1])>=reach&&dot(d,sides[2])>=reach&&dot(d,sides[3])>=reach;
}
fn gunneryVolumeRange(index:u32)->f32{let d=gunneryVolumes[index].centre.xyz-F.camPos.xyz;return dot(d,d);}
// Volumes blend over one another, so they are drawn farthest first. Each counts how many volumes to be drawn
// are nearer than itself and takes that place from the back of the list; only the nearest are kept. With
// none in view nothing is drawn, and the snapshot of the scene's depth they are drawn against is not taken.
@compute @workgroup_size(64)fn gunnerySortVolumes(@builtin(global_invocation_id)id:vec3u){
  let index=id.x;let sides=gunneryViewSides();
  // Fire volumes past the last fire burning are whatever an older fire left there.
  let end=GUNNERY_FIRE0+min(gunneryCounts.fires,GUNNERY_FIRES)*${GUNNERY_FIRE_VOLUMES}u;
  let mine=index<end&&gunneryVolumeDrawn(index,sides);var range=0.0;if(mine){range=gunneryVolumeRange(index);}
  var live=0u;var nearer=0u;
  for(var other=0u;other<end;other++){
    if(!gunneryVolumeDrawn(other,sides)){continue;}
    live++;
    let theirs=gunneryVolumeRange(other);
    if(theirs<range||(theirs==range&&other<index)){nearer++;}
  }
  let drawn=min(live,gunneryCounts.drawLimit);
  if(index==0u){gunneryDraw=GunneryDraw(36u,drawn,0u,0u,select(vec3u(0u),vec3u(gunneryCounts.depthGroups,1u),drawn>0u),0u);}
  if(mine&&nearer<drawn){gunneryOrder[drawn-1u-nearer]=index;}
}
// The light fires throw on timber, crew, land and sea. Fires within twelve metres burn as one light, and
// the two that matter most to this eye are handed to the frame. A burning ship also lights her own decks.
@compute @workgroup_size(1)fn gunneryFireLighting(){
  var clusters:array<vec4f,${fires}>;var count=0u;
  let fires=min(gunneryCounts.fires,GUNNERY_FIRES);
  for(var i=0u;i<fires;i++){
    let fire=gunneryFires[i];let raw=gunneryFireIntensity(fire);if(raw<=.01){continue;}
    let pos=gunneryFirePosition(fire);var merged=false;
    for(var c=0u;c<count;c++){
      let d=clusters[c].xyz-pos;
      if(dot(d,d)<144.0){let sum=clusters[c].w+raw;clusters[c]=vec4f((clusters[c].xyz*clusters[c].w+pos*raw)/sum,min(3.6,sum));merged=true;break;}
    }
    if(!merged){clusters[count]=vec4f(pos,min(3.2,raw));count++;}
  }
  var first=vec4f(0.0);var second=vec4f(0.0);var firstScore=-1.0;var secondScore=-1.0;
  for(var c=0u;c<count;c++){
    let score=clusters[c].w/(1.0+distance(clusters[c].xyz,F.camPos.xyz)*.02);
    if(score>firstScore){second=first;secondScore=firstScore;first=clusters[c];firstScore=score;}
    else if(score>secondScore){second=clusters[c];secondScore=score;}
  }
  let night=1.0-clamp((F.sunDir.y+.06)/.24,0.0,1.0);
  let flash=min(1.0,1.35/max(F.post.x,1e-3));let exposure=flash*(1.0+2.8*night);
  gunneryFireLights.lights[0]=vec4f(first.xyz,first.w*exposure);
  gunneryFireLights.lights[1]=vec4f(second.xyz,second.w*exposure);
  let hulls=min(arrayLength(&gunneryHulls),arrayLength(&gunneryFireLights.hulls));
  for(var h=0u;h<hulls;h++){
    // Her fires are listed newest first; the light sits at the oldest.
    var sum=0.0;var along=0.0;
    for(var i=0u;i<fires;i++){
      let fire=gunneryFires[i];if(fire.anchor.w<0.0||u32(fire.anchor.w)!=h){continue;}
      let raw=gunneryFireIntensity(fire);if(raw<=0.0){continue;}
      sum+=raw;along=fire.anchor.z;
    }
    // Packed as her hull shader reads it: the station along her in twelfths, and the strength in the fraction.
    let strength=min(2.4,sum)*flash;
    let station=clamp(floor(along/max(.8,gunneryHulls[h].size.y/12.0)+7.0),1.0,12.0);
    gunneryFireLights.hulls[h]=select(0.0,station+clamp(strength/2.5,.01,.98),strength>.01);
  }
}`;
}

// The field every bank of smoke is carved from, made once: a block that repeats in every direction.
//   r, a: billows, broad and less broad (cell noise turned inside out, so each cell is a bulge)
//   g: the small billows that ravel a bank's edge    b: a smooth field that bends the others
// It is kept at four sizes, each half the last, so a walk through smoke in long steps reads billows no
// finer than its steps and shows no grain.
export const GUNNERY_NOISE_SIZE=64;
export const GUNNERY_NOISE_LEVELS=4;
export const GUNNERY_NOISE=/* wgsl */ `
@group(0)@binding(0)var gunneryNoiseTarget:texture_storage_3d<rgba8unorm,write>;
@group(0)@binding(1)var gunneryNoiseFiner:texture_3d<f32>;
@group(0)@binding(2)var gunneryNoiseCoarser:texture_storage_3d<rgba8unorm,write>;
@compute @workgroup_size(4,4,4)fn gunneryHalveNoise(@builtin(global_invocation_id)id:vec3u){
  if(any(id>=textureDimensions(gunneryNoiseCoarser))){return;}
  var sum=vec4f(0.0);
  for(var corner=0u;corner<8u;corner++){sum+=textureLoad(gunneryNoiseFiner,vec3i(id*2u+vec3u(corner&1u,(corner>>1u)&1u,(corner>>2u)&1u)),0);}
  textureStore(gunneryNoiseCoarser,id,sum*.125);
}
fn gunneryNoiseHash(cell:vec3u,salt:u32)->vec3f{
  var v=cell*vec3u(1664525u,1013904223u,22695477u)+vec3u(salt*747796405u+2891336453u);
  v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
  return vec3f(v>>vec3u(8u))*(1.0/16777216.0);
}
fn gunneryNoiseWrap(cell:vec3i,cells:i32)->vec3u{return vec3u((cell%cells+cells)%cells);}
fn gunneryNoiseCells(p:vec3f,cells:i32,salt:u32)->f32{
  let q=p*f32(cells);let base=vec3i(floor(q));let f=fract(q);var nearest=8.0;
  for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let o=vec3i(x,y,z);let d=vec3f(o)+gunneryNoiseHash(gunneryNoiseWrap(base+o,cells),salt)-f;nearest=min(nearest,dot(d,d));
  }}}
  return 1.0-min(1.0,sqrt(nearest));
}
fn gunneryNoiseLattice(p:vec3f,cells:i32,salt:u32)->f32{
  let q=p*f32(cells);let base=vec3i(floor(q));let f=fract(q);let u=f*f*(3.0-2.0*f);var sum=0.0;
  for(var corner=0;corner<8;corner++){
    let o=vec3i(corner&1,(corner>>1)&1,(corner>>2)&1);let w=mix(1.0-u,u,vec3f(o));
    sum+=gunneryNoiseHash(gunneryNoiseWrap(base+o,cells),salt).x*w.x*w.y*w.z;
  }
  return sum;
}
fn gunneryNoiseBillows(p:vec3f,cells:i32,salt:u32)->f32{
  let n=gunneryNoiseCells(p,cells,salt)*.6+gunneryNoiseCells(p,cells*2,salt+7u)*.27+gunneryNoiseCells(p,cells*4,salt+13u)*.13;
  return clamp((n-.2)/.62,0.0,1.0);
}
fn gunneryNoiseSmooth(p:vec3f,cells:i32,salt:u32)->f32{
  return gunneryNoiseLattice(p,cells,salt)*.5+gunneryNoiseLattice(p,cells*2,salt+5u)*.3+gunneryNoiseLattice(p,cells*4,salt+9u)*.2;
}
@compute @workgroup_size(4,4,4)fn gunneryMakeNoise(@builtin(global_invocation_id)id:vec3u){
  let p=(vec3f(id)+.5)/${GUNNERY_NOISE_SIZE}.0;
  let broad=clamp(gunneryNoiseBillows(p,4,1u)*(.62+.76*gunneryNoiseSmooth(p,3,31u)),0.0,1.0);
  let less=clamp(gunneryNoiseBillows(p,5,2u)*(.62+.76*gunneryNoiseSmooth(p,4,37u)),0.0,1.0);
  textureStore(gunneryNoiseTarget,id,vec4f(broad,gunneryNoiseBillows(p,8,3u),gunneryNoiseSmooth(p,6,41u),less));
}`;

export function GUNNERY_DEPTH_RESOLVE(samples=4){
  const count=Math.max(1,Math.floor(samples));
  return /* wgsl */ `
@group(0)@binding(0)var gunneryDepthSource:${count===1?'texture_depth_2d':'texture_depth_multisampled_2d'};
@group(0)@binding(1)var gunneryDepthTarget:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8)fn gunneryResolveDepth(@builtin(global_invocation_id)id:vec3u){
  let size=textureDimensions(gunneryDepthTarget);if(any(id.xy>=size)){return;}
  var depth=0.0;
  for(var sample=0;sample<${count};sample++){depth=max(depth,textureLoad(gunneryDepthSource,vec2i(id.xy),${count===1?'0':'sample'}));}
  textureStore(gunneryDepthTarget,vec2i(id.xy),vec4f(depth));
}`;
}

export const GUNNERY_RENDER=FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+/* wgsl */ `
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var skyLUT:texture_2d<f32>;
@group(0)@binding(3)var sampC:sampler;
@group(0)@binding(4)var envCube:texture_cube<f32>;
@group(0)@binding(5)var<storage,read>sunVis:array<f32,4>;
@group(0)@binding(6)var gunnerySea:texture_2d_array<f32>;
@group(0)@binding(7)var gunnerySeaSampler:sampler;
struct GunneryVolume{centre:vec4f,axisX:vec4f,axisY:vec4f,axisZ:vec4f,optical:vec4f};
struct GunneryBall{positionRadius:vec4f};
struct GunneryContact{root:vec4f,motion:vec4f,detail:vec4f,extra:vec4f};
struct GunneryArcSegment{p0:vec4f,p1:vec4f,style:vec4f};
@group(0)@binding(8)var<storage,read>gunneryVolumes:array<GunneryVolume>;
@group(0)@binding(9)var<storage,read>gunneryBalls:array<GunneryBall>;
@group(0)@binding(10)var<storage,read>gunneryContacts:array<GunneryContact>;
@group(0)@binding(11)var gunnerySceneDepth:texture_2d<f32>;
@group(0)@binding(12)var<storage,read>gunneryArcs:array<GunneryArcSegment>;
@group(0)@binding(13)var<storage,read>gunneryOrder:array<u32>;
struct GunnerySmokeState{drift:vec4f,roll:vec4f,born:array<vec4f>};
@group(0)@binding(14)var<storage,read>gunnerySmokeState:GunnerySmokeState;
@group(0)@binding(15)var gunneryNoise:texture_3d<f32>;
@group(0)@binding(16)var gunneryNoiseSampler:sampler;
`+SKY_RENDER_FUNCS+/* wgsl */ `
// Records carry the clock at which a thing happened; the frame's clock starts again every ${GUNNERY_CLOCK_LOOP} s.
fn gunneryAge(birth:f32)->f32{let age=F.camPos.w-birth;return select(age,age+${GUNNERY_CLOCK_LOOP}.0,age<-1.0);}
fn gunneryWind()->vec3f{return vec3f(F.windP[0].x,0.0,F.windP[0].y)*F.windP[0].z;}
fn gunneryCorner(vertex:u32)->vec2f{return array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[vertex%6u];}
fn gunneryCube(vertex:u32)->vec3f{
  let points=array<vec3f,8>(vec3f(-1,-1,-1),vec3f(1,-1,-1),vec3f(-1,1,-1),vec3f(1,1,-1),vec3f(-1,-1,1),vec3f(1,-1,1),vec3f(-1,1,1),vec3f(1,1,1));
  let indices=array<u32,36>(0u,2u,1u,1u,2u,3u,4u,5u,6u,5u,7u,6u,0u,4u,2u,2u,4u,6u,1u,3u,5u,3u,7u,5u,0u,1u,4u,1u,5u,4u,2u,6u,3u,3u,6u,7u);
  return points[indices[vertex]];
}
fn gunneryVolumeLocal(v:GunneryVolume,p:vec3f)->vec3f{
  let d=p-v.centre.xyz;return vec3f(dot(d,v.axisX.xyz)/v.axisX.w,dot(d,v.axisY.xyz)/v.axisY.w,dot(d,v.axisZ.xyz)/v.axisZ.w);
}
fn gunneryVolumeRay(v:GunneryVolume,ray:vec3f)->vec3f{return vec3f(dot(ray,v.axisX.xyz)/v.axisX.w,dot(ray,v.axisY.xyz)/v.axisY.w,dot(ray,v.axisZ.xyz)/v.axisZ.w);}
fn gunneryHash3(p:vec3f)->f32{
  var q=fract(p*vec3f(.1031,.1030,.0973));
  q+=dot(q,q.yxz+33.33);
  return fract((q.x+q.y)*q.z);
}
fn gunneryNoise3(p:vec3f)->f32{
  let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
  return mix(
    mix(mix(gunneryHash3(i+vec3f(0,0,0)),gunneryHash3(i+vec3f(1,0,0)),u.x),
        mix(gunneryHash3(i+vec3f(0,1,0)),gunneryHash3(i+vec3f(1,1,0)),u.x),u.y),
    mix(mix(gunneryHash3(i+vec3f(0,0,1)),gunneryHash3(i+vec3f(1,0,1)),u.x),
        mix(gunneryHash3(i+vec3f(0,1,1)),gunneryHash3(i+vec3f(1,1,1)),u.x),u.y),
    u.z);
}
fn gunneryContrastNoise3(p:vec3f)->f32{
  // Trilinear value noise concentrates around [0.22, 0.78]; stretching to [0, 1]
  // restores full-amplitude turbulent crests and deep zero-density erosion troughs.
  return smoothstep(.21,.79,gunneryNoise3(p));
}
fn gunneryCloudFbm(p:vec3f)->f32{
  var q=p;
  let n0=gunneryContrastNoise3(q);q=q*2.07+vec3f(13.7,-7.3,5.1);
  let n1=gunneryContrastNoise3(q);q=q*2.13+vec3f(-9.1,11.3,-17.9);
  let n2=gunneryContrastNoise3(q);
  // True 3D billow noise: |2n - 1| is 1.0 at 3D eddy centers (rounded puffs)
  // and 0.0 along the narrow creases between eddies.
  let fbm=n0*.52+n1*.31+n2*.17;
  let b0=smoothstep(.06,.86,abs(n0*2.0-1.0));
  let b1=smoothstep(.06,.86,abs(n1*2.0-1.0));
  let b2=smoothstep(.06,.86,abs(n2*2.0-1.0));
  let billow=b0*.52+b1*.32+b2*.16;
  return mix(fbm,billow,.62);
}
fn gunneryCurlWarp(local:vec3f,age:f32,seed:f32)->vec3f{
  // Full-amplitude 3D divergence-free curl warp + buoyant thermal roll-up.
  let q=local*1.75+vec3f(seed*2.1,-age*.42,seed*3.3);
  let nX=gunneryContrastNoise3(q)-.5;
  let nY=gunneryContrastNoise3(q+vec3f(17.3,9.1,-11.7))-.5;
  let nZ=gunneryContrastNoise3(q+vec3f(-13.1,21.7,7.9))-.5;
  let q2=local*3.65+vec3f(-seed*3.1,-age*.88,seed*1.7);
  let fineCurl=vec3f(sin(q2.y*1.7+q2.z*1.3),sin(q2.z*1.7-q2.x*1.3),cos(q2.x*1.7+q2.y*1.3))*.24;
  let curl=vec3f(nY-nZ,nZ-nX,nX-nY)*.92+fineCurl;
  // Buoyant thermal shear: upper plume billows outward, underside pinches & rolls inward
  let roll=vec3f(local.x*local.y*.26,-dot(local.xz,local.xz)*.18,local.z*local.y*.22)*clamp(age*.42,0.0,1.0);
  let amp=.34+.24*clamp(age*.45,0.0,1.0);
  return curl*amp+roll;
}
fn gunneryMacroBillow(p:vec3f,age:f32,seed:f32)->f32{
  // Asymmetric, multi-turret 3D plume scaffold with no concentric ring bands at mid/late age.
  let jetStage=clamp(1.0-age*1.15,0.0,1.0);
  let u=clamp((p.z+.86)/1.72,0.0,1.0);
  // Subtle 3D spine meander breaks axial alignment when looking down the barrel
  let spineX=sin(p.z*2.4+seed*5.7)*.14;
  let spineY=.12*u*u*clamp(age*.48,0.0,1.2)+cos(p.z*2.1-seed*4.3)*.10;
  let dx=p.x-spineX;
  let dy=p.y-spineY;
  // Asymmetric vertical shear: buoyant crown expands at +dy, undercut base pinches at -dy
  let vertAsym=select(1.32,0.88,dy>0.0);
  let anisoR=length(vec2f(dx*1.04,dy*vertAsym));
  // Coarse 3D billow-turret modulation so cross-sections are irregular lobed clouds, never circles
  let m0=gunneryContrastNoise3(p*1.35+vec3f(seed*3.7,-age*.32,seed*2.1));
  let m1=gunneryContrastNoise3(p*2.65+vec3f(-seed*2.9,age*.44,-seed*1.7));
  let bMacro0=smoothstep(.05,.88,abs(m0*2.0-1.0));
  let bMacro1=smoothstep(.05,.88,abs(m1*2.0-1.0));
  let turretMod=.42+.74*(bMacro0*.64+bMacro1*.36);
  let baseSpan=mix(mix(.52,.26,jetStage),mix(.68,.54,jetStage),smoothstep(0.0,.72,u))*(1.0-smoothstep(.74,1.0,u)*.52);
  let axialCap=smoothstep(0.0,.12,u)*(1.0-smoothstep(.86,1.0,u));
  let irregularRadius=max(.16,baseSpan*turretMod);
  let coreField=clamp(1.0-anisoR/irregularRadius,0.0,1.0)*axialCap;
  // Transient muzzle vortex ring only during initial discharge (t < 0.6s)
  let ringTube=length(vec2f(anisoR-.32,(p.z-.22)*1.35));
  let vortexField=clamp(1.0-ringTube/(.26+.14*bMacro0),0.0,1.0)*jetStage*jetStage;
  return clamp(coreField*1.08+vortexField*.55,0.0,1.0);
}
fn gunneryDensityAndFbm(local:vec3f,age:f32,seed:f32,subtype:f32)->vec2f{
  // Soft cube-face boundary guard only near the outer [-1, 1]^3 walls
  let boxMax=max(abs(local.x),max(abs(local.y),abs(local.z)));
  let boxGuard=1.0-smoothstep(.74,1.0,boxMax);if(boxGuard<=0.0){return vec2f(0.0,0.0);}
  let isFireSmoke=subtype>=1.8;
  let firePhase=clamp((subtype-2.0)/0.8,0.0,1.0);
  let effAge=select(age,0.65+firePhase*1.55,isFireSmoke);
  let curl=gunneryCurlWarp(local,effAge,seed);
  let p=local+curl*select(1.0,0.55,isFireSmoke);
  var lobes=0.0;
  var fireEllipR=0.0;
  if(isFireSmoke){
    let m0=gunneryContrastNoise3(p*1.35+vec3f(seed*3.7,-age*.38,seed*2.1));
    fireEllipR=length(vec3f(p.x*1.12,p.y*1.12,p.z*1.14));
    let outerR=0.62+0.22*m0;
    lobes=smoothstep(outerR,0.16,fireEllipR);
  }else{
    lobes=gunneryMacroBillow(p,effAge,seed);
  }
  if(lobes<=0.001){return vec2f(0.0,0.0);}
  let q=p*select(2.15,1.75,isFireSmoke)+vec3f(seed*1.7,-age*.42,seed*2.3);
  let n0=gunneryContrastNoise3(q);
  let n1=gunneryContrastNoise3(q*2.08+vec3f(13.7,-7.3+age*.52,5.1));
  let n2=gunneryContrastNoise3(q*4.25+vec3f(-9.1,11.3-age*.88,-17.9));
  let fbm=n0*.52+n1*.32+n2*.16;
  // True 3D rounded billow puffs (|2n - 1| = 1 at eddy cores, 0 in deep creases between puffs)
  let b0=smoothstep(.05,.88,abs(n0*2.0-1.0));
  let b1=smoothstep(.05,.88,abs(n1*2.0-1.0));
  let b2=smoothstep(.05,.88,abs(n2*2.0-1.0));
  let billowPuffs=b0*.52+b1*.32+b2*.16;
  let turbField=mix(fbm,billowPuffs,select(.64,.42,isFireSmoke));
  // Subtractive turbulent erosion carves deep see-through rifts between 3D puffs
  // and erodes the perimeter into irregular curling billows and wispy tendrils.
  let ageNorm=clamp(age/2.9,0.0,1.0);
  let fireErode=mix(0.05,mix(0.44,0.72,firePhase),smoothstep(0.18,0.68,fireEllipR));
  let erodeStrength=select(mix(.54,.92,ageNorm),fireErode,isFireSmoke);
  let rawSignal=lobes-erodeStrength*(1.0-turbField);
  if(rawSignal<=0.0){return vec2f(0.0,turbField);}
  let wispy=smoothstep(0.0,select(.42,.28,isFireSmoke),rawSignal);
  let density=select(
    boxGuard*wispy*sqrt(wispy)*(.49+turbField*1.20),
    boxGuard*wispy*(1.45+turbField*2.35),
    isFireSmoke
  );
  return vec2f(density,turbField);
}
fn gunneryShadowDensity(local:vec3f,age:f32,seed:f32,localFbm:f32)->f32{
  let boxMax=max(abs(local.x),max(abs(local.y),abs(local.z)));
  let boxGuard=1.0-smoothstep(.74,1.0,boxMax);if(boxGuard<=0.0){return 0.0;}
  let u=clamp((local.z+.86)/1.72,0.0,1.0);
  let axialCap=smoothstep(0.0,.12,u)*(1.0-smoothstep(.86,1.0,u));
  let r=length(vec2f(local.x,local.y*select(1.25,0.88,local.y>0.0)));
  let core=clamp(1.0-r/(.56+.22*localFbm),0.0,1.0)*axialCap;
  return boxGuard*core*(.48+.52*localFbm);
}
// Powder smoke. A bank is not a shape of its own: it is a swelling, and what gives it form is one field of
// billows that fills the world and goes with the wind. Where the billows are full the smoke stands out to the
// swelling's edge; between them it is eaten back toward the middle, and late in its life right through, so an
// old bank tears into separate clouds. Banks that overlap are carved from the same billows, so they join as
// one cloud, and the cloud blows downwind whole. world is where; local is the same place in the volume's own
// measure, 1 at its edge. erode runs from about a half (fresh) to nearly one (about to go).
fn gunnerySmokeField(world:vec3f)->vec3f{return world-gunnerySmokeState.drift.xyz-vec3f(0.0,gunnerySmokeState.roll.x,0.0);}
fn gunnerySmokeCarve(billow:f32,erode:f32)->f32{return .04+(1.0-billow)*(.14+erode*.6+smoothstep(.74,.95,erode)*.55);}
// An edge is hard on fresh smoke and softens as it thins.
fn gunnerySmokeSoft(erode:f32)->f32{return mix(.1,.5,smoothstep(.5,.95,erode));}
// The billows a volume is carved from suit its size: grain.x is 1 for a puff a few metres through, grain.y 1
// for a bank tens of metres through. grain.z is how coarsely the walk through it steps, as a level of the
// broadest billows' field: each level up is billows twice the size, and a finer field is that many levels on.
fn gunnerySmokeSmall(q:vec3f)->vec3f{return (q-vec3f(0.0,gunnerySmokeState.roll.y-gunnerySmokeState.roll.x,0.0))/8.0;}
// How far inside its swelling a place is: 1 at the middle, 0 at the edge. The underside is the blunter half,
// so a bank that has risen clear of the sea has a broad base and does not stand on a narrowing stem.
fn gunnerySmokeBody(local:vec3f)->f32{return 1.0-length(vec3f(local.x,local.y*select(1.0,1.5,local.y<0.0),local.z));}
// The billows alone, without the ravelled edge: enough to know how much smoke stands toward the sun.
fn gunnerySmokeMass(world:vec3f,local:vec3f,erode:f32,grain:vec4f)->f32{
  let body=gunnerySmokeBody(local);if(body<=0.0){return 0.0;}
  let q=gunnerySmokeField(world);var billow=0.0;
  if(grain.x>.5){billow=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,gunnerySmokeSmall(q),clamp(grain.z+2.5,0.0,3.0)).g;}
  else if(grain.y>.5){billow=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,q/32.0,clamp(grain.z+.5,0.0,3.0)).r;}
  else{billow=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,q/16.0+vec3f(.37,.11,.73),clamp(grain.z+1.5,0.0,3.0)).a;}
  return smoothstep(0.0,gunnerySmokeSoft(erode),body-gunnerySmokeCarve(billow,erode)-.05*(1.0-grain.x));
}
// x: how much smoke is here, 0 to 1. y: how full the billow it stands in. Only the billows a volume of this
// size is carved from are looked up, and the small ones not at all where the large have left nothing.
fn gunnerySmoke(world:vec3f,local:vec3f,erode:f32,grain:vec4f)->vec2f{
  let body=gunnerySmokeBody(local);if(body<=0.0){return vec2f(0.0);}
  let q=gunnerySmokeField(world);var billow=1.0;var bend=vec3f(0.0);
  if(grain.x<.999){
    let broad=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,q/32.0,clamp(grain.z,0.0,3.0));billow=broad.r;bend=broad.bbb;
    if(grain.y<.999){
      let less=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,q/16.0+vec3f(.37,.11,.73),clamp(grain.z+1.0,0.0,3.0));
      billow=mix(less.a,broad.r,grain.y);bend.y=less.b;
    }
    // The small billows can only take smoke away from here.
    if(grain.x<=0.0&&body<=gunnerySmokeCarve(billow,erode)){return vec2f(0.0);}
  }
  // The small billows climb past the large ones, bent by the smooth field, so an edge never holds its shape.
  let fine=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,gunnerySmokeSmall(q)+bend*.3*(1.0-grain.x),clamp(grain.z+2.0,0.0,3.0)).g;
  billow=mix(billow,fine,grain.x);
  // A jet fresh from the muzzle is smaller than those billows: it is torn by ones half their size again.
  if(grain.w>0.0){
    let tiny=textureSampleLevel(gunneryNoise,gunneryNoiseSampler,gunnerySmokeSmall(q)*2.3+vec3f(.61,.29,.83),clamp(grain.z+3.2,0.0,3.0)).g;
    billow=mix(billow,billow*.4+tiny*.6,grain.w);
  }
  let stand=body-gunnerySmokeCarve(billow,erode)-(1.0-fine)*(.05+.13*erode)*(1.0-grain.x);
  return vec2f(smoothstep(0.0,gunnerySmokeSoft(erode),stand),billow);
}
// Metres from a place inside a volume to its edge, along a world direction given in the volume's measure.
fn gunneryChord(local:vec3f,along:vec3f)->f32{
  let a=max(dot(along,along),1e-8);let b=dot(local,along);let c=dot(local,local)-1.0;
  return max(0.0,(-b+sqrt(max(b*b-a*c,0.0)))/a);
}
fn gunnerySceneDistance(pixel:vec2f,ray:vec3f)->f32{
  let size=textureDimensions(gunnerySceneDepth);let uv=clamp(vec2i(pixel),vec2i(0),vec2i(size)-1);
  let depth=textureLoad(gunnerySceneDepth,uv,0).x;if(depth<=0.0){return 1e8;}
  // General camera-relative projection inversion, including the actual near
  // plane. No guessed 0.1/depth conversion or detached screen-space billboard.
  let clipRay=F.viewProj*vec4f(ray,0);let clipOrigin=F.viewProj*vec4f(0,0,0,1);
  return max(0.0,(clipOrigin.z-depth*clipOrigin.w)/(depth*clipRay.w-clipRay.z));
}
fn gunneryHgPhase(cosTheta:f32,g:f32)->f32{
  let g2=g*g;
  return (1.0-g2)/(4.0*PI*pow(max(.01,1.0+g2-2.0*g*cosTheta),1.5));
}
struct GunneryVolumeVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)@interpolate(flat)id:u32};
@vertex fn gunneryVolumeVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryVolumeVertex{
  // Drawn farthest first, in the order the sort pass left.
  let slot=gunneryOrder[id];let v=gunneryVolumes[slot];let c=gunneryCube(vertex);
  let world=v.centre.xyz+v.axisX.xyz*c.x*v.axisX.w+v.axisY.xyz*c.y*v.axisY.w+v.axisZ.xyz*c.z*v.axisZ.w;
  return GunneryVolumeVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,slot);
}
@fragment fn gunneryVolumeFS(v:GunneryVolumeVertex)->@location(0)vec4f{
  let volume=gunneryVolumes[v.id];let ray=normalize(v.world-F.camPos.xyz);
  let origin=gunneryVolumeLocal(volume,F.camPos.xyz);let direction=gunneryVolumeRay(volume,ray);
  // The density's domain warp stays within this ellipsoid's conservative cube.
  let safe=select(direction,vec3f(.000001),abs(direction)<vec3f(.000001));
  let t0=(-vec3f(1)-origin)/safe;let t1=(vec3f(1)-origin)/safe;
  let low=min(t0,t1);let high=max(t0,t1);
  var enter=max(0.0,max(low.x,max(low.y,low.z)));var leave=min(high.x,min(high.y,high.z));
  // Powder smoke lies wholly within the ellipsoid, so only the chord through that is walked.
  let powder=volume.centre.w<.5&&volume.optical.w<1.0;
  if(powder){
    let a=dot(direction,direction);let b=dot(origin,direction);let h=b*b-a*(dot(origin,origin)-1.0);
    if(h<=0.0){discard;}
    enter=max(enter,(-b-sqrt(h))/a);leave=min(leave,(-b+sqrt(h))/a);
  }
  let scene=gunnerySceneDistance(v.position.xy,ray);
  let centreDist=dot(volume.centre.xyz-F.camPos.xyz,ray);
  let minHorizR=min(volume.axisX.w,volume.axisZ.w);
  // Prevent fires centered inside or behind a building/hull wall from bleeding through the front face of that wall
  if(volume.centre.w>.5 && scene<centreDist-min(0.35,minHorizR*0.28)){discard;}
  let wallFrontFade=select(1.0,smoothstep(centreDist-minHorizR*0.35,centreDist+0.15,scene),volume.centre.w>.5);
  let exit=min(scene,leave);if(exit<=enter||wallFrontFade<=0.005){discard;}
  // Powder smoke is walked in steps of one length whichever way the ellipsoid is crossed: a tenth of the
  // way through its middle near to, a seventh far off. A ray that only clips it takes few.
  let stride=select(.2,.28,enter>90.0)/length(direction);
  let steps=select(select(12u,7u,enter>42.0),clamp(u32(ceil((exit-enter)/stride)),1u,10u),powder);
  let stepSize=select((exit-enter)/f32(steps),stride,powder);var transmittance=1.0;var radiance=vec3f(0);
  // Each pixel starts its walk a different part of a step in, by an ordered scatter that shows little grain:
  // a small part for flame and its smoke, most of a step for powder smoke, whose first look is then set
  // back to the billow's face (below).
  let jitter=select(.42+.16*fract(52.9829189*fract(dot(v.position.xy,vec2f(0.06711056,0.00583715))+volume.optical.z*.13)),
    .15+.7*fract(52.9829189*fract(dot(v.position.xy,vec2f(.06711056,.00583715)))+volume.optical.z*.618),powder);
  let skyZenith=skyAtmo(vec3f(0,1,0));
  let skyHorizon=skyAtmo(normalize(vec3f(F.sunDir.x,.12,F.sunDir.z)));
  let lightning=lightningLight()*.25;
  let sunlight=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);let sunUp=sunlight.x+sunlight.y+sunlight.z>1e-5;
  let sunLocal=gunneryVolumeRay(volume,F.sunDir.xyz);
  let sunLocalDir=normalize(sunLocal+vec3f(0.0,1e-5,0.0));
  let opticalScale=clamp(min(volume.axisX.w,volume.axisY.w)*.35,.32,1.25);
  let cosTheta=dot(ray,F.sunDir.xyz);
  // Dual-lobe Henyey-Greenstein phase function (silver-lining forward scatter + cloud back-scatter).
  let phase=mix(gunneryHgPhase(cosTheta,.66),gunneryHgPhase(cosTheta,-.32),.34)*1.95+.09;
  let age=volume.optical.y;
  let sootFactor=exp(-age*1.15);
  let emberFactor=exp(-age*5.5);
  let selfExposure=min(1.0,1.35/max(F.post.x,1e-3));
  let subtype=volume.optical.w;
  let isShipFlame=volume.centre.w>.5 && subtype>=0.9;
  // Powder smoke: how hard its billows are carved, how broad they are for its size, and where the sky is.
  let erode=fract(volume.optical.w);let smallest=min(volume.axisX.w,min(volume.axisY.w,volume.axisZ.w));
  let grain=vec4f(1.0-smoothstep(2.6,5.6,smallest),smoothstep(5.0,12.0,smallest),log2(max(stepSize,.01))-.2,1.0-smoothstep(1.3,2.6,smallest));let skyLocal=gunneryVolumeRay(volume,vec3f(0.0,1.0,0.0));
  let nearLook=clamp(smallest*.11,.45,1.7);let seaSoft=.28+smallest*.05;
  // Fresh from the gun it is a dirty grey-yellow; within a few seconds it is the white of the bank.
  let powderAlbedo=mix(vec3f(.9,.9,.91),vec3f(.68,.64,.58),exp(-age*.75)*.8);
  // Powder smoke is thick enough that one step into it can be all a pixel shows, and how deep that step fell
  // would show as grain. So where a walk first meets smoke it goes back by halves to find the billow's face,
  // and takes its first look a set short way inside that: found, and how far back it went.
  var found=false;var back=0.0;
  for(var sample=0u;sample<steps;sample++){
    var distance=enter+(f32(sample)+jitter)*stepSize-back;
    var local=origin+direction*distance;
    if(powder){
      var world=F.camPos.xyz+ray*distance;
      var smoke=gunnerySmoke(world,local,erode,grain);
      if(smoke.x<.002){continue;}
      if(!found){
        found=true;var clear=distance-stepSize;var within=distance;
        for(var halving=0u;halving<4u;halving++){
          let middle=(clear+within)*.5;
          if(gunnerySmoke(F.camPos.xyz+ray*middle,origin+direction*middle,erode,grain).x<.002){clear=middle;}else{within=middle;}
        }
        back=distance-(within+stepSize*.35);distance-=back;
        local=origin+direction*distance;world=F.camPos.xyz+ray*distance;smoke=gunnerySmoke(world,local,erode,grain);
      }
      if(distance>=exit){break;}
      let thickness=smoke.x*smoothstep(0.0,seaSoft,scene-distance);
      if(thickness<.002){continue;}
      // Sunlight has come through the billows just sunward of here, then through the rest of the bank. The
      // billows shade one another even in thin smoke, or an old bank would lose its form before its substance.
      var sunLit=0.0;
      if(sunUp){
        let far=nearLook*3.2;
        let sunward=gunnerySmokeMass(world+F.sunDir.xyz*nearLook,local+sunLocal*nearLook,erode,grain);
        // Where the billow next the sun already shades this place, what lies beyond it is taken to be as full.
        var sunwardFar=sunward;
        if(sunward*max(volume.optical.x,.16)*nearLook<1.7){sunwardFar=gunnerySmokeMass(world+F.sunDir.xyz*far,local+sunLocal*far,erode,grain);}
        let beyond=max(0.0,gunneryChord(local,sunLocal)-far);
        let sunDepth=max(volume.optical.x,.16)*(sunward*nearLook*1.5+sunwardFar*(far-nearLook))+volume.optical.x*beyond*max(0.0,1.0-length(local+sunLocal*(far+beyond*.5)))*.5;
        // Thick smoke scatters light many times over: it dims with depth far more slowly than a single pass would.
        sunLit=exp(-sunDepth)*.74+exp(-sunDepth*.18)*.26;
      }
      // The sky lights what is open to it. Deep in the bank, between billows and on its underside there is little.
      let above=gunneryChord(local,skyLocal);
      let skyDepth=volume.optical.x*above*.34*max(0.0,1.0-length(local+skyLocal*above*.5));
      let open=(exp(-skyDepth)*.6+exp(-skyDepth*.2)*.4)*(.5+.5*smoothstep(.1,.75,smoke.y));
      let ambient=(mix(skyHorizon*.4,skyZenith*.84,open)+lightning)*(.22+.78*open);
      let throat=max(0.0,1.0-length(local-vec3f(0.0,-.05,-.28))*1.45);
      let glow=vec3f(2.4,.42,.03)*(emberFactor*throat*throat*thickness)*selfExposure;
      let light=powderAlbedo*(ambient+sunlight*sunLit*phase*.66)+glow;
      let opacity=1.0-exp(-volume.optical.x*thickness*stepSize);
      radiance+=transmittance*opacity*light;transmittance*=1.0-opacity;
      if(transmittance<.03){break;}
      continue;
    }
    let softDepth=smoothstep(0.0,.28,scene-distance)*wallFrontFade;
    if(softDepth<=.001){continue;}
    var emission=vec3f(0);var extinction=0.0;
    if(isShipFlame){
      let boxMax=max(abs(local.x),max(abs(local.y),abs(local.z)));
      let boxGuard=(1.0-smoothstep(.74,1.0,boxMax))*softDepth;
      if(boxGuard<=.002){continue;}
      // Shipboard & fort fire (direction=[0,1,0] -> local.z is vertical in [-1, 1])
      let h=clamp(local.z*0.5+0.5,0.0,1.0);
      let isSparkCrown=subtype>1.4;
      let taper=select(mix(1.0,0.28,h*h),mix(0.65,1.15,h),isSparkCrown);
      let swirl=vec2f(sin(h*5.2-age*7.4+volume.optical.z),cos(h*4.8-age*6.3-volume.optical.z))*0.14*h;
      let rHoriz=length(local.xy-swirl)/max(0.20,taper);
      let advectPos=vec3f(local.x*3.1,local.y*3.1,local.z*2.4-age*5.8)+vec3f(volume.optical.z);
      let fTurb=gunneryCloudFbm(advectPos);
      let fineLick=gunneryNoise3(advectPos*2.6+vec3f(0.0,0.0,-age*4.4));
      let tongueMask=clamp(1.12-rHoriz+(fTurb-0.44)*(0.58+0.62*h)+(fineLick-0.5)*0.34,0.0,1.0);
      let vertEnv=smoothstep(0.0,0.14,h)*(1.0-smoothstep(0.56,1.0,h));
      let flameShape=select(tongueMask*vertEnv,clamp(1.0-rHoriz*0.88,0.0,1.0)*smoothstep(0.0,0.22,h)*(1.0-smoothstep(0.65,1.0,h)),isSparkCrown);
      if(flameShape<0.008){continue;}
      let temp=clamp(flameShape*(1.12-0.46*h)+0.26*fTurb+0.16*fineLick,0.0,1.0);
      let colOuter=vec3f(0.68,0.042,0.004);
      let colMid=vec3f(2.25,0.38,0.024);
      let colInner=vec3f(4.45,1.48,0.18);
      let colWhiteHot=vec3f(6.9,3.8,1.25);
      let c1=mix(colOuter,colMid,smoothstep(0.08,0.52,temp));
      let c2=mix(c1,colInner,smoothstep(0.48,0.84,temp));
      let colCore=mix(c2,colWhiteHot,smoothstep(0.78,0.98,temp)*(1.0-smoothstep(0.0,0.45,h)));
      // Buoyant glowing embers & flying sparks
      let sparkPos=advectPos*4.8+vec3f(sin(age*3.7)*0.8,cos(age*4.1)*0.8,-age*7.2);
      let sparkN1=gunneryNoise3(sparkPos);
      let sparkN2=gunneryNoise3(sparkPos*2.1+vec3f(13.7,7.1,3.9));
      let sparkMask=smoothstep(0.76,0.93,sparkN1)*smoothstep(0.52,0.82,sparkN2);
      let sparks=select(sparkMask*h*1.6,sparkMask*(0.6+1.8*h),subtype>1.1);
      let nightFlameBoost=1.0+0.65*(1.0-smoothstep(-0.08,0.14,F.sunDir.y));
      let flameEmit=select(colCore*flameShape*(1.05-0.25*step(1.15,subtype)),colCore*flameShape*0.28,isSparkCrown);
      emission=(flameEmit+vec3f(3.6,0.92,0.09)*sparks)*clamp(volume.optical.x,0.35,1.35)*selfExposure*nightFlameBoost;
      extinction=boxGuard*select(flameShape*4.8,max(flameShape*1.6,sparks*2.8),isSparkCrown);
    }else{
      let df=gunneryDensityAndFbm(local,age,volume.optical.z,subtype);
      // Soft intersection margin removes hard slices at timber and sea.
      let density=df.x*softDepth;
      if(density<.0015){continue;}
      extinction=volume.optical.x*density;
      if(volume.centre.w>.5){
        let flame=max(0.0,1.0-dot(local,local));
        let coreNoise=.68+.32*df.y;
        emission=mix(vec3f(2.8,0.42,.035),vec3f(6.8,1.95,0.32),flame*flame*coreNoise)*volume.optical.x*selfExposure;
        extinction=density*5.2;
      }else{
        // Intrinsic 3D billow self-shadowing (decoupled from translucent extinction so
        // even airy, see-through smoke wisps retain rich 3D tonal relief and shaded folds).
        let d1=gunneryShadowDensity(local+sunLocalDir*.24,age,volume.optical.z,df.y);
        let d2=gunneryShadowDensity(local+sunLocalDir*.56,age,volume.optical.z,df.y);
        let billowRelief=smoothstep(.40,.88,df.y);
        let foldCrevice=1.0-billowRelief;
        let shadowDepth=(d1*.85+d2*1.35+foldCrevice*.95)*1.75;
        let beer=exp(-shadowDepth*1.18);
        let multiScatter=exp(-shadowDepth*.34)*.34;
        let powder=1.0-.64*exp(-shadowDepth*2.8);
        let directTransfer=(beer*powder+multiScatter)*phase;
        let isFireSmoke=subtype>=1.8;
        let heightGrad=clamp(select(local.y,local.z,isFireSmoke)*.5+.5,0.0,1.0);
        let radialRim=clamp(length(local)*1.08,0.0,1.0);
        let creviceAO=mix(.34,1.0,billowRelief);
        let ambientOcclusion=mix(.32,1.0,clamp(heightGrad*.64+radialRim*.36,0.0,1.0))*creviceAO;
        let ambient=(mix(skyHorizon*.36,skyZenith*.72,heightGrad)+lightning)*ambientOcclusion;
        // Black powder smoke transitions from warm charcoal-slate soot at discharge to
        // sculpted silver-gray and warm sunlit cumulus wisps with deep slate-blue folds.
        let effSoot=select(sootFactor,0.96,isFireSmoke);
        let shadowTint=select(
          mix(vec3f(.34,.39,.47),vec3f(.19,.18,.18),effSoot*.82),
          vec3f(.055,.052,.054),
          isFireSmoke
        );
        let litTint=select(
          mix(vec3f(.95,.93,.89),vec3f(.54,.50,.46),effSoot*.65),
          vec3f(.24,.22,.21),
          isFireSmoke
        );
        let shadeMix=clamp(beer*.62+billowRelief*.46-.06,0.0,1.0);
        let cloudAlbedo=mix(shadowTint,litTint,shadeMix);
        let throatCore=max(0.0,1.0-length(local-vec3f(0.0,-.05,-.28))*1.45);
        let fireUnderGlow=select(
          0.0,
          (1.0-smoothstep(0.0,0.34,heightGrad))*max(0.0,1.0-length(local.xy)*1.12)*max(0.0,2.28-subtype)*0.45,
          isFireSmoke
        );
        let internalEmber=(vec3f(2.4,0.42,.03)*(emberFactor*throatCore*throatCore*density)+vec3f(0.95,0.18,0.015)*fireUnderGlow)*selfExposure;
        emission=cloudAlbedo*(ambient+sunlight*directTransfer)+internalEmber;
      }
    }
    let opacity=1.0-exp(-extinction*stepSize);
    radiance+=transmittance*opacity*emission;transmittance*=1.0-opacity;
    if(transmittance<.06){break;}
  }
  let rawAlpha=1.0-transmittance;if(rawAlpha<.002){discard;}
  // Flame and powder smoke are as opaque as the walk found them. A fire's smoke is a dense, towering soot
  // column under a smooth ceiling that lets a little through, more the higher the parcel has risen.
  let isFireSmokeVol=volume.centre.w<.5 && subtype>=1.8;
  let fireVeilCap=mix(.97,.82,clamp((subtype-2.0)/0.8,0.0,1.0));
  let alpha=select(rawAlpha,fireVeilCap*(1.0-exp(-rawAlpha*2.45/fireVeilCap)),isFireSmokeVol);
  let averageWorld=F.camPos.xyz+ray*(enter+exit)*.5;
  return vec4f(surfaceAir(radiance/max(rawAlpha,.0001),averageWorld)*alpha,alpha);
}

struct GunneryBallVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)normal:vec3f,@location(2)hot:f32};
@vertex fn gunneryBallVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryBallVertex{
  let ball=gunneryBalls[id].positionRadius;let cell=vertex/6u;let uv=gunneryCorner(vertex);
  let longitude=(f32(cell%12u)+uv.x)*(2.0*PI)/12.0;let latitude=(f32(cell/12u)+uv.y)*PI/8.0;
  let r=abs(ball.w);let isHot=select(0.0,1.0,ball.w<0.0);
  let normal=vec3f(cos(longitude)*sin(latitude),cos(latitude),sin(longitude)*sin(latitude));let world=ball.xyz+normal*r;
  return GunneryBallVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,normal,isHot);
}
@fragment fn gunneryBallFS(v:GunneryBallVertex)->@location(0)vec4f{
  let n=normalize(v.normal);let eye=normalize(F.camPos.xyz-v.world);
  if(v.hot>0.5){
    let core=clamp(dot(n,eye),0.0,1.0);
    let hotGlow=mix(vec3f(1.6,0.25,0.025),vec3f(3.8,0.95,0.12),core*core)*min(1.0,1.35/max(F.post.x,1e-3));
    return vec4f(surfaceAir(hotGlow,v.world),1);
  }
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),8.0).rgb;let sea=textureSampleLevel(envCube,sampC,vec3f(0,-.4,1),8.0).rgb;
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);let nl=max(0.0,dot(n,F.sunDir.xyz));
  let albedo=vec3f(.038,.034,.029);let light=albedo*(vesselAmbient(n,sky,sea)+direct*nl/PI)+vesselSpecular(n,eye,F.sunDir.xyz,.62,vec3f(.045))*direct*nl;
  return vec4f(surfaceAir(light+lightningSurface(n,eye,albedo,.62),v.world),1);
}

fn gunnerySeaDisplacement(q:vec2f)->vec3f{
  var d=vec3f(0);for(var c=0u;c<${CASCADES}u;c++){d+=textureSampleLevel(gunnerySea,gunnerySeaSampler,q*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;}return d;
}
fn gunnerySeaHeight(p:vec2f)->f32{var q=p;for(var i=0u;i<2u;i++){q=p-gunnerySeaDisplacement(q).xz;}return gunnerySeaDisplacement(q).y;}
fn gunneryContactHeading(c:GunneryContact)->vec2f{let horizontal=c.motion.xz;return normalize(horizontal+vec2f(.00001));}
fn gunneryImpactLift(c:GunneryContact)->f32{return clamp(3.0+abs(c.motion.y)*.14+length(c.motion.xyz)*.010,3.8,7.8)*sqrt(c.motion.w);}
fn gunneryImpactRadial(c:GunneryContact)->f32{return clamp(1.2+length(c.motion.xyz)*.008,1.4,3.4)*sqrt(c.motion.w);}
fn gunneryEarthAlbedo(c:GunneryContact)->vec3f{return mix(vec3f(.12,.08,.052),vec3f(.3,.235,.16),c.extra.z);}
fn gunneryWaterRadiance(world:vec3f,normal:vec3f,foam:f32)->vec3f{
  let eye=normalize(F.camPos.xyz-world);var n=normalize(normal);if(dot(n,eye)<0.0){n=-n;}
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),1.2).rgb;
  let nightFloor=vec3f(0.012,0.018,0.028)*min(1.0,1.2/max(F.post.x,1e-3))*(1.0-smoothstep(-0.08,0.12,F.sunDir.y));
  var fireGlow=vec3f(0.0);
  if(F.cascInvL[1].z>1e-5){
    let fPos=vec3f(F.camRight.w,F.camUp.w,F.camFwd.w);
    let fd0=max(1.2,length(fPos-world));
    fireGlow+=vec3f(1.0,0.38,0.07)*(F.cascInvL[1].z*12.0/(4.0+fd0*fd0*0.25));
  }
  let diffuse=skyAtmo(vec3f(0,1,0))*.72+direct*max(F.sunDir.y,.10)*.28+lightningLight()*.3+nightFloor+fireGlow;
  let glint=vesselSpecular(n,eye,F.sunDir.xyz,.16,vec3f(.0204))*direct*max(0.0,dot(n,F.sunDir.xyz));
  return mix(reflected*.88+glint+fireGlow*0.35,diffuse*1.12,foam);
}
struct GunneryWaterVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)uv:vec2f,@location(2)@interpolate(flat)id:u32};
// The initial crown combines an outer tulip splash rim and a tall central Worthington
// water column launched from the impact cavity.
@vertex fn gunneryCrownVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let age=gunneryAge(c.root.w);let uv=gunneryCorner(vertex);let cell=vertex/6u;
  // Ground goes up in pieces, not in a sheet.
  if(c.extra.y>0.0){return GunneryWaterVertex(vec4f(0.0,0.0,-1.0,1.0),vec3f(0.0),vec2f(0.0),id);}
  let angle=(f32(cell%${GUNNERY_CROWN_SEGMENTS}u)+uv.x)*(2.0*PI)/${GUNNERY_CROWN_SEGMENTS}.0;
  let row=(f32(cell/${GUNNERY_CROWN_SEGMENTS}u)+uv.y)/${GUNNERY_CROWN_ROWS}.0;
  let lift=gunneryImpactLift(c);let radial=gunneryImpactRadial(c);let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let lobe=.86+.09*sin(angle*5.0+c.detail.x*70.0)+.05*sin(angle*11.0-c.detail.x*43.0);
  let radius=(.12+radial*age*(0.18+0.42*pow(row,1.25)))*c.motion.w;
  let drift=heading*min(8.0,length(c.motion.xz)*.018)*age;
  let horizontal=side*cos(angle)*radius+heading*sin(angle)*radius*1.12+drift*row;
  let rise=max(0.0,lift*age-4.905*age*age)*pow(max(0.02,row),0.82)*lobe;
  let baseY=select(gunnerySeaHeight(c.root.xz+horizontal),c.root.y,c.extra.x>.5);
  let world=vec3f(c.root.x+horizontal.x,baseY+.02+rise,c.root.z+horizontal.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(angle,row),id);
}
@fragment fn gunneryCrownFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let age=gunneryAge(c.root.w);let life=min(1.45,gunneryImpactLift(c)/4.905);
  if(age>=life||age<=0.0){discard;}
  let kind=c.extra.x;
  let nVal=gunneryCloudFbm(v.world*1.65+vec3f(c.detail.x*13.0,-age*4.2,c.detail.x*29.0));
  let topFade=1.0-smoothstep(0.48,0.96,v.uv.y+0.24*(1.0-nVal));
  let botFade=smoothstep(0.0,0.18,v.uv.y);
  let lifeFade=smoothstep(0.0,.03,age)*(1.0-smoothstep(life*.45,life,age));
  let spray=smoothstep(0.26,0.78,nVal+0.22*(1.0-v.uv.y));
  let foam=clamp(.52+0.38*spray,0.0,1.0);
  let baseAlpha=topFade*botFade*spray*lifeFade*0.64;
  let alpha=select(min(0.76,baseAlpha),min(0.95,baseAlpha*1.35),kind>.5);
  if(alpha<.002){discard;}
  let n=normalize(vec3f(v.world.x-c.root.x,max(0.35,0.65*c.motion.w),v.world.z-c.root.z));
  let waterRad=gunneryWaterRadiance(v.world,n,foam);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let ambient=skyAtmo(vec3f(0,1,0))*.6+direct*max(F.sunDir.y,.08)*.25+lightningLight()*.25;
  let solidAlbedo=select(select(vec3f(.46,.33,.20),vec3f(.52,.44,.32),kind>1.5),vec3f(.68,.62,.54),kind>2.5);
  let rad=select(waterRad,solidAlbedo*ambient,kind>.5);
  return vec4f(surfaceAir(rad,v.world)*alpha,alpha);
}
@vertex fn gunneryDropVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryWaterVertex{
  let id=instance/${GUNNERY_DROP_COUNT}u;let c=gunneryContacts[id];let drop=f32(instance%${GUNNERY_DROP_COUNT}u);let age=gunneryAge(c.root.w);
  let random=fract(sin(drop*17.137+c.detail.x*73.0)*437.1);let angle=drop*2.399963+c.detail.x*63.0;
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);let radial=gunneryImpactRadial(c)*(.6+random*.55);
  let across=side*cos(angle)*radial+heading*sin(angle)*radial+heading*min(12.0,length(c.motion.xz)*.025);
  let launch=vec3f(across.x,gunneryImpactLift(c)*(.65+random*.4),across.y);
  // Analytic aerodynamic drift grows gradually; gravity remains 9.81 m/s².
  let wind=gunneryWind()*(age-.7*(1.0-exp(-age/.7)))*.16;
  let world=c.root.xyz+launch*age+vec3f(0,.04-4.905*age*age,0)+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;
  let kindBoost=select(1.45,2.15,c.extra.x>.5);
  // Thrown earth flies as the clods below.
  let radius=(.018+random*.036)*c.motion.w*kindBoost*select(1.0,0.0,c.extra.y>0.0);
  let eye=normalize(F.camPos.xyz-world);let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);
  let surface=world+(right*corner.x+up*corner.y)*radius;
  return GunneryWaterVertex(F.viewProj*vec4f(surface-F.camPos.xyz,1),surface,corner,id);
}
@fragment fn gunneryDropFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let radius=dot(v.uv,v.uv);
  let minHeight=c.root.y-select(0.0,6.5,c.extra.x>.5);
  if(radius>=1.0||gunneryAge(c.root.w)>3.4||v.world.y<minHeight){discard;}
  let eye=normalize(F.camPos.xyz-v.world);let n=normalize(normalize(F.camRight.xyz)*v.uv.x+normalize(F.camUp.xyz)*v.uv.y+eye*sqrt(max(.001,1.0-radius)));
  let alpha=(1.0-smoothstep(.3,1.0,radius))*.78;
  let kind=c.extra.x;
  let waterRad=gunneryWaterRadiance(v.world,n,.72);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let ambient=skyAtmo(vec3f(0,1,0))*.55+direct*max(dot(n,F.sunDir.xyz),.12)*.32+lightningLight()*.25;
  let fragAlbedo=select(select(vec3f(.38,.24,.12),vec3f(.44,.36,.25),kind>1.5),vec3f(.64,.42,.28),kind>2.5);
  let rad=select(waterRad,fragAlbedo*ambient,kind>.5);
  return vec4f(surfaceAir(rad,v.world)*alpha,alpha);
}
// Earth thrown by a strike on the ground OR 420 ballistic whitewater spray jets & droplets on water impacts.
@vertex fn gunneryEarthVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryWaterVertex{
  let id=instance/${GUNNERY_EARTH_COUNT}u;let c=gunneryContacts[id];let age=gunneryAge(c.root.w);
  var o=GunneryWaterVertex(vec4f(0.0,0.0,-1.0,1.0),vec3f(0.0),vec2f(0.0),id);
  let isWater=c.extra.x<.5;
  let pit=select(c.extra.y,max(0.85,c.motion.w*1.55),isWater);
  if(pit<=0.0){return o;}
  let n=f32(instance%${GUNNERY_EARTH_COUNT}u);
  let r1=fract(sin(n*12.9898+c.detail.x*78.233)*43758.5453);
  let r2=fract(sin(n*39.3461+c.detail.x*11.135)*24634.6345);
  let r3=fract(sin(n*73.1563+c.detail.x*51.721)*17431.1953);
  let r4=fract(sin(n*91.2271+c.detail.x*29.417)*31158.8231);
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let flatness=1.0-abs(c.motion.y)/max(length(c.motion.xyz),.001);
  let start=mix(.16,1.0,sqrt(r1));
  let speed=select(
    sqrt(9.81*pit)*1.05*pow(start,-.95)*(.65+r2*.7),
    gunneryImpactLift(c)*mix(0.48,1.38,pow(1.0-r1,0.55))*(0.68+r2*0.58),
    isWater
  );
  let turn=n*2.399963+c.detail.x*63.0;
  let fwdBias=select(flatness*.75,flatness*0.65*smoothstep(0.35,0.95,r1),isWater);
  let outward=normalize(side*cos(turn)+heading*(sin(turn)+fwdBias)+vec2f(.0001));
  let elevation=select(mix(.8,1.3,r3),mix(0.88,1.48,mix(r3,1.0-r1*0.65,0.55)),isWater);
  let up=sin(elevation)*speed;let along=cos(elevation)*speed;
  let flight=2.0*up/9.81;
  if(age<=0.0||age>=flight+.08){return o;}
  let rise=up*age-4.905*age*age;
  let wind=gunneryWind()*(age-.7*(1.0-exp(-age/.7)))*select(.05,.14,isWater);
  let radStart=select(start*pit*.55,start*0.35*c.motion.w,isWater);
  let centre=c.root.xyz+vec3f(outward.x*(radStart+along*age),rise,outward.y*(radStart+along*age))+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;
  let spin=age*(2.0+r2*9.0)+r1*6.28;
  let turned=vec2f(corner.x*cos(spin)-corner.y*sin(spin),corner.x*sin(spin)+corner.y*cos(spin));
  let size=select(
    mix(.022,.13,r4*r4*r4)*sqrt(pit/1.2),
    mix(.038,.165,r4*r4)*sqrt(c.motion.w)*(1.0+0.35*sin(age/max(flight,0.1)*PI)),
    isWater
  );
  let isWood=c.extra.x>.5 && c.extra.x<1.5;
  let stretchY=select(select(1.0,2.35,isWood),1.45,isWater);
  let world=centre+(normalize(F.camRight.xyz)*turned.x+normalize(F.camUp.xyz)*turned.y*stretchY)*size;
  o.position=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  o.world=world;
  o.uv=corner;
  return o;
}
@fragment fn gunneryEarthFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];
  let along=atan2(v.uv.y,v.uv.x);
  let edge=.72+.14*sin(along*3.0+v.world.x*40.0)+.1*sin(along*5.0-v.world.z*50.0);
  let radius=length(v.uv)/edge;if(radius>=1.0){discard;}
  let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);let eye=normalize(F.camPos.xyz-v.world);
  let n=normalize(right*v.uv.x+up*v.uv.y+eye*sqrt(max(.04,1.0-radius*radius)));
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  if(c.extra.x<.5){
    if(v.world.y<c.root.y-0.15){discard;}
    let wAlpha=(1.0-smoothstep(0.25,1.0,radius))*0.82;
    let wLit=skyAtmo(vec3f(0,1,0))*.85+direct*(.32+.68*max(dot(n,F.sunDir.xyz),.0))/PI+lightningLight()*.3;
    return vec4f(surfaceAir(vec3f(.94,.97,1.0)*wLit,v.world)*wAlpha,wAlpha);
  }
  let lit=skyAtmo(vec3f(0,1,0))*.6+direct*max(dot(n,F.sunDir.xyz),.0)/PI+lightningLight()*.25;
  let fragVar=fract(sin(v.world.x*19.3+v.world.z*31.7+c.detail.x*53.0)*437.5);
  let woodAlbedo=mix(vec3f(.26,.17,.085),vec3f(.54,.39,.22),fragVar);
  let stoneAlbedo=mix(vec3f(.56,.51,.43),vec3f(.62,.33,.21),step(.74,fragVar));
  let solidAlbedo=select(select(woodAlbedo,gunneryEarthAlbedo(c),c.extra.x>1.5),stoneAlbedo,c.extra.x>2.5);
  return vec4f(surfaceAir(solidAlbedo*lit,v.world),1.0);
}
// The dust that goes up with a ground strike OR rising sea-spray mist & churning whitewater boil on water impacts.
struct GunneryDustVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)uv:vec2f,@location(2)@interpolate(flat)id:u32,@location(3)@interpolate(flat)alpha:f32,@location(4)@interpolate(flat)seed:f32};
@vertex fn gunneryDustVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryDustVertex{
  let id=instance/${GUNNERY_DUST_COUNT}u;let c=gunneryContacts[id];let age=gunneryAge(c.root.w);
  var o=GunneryDustVertex(vec4f(0.0,0.0,-1.0,1.0),vec3f(0.0),vec2f(0.0),id,0.0,0.0);
  let isWater=c.extra.x<.5;
  let pit=select(c.extra.y,max(1.0,c.motion.w*1.65),isWater);
  if(pit<=0.0||age<=0.0){return o;}
  let n=f32(instance%${GUNNERY_DUST_COUNT}u);
  let r1=fract(sin(n*14.1731+c.detail.x*61.37)*43758.5453);
  let r2=fract(sin(n*47.2389+c.detail.x*23.91)*24634.6345);
  let r3=fract(sin(n*83.6127+c.detail.x*47.53)*17431.1953);
  let r4=fract(sin(n*29.8153+c.detail.x*91.27)*31158.8231);
  let decayTau=select(.65+r4*1.15,.65+r4*.85,isWater);
  let baseOp=select(.21,.15,isWater);
  o.alpha=baseOp*smoothstep(0.0,.04,age)*exp(-age/decayTau);
  if(o.alpha<.003){return o;}
  let size=pit/1.2;
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let flatness=1.0-abs(c.motion.y)/max(length(c.motion.xyz),.001);
  let turn=n*2.399963+c.detail.x*29.0;
  let outward=normalize(side*cos(turn)+heading*(sin(turn)+flatness*.6)+vec2f(.0001));
  let flung=1.0-exp(-age/.42);
  let isSurfaceBoil=isWater&&n<14.0;
  let far=select(mix(.8,7.5,r1*r1)*size*.42*flung,mix(0.22,2.6,r1)*size*0.48*flung,isSurfaceBoil);
  let high=select(
    mix(.5,8.0,r2*r2*r2)*size*.6*flung+.12*age,
    select((0.4+3.6*pow(r2,1.6))*size*flung*(1.0-0.35*smoothstep(0.7,2.0,age)),0.06+0.20*r2,isSurfaceBoil),
    isWater
  );
  let wind=gunneryWind()*(age-.7*(1.0-exp(-age/.7)))*.22;
  let radius=select((.22+.95*sqrt(age)*(.55+r3*.8))*size,(.28+.85*sqrt(age)*(.55+r3*.65))*size,isWater);
  let centre=vec3f(c.root.x+outward.x*far,c.root.y+high+radius*select(.35,.18,isSurfaceBoil),c.root.z+outward.y*far)+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;
  let world=centre+(normalize(F.camRight.xyz)*corner.x+normalize(F.camUp.xyz)*corner.y)*radius;
  o.position=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  o.world=world;o.uv=corner;o.seed=r3*37.0+n;
  return o;
}
@fragment fn gunneryDustFS(v:GunneryDustVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];
  let d=dot(v.uv,v.uv);if(d>=1.0){discard;}
  let wisps=.62+.5*gnoise(v.uv*1.7+v.seed)+.28*gnoise(v.uv*4.1-v.seed);
  let alpha=clamp(v.alpha*(1.0-d)*(1.0-d)*wisps*2.0,0.0,1.0);
  if(alpha<.002){discard;}
  let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);let eye=normalize(F.camPos.xyz-v.world);
  let n=normalize(right*v.uv.x+up*v.uv.y+eye*sqrt(max(.05,1.0-d)));
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let lit=skyAtmo(vec3f(0,1,0))*.7+direct*(.35+.65*max(dot(n,F.sunDir.xyz),0.0))/PI+lightningLight()*.25;
  if(c.extra.x<.5){
    return vec4f(surfaceAir(vec3f(.92,.96,1.0)*lit*1.22,v.world)*alpha,alpha);
  }
  let earthDust=mix(vec3f(.3,.235,.17),vec3f(.62,.53,.4),c.extra.z);
  let dustColor=select(select(vec3f(.46,.36,.24),earthDust,c.extra.x>1.5),vec3f(.66,.60,.52),c.extra.x>2.5);
  return vec4f(surfaceAir(dustColor*lit,v.world)*alpha,alpha);
}
@vertex fn gunneryRingVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let ring=vertex/(${GUNNERY_RING_SEGMENTS}u*6u);let uv=gunneryCorner(vertex);let segment=(vertex/6u)%${GUNNERY_RING_SEGMENTS}u;
  let age=gunneryAge(c.root.w)-f32(ring)*.24;let angle=(f32(segment)+uv.x)*(2.0*PI)/${GUNNERY_RING_SEGMENTS}.0;
  let crossSection=uv.y*2.0-1.0;
  let waveSpeed=(3.2-f32(ring)*.22)*sqrt(max(0.5,c.motion.w));
  let bandHalfWidth=.44+max(0.0,age)*.16;
  let wobble=(sin(angle*5.0+c.detail.x*37.0+f32(ring)*1.9)*.14+cos(angle*11.0-c.detail.x*23.0+max(0.0,age)*2.2)*.08)*(.35+.65*clamp(age,0.0,1.0));
  let radius=(.26+max(0.0,age)*waveSpeed)*(1.0+wobble)+crossSection*bandHalfWidth;
  let q=c.root.xz+vec2f(cos(angle),sin(angle))*radius;
  let waveProfile=cos(crossSection*1.5707963);
  let crest=waveProfile*(.26+.18*exp(-max(0.0,age)*1.1))*c.motion.w*exp(-max(0.0,age)*.45)*exp(-f32(ring)*.28)*step(0.0,age);
  let world=vec3f(q.x,gunnerySeaHeight(q)+.024+crest,q.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(crossSection,angle),id*${GUNNERY_RING_COUNT}u+ring);
}
@fragment fn gunneryRingFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id/${GUNNERY_RING_COUNT}u];if(c.extra.x>.5){discard;}
  let ring=v.id%${GUNNERY_RING_COUNT}u;let age=gunneryAge(c.root.w)-f32(ring)*.24;if(age<=0.0||age>=6.5){discard;}
  let edge=pow(max(0.0,1.0-abs(v.uv.x)),1.65);
  let nVal=gunneryCloudFbm(vec3f(cos(v.uv.y)*2.4+v.world.x*.35,sin(v.uv.y)*2.4+v.world.z*.35,age*.85+f32(ring)*1.7+c.detail.x*19.0));
  let ringFade=exp(-f32(ring)*.52);
  let broken=smoothstep(0.22+0.26*(1.0-ringFade),0.78,nVal);
  let crestFoam=clamp(exp(-age*.55)*ringFade*.88+.14*broken,0.12,0.92);
  let alpha=edge*broken*ringFade*exp(-age*.48)*smoothstep(0.0,.06,age)*(1.0-smoothstep(4.5,6.5,age))*.54;
  if(alpha<.002){discard;}
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  return vec4f(surfaceAir(gunneryWaterRadiance(v.world,n,crestFoam),v.world)*alpha,alpha);
}
struct GunneryArcVertex{
  @builtin(position)position:vec4f,
  @location(0)world:vec3f,
  @location(1)uv:vec2f,
  @location(2)@interpolate(flat)id:u32
};
@vertex fn gunneryArcVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryArcVertex{
  let seg=gunneryArcs[id];
  let corner=gunneryCorner(vertex);
  let isRing=seg.style.w>.5;
  if(isRing){
    // Surface-aligned impact ring quad centered at p0.xyz, normal in p1.xyz, outer radius in p0.w
    let center=seg.p0.xyz;
    let radius=max(.25,seg.p0.w);
    let n=normalize(seg.p1.xyz+vec3f(0.0,1e-5,0.0));
    let helper=select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(n.y)>.92);
    let tangent=normalize(cross(helper,n));
    let bitangent=cross(n,tangent);
    let localUV=corner*2.0-1.0;
    let world=center+(tangent*localUV.x+bitangent*localUV.y)*radius+n*.06;
    return GunneryArcVertex(F.viewProj*vec4f(world-F.camPos.xyz,1.0),world,localUV,id);
  }
  // 3D aerial trajectory ribbon segment from p0.xyz to p1.xyz
  let p=mix(seg.p0.xyz,seg.p1.xyz,corner.x);
  let dir=normalize(seg.p1.xyz-seg.p0.xyz+vec3f(0.0,1e-5,0.0));
  let toCam=normalize(F.camPos.xyz-p);
  var side=cross(dir,toCam);
  let sideLen=length(side);
  if(sideLen<1e-4){side=vec3f(0.0,1.0,0.0);}else{side/=sideLen;}
  let camDist=length(F.camPos.xyz-p);
  let halfWidth=max(seg.p0.w,.0022*camDist);
  let across=(corner.y*2.0-1.0);
  let world=p+side*across*halfWidth;
  let u=mix(seg.p1.w,seg.style.x,corner.x);
  return GunneryArcVertex(F.viewProj*vec4f(world-F.camPos.xyz,1.0),world,vec2f(u,across),id);
}
@fragment fn gunneryArcFS(v:GunneryArcVertex)->@location(0)vec4f{
  let seg=gunneryArcs[v.id];
  let kind=seg.style.z;
  let baseAlpha=seg.style.y;
  let isRing=seg.style.w>.5;
  // Color palette by predicted target zone:
  // 0 = water (warm gold), 1 = ship hull (emerald green), 2 = rigging/sails (bright cyan),
  // 3 = land/fort (fiery orange-red), 4 = live instantaneous roll arc (ice blue)
  var tint=vec3f(1.0,.78,.24);
  if(kind>.5&&kind<1.5){tint=vec3f(.22,1.0,.52);}
  else if(kind>=1.5&&kind<2.5){tint=vec3f(.24,.88,1.0);}
  else if(kind>=2.5&&kind<3.5){tint=vec3f(1.0,.42,.18);}
  else if(kind>=3.5){tint=vec3f(.55,.78,1.0);}
  let sunScale=.85+.25*sunVis[0];
  // They are a guide, not a lamp. Night exposure runs thousands of times higher than day's, so undo it, and keep
  // well under what would dazzle eyes used to the dark, whichever way the night was reached.
  let night=1.0-smoothstep(-.06,.16,F.sunDir.y);
  let glow=tint*(2.4*sunScale+.6*max(0.0,F.sunDir.y))*min(1.0,1.35/max(F.post.x,1e-3))*mix(1.0,.1,night);
  if(isRing){
    let r=length(v.uv);
    if(r>1.0){discard;}
    let outerRing=exp(-pow((r-.84)/.075,2.0));
    let innerRing=exp(-pow((r-.38)/.065,2.0))*.72;
    let centerDot=exp(-pow(r/.11,2.0))*.85;
    let crossHair=exp(-pow(min(abs(v.uv.x),abs(v.uv.y))/.035,2.0))*smoothstep(.18,.82,r)*step(r,.92)*.48;
    let pulse=.82+.18*sin(F.camPos.w*4.2-r*6.28318);
    let alpha=clamp((outerRing+innerRing+centerDot+crossHair)*baseAlpha*pulse,0.0,1.0);
    if(alpha<.004){discard;}
    return vec4f(surfaceAir(glow,v.world)*alpha,alpha);
  }
  let edge=1.0-smoothstep(.25,1.0,abs(v.uv.y));
  let u=v.uv.x;
  // Animated directional dashes flowing from muzzle to target + solid core filament
  let flow=fract(u*14.0-F.camPos.w*1.65);
  let dash=.38+.62*smoothstep(.15,.55,flow)*(1.0-smoothstep(.78,.96,flow));
  let endFade=smoothstep(0.0,.03,u)*(1.0-smoothstep(.94,1.0,u)*.35);
  let alpha=clamp(edge*dash*endFade*baseAlpha,0.0,1.0);
  if(alpha<.003){discard;}
  return vec4f(surfaceAir(glow,v.world)*alpha,alpha);
}
`;
