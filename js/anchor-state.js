import { boatForwardSpeed, boatRotate, KNOT_TO_MPS } from './boat.js';
import { ISLAND } from './terrain-model.js';
import { resolveShipNode } from './ship-models.js';

export const FATHOM_METRES = 1.8288;
// Gameplay equipment assumptions, not measurements of a particular replica.
export const ANCHOR_LIMITS = Object.freeze({maxDepth:35,maxRode:200,scope:5,maxDropKnots:1.5,
  payRate:3,weighRate:.75,maxCoastDistance:2500,anchorMass:240,renderScale:1,rodeRadius:.031,maxStiffness:16000});
// Authored first-rate equipment assumptions, not a measured holding-power
// curve or a claim that the surviving ship carries this exact bower anchor.
export const VICTORY_ANCHOR_LIMITS=Object.freeze({...ANCHOR_LIMITS,anchorMass:4000,renderScale:3.1,
  rodeRadius:.08,maxRode:260,payRate:2.4,weighRate:.4,maxStiffness:90000});
export const anchorEquipment=boat=>boat.modelId==='victory'?VICTORY_ANCHOR_LIMITS:ANCHOR_LIMITS;
export const anchorEyeOffset=boat=>.65*anchorEquipment(boat).renderScale;
const anchorLandmarks = new WeakMap();
const anchorFinite = (n,fallback=0)=>Number.isFinite(n)?n:fallback;
export const metresToFathoms = metres=>metres/FATHOM_METRES;

// Port bow cathead/fairlead, just outside the sheer. All dimensions in metres.
export function anchorFairlead(boat) {
  const p=resolveShipNode(boat,'anchor.port.fairlead'),out=[0,0,0];
  boatRotate(out,p[0],p[1],p[2],
    (boat.heading??0)*Math.PI/180,boat.pitch??0,boat.roll??0);
  return {x:(boat.x??0)+out[0],y:(boat.heave??0)+out[1],z:(boat.z??0)+out[2]};
}
function anchorHousedPosition(boat) {
  const p=anchorFairlead(boat),offset=[0,0,0];
  boatRotate(offset,0,-anchorEyeOffset(boat),0,(boat.heading??0)*Math.PI/180,boat.pitch??0,boat.roll??0);
  return {x:p.x+offset[0],y:p.y+offset[1],z:p.z+offset[2]};
}

function anchorTerrainPoints(terrain) {
  if(anchorLandmarks.has(terrain))return anchorLandmarks.get(terrain);
  const points=[];
  for(let j=0;j<=64;j++)for(let i=0;i<=64;i++){
    const x=ISLAND.x+(i/64-.5)*ISLAND.span,z=ISLAND.z+(j/64-.5)*ISLAND.span,y=terrain.height(x,z);
    if(y>1)points.push({x,y,z});
  }
  anchorLandmarks.set(terrain,points);return points;
}

export function anchorLandVisible(boat,{terrain,settings={},eye}={}) {
  if(!terrain?.height)return false;
  const from=eye??{x:boat.x,y:(boat.heave??0)+(boat.eye??5),z:boat.z};
  const haze=Math.max(.5,anchorFinite(settings.haze,3)),rain=Math.max(0,Math.min(1,anchorFinite(settings.rain)));
  // Matches surfaceAir's near-sea marine/rain extinction. This is a conservative
  // CPU visibility proxy; it does not claim to read the cloud raymarch pixels.
  const extinction=Math.max((13.558e-3+4.4e-3*haze)*1e-3,1.1e-4*Math.max(.2,Math.min(3,haze/3)))+rain*.0025;
  const cloudBase=Math.max(0,anchorFinite(settings.cloudBase,1.5))*1000;
  for(const p of anchorTerrainPoints(terrain)){
    const distance=Math.hypot(p.x-from.x,p.z-from.z);
    if(distance>ANCHOR_LIMITS.maxCoastDistance||Math.exp(-extinction*distance)<.04)continue;
    const top=settings.clouds>.65?Math.min(p.y,cloudBase):p.y;
    const curvature=distance*distance/(2*6371000);
    if(top+Math.max(0,from.y)-curvature>2)return true;
  }
  return false;
}

