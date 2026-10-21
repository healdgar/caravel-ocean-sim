// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {loadMarineGLB,MARINE_ASSET_LENGTH,MARINE_ASSET_HEAD_SIGN,MARINE_ASSET_VERTEX_FLOATS,MARINE_ASSET_ROOT_LIFT} from '../js/marine-asset.js';
import {readGLB,gltfAccessor} from '../js/gltf.js';

const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XkAAAAASUVORK5CYII=','base64');
function marineFixture(edit=()=>{}){
  const parts=[],views=[],accessors=[];let length=0;
  const view=bytes=>{
    const padded=(length+3)&~3;if(padded>length)parts.push(Buffer.alloc(padded-length));length=padded;
    const id=views.length;views.push({buffer:0,byteOffset:length,byteLength:bytes.byteLength});parts.push(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));length+=bytes.byteLength;return id;
  };
  const attribute=(values,type,n,componentType=5126)=>{
    const Typed=componentType===5123?Uint16Array:Float32Array,bytes=new Typed(values),bufferView=view(bytes),id=accessors.length;
    accessors.push({bufferView,componentType,count:values.length/n,type});return id;
  };
  const attributes={POSITION:attribute([-1,0,-2,1,0,-2,0,1,2],'VEC3',3),NORMAL:attribute(Array.from({length:3},()=>[0,-4/Math.sqrt(17),1/Math.sqrt(17)]).flat(),'VEC3',3),
    TEXCOORD_0:attribute([.15,.2,.8,.25,.6,.9],'VEC2',2),COLOR_0:attribute([.2,.5,1,.2,.5,1,.2,.5,1],'VEC3',3)};
  const indices=attribute([0,1,2],'SCALAR',1,5123),imageView=view(image),bin=Buffer.concat(parts),aligned=Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]);
  const g={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes,indices,material:0}]}],
    buffers:[{byteLength:aligned.length}],bufferViews:views,accessors,images:[{bufferView:imageView,mimeType:'image/png'}],textures:[{source:0,sampler:0}],samplers:[{wrapS:33071,wrapT:33648,minFilter:9985,magFilter:9728}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[.5,.8,.25,1],baseColorTexture:{index:0},metallicRoughnessTexture:{index:0},roughnessFactor:.7,metallicFactor:.2},normalTexture:{index:0,scale:.6},doubleSided:true}]};
  edit(g);const json=Buffer.from(JSON.stringify(g)),jsonAligned=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]),output=Buffer.alloc(12+8+jsonAligned.length+8+aligned.length);
  output.writeUInt32LE(0x46546c67,0);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);output.writeUInt32LE(jsonAligned.length,12);output.writeUInt32LE(0x4e4f534a,16);jsonAligned.copy(output,20);
  const at=20+jsonAligned.length;output.writeUInt32LE(aligned.length,at);output.writeUInt32LE(0x004e4942,at+4);aligned.copy(output,at+8);return output;
}
const close=(a,b,epsilon=1e-5)=>assert.ok(Math.abs(a-b)<epsilon,`${a} differs from ${b}`);
const point=(model,index)=>Array.from(model.vertices.subarray(index*11,index*11+3));
const normal=(model,index)=>Array.from(model.vertices.subarray(index*11+3,index*11+6));
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);

test('the supplied textured whale is bounded, metre-scaled, actor-aligned and retains all three embedded maps',()=>{
  const bytes=readFileSync(new URL('../assets/wildlife/whale.glb',import.meta.url)),model=loadMarineGLB(bytes);
  assert.equal(MARINE_ASSET_VERTEX_FLOATS,11);assert.equal(MARINE_ASSET_HEAD_SIGN,1);
  assert.equal(model.vertexCount,28526);assert.equal(model.indices.length,117762);assert.equal(model.vertices.byteLength/model.vertexCount,44);
  assert.ok(model.indices.length/3<45000,'the supplied 145,388-triangle source is reduced for the encounter renderer');
  close(model.bounds.size[2],MARINE_ASSET_LENGTH);assert.ok(model.bounds.size[0]>5&&model.bounds.size[0]<5.5);assert.ok(model.bounds.size[1]>3.3&&model.bounds.size[1]<3.7);
  for(let axis=0;axis<3;axis++)close(model.bounds.min[axis]+model.bounds.max[axis],axis===1?MARINE_ASSET_ROOT_LIFT*2:0);
  assert.equal(model.primitives.length,1);assert.deepEqual(model.primitives[0],{firstIndex:0,indexCount:model.indices.length,material:0});
  assert.ok(model.vertices.every(Number.isFinite));assert.ok(model.indices.every(i=>i<model.vertexCount));
  for(let i=0;i<model.vertexCount;i++){
    close(Math.hypot(...normal(model,i)),1);
    const at=i*11;assert.deepEqual(Array.from(model.vertices.subarray(at+6,at+9)),[1,1,1]);
    for(const uv of model.vertices.subarray(at+9,at+11))assert.ok(uv>=0&&uv<=1);
  }
  assert.equal(model.images.length,3);assert.ok(model.images.every(i=>i.mimeType==='image/jpeg'&&i.bytes.length>500000&&i.bytes[0]===255&&i.bytes[1]===216));
  assert.deepEqual(['baseColorTexture','metallicRoughnessTexture','normalTexture'].map(name=>model.materials[0][name].image),[1,2,0]);
  assert.deepEqual(model.images.map(i=>createHash('sha256').update(i.bytes).digest('hex')),[
    'abc380013c0b5dbcbd573bf39cdb71075abeb5671ad45b4932ae1183dc033253',
    'bbe89c57e601fceadc30fa3c7a704617b1fa7eb111dc634291230b9655e12f46',
    'e8962d421da3b1746d15a8f26b602fb5c6e003c3065737e3cc34eb6a6be7f616',
  ],'the source normal, color and roughness JPEGs pass through reduction byte-for-byte');
  assert.equal(model.materials[0].doubleSided,true);
});

