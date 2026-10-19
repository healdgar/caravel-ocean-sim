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
const skin=[.36,.18,.10],linen=[.55,.47,.31],trousers=[.095,.12,.15],leather=[.055,.025,.012],hairColor=[.045,.019,.009];
targetPlayer.sample(null,0);
// Reduce the superhero bulk around existing bone axes, preserving joint lengths,
// hands, head and feet. The same weights still drive every animation and IK grip.
const limbEnds={upperarm:'lowerarm',lowerarm:'hand',thigh:'calf',calf:'foot'};
const slimAxes=targetPlayer.joints.map(node=>{
  const name=targetPlayer.names[node],start=Array.from(targetPlayer.world[node].subarray(12,15));
  const match=/^(upperarm|lowerarm|thigh|calf)_([lr])$/.exec(name);
  if(match){
    const endNode=targetPlayer.names.indexOf(limbEnds[match[1]]+'_'+match[2]);
    const end=Array.from(targetPlayer.world[endNode].subarray(12,15));
    return {start,axis:end.map((v,i)=>v-start[i]),scale:{upperarm:.86,lowerarm:.93,thigh:.94,calf:.96}[match[1]]};
  }
  if(/^(spine_|pelvis|clavicle)/.test(name))return {start,axis:[0,1,0],scale:.91,chest:/^spine_0[23]$/.test(name)};
  return null;
});
function slimBody(pos,joints,weights){
  for(let i=0;i<pos.length/3;i++){
    const original=Array.from(pos.subarray(i*3,i*3+3)),delta=[0,0,0];
    for(let k=0;k<4;k++){
      const bone=slimAxes[joints[i*4+k]],weight=weights[i*4+k];if(!bone||weight===0)continue;
      const {start,axis,scale,chest}=bone,q=original.map((v,j)=>v-start[j]);
      const along=q.reduce((s,v,j)=>s+v*axis[j],0)/axis.reduce((s,v)=>s+v*v,0);
      for(let j=0;j<3;j++)delta[j]+=(q[j]-axis[j]*along)*(scale-1)*weight;
      // Flatten the pronounced front-chest contour without compressing the back.
      if(chest)delta[2]-=Math.max(0,q[2])*(female?.22:.12)*weight;
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
  for(let i=0;i<normals.length;i+=3){const length=Math.hypot(...normals.subarray(i,i+3));for(let k=0;k<3;k++)normals[i+k]=length>1e-10?normals[i+k]/length:fallback[i+k];}
  return normals;
}
// Simple authored tunic, breeches and shoes. These colours are linear, not sRGB.
for(let mi=0;mi<g.meshes.length;mi++)for(const p of g.meshes[mi].primitives){
  const old=body.json.meshes[mi].primitives[0],pos=gltfAccessor(body,old.attributes.POSITION),norm=gltfAccessor(body,old.attributes.NORMAL);
  const colors=new Float32Array(pos.length);
  for(let i=0;i<pos.length;i+=3){
    const x=pos[i],y=pos[i+1],z=pos[i+2];let color=skin,inflate=0;
    if(mi===0)color=hairColor;
    else if(mi===1){const cx=Math.abs(x)-.029;const iris=cx*cx+(y-(female?1.656:1.699))**2<.00006 && z>(female?.069:.074);color=iris?[.024,.013,.006]:[.65,.60,.49];}
    else if(y<.23){color=leather;inflate=.012;}
    else if(y<(female?.99:1.015)){color=trousers;inflate=.012;}
    else if((y<(female?1.49:1.565) || Math.abs(x)>.12) && Math.abs(x)<(female?.63:.69)){color=linen;inflate=.012;}
    colors.set(color,i);for(let k=0;k<3;k++)pos[i+k]+=norm[i+k]*inflate;
  }
  const joints=gltfAccessor(body,old.attributes.JOINTS_0),weights=gltfAccessor(body,old.attributes.WEIGHTS_0),indices=gltfAccessor(body,old.indices);
  if(mi===2)slimBody(pos,joints,weights);
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
for(const [name,rings,color] of [
  ['Leather belt',female?[[.97,.151,.129],[1.01,.151,.129]]:[[.995,.184,.144],[1.035,.184,.144]],leather],
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
g.extras={sourceRevision:revision,clips:clips.map(c=>c[0]),note:'Slimmed body around preserved bones, authored clothing and retargeted animation; no historical costume calibration'};
g.buffers=[{byteLength}];const bin=Buffer.concat(buffers);
let json=Buffer.from(JSON.stringify(g));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
const out=new URL('../assets/crew/'+(female?'sailor-female.glb':'sailor.glb'),import.meta.url);await fs.mkdir(new URL('../assets/crew/',import.meta.url),{recursive:true});
const output=Buffer.concat([header,json,bh,bin]);await fs.writeFile(out,output);
console.log(female?'Female sailor GLB:':'Male sailor GLB:',output.length,'bytes;',g.animations.map(a=>a.name).join(', '));
}
