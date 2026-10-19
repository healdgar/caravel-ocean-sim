// Rebuild the locally authored sailor from pinned CC0 data. No downloaded code runs.
// node scripts/prepare-crew.mjs /tmp/waterworld-crew [--download]
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readGLB,gltfAccessor,createSkinAnimator,gltfQuatMultiply,gltfSlerp} from '../js/gltf.js';
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
const body={json:JSON.parse(data['body.gltf']),bin:data['body.bin']},hair={json:JSON.parse(data['hair.gltf']),bin:data['hair.bin']};
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
const skin=[.36,.18,.10],linen=[.55,.47,.31],trousers=[.095,.12,.15],leather=[.055,.025,.012],hairColor=[.045,.019,.009];
// Simple authored tunic, breeches and shoes. These colours are linear, not sRGB.
for(let mi=0;mi<g.meshes.length;mi++)for(const p of g.meshes[mi].primitives){
  const old=body.json.meshes[mi].primitives[0],pos=gltfAccessor(body,old.attributes.POSITION),norm=gltfAccessor(body,old.attributes.NORMAL);
  const colors=new Float32Array(pos.length);
  for(let i=0;i<pos.length;i+=3){
    const x=pos[i],y=pos[i+1],z=pos[i+2];let color=skin,inflate=0;
    if(mi===0)color=hairColor;
    else if(mi===1){const cx=Math.abs(x)-.029;const iris=cx*cx+(y-1.699)**2<.00006 && z>.074;color=iris?[.024,.013,.006]:[.65,.60,.49];}
    else if(y<.23){color=leather;inflate=.012;}
    else if(y<1.015){color=trousers;inflate=.018;}
    else if((y<1.565 || Math.abs(x)>.12) && Math.abs(x)<.69){color=linen;inflate=.032;}
    colors.set(color,i);for(let k=0;k<3;k++)pos[i+k]+=norm[i+k]*inflate;
  }
  p.attributes={POSITION:accessor(pos,'VEC3'),NORMAL:accessor(norm,'VEC3'),COLOR_0:accessor(colors,'VEC3'),
    JOINTS_0:accessor(gltfAccessor(body,old.attributes.JOINTS_0),'VEC4',5123),WEIGHTS_0:accessor(gltfAccessor(body,old.attributes.WEIGHTS_0),'VEC4')};
  p.indices=accessor(gltfAccessor(body,old.indices),'SCALAR',5125);p.material=0;
}
g.skins[0].inverseBindMatrices=accessor(gltfAccessor(body,body.json.skins[0].inverseBindMatrices),'MAT4');
const jointIndex=name=>g.skins[0].joints.findIndex(n=>g.nodes[n].name===name);
function addMesh(name,positions,normals,colors,joints,weights,indices){
  const mesh=g.meshes.length;g.meshes.push({name,primitives:[{attributes:{POSITION:accessor(positions,'VEC3'),NORMAL:accessor(normals,'VEC3'),COLOR_0:accessor(colors,'VEC3'),JOINTS_0:accessor(joints,'VEC4',5123),WEIGHTS_0:accessor(weights,'VEC4')},indices:accessor(indices,'SCALAR',5125),material:0}]});
  const node=g.nodes.length;g.nodes.push({name,mesh,skin:0});g.nodes[g.scenes[0].nodes[0]].children.push(node);
}
const hp=hair.json.meshes[0].primitives[0],hairPos=gltfAccessor(hair,hp.attributes.POSITION),hc=[],hj=[],hw=[];
for(let i=0;i<hairPos.length/3;i++){hc.push(...hairColor);hj.push(jointIndex('Head'),0,0,0);hw.push(1,0,0,0);}
addMesh('Parted hair',hairPos,gltfAccessor(hair,hp.attributes.NORMAL),hc,hj,hw,gltfAccessor(hair,hp.indices));
// A belt finishes the short linen shirt; no rigid skirt that clips raised legs.
for(const [name,rings,color] of [
  ['Leather belt',[[.995,.205,.16],[1.035,.205,.16]],leather],
]){
  const pos=[],normal=[],col=[],joint=[],weight=[],idx=[],N=32;
  for(const [y,rx,rz] of rings)for(let i=0;i<N;i++){
    const a=i/N*Math.PI*2,c=Math.cos(a),s=Math.sin(a),fold=1+.018*Math.cos(a*12);
    pos.push(rx*c*fold,y,rz*s*fold-.015);const len=Math.hypot(c/rx,s/rz);normal.push(c/rx/len,0,s/rz/len);col.push(...color);
    joint.push(jointIndex('pelvis'),jointIndex('spine_01'),0,0);const upper=Math.max(0,(y-.92)*4);weight.push(1-upper,upper,0,0);
  }
  for(let r=0;r<rings.length-1;r++)for(let i=0;i<N;i++){const j=(i+1)%N,a=r*N+i,b=r*N+j;idx.push(a,b,a+N,b,b+N,a+N);}
  addMesh(name,pos,normal,col,joint,weight,idx);
}

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
g.extras={sourceRevision:revision,clips:clips.map(c=>c[0]),note:'Authored clothing and retargeted animation; no historical costume calibration'};
g.buffers=[{byteLength}];const bin=Buffer.concat(buffers);
let json=Buffer.from(JSON.stringify(g));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
const out=new URL('../assets/crew/sailor.glb',import.meta.url);await fs.mkdir(new URL('../assets/crew/',import.meta.url),{recursive:true});
const output=Buffer.concat([header,json,bh,bin]);await fs.writeFile(out,output);
console.log('Sailor GLB:',output.length,'bytes;',g.animations.map(a=>a.name).join(', '));
