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
const animation=readGLB(data['UAL1.glb']),sourcePlayer=createSkinAnimator(animation),oldPlayer=createSkinAnimator(body);
oldPlayer.sample(null,0);

// Reshape the comic-book Superhero rig (0.424 m shoulders, 0.229 m hips, 1:8.8 pinhead,
// female forearm > upperarm & crushed neck) into realistic adult human proportions:
// ~1.73 m male / ~1.65 m female, ~1:7.7 head-to-height, 0.35 m / 0.32 m shoulder span,
// upperarm > lowerarm (0.27 m / 0.24 m male, 0.255 m / 0.226 m female), ~0.19 m hip span.
const anatomicalJoints=female?{
  root:[0,0,0],
  pelvis:[0,.8620,-.0400],
  spine_01:[0,.9640,-.0130],
  spine_02:[0,1.0780,-.0020],
  spine_03:[0,1.2080,-.0010],
  neck_01:[0,1.3520,-.0320],
  Head:[0,1.4380,-.0120],
  clavicle_l:[.0250,1.3360,.0080],
  upperarm_l:[.1600,1.3160,-.0420],
  lowerarm_l:[.4150,1.3160,-.0470],
  hand_l:[.6410,1.3160,-.0420],
  thigh_l:[.0940,.8760,-.0420],
  calf_l:[.0940,.4620,-.0280],
  foot_l:[.0940,.0680,-.0680],
  ball_l:[.0940,.0140,.0560],
  ball_leaf_l:[.0940,.0140,.1200],
}:{
  root:[0,0,0],
  pelvis:[0,.9000,-.0380],
  spine_01:[0,1.0050,-.0080],
  spine_02:[0,1.1250,.0030],
  spine_03:[0,1.2650,.0050],
  neck_01:[0,1.4180,-.0360],
  Head:[0,1.5050,-.0160],
  clavicle_l:[.0270,1.4020,.0120],
  upperarm_l:[.1750,1.3800,-.0450],
  lowerarm_l:[.4450,1.3800,-.0520],
  hand_l:[.6850,1.3800,-.0450],
  thigh_l:[.0950,.9160,-.0320],
  calf_l:[.0950,.4820,-.0320],
  foot_l:[.0950,.0780,-.0780],
  ball_l:[.0950,.0145,.0540],
  ball_leaf_l:[.0950,.0145,.1260],
};
for(const [k,v] of Object.entries({...anatomicalJoints})){
  if(k.endsWith('_l'))anatomicalJoints[k.slice(0,-2)+'_r']=[-v[0],v[1],v[2]];
}
const handScale=female?.80:.76;
const oldNodePos=body.json.nodes.map((_,i)=>Array.from(oldPlayer.world[i].subarray(12,15)));
const newNodePos=oldNodePos.map(p=>p.slice());
for(const i of oldPlayer.order){
  const name=body.json.nodes[i].name;
  if(anatomicalJoints[name])newNodePos[i]=anatomicalJoints[name].slice();
  else{
    const fMatch=/^(index|middle|ring|pinky|thumb)_0[1234](?:_leaf)?_([lr])$/.exec(name);
    if(fMatch){
      const side=fMatch[2],hIdx=oldPlayer.names.indexOf('hand_'+side);
      newNodePos[i]=newNodePos[hIdx].map((hv,k)=>hv+(oldNodePos[i][k]-oldNodePos[hIdx][k])*handScale);
    }
  }
}
// Preserve every joint's rest world orientation R_world while updating node.translation so W_rest[i].pos === newNodePos[i].
for(const i of oldPlayer.order){
  if(!oldPlayer.joints.includes(i))continue;
  const p=oldPlayer.parent[i];
  const pPos=p<0?[0,0,0]:newNodePos[p],pw=p<0?[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]:oldPlayer.world[p];
  const d=[newNodePos[i][0]-pPos[0],newNodePos[i][1]-pPos[1],newNodePos[i][2]-pPos[2]];
  // R_parent^T * d (columns of pw are rows of R_parent^T)
  body.json.nodes[i].translation=[
    pw[0]*d[0]+pw[1]*d[1]+pw[2]*d[2],
    pw[4]*d[0]+pw[5]*d[1]+pw[6]*d[2],
    pw[8]*d[0]+pw[9]*d[1]+pw[10]*d[2],
  ];
}
const targetPlayer=createSkinAnimator(body);
targetPlayer.sample(null,0);

