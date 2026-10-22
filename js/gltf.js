// Deliberately bounded glTF 2.0 subset for locally prepared crew assets.
// No extensions, sparse data, textures, morph targets or matrix-authored nodes.
export function readGLB(input) {
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<20 || view.getUint32(0,true)!==0x46546c67 || view.getUint32(4,true)!==2 || view.getUint32(8,true)!==bytes.length)throw Error('Invalid GLB header');
  let json,bin;
  for(let at=12;at<bytes.length;){
    if(at+8>bytes.length)throw Error('Truncated GLB chunk');
    const length=view.getUint32(at,true),type=view.getUint32(at+4,true);at+=8;
    if(length%4 || at+length>bytes.length)throw Error('Invalid GLB chunk');
    if(type===0x4e4f534a){if(json || at!==20)throw Error('Invalid GLB JSON order');json=JSON.parse(new TextDecoder().decode(bytes.subarray(at,at+length)));}
    if(type===0x004e4942){if(bin)throw Error('Duplicate GLB buffer');bin=bytes.subarray(at,at+length);}
    at+=length;
  }
  if(!json || !bin || json.asset?.version!=='2.0' || json.buffers?.length!==1 || json.buffers[0].uri || json.buffers[0].byteLength>bin.length)throw Error('Expected embedded glTF 2.0 buffer');
  if(json.extensionsRequired?.length)throw Error('Unsupported glTF extensions');
  return {json,bin};
}

export function gltfAccessor(asset,index) {
  const a=asset.json.accessors?.[index],v=asset.json.bufferViews?.[a?.bufferView];
  const types={5120:[1,'getInt8'],5121:[1,'getUint8'],5122:[2,'getInt16'],5123:[2,'getUint16'],5125:[4,'getUint32'],5126:[4,'getFloat32']};
  const n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[a?.type],type=types[a?.componentType];
  if(!a || !v || !n || !type || a.sparse || v.buffer!==0 || !Number.isSafeInteger(a.count) || a.count<1 || a.count>2000000)throw Error('Unsupported glTF accessor');
  const [size,method]=type,stride=v.byteStride??n*size,offset=a.byteOffset??0,start=(v.byteOffset??0)+offset;
  if(stride<n*size || start<0 || offset<0 || offset+(a.count-1)*stride+n*size>v.byteLength || (v.byteOffset??0)+v.byteLength>asset.bin.length)throw Error('glTF accessor exceeds buffer');
  const view=new DataView(asset.bin.buffer,asset.bin.byteOffset,asset.bin.byteLength),out=new Float32Array(a.count*n);
  for(let i=0;i<a.count;i++)for(let c=0;c<n;c++){
    let value=view[method](start+i*stride+c*size,true);
    if(a.normalized){
      const max={5120:127,5121:255,5122:32767,5123:65535}[a.componentType];
      if(!max)throw Error('Invalid normalized accessor');value=Math.max(-1,value/max);
    }
    if(!Number.isFinite(value))throw Error('Non-finite glTF value');out[i*n+c]=value;
  }
  return out;
}

export function gltfQuatMultiply(out,a,b) {
  const [x,y,z,w]=a,[X,Y,Z,W]=b;
  out[0]=w*X+x*W+y*Z-z*Y;out[1]=w*Y-x*Z+y*W+z*X;
  out[2]=w*Z+x*Y-y*X+z*W;out[3]=w*W-x*X-y*Y-z*Z;return out;
}
export function gltfSlerp(out,a,b,t) {
  let dot=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3],sign=dot<0?-1:1;dot=Math.abs(dot);
  let x=1-t,y=t;
  if(dot<.9995){const angle=Math.acos(Math.min(1,dot)),s=Math.sin(angle);x=Math.sin((1-t)*angle)/s;y=Math.sin(t*angle)/s;}
  let norm=0;for(let i=0;i<4;i++){out[i]=x*a[i]+y*b[i]*sign;norm+=out[i]*out[i];}
  norm=Math.sqrt(norm);if(norm<1e-10)throw Error('Invalid quaternion');for(let i=0;i<4;i++)out[i]/=norm;return out;
}
export function gltfTRS(out,t,q,s) {
  const [x,y,z,w]=q,xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;
  out[0]=(1-2*(yy+zz))*s[0];out[1]=2*(xy+wz)*s[0];out[2]=2*(xz-wy)*s[0];out[3]=0;
  out[4]=2*(xy-wz)*s[1];out[5]=(1-2*(xx+zz))*s[1];out[6]=2*(yz+wx)*s[1];out[7]=0;
  out[8]=2*(xz+wy)*s[2];out[9]=2*(yz-wx)*s[2];out[10]=(1-2*(xx+yy))*s[2];out[11]=0;
  out[12]=t[0];out[13]=t[1];out[14]=t[2];out[15]=1;return out;
}
export function gltfMatMultiply(out,a,b) {
  // out must not alias a or b.
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)out[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
  return out;
}