export function anchorEligibility(boat,environment={}) {
  const {terrain}=environment,point=anchorFairlead(boat),limits=anchorEquipment(boat);
  const result={allowed:false,reason:'No coastal sounding available',depth:null,depthFathoms:null,
    source:'Simulated coastal sounding',point,bed:null};
  if(!terrain?.height)return result;
  if(Math.abs(point.x-ISLAND.x)>=ISLAND.span/2||Math.abs(point.z-ISLAND.z)>=ISLAND.span/2)return result;
  const bed=terrain.height(point.x,point.z),depth=-bed;
  if(!Number.isFinite(bed))return result;
  result.bed=bed;result.depth=depth;result.depthFathoms=metresToFathoms(depth);
  if(depth<Math.max(3,(boat.hydrodynamics?.draft??2)+1)){result.reason='Too shallow for safe anchoring';return result;}
  if(depth>limits.maxDepth||(depth+Math.max(1,point.y))*limits.scope>limits.maxRode){
    result.reason=`Too deep: anchor limit ${limits.maxDepth} m`;return result;
  }
  if(!anchorLandVisible(boat,environment)){result.reason='Land must be visible to anchor';return result;}
  if(Math.hypot(boatForwardSpeed(boat),boat.leewayVelocity??0)>limits.maxDropKnots*KNOT_TO_MPS){
    result.reason=`Slow below ${limits.maxDropKnots} knots to drop anchor`;return result;
  }
  result.allowed=true;result.reason='Ready to drop anchor';return result;
}

// Elastic hemp rode and seabed friction. A slack rode cannot push; tension is
// a force through hull inertia, never a position/heading lock. Excess tension
// drags the anchor instead of giving it infinite holding strength.
export function anchorTetherForce(state,boat,point) {
  if(!state.embedded||!['setting','anchored','weighing'].includes(state.phase))return {x:0,z:0,yaw:0,tension:0};
  const p=point??anchorFairlead(boat),dx=state.position.x-p.x,dz=state.position.z-p.z,limits=anchorEquipment(boat);
  const horizontal=Math.hypot(dx,dz),vertical=Math.max(0,p.y-state.position.y-anchorEyeOffset(boat)),distance=Math.hypot(horizontal,vertical);
  const stretch=Math.max(0,distance-state.rode*.97);
  if(stretch<=0||horizontal<1e-6)return {x:0,z:0,yaw:0,tension:0};
  const heading=(boat.heading??0)*Math.PI/180,forward=boatForwardSpeed(boat),side=boat.leewayVelocity??0;
  const rx=p.x-boat.x,rz=p.z-boat.z,yawRate=boat.yawRate??0;
  const vx=Math.sin(heading)*forward+Math.cos(heading)*side-rz*yawRate;
  const vz=-Math.cos(heading)*forward+Math.sin(heading)*side+rx*yawRate;
  const outward=-(vx*dx+vz*dz)/horizontal;
  const mass=boat.hydrodynamics?.mass??60000,stiffness=Math.min(limits.maxStiffness,mass*.12);
  const damping=2*.65*Math.sqrt(stiffness*mass);
  const demand=Math.max(0,stiffness*stretch+damping*outward);
  const holding=Math.min(mass*9.81*.10,limits.anchorMass*9.81*8),tension=Math.min(holding,demand);
  const force=tension*horizontal/Math.max(distance,1e-6),x=dx/horizontal*force,z=dz/horizontal*force;
  return {x,z,yaw:rx*z-rz*x,tension,demand,holding};
}