function invertMat4(m){
  const a=Float64Array.from(m),inv=new Float64Array(16);
  inv[0]=a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  inv[4]=-a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  inv[8]=a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  inv[12]=-a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  inv[1]=-a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  inv[5]=a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  inv[9]=-a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  inv[13]=a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  inv[2]=a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  inv[6]=-a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  inv[10]=a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  inv[14]=-a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  inv[3]=-a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  inv[7]=a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  inv[11]=-a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  inv[15]=a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  const det=a[0]*inv[0]+a[1]*inv[4]+a[2]*inv[8]+a[3]*inv[12];
  return Float32Array.from(inv,v=>v/det);
}
function rotBetween(u,v){
  const ul=Math.hypot(...u)||1,vl=Math.hypot(...v)||1;
  const a=u.map(x=>x/ul),b=v.map(x=>x/vl);
  const cx=a[1]*b[2]-a[2]*b[1],cy=a[2]*b[0]-a[0]*b[2],cz=a[0]*b[1]-a[1]*b[0];
  const c=a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  if(c<-.9999)return [1,0,0, 0,-1,0, 0,0,-1];
  const k=1/(1+c);
  return [
    1-(cy*cy+cz*cz)*k, cx*cy*k-cz, cx*cz*k+cy,
    cx*cy*k+cz, 1-(cx*cx+cz*cz)*k, cy*cz*k-cx,
    cx*cz*k-cy, cy*cz*k+cx, 1-(cx*cx+cy*cy)*k,
  ];
}
const applyR=(R,v)=>[R[0]*v[0]+R[1]*v[1]+R[2]*v[2],R[3]*v[0]+R[4]*v[1]+R[5]*v[2],R[6]*v[0]+R[7]*v[1]+R[8]*v[2]];
const chainNext={
  pelvis:'spine_01',spine_01:'spine_02',spine_02:'spine_03',spine_03:'neck_01',neck_01:'Head',
  clavicle_l:'upperarm_l',upperarm_l:'lowerarm_l',lowerarm_l:'hand_l',
  clavicle_r:'upperarm_r',upperarm_r:'lowerarm_r',lowerarm_r:'hand_r',
  thigh_l:'calf_l',calf_l:'foot_l',foot_l:'ball_l',ball_l:'ball_leaf_l',
  thigh_r:'calf_r',calf_r:'foot_r',foot_r:'ball_r',ball_r:'ball_leaf_r',
};
const oldEyeY=female?1.6560:1.6990,newEyeY=female?1.5290:1.6020;
const headScaleY=female?.985:1.037,headScaleXZ=female?.970:1.015;
const jointDeforms=targetPlayer.joints.map(node=>{
  const name=targetPlayer.names[node],a=oldNodePos[node],b=Array.from(targetPlayer.world[node].subarray(12,15));
  if(name==='Head')return {kind:'head',a,b};
  if(/^(hand|index|middle|ring|pinky|thumb)_/.test(name)){
    const side=name.slice(-1),hNode=oldPlayer.names.indexOf('hand_'+side);
    return {kind:'hand',a:oldNodePos[hNode],b:Array.from(targetPlayer.world[hNode].subarray(12,15))};
  }
  const refName=name.startsWith('ball_leaf_')?'ball_'+name.slice(-1):name;
  const nxtName=chainNext[refName];
  if(nxtName){
    const refNode=oldPlayer.names.indexOf(refName),nxtNode=oldPlayer.names.indexOf(nxtName);
    const oa=oldNodePos[refNode],ob=oldNodePos[nxtNode];
    const na=Array.from(targetPlayer.world[refNode].subarray(12,15)),nb=Array.from(targetPlayer.world[nxtNode].subarray(12,15));
    const od=ob.map((v,k)=>v-oa[k]),nd=nb.map((v,k)=>v-na[k]);
    const olen=Math.hypot(...od)||1,nlen=Math.hypot(...nd)||1;
    const u=od.map(v=>v/olen),R=rotBetween(od,nd),stretch=name.startsWith('ball_leaf_')?1:nlen/olen;
    const isTorso=/^(pelvis|spine_)/.test(name),isLowerArm=name.startsWith('lowerarm_');
    return {kind:'chain',a:oa,b:na,u,olen,R,stretch,isTorso,isLowerArm};
  }
  return {kind:'shift',a,b};
});
function mapHeadPoint(p,a,b){
  return [b[0]+(p[0]-a[0])*headScaleXZ,newEyeY+(p[1]-oldEyeY)*headScaleY,b[2]+(p[2]-a[2])*headScaleXZ];
}
function deformToAnatomical(pos,joints,weights){
  for(let i=0;i<pos.length/3;i++){
    const p=[pos[i*3],pos[i*3+1],pos[i*3+2]],out=[0,0,0];
    let wSum=0;
    for(let k=0;k<4;k++){
      const w=weights[i*4+k];if(w<=0)continue;
      wSum+=w;
      const d=jointDeforms[joints[i*4+k]];
      let moved;
      if(d.kind==='head')moved=mapHeadPoint(p,d.a,d.b);
      else if(d.kind==='hand')moved=d.b.map((bv,j)=>bv+(p[j]-d.a[j])*handScale);
      else if(d.kind==='chain'){
        const rel=p.map((pv,j)=>pv-d.a[j]);
        const along=rel[0]*d.u[0]+rel[1]*d.u[1]+rel[2]*d.u[2];
        const perp=rel.map((rv,j)=>rv-d.u[j]*along);
        let radScale=[.93,.93,.93];
        if(d.isTorso)radScale=[female?.89:.84,.93,.92];
        else if(d.isLowerArm){
          const tArm=Math.max(0,Math.min(1,(along/d.olen-.70)/.30));
          const s=0.93+(handScale-0.93)*tArm*tArm*(3-2*tArm);
          radScale=[s,s,s];
        }
        const local=[d.u[0]*along*d.stretch+perp[0]*radScale[0],d.u[1]*along*d.stretch+perp[1]*radScale[1],d.u[2]*along*d.stretch+perp[2]*radScale[2]];
        const rot=applyR(d.R,local);
        moved=[d.b[0]+rot[0],d.b[1]+rot[1],d.b[2]+rot[2]];
      }else moved=d.b.map((bv,j)=>bv+(p[j]-d.a[j]));
      for(let j=0;j<3;j++)out[j]+=moved[j]*w;
    }
    if(wSum>0)for(let j=0;j<3;j++)pos[i*3+j]=out[j]/wSum;
  }
}

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
// Reduce the superhero bulk around original bone axes and neutralize exaggerated
// jaw/brow features BEFORE deforming onto the anatomical skeleton.
const limbEnds={upperarm:'lowerarm',lowerarm:'hand',thigh:'calf',calf:'foot'};
const oldHeadCenter=oldNodePos[oldPlayer.names.indexOf('Head')];
const oldSlimAxes=oldPlayer.joints.map(node=>{
  const name=oldPlayer.names[node],start=oldNodePos[node];
  const match=/^(upperarm|lowerarm|thigh|calf)_([lr])$/.exec(name);
  if(match){
    const endNode=oldPlayer.names.indexOf(limbEnds[match[1]]+'_'+match[2]);
    const end=oldNodePos[endNode];
    return {start,axis:end.map((v,i)=>v-start[i]),scale:{upperarm:.84,lowerarm:.91,thigh:.93,calf:.94}[match[1]]};
  }
  if(/^(spine_|pelvis|clavicle|neck_)/.test(name))return {start,axis:[0,1,0],scale:name.startsWith('neck_')?(female?.94:.89):.90,chest:/^spine_0[23]$/.test(name)};
  return null;
});
const newSlimAxes=targetPlayer.joints.map(node=>{
  const name=targetPlayer.names[node],start=Array.from(targetPlayer.world[node].subarray(12,15));
  const match=/^(upperarm|lowerarm|thigh|calf)_([lr])$/.exec(name);
  if(match){
    const endNode=targetPlayer.names.indexOf(limbEnds[match[1]]+'_'+match[2]);
    const end=Array.from(targetPlayer.world[endNode].subarray(12,15));
    return {start,axis:end.map((v,i)=>v-start[i])};
  }
  return null;
});
const clamp01=x=>Math.max(0,Math.min(1,x));
const smooth=(lo,hi,x)=>{const t=clamp01((x-lo)/(hi-lo));return t*t*(3-2*t);};
function slimBody(pos,joints,weights){
  for(let i=0;i<pos.length/3;i++){
    const original=Array.from(pos.subarray(i*3,i*3+3)),delta=[0,0,0];
    let headWeight=0;
    for(let k=0;k<4;k++){
      const node=oldPlayer.joints[joints[i*4+k]],name=oldPlayer.names[node],weight=weights[i*4+k];
      if(name==='Head')headWeight+=weight;
      const bone=oldSlimAxes[joints[i*4+k]];if(!bone||weight===0)continue;
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
      delta[0]-=(original[0]-oldHeadCenter[0])*(.045+.055*jawBand)*headWeight;
      delta[2]-=Math.max(0,original[2]-oldHeadCenter[2])*(.035*jawBand+.05*browBand)*headWeight;
    }
    for(let j=0;j<3;j++)pos[i*3+j]+=delta[j];
  }
}
// Shape the clothed surface as 1550-1650 mariner attire on the anatomical frame:
// a bloused canvas/linen slop-shirt, wide knee-gathered Venetian slops (galligaskins),
// fitted wool stockings/hose on the lower calf, and low leather shoes.
function drapeWorkwear(pos,colors,joints,weights){
  const waist=female?.918:.958,shoulder=female?1.368:1.436;
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
      const bone=newSlimAxes[joints[i*4+k]],q=p.map((v,j)=>v-bone.start[j]),length=Math.hypot(...bone.axis);
      const t=q.reduce((s,v,j)=>s+v*bone.axis[j],0)/(length*length),tc=clamp01(t);
      const radial=q.map((v,j)=>v-bone.axis[j]*t),radius=Math.hypot(...radial);if(radius<.001)continue;
      const ang=Math.atan2(radial[2],radial[0]);
      const ends={upperarm:[.062,.051],lowerarm:[.052,.037],thigh:[.104,.080],calf:[.074,.051]}[part];
      let fit=(ends[0]+(ends[1]-ends[0])*tc)*(female?.91:1);
      if(part==='lowerarm')fit+=(.0050+.0014*Math.cos(ang*8))*Math.sin(Math.PI*tc)*(1-smooth(.82,.98,tc));
      else if(part==='thigh')fit+=(.010+.0028*Math.cos(ang*10))*Math.sin(Math.PI*tc);
      else if(part==='calf')fit+=pants?(.007+.0018*Math.cos(ang*8))*(1-smooth(.10,.28,tc)):0;
      const blend=arm?.9:smooth(.04,.28,t)*.78;
      const change=Math.max(-.012,Math.min(.020,fit-radius))*w*blend;
      for(let j=0;j<3;j++)delta[j]+=radial[j]/radius*change;
    }
    if(shirt&&torso>.01){
      const t=clamp01((p[1]-waist)/(shoulder-waist));
      const rx=(female?.134:.150)+(female?.026:.030)*smooth(.15,.85,t);
      const rz=(female?.104:.116)+.013*smooth(.25,.8,t),center=-.024;
      const angle=Math.atan2(p[2]-center,p[0]),c=Math.cos(angle),s=Math.sin(angle),power=2.5;
      const radius=(Math.abs(c/rx)**power+Math.abs(s/rz)**power)**(-1/power);
      const fold=1+.013*Math.cos(angle*10+t*2.2)*Math.sin(Math.PI*t);
      const blend=torso*(1-smooth(shoulder-.065,shoulder+.022,p[1]));
      delta[0]+=(c*radius*fold-p[0])*blend;
      delta[2]+=(center+s*radius*fold-p[2])*blend;
    }
    if(pants){
      // Venetian slops bridge the seat and groin into one pleated cloth envelope,
      // blending into full knee-gathered breeches legs below the pelvis.
      const crotch=female?.792:.832,center=-.024;
      const upper=smooth(crotch-.015,crotch+.042,p[1]);
      const t=clamp01((p[1]-crotch)/(waist-crotch));
      const waistRadius=female?.134:.150;
      const rx=(female?.162:.175)+(waistRadius-(female?.162:.175))*smooth(.5,1,t);
      const rz=p[2]>=center
        ?.046+((female?.104:.116)-.046)*smooth(0,.85,t)
        :(female?.104:.116)+.016*Math.sin(Math.PI*t);
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
  if(mi===2){
    slimBody(pos,joints,weights);
    deformToAnatomical(pos,joints,weights);
    drapeWorkwear(pos,colors,joints,weights);
    clothedBody={pos,joints,weights};
  }else{
    deformToAnatomical(pos,joints,weights);
  }
  p.attributes={POSITION:accessor(pos,'VEC3'),NORMAL:accessor(surfaceNormals(pos,indices,norm),'VEC3'),COLOR_0:accessor(colors,'VEC3'),
    JOINTS_0:accessor(joints,'VEC4',5123),WEIGHTS_0:accessor(weights,'VEC4')};
  p.indices=accessor(indices,'SCALAR',5125);p.material=0;
}
const ibmValues=new Float32Array(targetPlayer.joints.length*16);
for(let j=0;j<targetPlayer.joints.length;j++){
  ibmValues.set(invertMat4(targetPlayer.world[targetPlayer.joints[j]]),j*16);
}
g.skins[0].inverseBindMatrices=accessor(ibmValues,'MAT4');
const jointIndex=name=>g.skins[0].joints.findIndex(n=>g.nodes[n].name===name);
function addMesh(name,positions,normals,colors,joints,weights,indices){
  const mesh=g.meshes.length;g.meshes.push({name,primitives:[{attributes:{POSITION:accessor(positions,'VEC3'),NORMAL:accessor(normals,'VEC3'),COLOR_0:accessor(colors,'VEC3'),JOINTS_0:accessor(joints,'VEC4',5123),WEIGHTS_0:accessor(weights,'VEC4')},indices:accessor(indices,'SCALAR',5125),material:0}]});
  const node=g.nodes.length;g.nodes.push({name,mesh,skin:0});g.nodes[g.scenes[0].nodes[0]].children.push(node);
}
const hp=hair.json.meshes[0].primitives[0],hairPos=gltfAccessor(hair,hp.attributes.POSITION),hairNorm=gltfAccessor(hair,hp.attributes.NORMAL),hc=[],hj=[],hw=[];
// Hair exports use different node transforms; bake their centimetre/Z-up frame and map onto anatomical Head.
const hairNode=hair.json.nodes.find(n=>n.mesh===0),hairMatrix=gltfTRS(new Float32Array(16),hairNode.translation??[0,0,0],hairNode.rotation??[0,0,0,1],hairNode.scale??[1,1,1]);
const headNode=targetPlayer.names.indexOf('Head'),oldHeadPos=oldNodePos[headNode],newHeadPos=Array.from(targetPlayer.world[headNode].subarray(12,15));
for(let i=0;i<hairPos.length;i+=3){
  for(const [values,w] of [[hairPos,1],[hairNorm,0]]){
    const x=values[i],y=values[i+1],z=values[i+2];
    for(let k=0;k<3;k++)values[i+k]=hairMatrix[k]*x+hairMatrix[4+k]*y+hairMatrix[8+k]*z+hairMatrix[12+k]*w;
    if(!w){
      values[i]/=headScaleXZ;values[i+1]/=headScaleY;values[i+2]/=headScaleXZ;
      const length=Math.hypot(values[i],values[i+1],values[i+2])||1;
      for(let k=0;k<3;k++)values[i+k]/=length;
    }
  }
  const mappedHair=mapHeadPoint([hairPos[i],hairPos[i+1],hairPos[i+2]],oldHeadPos,newHeadPos);
  hairPos[i]=mappedHair[0];hairPos[i+1]=mappedHair[1];hairPos[i+2]=mappedHair[2];
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
  ['Leather belt',female?[[.898,.139,.109],[.934,.139,.109]]:[[.938,.155,.121],[.976,.155,.121]],leather],
]){
  const pos=[],normal=[],col=[],joint=[],weight=[],idx=[],N=24;
  for(const [y,rx,rz] of rings)for(let i=0;i<N;i++){
    const a=i/N*Math.PI*2,c=Math.cos(a),s=Math.sin(a),radius=(Math.abs(c/rx)**2.5+Math.abs(s/rz)**2.5)**(-1/2.5);
    const point=[radius*c,y,radius*s-.024],binding=garmentWeights(point);
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
  clothBand('Rolled cuff '+side,[[.83,.041],[.85,.045],[.95,.045],[.98,.040]],12,(t,r,a)=>{
    const center=elbow.map((v,k)=>v+(wrist[k]-v)*t),radius=r*(female?.91:1);
    return [center[0],center[1]+Math.cos(a)*radius,center[2]+Math.sin(a)*radius*sign];
  },'lowerarm_'+side);
  const knee=Array.from(targetPlayer.world[targetPlayer.names.indexOf('calf_'+side)].subarray(12,15));
  const ankle=Array.from(targetPlayer.world[targetPlayer.names.indexOf('foot_'+side)].subarray(12,15));
  clothBand('Knee garter '+side,[[.17,.068],[.24,.063]],12,(t,r,a)=>{
    const center=knee.map((v,k)=>v+(ankle[k]-v)*t),radius=r*(female?.91:1);
    return [center[0]+Math.cos(a)*radius,center[1],center[2]+Math.sin(a)*radius-.012];
  },'calf_'+side,leather);
}
const neck=Array.from(targetPlayer.world[targetPlayer.names.indexOf('neck_01')].subarray(12,15));
clothBand('Linen neck band',[[female?1.346:1.412,1],[female?1.357:1.424,1.05],[female?1.370:1.438,1]],16,(y,r,a)=>[
  Math.cos(a)*(female?.053:.059)*r,y,neck[2]+Math.sin(a)*(female?.050:.055)*r,
],'neck_01');

// Retarget rotation in model space, retaining target bone lengths. Matching
// names alone is insufficient: these two exports have different rest rotations.
sourcePlayer.sample(null,0);
const qidentity=[0,0,0,1],inverse=q=>[-q[0],-q[1],-q[2],q[3]],mul=(a,b)=>gltfQuatMultiply(new Float32Array(4),a,b);
function globalRotations(player,pose){const q=[];for(const i of player.order)q[i]=mul(player.parent[i]<0?qidentity:q[player.parent[i]],pose[i].r);return q;}
const sourceRest=globalRotations(sourcePlayer,sourcePlayer.rest),targetRest=globalRotations(targetPlayer,targetPlayer.rest);
const names=new Map(animation.json.nodes.map((n,i)=>[n.name,i]));
const mapped=body.json.nodes.map(n=>names.get(n.name));
const srcPelvisY=sourcePlayer.world[names.get('pelvis')][13]||.94;
const dstPelvisY=targetPlayer.world[targetPlayer.names.indexOf('pelvis')][13];
const hipScale=dstPelvisY/srcPelvisY;
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
      if(si!==undefined && ['pelvis','root'].includes(body.json.nodes[i].name))for(let k=0;k<3;k++)t[k]+=(sourcePlayer.pose[si].t[k]-sourcePlayer.rest[si].t[k])*hipScale;
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
g.extras={sourceRevision:revision,clips:clips.map(c=>c[0]),workwearRevision:4,note:'Anatomical human rig (1:7.7 head, realistic shoulder/limb proportions) with 1550-1650 mariner attire'};
g.buffers=[{byteLength}];const bin=Buffer.concat(buffers);
let json=Buffer.from(JSON.stringify(g));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
const out=new URL('../assets/crew/'+(female?'sailor-female-classic.glb':'sailor-classic.glb'),import.meta.url);await fs.mkdir(new URL('../assets/crew/',import.meta.url),{recursive:true});
const output=Buffer.concat([header,json,bh,bin]);await fs.writeFile(out,output);
console.log(female?'Female sailor GLB:':'Male sailor GLB:',output.length,'bytes;',g.animations.map(a=>a.name).join(', '));
}