export function createSkinAnimator(asset) {
  const g=asset.json;
  if(!g.nodes?.length || g.nodes.length>256 || g.skins?.length!==1)throw Error('Crew expects one skin and at most 256 nodes');
  const parent=new Int16Array(g.nodes.length).fill(-1),order=[],seen=new Uint8Array(g.nodes.length);
  for(let i=0;i<g.nodes.length;i++)for(const c of g.nodes[i].children??[]){
    if(!Number.isInteger(c) || c<0 || c>=parent.length || parent[c]!==-1)throw Error('Invalid glTF hierarchy');parent[c]=i;
  }
  function visit(i){if(seen[i]===1)throw Error('Cyclic glTF hierarchy');if(seen[i]===2)return;seen[i]=1;if(parent[i]>=0)visit(parent[i]);seen[i]=2;order.push(i);}
  for(let i=0;i<parent.length;i++)visit(i);
  const rest=g.nodes.map(n=>{
    if(n.matrix)throw Error('Crew nodes must use TRS');
    const t=new Float32Array(n.translation??[0,0,0]),r=new Float32Array(n.rotation??[0,0,0,1]),s=new Float32Array(n.scale??[1,1,1]);
    if(t.length!==3 || r.length!==4 || s.length!==3 || ![...t,...r,...s].every(Number.isFinite) || Math.abs(s[0]-s[1])>1e-4 || Math.abs(s[1]-s[2])>1e-4 || s[0]<=0)throw Error('Unsupported crew node transform');
    gltfSlerp(r,r,r,0);return {t,r,s};
  });
  const pose=()=>rest.map(n=>({t:n.t.slice(),r:n.r.slice(),s:n.s.slice()}));
  const aPose=pose(),bPose=pose(),world=g.nodes.map(()=>new Float32Array(16)),local=new Float32Array(16);
  const skin=g.skins[0],joints=skin.joints;
  if(!joints?.length || joints.length>128 || joints.some(i=>!Number.isInteger(i)||i<0||i>=g.nodes.length))throw Error('Invalid crew joints');
  const inverse=gltfAccessor(asset,skin.inverseBindMatrices);
  if(inverse.length!==joints.length*16)throw Error('Invalid inverse bind matrices');
  const palette=new Float32Array(joints.length*16),matrices=joints.map((_,i)=>palette.subarray(i*16,i*16+16));
  const inverseMatrices=joints.map((_,i)=>inverse.subarray(i*16,i*16+16));
  // Preserve parent-first evaluation order, but retain the exact subset whose
  // world transforms depend on each node. IK only changes one local rotation.
  const branches=g.nodes.map(()=>[]),jointSlots=g.nodes.map(()=>[]);
  for(const node of order)for(let ancestor=node;ancestor>=0;ancestor=parent[ancestor])branches[ancestor].push(node);
  for(let i=0;i<joints.length;i++)jointSlots[joints[i]].push(i);
  const branchJoints=branches.map(nodes=>nodes.flatMap(node=>jointSlots[node]));
  const names=g.nodes.map(n=>n.name),nameIndices=new Map();
  for(let i=0;i<names.length;i++)if(!nameIndices.has(names[i]))nameIndices.set(names[i],i);
  const clips=new Map();
  for(const clip of g.animations??[]){
    if(!clip.name || clips.has(clip.name))throw Error('Animations need unique names');
    let duration=0;const channels=clip.channels.map(ch=>{
      const path=ch.target.path,node=ch.target.node,s=clip.samplers[ch.sampler],n=path==='rotation'?4:3;
      if(!['rotation','translation','scale'].includes(path)||!rest[node]||!s||!['LINEAR','STEP'].includes(s.interpolation??'LINEAR'))throw Error('Unsupported animation channel');
      const times=gltfAccessor(asset,s.input),values=gltfAccessor(asset,s.output);
      if(values.length!==times.length*n || times[0]<0 || times.some((v,i)=>i>0&&v<=times[i-1]))throw Error('Invalid animation keys');
      duration=Math.max(duration,times.at(-1));return {path,node,n,times,values,step:s.interpolation==='STEP'};
    });
    clips.set(clip.name,{duration,channels});
  }
  const qa=new Float32Array(4),qb=new Float32Array(4);
  function evaluate(pose,name,time){
    for(let i=0;i<pose.length;i++){pose[i].t.set(rest[i].t);pose[i].r.set(rest[i].r);pose[i].s.set(rest[i].s);}
    if(name===null)return;
    const clip=clips.get(name);if(!clip)throw Error('Missing crew animation: '+name);
    const t=clip.duration>0?((time%clip.duration)+clip.duration)%clip.duration:0;
    for(const ch of clip.channels){
      const {times,values,n}=ch;let lo=0,hi=times.length-1;
      while(lo+1<hi){const m=(lo+hi)>>1;if(times[m]<=t)lo=m;else hi=m;}
      if(t>=times[hi])lo=hi;
      const f=ch.step||lo===hi?0:Math.max(0,Math.min(1,(t-times[lo])/(times[hi]-times[lo])));
      const dest=pose[ch.node][ch.path==='rotation'?'r':ch.path==='translation'?'t':'s'];
      if(n===4){for(let i=0;i<4;i++){qa[i]=values[lo*4+i];qb[i]=values[hi*4+i];}gltfSlerp(dest,qa,qb,f);}
      else for(let i=0;i<n;i++)dest[i]=values[lo*n+i]*(1-f)+values[hi*n+i]*f;
    }
  }
  function blendPose(weight){
    weight=Math.max(0,Math.min(1,weight));
    for(let i=0;i<aPose.length;i++){const a=aPose[i],b=bPose[i];gltfSlerp(a.r,a.r,b.r,weight);for(let k=0;k<3;k++){a.t[k]+=(b.t[k]-a.t[k])*weight;a.s[k]+=(b.s[k]-a.s[k])*weight;}}
  }
  function updateMatrices(){
    for(const i of order){gltfTRS(local,aPose[i].t,aPose[i].r,aPose[i].s);if(parent[i]<0)world[i].set(local);else gltfMatMultiply(world[i],world[parent[i]],local);}
    for(let i=0;i<joints.length;i++)gltfMatMultiply(matrices[i],world[joints[i]],inverseMatrices[i]);
    return palette;
  }
  function updateBranch(node){
    if(!Number.isInteger(node)||node<0||node>=branches.length)throw Error('Invalid animation branch');
    for(const i of branches[node]){gltfTRS(local,aPose[i].t,aPose[i].r,aPose[i].s);if(parent[i]<0)world[i].set(local);else gltfMatMultiply(world[i],world[parent[i]],local);}
    for(const i of branchJoints[node])gltfMatMultiply(matrices[i],world[joints[i]],inverseMatrices[i]);
    return palette;
  }
  return {rest,parent,order,world,pose:aPose,palette,clips,joints,names,nodeIndex:name=>nameIndices.get(name)??-1,update:updateMatrices,updateBranch,
    sample(name,time,other=null,otherTime=0,blend=0){
      if(!Number.isFinite(time)||!Number.isFinite(otherTime)||!Number.isFinite(blend))throw Error('Invalid animation time');
      evaluate(aPose,name,time);
      if(other!==null && blend>0){evaluate(bPose,other,otherTime);blendPose(blend);}
      return updateMatrices();
    },
    blend(name,time,weight){
      if(!Number.isFinite(time)||!Number.isFinite(weight))throw Error('Invalid animation blend');
      evaluate(bPose,name,time);blendPose(weight);return updateMatrices();
    },
  };
}

