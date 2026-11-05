// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Multi-tier Level of Detail (LOD) for skinned crew models.
// Simplifies triangle index buffers while indexing directly into the shared
// 60-byte-stride skinned vertex buffer, preserving 65-joint skin weights,
// sentinel COLOR_0 regions (shirt, trousers, skin, hair) and watertight seams.

export const CREW_LOD_TIERS=Object.freeze([
  Object.freeze({id:'near',level:0,maxDistance:28,targetRatio:1}),
  Object.freeze({id:'mid',level:1,maxDistance:85,targetRatio:.28}),
  Object.freeze({id:'far',level:2,maxDistance:Infinity,targetRatio:.10}),
]);

function vertexColorGroup(floats,i){
  const r=Math.round(floats[i*15+6]*40),g=Math.round(floats[i*15+7]*40),b=Math.round(floats[i*15+8]*40);
  return (r<<12)|(g<<6)|b;
}

function vertexPartGroup(animator,joints,floats,i){
  let bestSlot=joints[i*30+18],bestWeight=floats[i*15+11];
  for(let k=1;k<4;k++){
    const w=floats[i*15+11+k];
    if(w>bestWeight){bestWeight=w;bestSlot=joints[i*30+18+k];}
  }
  const name=animator?.names?.[animator.joints[bestSlot]]??'';
  if(/_l$/.test(name))return 1;
  if(/_r$/.test(name))return 2;
  if(/^(Head|neck)/.test(name))return 3;
  return 0;
}

function decimateCrewIndices(vertices,indices,vertexCount,animator,cellSize){
  if(!(cellSize>0))return new Uint32Array(indices);
  const floats=new Float32Array(vertices.buffer,vertices.byteOffset,vertexCount*15);
  const joints=new Uint16Array(vertices.buffer,vertices.byteOffset,vertexCount*30);
  const colorGroup=new Int32Array(vertexCount);
  const partGroup=new Uint8Array(vertexCount);
  for(let i=0;i<vertexCount;i++){
    colorGroup[i]=vertexColorGroup(floats,i);
    partGroup[i]=vertexPartGroup(animator,joints,floats,i);
  }
  // Protect colour-seam vertices with a finer cell quantum so garment edges stay crisp.
  const seamVertex=new Uint8Array(vertexCount);
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],b=indices[i+1],c=indices[i+2];
    const ca=colorGroup[a],cb=colorGroup[b],cc=colorGroup[c];
    if(ca!==cb||cb!==cc||ca!==cc){seamVertex[a]=1;seamVertex[b]=1;seamVertex[c]=1;}
  }
  const cells=new Map();
  for(let i=0;i<vertexCount;i++){
    const step=seamVertex[i]?cellSize*.65:cellSize;
    const x=floats[i*15],y=floats[i*15+1],z=floats[i*15+2];
    const gx=Math.floor(x/step),gy=Math.floor(y/step),gz=Math.floor(z/step);
    const key=`${colorGroup[i]}:${partGroup[i]}:${seamVertex[i]}:${gx},${gy},${gz}`;
    let cell=cells.get(key);
    if(!cell){cell={cx:0,cy:0,cz:0,nx:0,ny:0,nz:0,members:[]};cells.set(key,cell);}
    cell.cx+=x;cell.cy+=y;cell.cz+=z;
    cell.nx+=floats[i*15+3];cell.ny+=floats[i*15+4];cell.nz+=floats[i*15+5];
    cell.members.push(i);
  }
  const remap=new Uint32Array(vertexCount);
  for(const cell of cells.values()){
    const n=cell.members.length;
    if(n===1){remap[cell.members[0]]=cell.members[0];continue;}
    const cx=cell.cx/n,cy=cell.cy/n,cz=cell.cz/n;
    const nLen=Math.hypot(cell.nx,cell.ny,cell.nz)||1,nx=cell.nx/nLen,ny=cell.ny/nLen,nz=cell.nz/nLen;
    let best=cell.members[0],bestScore=Infinity;
    for(const idx of cell.members){
      const dx=floats[idx*15]-cx,dy=floats[idx*15+1]-cy,dz=floats[idx*15+2]-cz;
      const ndot=floats[idx*15+3]*nx+floats[idx*15+4]*ny+floats[idx*15+5]*nz;
      const score=(dx*dx+dy*dy+dz*dz)+Math.max(0,1-ndot)*cellSize*cellSize*.25;
      if(score<bestScore){bestScore=score;best=idx;}
    }
    for(const idx of cell.members)remap[idx]=best;
  }
  const out=[],seenFaces=new Set();
  for(let i=0;i<indices.length;i+=3){
    const a=remap[indices[i]],b=remap[indices[i+1]],c=remap[indices[i+2]];
    if(a===b||b===c||a===c)continue;
    const min=Math.min(a,b,c),max=Math.max(a,b,c),mid=a+b+c-min-max;
    const faceKey=`${min}:${mid}:${max}`;
    if(seenFaces.has(faceKey))continue;
    seenFaces.add(faceKey);
    out.push(a,b,c);
  }
  return new Uint32Array(out);
}

