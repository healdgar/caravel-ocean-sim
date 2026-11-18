import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {INDIGENOUS_CULTURE_REGIONS} from '../js/coastal-world.js';
import {DRESS_BARE_TORSO,DRESS_FEATHERS,DRESS_MASK_SCALE,DRESS_PIECES,INDIGENOUS_DRESS,indigenousDress} from '../js/indigenous-dress.js';
import {loadCrewGLB} from '../js/gltf.js';
import {
  INDIGENOUS_ARCHETYPE_IDS,
  buildIndigenousCrewModel,
  createIndigenousCrewModels,
  indigenousArchetypeForCulture,
  loadGroomPackGLB,
} from '../js/crew.js';

const everyone=(culture,sex,count=400)=>Array.from({length:count},(_,i)=>indigenousDress(culture,sex,i));

test('every culture in the world has its own dress',()=>{
  for(const {id} of INDIGENOUS_CULTURE_REGIONS)assert.ok(INDIGENOUS_DRESS[id],`${id} has no dress`);
  const signature=id=>JSON.stringify([INDIGENOUS_DRESS[id].men,INDIGENOUS_DRESS[id].women,INDIGENOUS_DRESS[id].elite]);
  const ids=Object.keys(INDIGENOUS_DRESS);
  assert.equal(new Set(ids.map(signature)).size,ids.length,'no two cultures dress alike');
});

test('feathers are the exception, not a uniform',()=>{
  for(const id of Object.keys(INDIGENOUS_DRESS))for(const sex of ['male','female']){
    const share=everyone(id,sex).filter(p=>p.mask&DRESS_FEATHERS).length/400;
    assert.ok(share<=.2,`${share} of ${id} ${sex} wear feathers every day`);
  }
});

test('rank shows on those who hold it',()=>{
  const cacique=indigenousDress('taino-greater-antilles','male',1,{role:'Cacique / Halach Uinic'});
  assert.ok(cacique.mask&DRESS_FEATHERS,'a cacique wears feathers');
  assert.equal(cacique.elite,true);
  const maya=indigenousDress('maya-mesoamerica-coast','male',1,{elite:true});
  assert.ok(maya.mask&(1<<DRESS_PIECES.indexOf('QUETZAL_PLUMES')),'Maya rank is quetzal, not eagle');
  assert.equal(maya.mask&(1<<DRESS_PIECES.indexOf('ONE_FEATHER')),0);
  const tupinamba=indigenousDress('tupinamba-brazil-guiana','male',1,{elite:true});
  assert.ok(tupinamba.mask&(1<<DRESS_PIECES.indexOf('FEATHER_CROWN')));
});

test('the same person always looks the same, and masks fit the shader',()=>{
  assert.deepEqual(indigenousDress('abenaki-algonquian','female',7),indigenousDress('abenaki-algonquian','female',7));
  for(const id of [...Object.keys(INDIGENOUS_DRESS),'nobody-we-know-of'])for(const sex of ['male','female'])for(const p of everyone(id,sex,60)){
    assert.ok(Number.isInteger(p.mask)&&p.mask>=0&&p.mask<DRESS_MASK_SCALE,`${id} mask ${p.mask}`);
    assert.ok(p.face[3]>1.5,'marked as Indigenous for the shader');
  }
  for(const id of Object.keys(INDIGENOUS_DRESS))for(const p of everyone(id,'female'))assert.equal(p.mask&DRESS_BARE_TORSO,0,`${id}: women's dress stays on the model`);
});

test('an unknown people gets plain hair and clothes, and nothing assumed',()=>{
  for(const sex of ['male','female'])for(const p of everyone('nobody-we-know-of',sex))assert.equal(p.mask&DRESS_FEATHERS,0);
});

// A native town's people are its townsfolk (js/townsfolk.js townLooks), each dressed for the town's culture.
test('villagers wear their own culture rather than one costume',()=>{
  const dressOf=cultureId=>Array.from({length:8},(_,i)=>indigenousDress(cultureId,i%2?'female':'male',i)).map(p=>[p.mask,p.shirt,p.trousers]);
  assert.notDeepEqual(dressOf('tupinamba-brazil-guiana'),dressOf('maya-mesoamerica-coast'));
});

test('every piece is tagged in the model, and the sailors have none',()=>{
  const names=new Set(DRESS_PIECES);
  assert.equal(names.size,DRESS_PIECES.length);
  assert.ok(DRESS_PIECES.length<=12,'pieces fit below the look bits');
  const source=readFileSync(new URL('../js/crew.js',import.meta.url),'utf8');
  for(const name of DRESS_PIECES)assert.ok(source.includes(`'${name}'`),`${name} is never built`);
  assert.equal(typeof buildIndigenousCrewModel,'function');
});

test('all nine Indigenous culture regions map onto four dedicated regional M/F base models with 3D Tripo groom',()=>{
  const groomPack=loadGroomPackGLB(readFileSync(new URL('../assets/crew/groom-pack.glb',import.meta.url)));
  const load=name=>{const m=loadCrewGLB(readFileSync(new URL(`../assets/crew/${name}.glb`,import.meta.url)));m.groomPack=groomPack;return m;};
  const sailor=load('sailor'),sailorFemale=load('sailor-female');
  const archetypes={
    algonquian:[load('indigenous-algonquian-male'),load('indigenous-algonquian-female')],
    caribbean:[load('indigenous-caribbean-male'),load('indigenous-caribbean-female')],
    maya:[load('indigenous-maya-male'),load('indigenous-maya-female')],
    andean:[load('indigenous-andean-male'),load('indigenous-andean-female')],
  };
  sailor.indigenousBase=archetypes.caribbean[0];
  sailorFemale.indigenousBase=archetypes.caribbean[1];
  sailor.indigenousArchetypes=archetypes;

  const seenArchetypes=new Set();
  for(const {id} of INDIGENOUS_CULTURE_REGIONS){
    const arch=indigenousArchetypeForCulture(id);
    assert.ok(INDIGENOUS_ARCHETYPE_IDS.includes(arch),`${id} maps to valid regional archetype ${arch}`);
    seenArchetypes.add(arch);
    const [maleModel,femaleModel]=createIndigenousCrewModels([sailor,sailorFemale],id);
    assert.ok(maleModel.vertexCount>archetypes[arch][0].vertexCount,`${id} male attaches 3D groom & cultural regalia`);
    assert.ok(femaleModel.vertexCount>archetypes[arch][1].vertexCount,`${id} female attaches 3D groom & cultural regalia`);
    // No ladder of decimated levels: the continuum is the only simplification.
    assert.equal(maleModel.lods,undefined,`${id} male carries no tier ladder`);
    assert.equal(femaleModel.lods,undefined,`${id} female carries no tier ladder`);
    assert.equal(maleModel.indices.length/3,archetypes[arch][0].indices.length/3+maleModel.accessoryTriangleCount,`${id} male draws every triangle`);
  }
  assert.deepEqual([...seenArchetypes].sort(),[...INDIGENOUS_ARCHETYPE_IDS].sort(),'all four regional M/F pairs are exercised');
});