export function loadCrewGLB(bytes) {
  const asset=readGLB(bytes),g=asset.json,animator=createSkinAnimator(asset),chunks=[],indices=[];let count=0;
  if(g.textures?.length)throw Error('Crew materials must be baked to vertex colours');
  for(const node of g.nodes)if(node.mesh!==undefined){
    if(node.skin!==0)throw Error('Crew meshes must share one skin');
    for(const p of g.meshes[node.mesh].primitives){
      if((p.mode??4)!==4 || p.targets || p.attributes.JOINTS_1!==undefined)throw Error('Unsupported crew primitive');
      const a=p.attributes,pos=gltfAccessor(asset,a.POSITION),norm=gltfAccessor(asset,a.NORMAL),joint=gltfAccessor(asset,a.JOINTS_0),weight=gltfAccessor(asset,a.WEIGHTS_0),color=a.COLOR_0!==undefined?gltfAccessor(asset,a.COLOR_0):null;
      const num=pos.length/3,colors=color?color.length/num:0;
      if(norm.length!==num*3||joint.length!==num*4||weight.length!==num*4||(color&&![3,4].includes(colors)))throw Error('Mismatched crew attributes');
      const data=new ArrayBuffer(num*60),f=new Float32Array(data),u=new Uint16Array(data),base=g.materials?.[p.material]?.pbrMetallicRoughness?.baseColorFactor??[1,1,1,1];
      for(let i=0;i<num;i++){
        let sum=0;for(let k=0;k<4;k++){if(!Number.isInteger(joint[i*4+k])||joint[i*4+k]>=animator.joints.length||joint[i*4+k]<0||weight[i*4+k]<0)throw Error('Invalid skin influence');sum+=weight[i*4+k];}
        if(sum<1e-6)throw Error('Unweighted crew vertex');
        for(let k=0;k<3;k++){f[i*15+k]=pos[i*3+k];f[i*15+3+k]=norm[i*3+k];f[i*15+6+k]=base[k]*(color?color[i*colors+k]:1);}
        for(let k=0;k<4;k++){u[i*30+18+k]=joint[i*4+k];f[i*15+11+k]=weight[i*4+k]/sum;}
      }
      const idx=gltfAccessor(asset,p.indices);if(idx.length%3)throw Error('Invalid triangle count');
      for(const n of idx){if(!Number.isInteger(n)||n<0||n>=num)throw Error('Crew index out of range');indices.push(n+count);}
      chunks.push(new Uint8Array(data));count+=num;
    }
  }
  if(count===0||count>100000)throw Error('Crew mesh exceeds budget');
  const vertices=new Uint8Array(count*60);let offset=0;for(const c of chunks){vertices.set(c,offset);offset+=c.length;}
  // Once per prepared crew asset, measure the actual skinned boots in their
  // authored bind posture. Walking IK uses these soles, not guessed ankles.
  animator.sample(null,0);animator.footContacts={};
  const contactFloats=new Float32Array(vertices.buffer,vertices.byteOffset,vertices.byteLength/4),contactJoints=new Uint16Array(vertices.buffer,vertices.byteOffset,vertices.byteLength/2);
  for(const side of ['l','r']){
    const node=animator.nodeIndex('foot_'+side);if(node<0)continue;
    const slots=new Set(animator.joints.map((n,i)=>animator.names[n]==='foot_'+side||animator.names[n]==='ball_'+side?i:-1).filter(i=>i>=0)),points=[];
    for(let i=0;i<count;i++){
      let influence=0;for(let k=0;k<4;k++)if(slots.has(contactJoints[i*30+18+k]))influence+=contactFloats[i*15+11+k];
      if(influence<.5)continue;
      const point=[0,0,0];
      for(let k=0;k<4;k++){
        const at=contactJoints[i*30+18+k]*16,w=contactFloats[i*15+11+k];
        for(let c=0;c<3;c++)point[c]+=w*(animator.palette[at+c]*contactFloats[i*15]+animator.palette[at+4+c]*contactFloats[i*15+1]+animator.palette[at+8+c]*contactFloats[i*15+2]+animator.palette[at+12+c]);
      }
      points.push({index:i,point});
    }
    if(!points.length)continue;
    const ankle=Array.from(animator.world[node].subarray(12,15)),min=[0,1,2].map(c=>Math.min(...points.map(p=>p.point[c]))),max=[0,1,2].map(c=>Math.max(...points.map(p=>p.point[c])));
    animator.footContacts[side]=Object.freeze({node,ankle:Object.freeze(ankle),ankleAboveSole:ankle[1]-min[1],
      min:Object.freeze(min.map((v,i)=>v-ankle[i])),max:Object.freeze(max.map((v,i)=>v-ankle[i])),
      restWorld:Object.freeze(Array.from(animator.world[node])),vertices:Object.freeze(points.map(p=>p.index))});
  }
  return {asset,animator,vertices,indices:new Uint32Array(indices),vertexCount:count};
}