export function createCrewLODs(model){
  const {vertices,indices,vertexCount,animator}=model;
  const baseTriangles=indices.length/3;
  return CREW_LOD_TIERS.map(tier=>{
    if(tier.level===0){
      return Object.freeze({
        id:tier.id,level:0,maxDistance:tier.maxDistance,
        indices,indexCount:indices.length,triangles:baseTriangles,ratio:1,
      });
    }
    const targetTriangles=Math.max(240,Math.round(baseTriangles*tier.targetRatio));
    let lo=.004,hi=.14,best=indices,bestDiff=Infinity;
    for(let iter=0;iter<9;iter++){
      const mid=(lo+hi)*.5;
      const candidate=decimateCrewIndices(vertices,indices,vertexCount,animator,mid);
      const tris=candidate.length/3,diff=Math.abs(tris-targetTriangles);
      if(tris>=200&&diff<bestDiff){bestDiff=diff;best=candidate;}
      if(tris>targetTriangles)lo=mid;else hi=mid;
    }
    return Object.freeze({
      id:tier.id,level:tier.level,maxDistance:tier.maxDistance,
      indices:best,indexCount:best.length,triangles:best.length/3,ratio:best.length/indices.length,
    });
  });
}

// A body a few dozen pixels tall needs little more than its silhouette and the colours of its clothes.
export function createDistantCrewLOD(model,targetTriangles=320){
  const {vertices,vertexCount,animator}=model;
  // Regalia is too small to see at this size, and optional pieces would use up the triangles.
  const reds=new Float32Array(vertices.buffer,vertices.byteOffset,vertexCount*15),kept=[];
  for(let i=0;i<model.indices.length;i+=3){
    const a=model.indices[i],b=model.indices[i+1],c=model.indices[i+2];
    if(reds[a*15+6]<2&&reds[b*15+6]<2&&reds[c*15+6]<2)kept.push(a,b,c);
  }
  const indices=new Uint32Array(kept);
  let lo=.02,hi=.4,best=null,bestDiff=Infinity;
  for(let iter=0;iter<9;iter++){
    const mid=(lo+hi)*.5,candidate=decimateCrewIndices(vertices,indices,vertexCount,animator,mid),tris=candidate.length/3,diff=Math.abs(tris-targetTriangles);
    if(tris>=40&&diff<bestDiff){bestDiff=diff;best=candidate;}
    if(tris>targetTriangles)lo=mid;else hi=mid;
  }
  return best??indices;
}

export const CREW_CULL_DISTANCE=420;
const CREW_LOD_TAN_HALF_FOV=Math.tan(29*Math.PI/180);
// How much nearer a narrow lens brings a body than the ordinary view would.
export function crewLensZoom(camera){
  const fovY=camera?.fovY;
  return Number.isFinite(fovY)&&fovY>0?Math.max(1,CREW_LOD_TAN_HALF_FOV/Math.tan(fovY*.5)):1;
}

