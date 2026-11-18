// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// How often a person's skeleton is solved, and from what: the sparse physical simulation of the people. What is drawn
// of each body, at any distance, is the continuum's to choose on the GPU (js/crew-continuum-draw.js); nothing here
// chooses a mesh. The skeleton is the physical truth for wounds, footing and falls, so it is solved wherever anything
// it carries can show.

const CREW_TAN_HALF_FOV=Math.tan(29*Math.PI/180);
// How much nearer a narrow lens brings a body than the ordinary view would.
export function crewLensZoom(camera){
  const fovY=camera?.fovY;
  return Number.isFinite(fovY)&&fovY>0?Math.max(1,CREW_TAN_HALF_FOV/Math.tan(fovY*.5)):1;
}

// How far the eye is from a company: from her hull, or from whichever of her people overboard is nearer. Aboard,
// or without a camera, here.
export function crewCompanyDistance(boat,camera=null){
  if(!camera||boat?.enabled===true||!Number.isFinite(camera.x)||!Number.isFinite(camera.z))return 0;
  const bx=Number.isFinite(boat?.x)?boat.x:0,by=Number.isFinite(boat?.heave)?boat.heave:0,bz=Number.isFinite(boat?.z)?boat.z:0;
  const cy=Number.isFinite(camera.y)?camera.y:0;
  let distance=Math.hypot(camera.x-bx,cy-by,camera.z-bz);
  const crew=boat?.crewCompany?.crew;
  if(Array.isArray(crew)){
    for(let i=0;i<crew.length;i++){
      const o=crew[i]?.overboard;
      if(o&&!o.gone&&crew[i].visible!==false){
        const d=Math.hypot(camera.x-o.x,cy-o.y,camera.z-o.z);
        if(d<distance)distance=d;
      }
    }
  }
  return distance;
}

// How many frames apart a sailor's skeleton is solved, by how far they appear from the eye. The GPU
// blends between solves, so their limbs keep moving; anyone close is solved every frame.
const CREW_POSE_EVERY_FRAME_M=10;
const CREW_POSE_MID_M=25;
const CREW_POSE_FAR_M=50;
const CREW_POSE_MID_FRAMES=3;
const CREW_POSE_FAR_FRAMES=5;
const CREW_POSE_LONGEST_FRAMES=8;
export function crewPoseInterval(apparentMetres){
  return apparentMetres<CREW_POSE_EVERY_FRAME_M?1:apparentMetres<CREW_POSE_MID_M?CREW_POSE_MID_FRAMES:apparentMetres<CREW_POSE_FAR_M?CREW_POSE_FAR_FRAMES:CREW_POSE_LONGEST_FRAMES;
}
// How many frames apart a garrison is sampled, by how near its nearest soldier stands. Its joints are shown as
// solved, with nothing between, so the stride is short.
const FORT_POSE_EVERY_FRAME_M=28;
const FORT_POSE_MID_M=85;
export function fortPoseStride(metres){
  return metres<FORT_POSE_EVERY_FRAME_M?1:metres<FORT_POSE_MID_M?2:4;
}
// How far from the eye a sailor appears, allowing for a narrow lens. Without a camera, right here.
export function crewApparentDistance(position,boat,camera,zoom=crewLensZoom(camera)){
  if(!camera||!Number.isFinite(camera.x)||!Number.isFinite(camera.z))return 0;
  const heading=(boat?.heading??0)*Math.PI/180,c=Math.cos(heading),sn=Math.sin(heading);
  const x=(boat?.x??0)+position[0]*c-position[2]*sn,z=(boat?.z??0)+position[0]*sn+position[2]*c,y=(boat?.heave??0)+position[1];
  return Math.hypot(x-camera.x,y-(camera.y??0),z-camera.z)/zoom;
}

// Beyond this a sailor's hands and feet are a few pixels, so baked clips alone will do. Someone
// seated, fallen or just hurt still needs their own solved pose.
const CREW_CLIP_ONLY_M=50;
export function crewClipOnly(apparentMetres,sailor){
  // A lost limb and a stuck arrow are in his own solved pose, and a baked clip has neither.
  return apparentMetres>=CREW_CLIP_ONLY_M&&!sailor.seatedPose&&!sailor.pendingWounds?.length&&!sailor.crewInjuries?.length&&!sailor.stuckArrows?.length&&!((sailor.knockdownTimer??0)>0)&&sailor.casualtyState!=='fallen';
}

// A man in the water with no wound to show swims, or floats, as every other does, so a baked loop serves him at
// any distance and JavaScript solves nothing for him. One who is hurt, or only now hit, keeps his own solved pose.
export function crewAfloatClip(sailor){
  const o=sailor.overboard;
  if(!o?.inWater||o.gone||sailor.pendingWounds?.length||sailor.crewInjuries?.length||sailor.stuckArrows?.length)return null;
  return o.alive?'Swim':'Float';
}
// Which baked clip poses a sailor this frame, if any: a loop for a man in the water, 'walk' for the standing and
// walking clips of one far off, and none for one whose pose is solved for him.
export function crewBakedPose(apparentMetres,sailor){
  return crewAfloatClip(sailor)??(crewClipOnly(apparentMetres,sailor)?'walk':null);
}

// A fallen body whose ragdoll has gone to sleep. It is solved twice more, so that both poses the GPU shows it
// between are the one it rests in, and then not again until something wakes it.
const CREW_REST_POSES=2;
export function crewBodyAtRest(sailor){
  return sailor.casualtyState==='fallen'&&!sailor.overboard&&Boolean(sailor.ragdoll?.active&&sailor.ragdoll.settled);
}
// Whether to solve a sailor's skeleton this frame. `snap` is a change that has to show at once.
export function crewPoseDue(sailor,clipOnly,snap,interval){
  if(clipOnly)return false;
  if(snap)return true;
  if(sailor.visible===false||(sailor.poseAge??0)<interval)return false;
  return !(crewBodyAtRest(sailor)&&(sailor.posedAtRest??0)>=CREW_REST_POSES);
}
export function crewPoseSolved(sailor){
  sailor.posedAtRest=crewBodyAtRest(sailor)?(sailor.posedAtRest??0)+1:0;
}
// Whether to solve a soldier ashore this frame. A garrison is solved at a stride of frames set by how far off it
// is, and its joints are shown as solved, with nothing between. So what has just changed is solved at once, a body
// in the air or tumbling every frame, a walking sentry on the stride, and a body come to rest once and no more.
// `everyone` is a new port, where every slot still holds somebody else's pose.
export function fortPoseDue(soldier,onStride,everyone,stirred){
  if(everyone||stirred||soldier.pendingWounds?.length)return true;
  if(crewBodyAtRest(soldier))return (soldier.posedAtRest??0)<1;
  if(soldier.casualtyState==='fallen'||(soldier.knockdownTimer??0)>0||soldier.garrisonFall)return true;
  return onStride;
}