test('marine normalization explicitly changes source +Z heading to -Z without altering UVs or material factors',()=>{
  const bytes=marineFixture(),native=loadMarineGLB(bytes,{headSign:-1}),engine=loadMarineGLB(bytes);
  assert.equal(engine.skin,null);
  close(engine.bounds.size[2],14.1);close(engine.vertices[2],7.05);close(engine.vertices[2*11+2],-7.05);
  for(let i=0;i<engine.vertexCount;i++){
    for(let axis=0;axis<3;axis++){
      close(engine.vertices[i*11+axis],native.vertices[i*11+axis]*(axis===1?1:-1));
      close(engine.vertices[i*11+3+axis],native.vertices[i*11+3+axis]*(axis===1?1:-1));
    }
    close(engine.vertices[i*11+6],.1);close(engine.vertices[i*11+7],.4);close(engine.vertices[i*11+8],.25);
  }
  assert.deepEqual(Array.from(engine.vertices.subarray(9,11)),Array.from(new Float32Array([.15,.2])));
  assert.deepEqual(engine.images[0].bytes,new Uint8Array(image));
  const material=engine.materials[0];assert.equal(material.normalScale,.6);assert.equal(material.roughnessFactor,.7);assert.equal(material.metallicFactor,.2);
  assert.deepEqual(material.baseColorTexture,{image:0,texCoord:0,sampler:{wrapS:33071,wrapT:33648,minFilter:9985,magFilter:9728}});
});

test('the supplied straight 18-bone whale keeps normalized influences and its authored rest shape after metre/origin conversion',()=>{
  const bytes=readFileSync(new URL('../assets/wildlife/whale.glb',import.meta.url)),model=loadMarineGLB(bytes),{animator,joints,weights}=model.skin;
  assert.equal(animator.joints.length,18);assert.equal(animator.clips.size,0);assert.equal(joints.length,model.vertexCount*4);assert.equal(weights.length,model.vertexCount*4);
  assert.ok(joints instanceof Uint16Array);assert.ok(weights instanceof Float32Array);
  for(let i=0;i<animator.palette.length;i++)close(animator.palette[i],i%16%5===0?1:0,1e-5);
  const asset=readGLB(bytes),primitive=asset.json.meshes[0].primitives[0],positions=gltfAccessor(asset,primitive.attributes.POSITION);
  const {scale,sourceCentre}=model.normalization;
  let maxError=0;
  for(let i=0;i<model.vertexCount;i++){
    let sum=0;const result=[0,0,0];
    for(let k=0;k<4;k++){
      const joint=joints[i*4+k],weight=weights[i*4+k],at=joint*16;
      assert.ok(joint>=0&&joint<18&&weight>=0&&weight<=1);sum+=weight;
      for(let axis=0;axis<3;axis++)result[axis]+=weight*(animator.palette[at+axis]*positions[i*3]+animator.palette[at+4+axis]*positions[i*3+1]+animator.palette[at+8+axis]*positions[i*3+2]+animator.palette[at+12+axis]);
    }
    close(sum,1,1e-6);
    for(let axis=0;axis<3;axis++){
      const normalized=(result[axis]-sourceCentre[axis])*scale*(axis===1?1:-1);
      maxError=Math.max(maxError,Math.abs(normalized-model.vertices[i*11+axis]));
    }
  }
  assert.ok(maxError<1e-4,`rest skinning must preserve the whole normalized mesh, maximum deviation ${maxError}m`);
  // Bone edits produce actual deformation through retained influences, rather
  // than a decorative skeleton detached from the exported vertex mesh.
  const tail=animator.names.indexOf('Bone_008');assert.ok(tail>=0);
  animator.pose[tail].t[1]+=.05;animator.update();
  let changed=0;
  for(let i=0;i<model.vertexCount;i+=7){
    const source=positions.subarray(i*3,i*3+3),deformed=[0,0,0];
    for(let k=0;k<4;k++){
      const at=joints[i*4+k]*16,w=weights[i*4+k];
      for(let axis=0;axis<3;axis++)deformed[axis]+=w*(animator.palette[at+axis]*source[0]+animator.palette[at+4+axis]*source[1]+animator.palette[at+8+axis]*source[2]+animator.palette[at+12+axis]);
    }
    if(Math.hypot(...subtract(deformed,source))*scale>.01)changed++;
  }
  assert.ok(changed>100,'tail-chain bones must influence a substantial part of the model');
});