export function selectCrewLOD(boat,camera=null){
  if(!camera||boat?.enabled===true||!Number.isFinite(camera.x)||!Number.isFinite(camera.z)){
    return {mainTier:0,shadowTier:1,distance:0};
  }
  const bx=Number.isFinite(boat?.x)?boat.x:0,by=Number.isFinite(boat?.heave)?boat.heave:0,bz=Number.isFinite(boat?.z)?boat.z:0;
  const cy=Number.isFinite(camera.y)?camera.y:0;
  const distance=Math.hypot(camera.x-bx,cy-by,camera.z-bz);
  const apparent=distance/crewLensZoom(camera);
  const mainTier=apparent<CREW_LOD_TIERS[0].maxDistance?0:apparent<CREW_LOD_TIERS[1].maxDistance?1:2;
  const shadowTier=Math.min(CREW_LOD_TIERS.length-1,mainTier+1);
  if(apparent>CREW_CULL_DISTANCE)return {mainTier,shadowTier,distance,culled:true};
  return {mainTier,shadowTier,distance};
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
// How far from the eye a sailor appears, allowing for a narrow lens. Without a camera, right here.
export function crewApparentDistance(position,boat,camera,zoom=crewLensZoom(camera)){
  if(!camera||!Number.isFinite(camera.x)||!Number.isFinite(camera.z))return 0;
  const heading=(boat?.heading??0)*Math.PI/180,c=Math.cos(heading),sn=Math.sin(heading);
  const x=(boat?.x??0)+position[0]*c-position[2]*sn,z=(boat?.z??0)+position[0]*sn+position[2]*c,y=(boat?.heave??0)+position[1];
  return Math.hypot(x-camera.x,y-(camera.y??0),z-camera.z)/zoom;
}

// Each sailor's own level of detail. Hysteresis stops anyone flickering between models at a boundary.
const CREW_SAILOR_NEAR_M=12;
const CREW_SAILOR_MID_M=35;
const CREW_SAILOR_HYSTERESIS=1.15;
export function crewSailorTier(apparentMetres,previous=0){
  const nearLimit=CREW_SAILOR_NEAR_M*(previous===0?CREW_SAILOR_HYSTERESIS:1);
  const midLimit=CREW_SAILOR_MID_M*(previous<=1?CREW_SAILOR_HYSTERESIS:1);
  return apparentMetres<nearLimit?0:apparentMetres<midLimit?1:2;
}
// One instanced draw per unbroken run of sailors at the same detail. Instance order is their
// slot in the pose buffers, and stations keep neighbours together, so runs stay few.
export function crewDrawRuns(people,tierOf){
  const runs=[];let run=null;
  for(let i=0;i<people.length;i++){
    const tier=tierOf(people[i]);
    if(tier<0){run=null;continue;}
    if(run&&run.tier===tier)run.count++;
    else{run={tier,first:i,count:1};runs.push(run);}
  }
  return runs;
}

// Who needs the shader that can cut fragments. Everyone within this distance of a first-person eye
// fades from the sightline, and enough wounds leave torn cloth. Everyone else stays opaque.
const CREW_FADE_REACH_M=6.5;
const CREW_TORN_DAMAGE=0.45;
export function crewNeedsCutShader(metresFromEye,firstPerson,woundAndScorch){
  return (firstPerson&&metresFromEye<CREW_FADE_REACH_M)||woundAndScorch>CREW_TORN_DAMAGE;
}

// Beyond this a sailor's hands and feet are a few pixels, so baked clips alone will do. Someone
// seated, fallen or just hurt still needs their own solved pose.
const CREW_CLIP_ONLY_M=50;
export function crewClipOnly(apparentMetres,sailor){
  return apparentMetres>=CREW_CLIP_ONLY_M&&!sailor.seatedPose&&!sailor.pendingWounds?.length&&!((sailor.knockdownTimer??0)>0)&&sailor.casualtyState!=='fallen';
}

