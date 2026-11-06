import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProceduralCoastalPack} from '../js/coastal-world.js';
import {terrainSurfaceSample} from '../js/terrain-model.js';
import {PROP_MODELS,layPortProps,readPropModel} from '../js/port-props.js';

const GRID={size:513,biomeSize:128,albedoSize:256};

// A small port: one pier running out from a straight beach, with water to the west.
function bay(extra={}){
  const groundAt=(x)=>x*.05;
  const pier={prefabId:'timber_mole_pier',x:-20,z:0,y:.4,yaw:Math.PI/2,length:68,width:7.5,height:2.8};
  const hall={prefabId:'casa_de_contratacion',x:60,z:0,y:3,yaw:0,length:30,width:20,height:9};
  return {port:{center:{x:40,z:0},instances:[pier,hall],indigenousSettlement:{hasIndigenousSettlement:false},...extra},groundAt,pier};
}

test('every model reads as real metres, standing on the ground, centred, with its own texture',()=>{
  for(const spec of PROP_MODELS){
    const m=readPropModel(readFileSync(new URL('../'+spec.file,import.meta.url)),spec);
    assert.ok(m.indices.length/3>100&&m.indices.length/3<2000,`${spec.id}: ${m.indices.length/3} triangles`);
    assert.ok(m.indices.every(i=>i*8<m.vertices.length));
    const lo=[9e9,9e9,9e9],hi=[-9e9,-9e9,-9e9];
    for(let i=0;i<m.vertices.length;i+=8)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],m.vertices[i+k]);hi[k]=Math.max(hi[k],m.vertices[i+k]);}
    assert.ok(Math.abs(lo[1])<1e-4,`${spec.id} stands on y = 0`);
    assert.ok(Math.abs(lo[0]+hi[0])<1e-3&&Math.abs(lo[2]+hi[2])<1e-3,`${spec.id} is centred`);
    assert.ok(hi[2]-lo[2]>=hi[0]-lo[0],`${spec.id} runs along z`);
    assert.equal(m.mime,'image/jpeg');
    assert.deepEqual([...m.image.subarray(0,3)],[0xff,0xd8,0xff],'real JPEG bytes');
    if(spec.deckShare)assert.ok(m.standsAt<0,'a jetty stands in the water');
  }
});

test('cleats line both edges of a pier at deck height, and stay on it',()=>{
  const {port,groundAt,pier}=bay(),cleats=layPortProps(port,groundAt).filter(p=>p.model===0),c=Math.cos(pier.yaw),s=Math.sin(pier.yaw);
  assert.ok(cleats.length>=12,`${cleats.length} cleats`);
  for(const cleat of cleats){
    assert.equal(cleat.y,pier.y+pier.height);
    assert.equal(cleat.owner,0);
    const dx=cleat.x-pier.x,dz=cleat.z-pier.z,lx=dx*c-dz*s,lz=dx*s+dz*c;
    assert.ok(Math.abs(lx)<pier.width/2&&Math.abs(lx)>pier.width/2-1,`across the deck ${lx}`);
    assert.ok(Math.abs(lz)<pier.length/2,`along it ${lz}`);
  }
  assert.ok(cleats.some(p=>(p.x-pier.x)*c-(p.z-pier.z)*s>0)&&cleats.some(p=>(p.x-pier.x)*c-(p.z-pier.z)*s<0));
});

test('a quay has cleats only on its sea side',()=>{
  const quay={prefabId:'stone_quay_seawall',x:0,z:0,y:1,yaw:0,length:40,width:6,height:2};
  const cleats=layPortProps({center:{x:40,z:0},instances:[quay]},x=>x*.05).filter(p=>p.model===0);
  assert.ok(cleats.length>0);
  assert.ok(cleats.every(p=>p.x<0),'the sea is to the west');
});

test('a jetty stands on the shore, root on the beach and head in the water, clear of buildings',()=>{
  const {port,groundAt}=bay(),jetties=layPortProps(port,groundAt).filter(p=>p.model>0);
  assert.ok(jetties.length>0&&jetties.length<=2,`${jetties.length} jetties`);
  for(const j of jetties){
    const seaX=Math.sin(j.yaw),seaZ=Math.cos(j.yaw);
    assert.ok(groundAt(j.x-seaX*12)>groundAt(j.x+seaX*12),'its length runs down the beach');
    assert.ok(groundAt(j.x+seaX*5)<0,'its head is in water');
    assert.equal(j.y,null,'its height comes from the model');
    assert.equal(j.owner,-1);
    for(const inst of port.instances)assert.ok(Math.hypot(inst.x-j.x,inst.z-j.z)>Math.hypot(inst.length,inst.width)/2,inst.prefabId);
  }
  if(jetties.length===2)assert.notEqual(jetties[0].model,jetties[1].model);
});

test('a sovereign Indigenous town gets no plank jetty, and a place with no port gets nothing',()=>{
  const {port,groundAt}=bay({indigenousSettlement:{hasIndigenousSettlement:true,isSovereignPolity:true}});
  assert.equal(layPortProps(port,groundAt).filter(p=>p.model>0).length,0);
  assert.deepEqual(layPortProps(null,groundAt),[]);
  assert.deepEqual(layPortProps({center:{x:0,z:0},instances:[]},groundAt),[]);
});

test('the same port lays the same props, and a real port gets them',()=>{
  const {port,groundAt}=bay();
  assert.deepEqual(layPortProps(port,groundAt),layPortProps(port,groundAt));
  const pack=generateProceduralCoastalPack('lisbon',GRID);
  const ground=(x,z)=>terrainSurfaceSample(pack.heights,x,z,pack.region);
  assert.deepEqual(pack.port.props,layPortProps(pack.port,ground));
  assert.ok(pack.port.props.some(p=>p.model===0),'Lisbon has cleats on its piers');
});
