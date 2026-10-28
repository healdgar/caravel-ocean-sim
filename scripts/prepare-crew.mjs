// Rebuild the locally authored sailor from pinned CC0 data. No downloaded code runs.
// node scripts/prepare-crew.mjs /tmp/waterworld-crew [--download]
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readGLB,gltfAccessor,createSkinAnimator,gltfQuatMultiply,gltfSlerp,gltfTRS} from '../js/gltf.js';
const source=process.argv[2]??'/tmp/waterworld-crew';
const revision='5821923af517ac5fdc82505faa92a0d575fc1b1a';
const prefix='https://raw.githubusercontent.com/NafisRayan/Animate-Rigged-Humanoid-No-Blender/'+revision+'/';
const bodyPath='Universal Base Characters[Standard]/Universal Base Characters[Standard]/Base Characters/Godot - UE/';
const hairPath='Universal Base Characters[Standard]/Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)/';
const files={
  'UAL1.glb':['Universal Animation Library[Standard]/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb','69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997'],
  'body.gltf':[bodyPath+'Superhero_Male_FullBody.gltf','e7fcea214ecf8855afbf910b50de6f9c7d1decfb71ca28bad8a4481452dafeb4'],
  'body.bin':[bodyPath+'Superhero_Male_FullBody.bin','459003f9745853ae562a85506a2b94dd56515c1f37728f9fa3d2ce1a3e4cd92f'],
  'hair.gltf':[hairPath+'Hair_SimpleParted.gltf','ce6c666d00bcca2baa0c58d0442505f90f8feff952592effc4697a2341e9e56d'],
  'hair.bin':[hairPath+'Hair_SimpleParted.bin','57c6359703a37e346ee38a9c7ba55c8dee761c0a02da99847d06f5a91728f3cc'],
  'female.gltf':[bodyPath+'Superhero_Female_FullBody.gltf','adedf28000a0716f689b009a70314506fc62f827498f77ba852acb5610f3f3f4'],
  'female.bin':[bodyPath+'Superhero_Female_FullBody.bin','3a8220a485b33d05d879115a50697728b45a151781106033afb8b8c243fca208'],
  'buns.gltf':[hairPath+'Hair_Buns.gltf','2bb3593575e21c9af39a53e48c42c1314b0a894e9577f3f14abffcb145cd56c5'],
  'buns.bin':[hairPath+'Hair_Buns.bin','4f6d4c010201278483da8d6d46ec40e3beb8d9e679ec2139bed216c561bccd38'],
};
const data={};await fs.mkdir(source,{recursive:true});
for(const [name,[remote,hash]] of Object.entries(files)){
  if(process.argv.includes('--download')){
    const response=await fetch(prefix+remote.split('/').map(encodeURIComponent).join('/'));
    if(!response.ok)throw Error('Download failed: '+name);await fs.writeFile(path.join(source,name),new Uint8Array(await response.arrayBuffer()));
  }
  data[name]=await fs.readFile(path.join(source,name));
  if(createHash('sha256').update(data[name]).digest('hex')!==hash)throw Error('Source checksum mismatch: '+name);
}
for(const female of [false,true]) {
const bodyName=female?'female':'body',hairName=female?'buns':'hair';
const body={json:JSON.parse(data[bodyName+'.gltf']),bin:data[bodyName+'.bin']},hair={json:JSON.parse(data[hairName+'.gltf']),bin:data[hairName+'.bin']};
const animation=readGLB(data['UAL1.glb']),sourcePlayer=createSkinAnimator(animation),targetPlayer=createSkinAnimator(body);
const g=structuredClone(body.json);
delete g.images;delete g.textures;delete g.samplers;delete g.extensionsUsed;delete g.extensionsRequired;
g.materials=[{name:'Sailor vertex colours',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:.9},doubleSided:true}];
g.bufferViews=[];g.accessors=[];g.animations=[];
const buffers=[];let byteLength=0;
function accessor(values,type,componentType=5126){
  const n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[type],Typed=componentType===5123?Uint16Array:componentType===5125?Uint32Array:Float32Array;
  const a=new Typed(values),bytes=Buffer.from(a.buffer,a.byteOffset,a.byteLength),padded=Buffer.alloc((bytes.length+3)&~3);bytes.copy(padded);
  const view=g.bufferViews.length;g.bufferViews.push({buffer:0,byteOffset:byteLength,byteLength:bytes.length});buffers.push(padded);byteLength+=padded.length;
  const desc={bufferView:view,componentType,count:a.length/n,type};
  if(type==='VEC3'||type==='SCALAR'){
    desc.min=Array(n).fill(Infinity);desc.max=Array(n).fill(-Infinity);
    for(let i=0;i<a.length;i++){const k=i%n;desc.min[k]=Math.min(desc.min[k],a[i]);desc.max[k]=Math.max(desc.max[k],a[i]);}
  }
  g.accessors.push(desc);return g.accessors.length-1;
}
const skin=[.36,.18,.10],linen=[.55,.47,.31],trousers=[.095,.12,.15],hose=[.22,.195,.165],leather=[.055,.025,.012],hairColor=[.045,.019,.009];
targetPlayer.sample(null,0);
// Reduce the superhero bulk around existing bone axes and neutralize exaggerated
// jaw/brow features into a clean anatomical base, preserving joint lengths,
// hands, head and feet. The same weights still drive every animation and IK grip.
const limbEnds={upperarm:'lowerarm',lowerarm:'hand',thigh:'calf',calf:'foot'};
const headCenter=Array.from(targetPlayer.world[targetPlayer.names.indexOf('Head')].subarray(12,15));
const slimAxes=targetPlayer.joints.map(node=>{
  const name=targetPlayer.names[node],start=Array.from(targetPlayer.world[node].subarray(12,15));
  const match=/^(upperarm|lowerarm|thigh|calf)_([lr])$/.exec(name);
  if(match){
    const endNode=targetPlayer.names.indexOf(limbEnds[match[1]]+'_'+match[2]);
    const end=Array.from(targetPlayer.world[endNode].subarray(12,15));
    return {start,axis:end.map((v,i)=>v-start[i]),scale:{upperarm:.84,lowerarm:.91,thigh:.93,calf:.94}[match[1]]};
  }
  if(/^(spine_|pelvis|clavicle|neck_)/.test(name))return {start,axis:[0,1,0],scale:name.startsWith('neck_')?(female?.94:.89):.90,chest:/^spine_0[23]$/.test(name)};
  return null;
});
const clamp01=x=>Math.max(0,Math.min(1,x));
const smooth=(lo,hi,x)=>{const t=clamp01((x-lo)/(hi-lo));return t*t*(3-2*t);};
function slimBody(pos,joints,weights){
  for(let i=0;i<pos.length/3;i++){
    const original=Array.from(pos.subarray(i*3,i*3+3)),delta=[0,0,0];
    let headWeight=0;
    for(let k=0;k<4;k++){
      const node=targetPlayer.joints[joints[i*4+k]],name=targetPlayer.names[node],weight=weights[i*4+k];
      if(name==='Head')headWeight+=weight;
      const bone=slimAxes[joints[i*4+k]];if(!bone||weight===0)continue;
      const {start,axis,scale,chest}=bone,q=original.map((v,j)=>v-start[j]);
      const along=q.reduce((s,v,j)=>s+v*axis[j],0)/axis.reduce((s,v)=>s+v*v,0);
      for(let j=0;j<3;j++)delta[j]+=(q[j]-axis[j]*along)*(scale-1)*weight;
      // Flatten the pronounced front-chest contour without compressing the back.
      if(chest)delta[2]-=Math.max(0,q[2])*(female?.22:.14)*weight;
    }
    if(!female&&headWeight>.1){
      // Neutralize the comic-book superhero square jaw and heavy brow ridge so
      // per-sailor facial uniforms deform around a balanced neutral male head.
      const jawBand=smooth(1.56,1.615,original[1])*(1-smooth(1.635,1.69,original[1]));
      const browBand=smooth(1.69,1.72,original[1])*(1-smooth(1.73,1.76,original[1]))*smooth(.04,.095,original[2]);
      delta[0]-=(original[0]-headCenter[0])*(.045+.055*jawBand)*headWeight;
      delta[2]-=Math.max(0,original[2]-headCenter[2])*(.035*jawBand+.05*browBand)*headWeight;
    }
    for(let j=0;j<3;j++)pos[i*3+j]+=delta[j];
  }
}
// Shape the clothed surface as 1550-1650 mariner attire: a bloused canvas/linen
// slop-shirt, wide knee-gathered Venetian slops (galligaskins), fitted wool
// stockings/hose on the lower calf, and low leather shoes.
function drapeWorkwear(pos,colors,joints,weights){
  const waist=female?.99:1.015,shoulder=female?1.47:1.53;
  for(let i=0;i<pos.length/3;i++){
    const shirt=Math.abs(colors[i*3]-linen[0])<.001,pants=Math.abs(colors[i*3]-trousers[0])<.001,stocking=Math.abs(colors[i*3]-hose[0])<.001;
    if(!shirt&&!pants&&!stocking)continue;
    const p=Array.from(pos.subarray(i*3,i*3+3));let torso=0;
    const delta=[0,0,0];
    for(let k=0;k<4;k++){
      const node=targetPlayer.joints[joints[i*4+k]],name=targetPlayer.names[node],w=weights[i*4+k];
      if(/^(spine_|pelvis|clavicle)/.test(name))torso+=w;
      const match=/^(upperarm|lowerarm|thigh|calf)_([lr])$/.exec(name);if(!match||w===0)continue;
      const part=match[1],arm=part.includes('arm');if(shirt!==arm)continue;
      const bone=slimAxes[joints[i*4+k]],q=p.map((v,j)=>v-bone.start[j]),length=Math.hypot(...bone.axis);
      const t=q.reduce((s,v,j)=>s+v*bone.axis[j],0)/(length*length),tc=clamp01(t);
      const radial=q.map((v,j)=>v-bone.axis[j]*t),radius=Math.hypot(...radial);if(radius<.001)continue;
      const ang=Math.atan2(radial[2],radial[0]);
      const ends={upperarm:[.067,.055],lowerarm:[.056,.040],thigh:[.112,.086],calf:[.080,.055]}[part];
      let fit=(ends[0]+(ends[1]-ends[0])*tc)*(female?.91:1);
      if(part==='lowerarm')fit+=(.0055+.0015*Math.cos(ang*8))*Math.sin(Math.PI*tc)*(1-smooth(.82,.98,tc));
      else if(part==='thigh')fit+=(.011+.003*Math.cos(ang*10))*Math.sin(Math.PI*tc);
      else if(part==='calf')fit+=pants?(.008+.002*Math.cos(ang*8))*(1-smooth(.10,.28,tc)):0;
      const blend=arm?.9:smooth(.04,.28,t)*.78;
      const change=Math.max(-.012,Math.min(.022,fit-radius))*w*blend;
      for(let j=0;j<3;j++)delta[j]+=radial[j]/radius*change;
    }
    if(shirt&&torso>.01){
      const t=clamp01((p[1]-waist)/(shoulder-waist));
      const rx=(female?.148:.172)+(female?.032:.038)*smooth(.15,.85,t);
      const rz=(female?.112:.127)+.015*smooth(.25,.8,t),center=-.027;
      const angle=Math.atan2(p[2]-center,p[0]),c=Math.cos(angle),s=Math.sin(angle),power=2.5;
      const radius=(Math.abs(c/rx)**power+Math.abs(s/rz)**power)**(-1/power);
      const fold=1+.014*Math.cos(angle*10+t*2.2)*Math.sin(Math.PI*t);
      const blend=torso*(1-smooth(shoulder-.07,shoulder+.025,p[1]));
      delta[0]+=(c*radius*fold-p[0])*blend;
      delta[2]+=(center+s*radius*fold-p[2])*blend;
    }
    if(pants){
      // Venetian slops bridge the seat and groin into one pleated cloth envelope,
      // blending into full knee-gathered breeches legs below the pelvis.
      const crotch=female?.855:.885,center=-.027;
      const upper=smooth(crotch-.015,crotch+.045,p[1]);
      const t=clamp01((p[1]-crotch)/(waist-crotch));
      const waistRadius=female?.148:.172;
      const rx=(female?.182:.201)+(waistRadius-(female?.182:.201))*smooth(.5,1,t);
      const rz=p[2]>=center
        ?.05+((female?.112:.127)-.05)*smooth(0,.85,t)
        :(female?.112:.127)+.018*Math.sin(Math.PI*t);
      const angle=Math.atan2(p[2]-center,p[0]),c=Math.cos(angle),s=Math.sin(angle),power=2.5;
      const radius=(Math.abs(c/rx)**power+Math.abs(s/rz)**power)**(-1/power);
      delta[0]+=(c*radius-p[0])*upper;
      delta[2]+=(center+s*radius-p[2])*upper;
    }
    for(let j=0;j<3;j++)pos[i*3+j]+=delta[j];
  }
}
function surfaceNormals(pos,indices,fallback){
  const normals=new Float32Array(pos.length);
  for(let i=0;i<indices.length;i+=3){
    const [a,b,c]=Array.from(indices.subarray(i,i+3),x=>x*3);
    const u=[0,1,2].map(k=>pos[b+k]-pos[a+k]),v=[0,1,2].map(k=>pos[c+k]-pos[a+k]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    for(const vertex of [a,b,c])for(let k=0;k<3;k++)normals[vertex+k]+=n[k];
  }
  // Mirrored source vertices share positions but not indices. Average their
  // normals so a hard centre seam cannot recreate a cleft through lighting.
  const seams=new Map();
  for(let i=0;i<pos.length;i+=3){const key=[0,1,2].map(k=>Math.round(pos[i+k]*1e5)).join(',');if(!seams.has(key))seams.set(key,[]);seams.get(key).push(i);}
  for(const vertices of seams.values())if(vertices.length>1){
    const sum=[0,0,0];for(const i of vertices)for(let k=0;k<3;k++)sum[k]+=normals[i+k];
    for(const i of vertices)for(let k=0;k<3;k++)normals[i+k]=sum[k];
  }
  for(let i=0;i<normals.length;i+=3){const length=Math.hypot(...normals.subarray(i,i+3));for(let k=0;k<3;k++)normals[i+k]=length>1e-10?normals[i+k]/length:fallback[i+k];}
  return normals;
}
// Simple authored tunic, breeches and shoes. These colours are linear, not sRGB.
let clothedBody;
for(let mi=0;mi<g.meshes.length;mi++)for(const p of g.meshes[mi].primitives){
  const old=body.json.meshes[mi].primitives[0],pos=gltfAccessor(body,old.attributes.POSITION),norm=gltfAccessor(body,old.attributes.NORMAL);
  const colors=new Float32Array(pos.length);
  for(let i=0;i<pos.length;i+=3){
    const x=pos[i],y=pos[i+1],z=pos[i+2];let color=skin,inflate=0;
    if(mi===0)color=hairColor;
    else if(mi===1){const cx=Math.abs(x)-.029;const iris=cx*cx+(y-(female?1.656:1.699))**2<.00006 && z>(female?.069:.074);color=iris?[.024,.013,.006]:[.65,.60,.49];}
    else if(y<.165){color=leather;inflate=.012;}
    else if(y<(female?.445:.465)){color=hose;inflate=.012;}
    else if(y<(female?.99:1.015)){color=trousers;inflate=.012;}
    else if((y<(female?1.515:1.565) || Math.abs(x)>.12) && Math.abs(x)<(female?.63:.69)){color=linen;inflate=.012;}
    colors.set(color,i);for(let k=0;k<3;k++)pos[i+k]+=norm[i+k]*inflate;
  }
  const joints=gltfAccessor(body,old.attributes.JOINTS_0),weights=gltfAccessor(body,old.attributes.WEIGHTS_0),indices=gltfAccessor(body,old.indices);
  if(mi===2){slimBody(pos,joints,weights);drapeWorkwear(pos,colors,joints,weights);clothedBody={pos,joints,weights};}
  p.attributes={POSITION:accessor(pos,'VEC3'),NORMAL:accessor(mi===2?surfaceNormals(pos,indices,norm):norm,'VEC3'),COLOR_0:accessor(colors,'VEC3'),
    JOINTS_0:accessor(joints,'VEC4',5123),WEIGHTS_0:accessor(weights,'VEC4')};
  p.indices=accessor(indices,'SCALAR',5125);p.material=0;
}
g.skins[0].inverseBindMatrices=accessor(gltfAccessor(body,body.json.skins[0].inverseBindMatrices),'MAT4');
const jointIndex=name=>g.skins[0].joints.findIndex(n=>g.nodes[n].name===name);
function addMesh(name,positions,normals,colors,joints,weights,indices){
  const mesh=g.meshes.length;g.meshes.push({name,primitives:[{attributes:{POSITION:accessor(positions,'VEC3'),NORMAL:accessor(normals,'VEC3'),COLOR_0:accessor(colors,'VEC3'),JOINTS_0:accessor(joints,'VEC4',5123),WEIGHTS_0:accessor(weights,'VEC4')},indices:accessor(indices,'SCALAR',5125),material:0}]});
  const node=g.nodes.length;g.nodes.push({name,mesh,skin:0});g.nodes[g.scenes[0].nodes[0]].children.push(node);
}
const hp=hair.json.meshes[0].primitives[0],hairPos=gltfAccessor(hair,hp.attributes.POSITION),hairNorm=gltfAccessor(hair,hp.attributes.NORMAL),hc=[],hj=[],hw=[];
// Hair exports use different node transforms; bake their centimetre/Z-up frame.
const hairNode=hair.json.nodes.find(n=>n.mesh===0),hairMatrix=gltfTRS(new Float32Array(16),hairNode.translation??[0,0,0],hairNode.rotation??[0,0,0,1],hairNode.scale??[1,1,1]);
for(let i=0;i<hairPos.length;i+=3){
  for(const [values,w] of [[hairPos,1],[hairNorm,0]]){
    const x=values[i],y=values[i+1],z=values[i+2];
    for(let k=0;k<3;k++)values[i+k]=hairMatrix[k]*x+hairMatrix[4+k]*y+hairMatrix[8+k]*z+hairMatrix[12+k]*w;
    if(!w){const length=Math.hypot(values[i],values[i+1],values[i+2]);for(let k=0;k<3;k++)values[i+k]/=length;}
  }
}
for(let i=0;i<hairPos.length/3;i++){hc.push(...hairColor);hj.push(jointIndex('Head'),0,0,0);hw.push(1,0,0,0);}
addMesh(female?'Tied hair':'Parted hair',hairPos,hairNorm,hc,hj,hw,gltfAccessor(hair,hp.indices));
// A belt finishes the short linen shirt; no rigid skirt that clips raised legs.
function garmentWeights(point){
  const {pos,joints,weights}=clothedBody,nearest=[];
  for(let i=0;i<pos.length/3;i++){
    const d=[0,1,2].reduce((sum,k)=>sum+(pos[i*3+k]-point[k])**2,0);
    if(nearest.length===4&&d>=nearest[3].d)continue;
    nearest.push({i,d});nearest.sort((a,b)=>a.d-b.d);nearest.length=Math.min(4,nearest.length);
  }
  const influence=new Map();
  for(const {i,d} of nearest)for(let k=0;k<4;k++){
    const j=joints[i*4+k],w=weights[i*4+k]/Math.max(d,1e-6);
    influence.set(j,(influence.get(j)??0)+w);
  }
  const top=[...influence].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((n,v)=>n+v[1],0);
  while(top.length<4)top.push([0,0]);
  return {joints:top.map(v=>v[0]),weights:top.map(v=>v[1]/sum)};
}
for(const [name,rings,color] of [
  ['Leather belt',female?[[.97,.174,.15],[1.01,.174,.15]]:[[.995,.191,.15],[1.035,.191,.15]],leather],
]){
  const pos=[],normal=[],col=[],joint=[],weight=[],idx=[],N=24;
  for(const [y,rx,rz] of rings)for(let i=0;i<N;i++){
    const a=i/N*Math.PI*2,c=Math.cos(a),s=Math.sin(a),radius=(Math.abs(c/rx)**2.5+Math.abs(s/rz)**2.5)**(-1/2.5);
    const point=[radius*c,y,radius*s-.027],binding=garmentWeights(point);
    pos.push(...point);const len=Math.hypot(c/rx,s/rz);normal.push(c/rx/len,0,s/rz/len);col.push(...color);
    joint.push(...binding.joints);weight.push(...binding.weights);
  }
  for(let r=0;r<rings.length-1;r++)for(let i=0;i<N;i++){const j=(i+1)%N,a=r*N+i,b=r*N+j;idx.push(a,b,a+N,b,b+N,a+N);}
  addMesh(name,pos,normal,col,joint,weight,idx);
}

// Rolled cuffs, knee garters and a sewn neck band give the 1550-1650 slop-shirt
// and Venetian slops actual cloth edges.
function clothBand(name,rings,N,point,jointName,bandColor=linen){
  const pos=[],norm=[],col=[],joints=[],weights=[],indices=[];
  for(const [along,radius] of rings)for(let i=0;i<N;i++){
    const angle=i/N*Math.PI*2,p=point(along,radius,angle);
    pos.push(...p);norm.push(0,1,0);col.push(...bandColor);joints.push(jointIndex(jointName),0,0,0);weights.push(1,0,0,0);
  }
  for(let r=0;r<rings.length-1;r++)for(let i=0;i<N;i++){const a=r*N+i,b=r*N+(i+1)%N;indices.push(a,a+N,b,b,a+N,b+N);}
  addMesh(name,pos,surfaceNormals(new Float32Array(pos),new Uint32Array(indices),new Float32Array(norm)),col,joints,weights,indices);
}
for(const [side,sign] of [['l',1],['r',-1]]){
  const elbow=Array.from(targetPlayer.world[targetPlayer.names.indexOf('lowerarm_'+side)].subarray(12,15));
  const wrist=Array.from(targetPlayer.world[targetPlayer.names.indexOf('hand_'+side)].subarray(12,15));
  clothBand('Rolled cuff '+side,[[.83,.043],[.85,.047],[.95,.047],[.98,.042]],12,(t,r,a)=>{
    const center=elbow.map((v,k)=>v+(wrist[k]-v)*t),radius=r*(female?.91:1);
    return [center[0],center[1]+Math.cos(a)*radius,center[2]+Math.sin(a)*radius*sign];
  },'lowerarm_'+side);
  const knee=Array.from(targetPlayer.world[targetPlayer.names.indexOf('calf_'+side)].subarray(12,15));
  const ankle=Array.from(targetPlayer.world[targetPlayer.names.indexOf('foot_'+side)].subarray(12,15));
  clothBand('Knee garter '+side,[[.17,.070],[.24,.065]],12,(t,r,a)=>{
    const center=knee.map((v,k)=>v+(ankle[k]-v)*t),radius=r*(female?.91:1);
    return [center[0]+Math.cos(a)*radius,center[1],center[2]+Math.sin(a)*radius-.012];
  },'calf_'+side,leather);
}
const neck=Array.from(targetPlayer.world[targetPlayer.names.indexOf('neck_01')].subarray(12,15));
clothBand('Linen neck band',[[female?1.488:1.538,1],[female?1.498:1.55,1.055],[female?1.516:1.566,1]],16,(y,r,a)=>[
  Math.cos(a)*(female?.061:.067)*r,y,neck[2]+Math.sin(a)*(female?.057:.062)*r,
],'neck_01');

// Retarget rotation in model space, retaining target bone lengths. Matching
// names alone is insufficient: these two exports have different rest rotations.
const qidentity=[0,0,0,1],inverse=q=>[-q[0],-q[1],-q[2],q[3]],mul=(a,b)=>gltfQuatMultiply(new Float32Array(4),a,b);
function globalRotations(player,pose){const q=[];for(const i of player.order)q[i]=mul(player.parent[i]<0?qidentity:q[player.parent[i]],pose[i].r);return q;}
const sourceRest=globalRotations(sourcePlayer,sourcePlayer.rest),targetRest=globalRotations(targetPlayer,targetPlayer.rest);
const names=new Map(animation.json.nodes.map((n,i)=>[n.name,i]));
const mapped=body.json.nodes.map(n=>names.get(n.name));
const clips=[['Idle_Loop','Idle'],['Walk_Loop','Walk'],['Crouch_Idle_Loop','Brace']];
for(const [sourceName,name] of clips){
  const duration=sourcePlayer.clips.get(sourceName).duration,steps=Math.max(2,Math.round(duration*30)),times=Float32Array.from({length:steps+1},(_,i)=>duration*i/steps);
  const tracks=body.json.nodes.map(()=>({r:[],t:[]}));
  for(let frame=0;frame<=steps;frame++){
    sourcePlayer.sample(sourceName,frame===steps?0:times[frame]);const sourceQ=globalRotations(sourcePlayer,sourcePlayer.pose),targetQ=[];
    for(const i of targetPlayer.order){
      const si=mapped[i],parent=targetPlayer.parent[i],parentQ=parent<0?qidentity:targetQ[parent];
      let q=targetPlayer.rest[i].r;
      if(si!==undefined){targetQ[i]=mul(mul(sourceQ[si],inverse(sourceRest[si])),targetRest[i]);q=mul(inverse(parentQ),targetQ[i]);}
      else targetQ[i]=mul(parentQ,q);
      gltfSlerp(q,q,q,0);tracks[i].r.push(...q);
      const t=Array.from(targetPlayer.rest[i].t);
      if(si!==undefined && ['pelvis','root'].includes(body.json.nodes[i].name))for(let k=0;k<3;k++)t[k]+=(sourcePlayer.pose[si].t[k]-sourcePlayer.rest[si].t[k])*1.04;
      tracks[i].t.push(...t);
    }
  }
  const clip={name,channels:[],samplers:[]};let input;
  for(let i=0;i<tracks.length;i++)for(const [key,kind,n] of [['r','rotation',4],['t','translation',3]]){
    const values=tracks[i][key],rest=targetPlayer.rest[i][key];
    if(values.every((x,k)=>Math.abs(x-rest[k%n])<1e-5))continue;
    input??=accessor(times,'SCALAR');const output=accessor(values,n===4?'VEC4':'VEC3');
    clip.channels.push({sampler:clip.samplers.length,target:{node:i,path:kind}});clip.samplers.push({input,output,interpolation:'LINEAR'});
  }
  g.animations.push(clip);
}
g.asset={version:'2.0',generator:'waterworld/scripts/prepare-crew.mjs',copyright:'Quaternius and Gonzalo Furnier (CC0); sailor adaptation CC0'};
g.extras={sourceRevision:revision,clips:clips.map(c=>c[0]),workwearRevision:3,note:'Neutral body/face base with 1550-1650 mariner slop-shirt, knee-gathered Venetian slops, knitted hose and low leather shoes'};
g.buffers=[{byteLength}];const bin=Buffer.concat(buffers);
let json=Buffer.from(JSON.stringify(g));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
const out=new URL('../assets/crew/'+(female?'sailor-female.glb':'sailor.glb'),import.meta.url);await fs.mkdir(new URL('../assets/crew/',import.meta.url),{recursive:true});
const output=Buffer.concat([header,json,bh,bin]);await fs.writeFile(out,output);
console.log(female?'Female sailor GLB:':'Male sailor GLB:',output.length,'bytes;',g.animations.map(a=>a.name).join(', '));
}