export function createAnchorState(boat,options={}) {
  let serial=0,pending=[],checkTime=0;
  const state={phase:'stowed',position:anchorHousedPosition(boat),rode:anchorEyeOffset(boat),
    worldHeading:boat.heading??0,
    embedded:false,depth:null,depthFathoms:null,bed:null,velocity:{x:0,y:0,z:0},
    time:0,splash:null,events:[],force:{x:0,z:0,yaw:0,tension:0},reelRate:0,eligibility:{allowed:false,reason:'Checking coastal sounding'},onSurfaceEvent:typeof options.onSurfaceEvent==='function'?options.onSurfaceEvent:null,
    get active(){return this.phase!=='stowed';},
    get status(){
      const depth=this.depthFathoms===null?'':` · ${this.depthFathoms.toFixed(1)} fathoms (simulated sounding)`;
      if(this.phase==='stowed')return this.eligibility.reason;
      if(this.phase==='lowering')return 'Anchor lowering';
      if(this.phase==='setting')return `Paying out rode${depth}`;
      if(this.phase==='weighing')return this.embedded?'Hauling rode · bringing bow over anchor':'Weighing anchor';
      return `Anchor ${this.dragging?'dragging':'set'}${depth}`;
    },
    drop(currentBoat,environment){
      if(this.phase!=='stowed')return false;
      this.eligibility=anchorEligibility(currentBoat,environment);if(!this.eligibility.allowed)return false;
      const p=anchorFairlead(currentBoat),heading=(currentBoat.heading??0)*Math.PI/180;
      this.position=anchorHousedPosition(currentBoat);this.rode=anchorEyeOffset(currentBoat);this.bed=this.eligibility.bed;
      this.worldHeading=currentBoat.heading??0;
      this.depth=null;this.depthFathoms=null;this.embedded=false;this.dragging=false;this.phase='lowering';
      this.velocity={x:Math.sin(heading)*boatForwardSpeed(currentBoat),y:0,z:-Math.cos(heading)*boatForwardSpeed(currentBoat)};
      this.waterY=environment?.waterHeight?.(p.x,p.z)??currentBoat.target?.heave??0;
      emit('drop');emit('reel-start');return true;
    },
    weigh(){if(!this.active||this.phase==='weighing')return false;this.phase='weighing';emit('reel-start');return true;},
    reset(currentBoat){
      if(this.active)emit('reel-stop');
      this.phase='stowed';this.position=anchorHousedPosition(currentBoat);this.rode=anchorEyeOffset(currentBoat);this.embedded=false;
      this.worldHeading=currentBoat.heading??0;
      this.depth=this.depthFathoms=null;this.force={x:0,z:0,yaw:0,tension:0};this.splash=null;this.reelRate=0;
    },
    step(dt,currentBoat,environment={}){
      dt=Math.max(0,Math.min(.1,anchorFinite(dt)));this.time+=dt;this.events=pending;pending=[];
      checkTime-=dt;if(checkTime<=0){this.eligibility=anchorEligibility(currentBoat,environment);checkTime=.5;}
      this.reelRate=0;
      if(this.phase==='stowed'){
        this.position=anchorHousedPosition(currentBoat);this.force={x:0,z:0,yaw:0,tension:0};return this.force;
      }
      const p=anchorFairlead(currentBoat),housedPosition=anchorHousedPosition(currentBoat),limits=anchorEquipment(currentBoat),eyeOffset=anchorEyeOffset(currentBoat);
      const bedOffset=.22*limits.renderScale;
      const steps=this.phase==='lowering'?Math.max(1,Math.ceil(dt*120)):1,h=dt/steps;
      for(let i=0;i<steps;i++){
        if(this.phase==='stowed'){this.position=housedPosition;continue;}
        if(this.phase==='lowering'){
          const wasY=this.position.y;
          this.rode=Math.min(limits.maxRode,this.rode+limits.payRate*h);this.reelRate=limits.payRate;
          this.velocity.y=(this.velocity.y-9.81*h)/(1+(this.position.y<0?2.3:.08)*h);
          this.velocity.x*=Math.exp(-h*.8);this.velocity.z*=Math.exp(-h*.8);
          this.position.x+=this.velocity.x*h;this.position.z+=this.velocity.z*h;this.position.y+=this.velocity.y*h;
          const dx=this.position.x-p.x,dz=this.position.z-p.z;
          this.position.y=Math.max(this.position.y,p.y-eyeOffset-Math.sqrt(Math.max(0,this.rode*this.rode-dx*dx-dz*dz)));
          const surface=environment.waterHeight?.(this.position.x,this.position.z)??this.waterY??0;
          if(wasY>surface&&this.position.y<=surface){
            this.splash={x:this.position.x,y:surface,z:this.position.z,at:this.time};emit('splash',surface,{massKg:limits.anchorMass,scale:limits.renderScale,velocity:[this.velocity.x,this.velocity.y,this.velocity.z]});
          }
          const localBed=environment.terrain?.height?.(this.position.x,this.position.z);
          if(Number.isFinite(localBed)&&localBed<0)this.bed=localBed;
          if(this.position.y<=this.bed+bedOffset){
            this.position.y=this.bed+bedOffset;this.velocity={x:0,y:0,z:0};this.embedded=true;this.phase='setting';
            this.depth=-this.bed;this.depthFathoms=metresToFathoms(this.depth);emit('set');
          }
        }
        if(this.phase==='setting'){
          const desired=Math.min(limits.maxRode,limits.scope*(this.depth+Math.max(1,p.y)));
          this.rode=Math.min(desired,this.rode+limits.payRate*h);this.reelRate=limits.payRate;
          if(this.rode>=desired){this.phase='anchored';this.reelRate=0;emit('reel-stop');}
        }
        if(this.phase==='weighing'){
          const target=housedPosition;
          const dx=target.x-this.position.x,dy=target.y-this.position.y,dz=target.z-this.position.z;
          const distance=Math.hypot(dx,dy,dz),horizontal=Math.hypot(dx,dz);
          this.reelRate=-limits.weighRate;
          if(this.embedded){
            // Winching shortens the spring, pulling the *vessel* toward the
            // anchor. Break it out only once the bow is approximately above it.
            this.rode=Math.max(distance*.94,this.rode-limits.weighRate*h);
            if(horizontal<Math.max(2,Math.abs(dy)*.22)&&this.rode<=distance*1.02){this.embedded=false;}
          }else{
            const move=Math.min(distance,limits.weighRate*h);
            if(distance>1e-8){this.position.x+=dx/distance*move;this.position.y+=dy/distance*move;this.position.z+=dz/distance*move;}
            this.rode=Math.max(eyeOffset,distance-move+eyeOffset);
            if(distance<=.04){this.phase='stowed';this.reelRate=0;emit('reel-stop');emit('secured');}
          }
        }
        const f=anchorTetherForce(this,currentBoat,p);this.dragging=!!(f.demand>f.holding);
        if(this.dragging){
          const dx=p.x-this.position.x,dz=p.z-this.position.z,d=Math.hypot(dx,dz)||1;
          const drift=Math.min(.7,(f.demand-f.holding)/(currentBoat.hydrodynamics?.mass??60000)*.25)*h;
          this.position.x+=dx/d*drift;this.position.z+=dz/d*drift;
          const bed=environment.terrain?.height?.(this.position.x,this.position.z);
          if(Number.isFinite(bed)&&bed<0){this.bed=bed;this.position.y=bed+bedOffset;}
        }
      }
      this.force=anchorTetherForce(this,currentBoat,p);this.events.push(...pending);pending=[];
      return this.force;
    },
  };
  function emit(type,surface,contact){
    const p=state.position,event={type,serial:++serial,x:p.x,y:surface??p.y,z:p.z,strength:type==='splash'?.8:1};
    if(contact){event.massKg=contact.massKg;event.velocity=contact.velocity.slice();}
    pending.push(event);
    if(type==='splash'&&contact)state.onSurfaceEvent?.({source:options.source??'anchor',id:event.serial,x:p.x,z:p.z,kind:'entry',age:0,
      radiusMetres:.32*contact.scale,closingSpeed:Math.max(0,-contact.velocity[1]),velocity:contact.velocity.slice(),massKg:contact.massKg});
  }
  return state;
}

// Bounded sagging line, clamped to the simulated bed. It straightens as tension
// rises, instead of drawing a rigid rod from ship to bottom.
export function anchorRodePoints(state,boat,segments=48) {
  const a=anchorFairlead(boat),b=state.phase==='stowed'?a:{...state.position,y:state.position.y+anchorEyeOffset(boat)},out=[];
  const distance=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z),slack=Math.max(0,state.rode-distance);
  const sag=Math.min(Math.max(0,(a.y-(state.bed??-120))*.8),Math.sqrt(slack*Math.max(1,state.rode))*.5);
  for(let i=0;i<=segments;i++){
    const t=i/segments;out.push({x:a.x+(b.x-a.x)*t,y:Math.max((state.bed??-120)+.04,a.y+(b.y-a.y)*t-Math.sin(Math.PI*t)*sag),z:a.z+(b.z-a.z)*t});
  }
  return out;
}
