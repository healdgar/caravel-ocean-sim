// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {readGLB,gltfAccessor,gltfTRS,gltfMatMultiply,createSkinAnimator} from './gltf.js';

// Audited Meshy whale: Y up, head +Z. Its rigged export changes source scale
// and origin; anatomical extent normalization preserves the same 14.1 m animal.
// The encounter renderer uses metres, head -Z and a trunk-aligned actor origin.
export const MARINE_ASSET_LENGTH=14.1;
export const MARINE_ASSET_HEAD_SIGN=1;
export const MARINE_ASSET_VERTEX_FLOATS=11;
export const MARINE_ASSET_ROOT_LIFT=1.2;

export function loadMarineGLB(bytes,{headSign=MARINE_ASSET_HEAD_SIGN}={}){
  if(![1,-1].includes(headSign))throw Error('Marine headSign must be 1 or -1');
  const asset=readGLB(bytes),g=asset.json;
  if(!g.nodes?.length||g.nodes.length>256||!g.meshes?.length||g.meshes.length>128||(!g.skins?.length&&g.animations?.length))throw Error('Expected bounded static or skinned marine meshes');
  const animator=g.skins?.length?createSkinAnimator(asset):null;
  if(animator)animator.sample(null,0);
  if((g.materials?.length??0)>1)throw Error('Marine asset currently supports one material');
  if((g.images?.length??0)>16||(g.textures?.length??0)>16)throw Error('Marine texture count exceeds budget');
  const finite=(value,n)=>Array.isArray(value)&&value.length===n&&value.every(Number.isFinite);
  const images=(g.images??[]).map((image,index)=>{
    const view=g.bufferViews?.[image.bufferView],offset=view?.byteOffset??0,length=view?.byteLength;
    if(image.uri||image.extensions||!view||view.buffer!==0||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<4||length>16*1024*1024||offset+length>asset.bin.length||!['image/jpeg','image/png'].includes(image.mimeType))throw Error('Expected embedded PNG/JPEG marine texture');
    const data=new Uint8Array(asset.bin.subarray(offset,offset+length));
    if(image.mimeType==='image/jpeg'?(data[0]!==255||data[1]!==216):(data[0]!==137||data[1]!==80||data[2]!==78||data[3]!==71))throw Error('Invalid marine image signature');
    return {bytes:data,mimeType:image.mimeType,name:image.name??`marine image ${index}`};
  });
  const texture=info=>{
    if(info===undefined)return null;
    const value=g.textures?.[info.index],image=value?.source,sampler=g.samplers?.[value?.sampler]??{};
    if(info.extensions||value?.extensions||!Number.isInteger(info.index)||!Number.isInteger(image)||!images[image]||(info.texCoord??0)!==0||(value.sampler!==undefined&&(!Number.isInteger(value.sampler)||!g.samplers?.[value.sampler])))throw Error('Unsupported marine texture reference');
    const wrapS=sampler.wrapS??10497,wrapT=sampler.wrapT??10497,minFilter=sampler.minFilter??9987,magFilter=sampler.magFilter??9729;
    if(![33071,33648,10497].includes(wrapS)||![33071,33648,10497].includes(wrapT)||![9728,9729,9984,9985,9986,9987].includes(minFilter)||![9728,9729].includes(magFilter))throw Error('Unsupported marine texture sampler');
    return {image,texCoord:0,sampler:{wrapS,wrapT,minFilter,magFilter}};
  };
  const sourceMaterial=g.materials?.[0]??{},pbr=sourceMaterial.pbrMetallicRoughness??{},baseColorFactor=pbr.baseColorFactor??[1,1,1,1];
  const roughnessFactor=pbr.roughnessFactor??1,metallicFactor=pbr.metallicFactor??1,normalScale=sourceMaterial.normalTexture?.scale??1;
  if(sourceMaterial.extensions||(sourceMaterial.alphaMode??'OPAQUE')!=='OPAQUE'||sourceMaterial.emissiveTexture||sourceMaterial.occlusionTexture||(sourceMaterial.emissiveFactor??[0,0,0]).some(v=>v!==0)||!finite(baseColorFactor,4)||baseColorFactor.some(v=>v<0||v>1)||![roughnessFactor,metallicFactor].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||!Number.isFinite(normalScale)||normalScale<0)throw Error('Unsupported marine material');
  const materials=[{name:sourceMaterial.name??'marine skin',baseColorFactor:[...baseColorFactor],roughnessFactor,metallicFactor,normalScale,doubleSided:sourceMaterial.doubleSided??false,
    baseColorTexture:texture(pbr.baseColorTexture),metallicRoughnessTexture:texture(pbr.metallicRoughnessTexture),normalTexture:texture(sourceMaterial.normalTexture)}];
  const scene=g.scenes?.[g.scene??0];
  if(!scene?.nodes?.length)throw Error('Marine asset needs a populated scene');
  const seen=new Uint8Array(g.nodes.length),chunks=[],jointChunks=[],weightChunks=[],indices=[],primitives=[];let vertexCount=0;
  const sourceMin=[Infinity,Infinity,Infinity],sourceMax=[-Infinity,-Infinity,-Infinity];
  function visit(index,parent){
    if(!Number.isInteger(index)||!g.nodes[index]||seen[index])throw Error('Invalid or cyclic marine hierarchy');
    seen[index]=1;const node=g.nodes[index],local=new Float32Array(16),world=new Float32Array(16);
    if((node.skin!==undefined&&(!animator||node.skin!==0))||node.weights||node.extensions)throw Error('Unsupported marine node');
    if(node.matrix){
      if(!finite(node.matrix,16)||node.translation||node.rotation||node.scale||Math.abs(node.matrix[3])+Math.abs(node.matrix[7])+Math.abs(node.matrix[11])+Math.abs(node.matrix[15]-1)>1e-7)throw Error('Invalid marine node matrix');
      local.set(node.matrix);
    }else{
      const t=node.translation??[0,0,0],q=node.rotation??[0,0,0,1],s=node.scale??[1,1,1];
      if(!finite(t,3)||!finite(q,4)||!finite(s,3)||s.some(v=>Math.abs(v)<1e-8))throw Error('Invalid marine node TRS');
      const length=Math.hypot(...q);if(length<1e-8)throw Error('Invalid marine quaternion');
      gltfTRS(local,t,q.map(v=>v/length),s);
    }
    if(parent)gltfMatMultiply(world,parent,local);else world.set(local);
    // Cofactor columns form inverse-transpose (up to the determinant).
    const a=[world[0],world[1],world[2]],b=[world[4],world[5],world[6]],c=[world[8],world[9],world[10]];
    const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],cof=[cross(b,c),cross(c,a),cross(a,b)];
    const determinant=a.reduce((sum,v,i)=>sum+v*cof[0][i],0);
    if(!Number.isFinite(determinant)||Math.abs(determinant)<1e-12)throw Error('Singular marine transform');
    if(node.mesh!==undefined){
      const mesh=g.meshes[node.mesh];if(!Number.isInteger(node.mesh)||!mesh?.primitives?.length||mesh.weights||mesh.extensions)throw Error('Invalid marine mesh');
      if(animator&&(node.skin!==0||world.some((v,i)=>Math.abs(v-(i%5===0?1:0))>1e-5)))throw Error('Skinned marine mesh needs an identity node transform');
      for(const primitive of mesh.primitives){
        const attributes=primitive.attributes;
        if((primitive.mode??4)!==4||primitive.targets||primitive.extensions||(primitive.material??0)!==0||!attributes||(!animator&&(attributes.JOINTS_0!==undefined||attributes.WEIGHTS_0!==undefined))||attributes.JOINTS_1!==undefined||attributes.WEIGHTS_1!==undefined||attributes.TEXCOORD_1!==undefined)throw Error('Unsupported marine primitive');
        for(const [name,type]of [['POSITION','VEC3'],['NORMAL','VEC3'],['TEXCOORD_0','VEC2']])if(g.accessors?.[attributes[name]]?.type!==type)throw Error('Missing marine position, normal or UV attribute');
        for(const name of ['POSITION','NORMAL'])if(g.accessors[attributes[name]].componentType!==5126)throw Error('Marine positions and normals must use floats');
        const positions=gltfAccessor(asset,attributes.POSITION),normals=gltfAccessor(asset,attributes.NORMAL),uv=gltfAccessor(asset,attributes.TEXCOORD_0),colors=attributes.COLOR_0===undefined?null:gltfAccessor(asset,attributes.COLOR_0);
        const count=positions.length/3,colorSize=colors?colors.length/count:0;
        if(normals.length!==count*3||uv.length!==count*2||(colors&&![3,4].includes(colorSize))||vertexCount+count>100000)throw Error('Marine attributes exceed the bounded mesh layout');
        if(animator){
          if(g.accessors?.[attributes.JOINTS_0]?.type!=='VEC4'||g.accessors?.[attributes.WEIGHTS_0]?.type!=='VEC4'||![5121,5123].includes(g.accessors[attributes.JOINTS_0].componentType))throw Error('Invalid marine skin attributes');
          const joints=gltfAccessor(asset,attributes.JOINTS_0),weights=gltfAccessor(asset,attributes.WEIGHTS_0);
          if(joints.length!==count*4||weights.length!==count*4)throw Error('Mismatched marine skin attributes');
          for(let i=0;i<count;i++){
            let sum=0;for(let k=0;k<4;k++){
              const at=i*4+k;if(!Number.isInteger(joints[at])||joints[at]<0||joints[at]>=animator.joints.length||weights[at]<0)throw Error('Invalid marine skin influence');sum+=weights[at];
            }
            if(sum<1e-8)throw Error('Unweighted marine vertex');
            for(let k=0;k<4;k++)weights[i*4+k]/=sum;
          }
          jointChunks.push(new Uint16Array(joints));weightChunks.push(weights);
        }
        const output=new Float32Array(count*MARINE_ASSET_VERTEX_FLOATS);
        for(let i=0;i<count;i++){
          const p=positions.subarray(i*3,i*3+3),n=normals.subarray(i*3,i*3+3),at=i*MARINE_ASSET_VERTEX_FLOATS;
          const normal=[0,1,2].map(k=>(cof[0][k]*n[0]+cof[1][k]*n[1]+cof[2][k]*n[2])/determinant),length=Math.hypot(...normal);
          if(length<1e-8)throw Error('Invalid marine normal');
          for(let k=0;k<3;k++){
            const value=world[k]*p[0]+world[4+k]*p[1]+world[8+k]*p[2]+world[12+k];
            if(!Number.isFinite(value))throw Error('Non-finite marine transform');
            output[at+k]=value;sourceMin[k]=Math.min(sourceMin[k],value);sourceMax[k]=Math.max(sourceMax[k],value);
            output[at+3+k]=normal[k]/length;output[at+6+k]=baseColorFactor[k]*(colors?colors[i*colorSize+k]:1);
          }
          output.set(uv.subarray(i*2,i*2+2),at+9);
        }
        const firstIndex=indices.length,raw=primitive.indices===undefined?Float32Array.from({length:count},(_,i)=>i):gltfAccessor(asset,primitive.indices);
        if(raw.length%3||indices.length+raw.length>600000||(primitive.indices!==undefined&&(g.accessors[primitive.indices].type!=='SCALAR'||![5121,5123,5125].includes(g.accessors[primitive.indices].componentType))))throw Error('Invalid marine triangle indices');
        for(let i=0;i<raw.length;i+=3){
          const triangle=determinant<0?[raw[i],raw[i+2],raw[i+1]]:[raw[i],raw[i+1],raw[i+2]];
          for(const value of triangle){if(!Number.isInteger(value)||value<0||value>=count)throw Error('Marine index out of range');indices.push(vertexCount+value);}
        }
        primitives.push({firstIndex,indexCount:raw.length,material:0});chunks.push(output);vertexCount+=count;
      }
    }
    for(const child of node.children??[])visit(child,world);
  }
  for(const root of scene.nodes)visit(root,null);
  const sourceLength=sourceMax[2]-sourceMin[2];
  if(!vertexCount||indices.length>600000||!Number.isFinite(sourceLength)||sourceLength<1e-6)throw Error('Empty or unbounded marine asset');
  const scale=MARINE_ASSET_LENGTH/sourceLength,sourceCentre=sourceMin.map((v,i)=>(v+sourceMax[i])*.5),direction=headSign===1?-1:1;
  sourceCentre[1]-=MARINE_ASSET_ROOT_LIFT/scale;
  const vertices=new Float32Array(vertexCount*MARINE_ASSET_VERTEX_FLOATS),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let offset=0;
  for(const chunk of chunks){
    for(let i=0;i<chunk.length;i+=MARINE_ASSET_VERTEX_FLOATS)for(let k=0;k<3;k++){
      const axis=k===1?1:direction;chunk[i+k]=(chunk[i+k]-sourceCentre[k])*scale*axis;chunk[i+3+k]*=axis;
      min[k]=Math.min(min[k],chunk[i+k]);max[k]=Math.max(max[k],chunk[i+k]);
    }
    vertices.set(chunk,offset);offset+=chunk.length;
  }
  let skin=null;
  if(animator){
    const joints=new Uint16Array(vertexCount*4),weights=new Float32Array(vertexCount*4);let at=0;
    for(let i=0;i<jointChunks.length;i++){joints.set(jointChunks[i],at);weights.set(weightChunks[i],at);at+=jointChunks[i].length;}
    skin={animator,joints,weights};
  }
  return {vertices,indices:new Uint32Array(indices),vertexCount,images,materials,primitives,skin,
    bounds:{min,max,size:min.map((v,i)=>max[i]-v)},sourceBounds:{min:sourceMin,max:sourceMax,size:sourceMin.map((v,i)=>sourceMax[i]-v)},normalization:{scale,headSign,sourceCentre}};
}