test('marine rigs reject invalid joint references and vertices without any skin weight',()=>{
  const bytes=readFileSync(new URL('../assets/wildlife/whale.glb',import.meta.url));
  const jointBytes=Buffer.from(bytes),jointAsset=readGLB(jointBytes),g=jointAsset.json,primitive=g.meshes[0].primitives[0];
  const jointAccessor=g.accessors[primitive.attributes.JOINTS_0],jointView=g.bufferViews[jointAccessor.bufferView];
  jointAsset.bin[(jointView.byteOffset??0)+(jointAccessor.byteOffset??0)]=255;
  assert.throws(()=>loadMarineGLB(jointBytes),/skin influence/);
  const weightBytes=Buffer.from(bytes),weightAsset=readGLB(weightBytes),accessor=weightAsset.json.accessors[primitive.attributes.WEIGHTS_0],view=weightAsset.json.bufferViews[accessor.bufferView];
  const data=new DataView(weightAsset.bin.buffer,weightAsset.bin.byteOffset,weightAsset.bin.byteLength),start=(view.byteOffset??0)+(accessor.byteOffset??0);
  for(let k=0;k<4;k++)data.setFloat32(start+k*4,0,true);
  assert.throws(()=>loadMarineGLB(weightBytes),/Unweighted/);
});

test('nested transforms use inverse-transpose normals and preserve outward winding under reflection',()=>{
  for(const reflected of [false,true]){
    const bytes=marineFixture(g=>{g.nodes=[{translation:[3,4,5],rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],children:[1]},{translation:[1,2,3],scale:[reflected?-2:2,3,.5],mesh:0}];});
    const model=loadMarineGLB(bytes,{headSign:-1}),a=point(model,model.indices[0]),b=point(model,model.indices[1]),c=point(model,model.indices[2]),n=normal(model,model.indices[0]);
    close(dot(n,subtract(b,a)),0);close(dot(n,subtract(c,a)),0);close(Math.hypot(...n),1);
    // The source plane normal (0,-4,1), inverse-scaled then rotated about Z,
    // becomes proportional to (4/3,0,2), independently of X reflection.
    close(n[0],2/Math.sqrt(13));close(n[1],0);close(n[2],3/Math.sqrt(13));
    const u=subtract(b,a),v=subtract(c,a),face=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    assert.ok(dot(n,face)>0,'a reflected mesh reverses triangle winding together with its transformed normal');
    close(model.bounds.size[2],14.1);close(model.bounds.size[0],21.15);close(model.bounds.size[1],28.2);
  }
  const matrix=loadMarineGLB(marineFixture(g=>{g.nodes=[{matrix:[2,0,0,0,0,3,0,0,0,0,.5,0,3,4,5,1],mesh:0}];}),{headSign:-1});
  close(matrix.bounds.size[0],28.2);close(matrix.bounds.size[1],21.15);close(matrix.bounds.size[2],14.1);
});

test('static marine loading rejects external, animated, singular and malformed geometry rather than silently degrading',()=>{
  const bad=[
    [g=>{g.images[0].uri='https://example.com/skin.png';},/embedded/],
    [g=>{g.animations=[{}];},/static/],
    [g=>{g.nodes[0].scale=[1,0,1];},/TRS/],
    [g=>{g.nodes[0].children=[0];},/hierarchy/],
    [g=>{g.nodes[0].matrix=[1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1];},/Singular/],
    [g=>{g.meshes[0].primitives[0].mode=1;},/primitive/],
    [g=>{delete g.meshes[0].primitives[0].attributes.TEXCOORD_0;},/UV/],
    [g=>{g.accessors[2].count=2;},/attributes/],
    [g=>{g.accessors[4].componentType=5126;},/buffer|indices/],
    [g=>{g.materials[0].normalTexture.texCoord=1;},/texture/],
    [g=>{g.materials.push({});},/one material/],
    [g=>{g.materials[0].alphaMode='BLEND';},/material/],
    [g=>{g.textures[0].sampler=12;},/texture/],
    [g=>{g.accessors[0].count=200001;},/buffer|layout/],
  ];
  for(const [edit,message]of bad)assert.throws(()=>loadMarineGLB(marineFixture(edit)),message);
  assert.throws(()=>loadMarineGLB(marineFixture(),{headSign:0}),/headSign/);
});
