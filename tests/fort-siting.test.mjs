// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Forts stand where the harbour needs them: the record's works against the harbour read from its real coast. The
// coasts here are kept in tests/data/harbours by scripts/harbour-coasts.mjs, so this needs no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {HISTORICAL_COLONIAL_PORTS,generateProceduralCoastalPack,placeCoastalPort,resolveGlobalCoastalRegion,smoothCoastlineAndForeshoreBeaches} from '../js/coastal-world.js';
import {FORT_RECORDS,fortRecordsFor} from '../js/fort-records.js';
import {worldOfPosition} from '../js/harbour-defences.js';

const fixtures=new URL('./data/harbours/',import.meta.url);
function coastOf(id){
  const all=zlib.gunzipSync(fs.readFileSync(new URL(`${id}.bin.gz`,fixtures))),length=all.readUInt32LE(0),header=JSON.parse(all.subarray(4,4+length).toString());
  const words=new Int16Array(all.buffer.slice(all.byteOffset+4+length,all.byteOffset+all.length)),heights=new Float32Array(words.length);
  for(let i=0;i<words.length;i++)heights[i]=words[i]/10;
  return {header,heights};
}
const placed=new Map();
function portOn(id,year){
  const key=`${id}@${year}`;
  if(placed.has(key))return placed.get(key);
  const {header,heights:raw}=coastOf(id);
  const region=resolveGlobalCoastalRegion({id,year,size:header.size,biomeSize:64,albedoSize:64,vegetationCandidates:100,latitude:header.latitude,longitude:header.longitude,shoreBearing:header.shoreBearing});
  const heights=new Float32Array(raw);
  smoothCoastlineAndForeshoreBeaches(heights,region,{});
  const port=placeCoastalPort(region,heights,{preserveRealCoast:true,coastIsReal:true});
  const value={port,region,heights};
  placed.set(key,value);
  return value;
}
// Where the record stands a work on this coast, in its region's frame (the board's model sets each there).
const recorded=(id,year,region,piece)=>{
  const fort=fortRecordsFor(id,year).forts.find(f=>f.name.includes(piece));
  assert.ok(fort,`no ${piece} among ${fortRecordsFor(id,year).forts.map(f=>f.name).join(', ')}`);
  return {...worldOfPosition(region,fort.lat,fort.lon),name:fort.name};
};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

test('El Morro and La Punta face each other across the harbour mouth read from the coast, as at Havana and San Juan',()=>{
  const {port,region}=portOn('havana',1650);
  const morro=recorded('havana',1650,region,'Morro'),punta=recorded('havana',1650,region,'Punta'),mouth=port.harbour.mouth;
  assert.equal(port.harbour.kind,'mouth');
  assert.ok(mouth.width<600,`Havana's mouth reads ${mouth.width} m wide`);
  assert.ok(distance(morro,mouth)<700,`Morro ${distance(morro,mouth).toFixed(0)} m from the mouth`);
  assert.ok(distance(punta,mouth)<700,`La Punta ${distance(punta,mouth).toFixed(0)} m from the mouth`);
  // On opposite sides of the way in.
  const across=(f)=>(f.x-mouth.x)*(mouth.right.x-mouth.left.x)+(f.z-mouth.z)*(mouth.right.z-mouth.left.z);
  assert.ok(across(morro)*across(punta)<0,'one on each hand');
  const {port:sj,region:sjRegion}=portOn('san-juan',1650);
  const elMorro=recorded('san-juan',1650,sjRegion,'Morro'),canuelo=recorded('san-juan',1650,sjRegion,'Canuelo'),sjMouth=sj.harbour.mouth;
  assert.ok(distance(elMorro,sjMouth)<1000&&distance(canuelo,sjMouth)<1000,'San Juan closes its mouth from both sides');
});

test('a sovereign Indigenous town keeps its own works, and a palisade town gets no European fort',()=>{
  const pack=generateProceduralCoastalPack({latitude:41.2,longitude:-72,year:1650,size:65,biomeSize:64,albedoSize:64,vegetationCandidates:100,hasColonialPort:false});
  // A port's works are its board's alone, and none stands a European trace here.
  assert.deepEqual(pack.port.works??[],[],'no European work is stood');
  assert.deepEqual(pack.port.instances,[],'and the port stamps no building of its own');
  assert.equal(pack.port.harbour,null,'and no one reads its harbour for forts');
});

test('the record has what the game needs: every fort a place, a job and a date',()=>{
  const ids=new Set(HISTORICAL_COLONIAL_PORTS.map(p=>p.id));
  for(const [id,record] of Object.entries(FORT_RECORDS)){
    assert.ok(ids.has(id),`${id} is a port`);
    for(const fort of record.forts){
      assert.ok(Number.isFinite(fort.lat)&&Number.isFinite(fort.lon)&&fort.from>=1000,`${id}: ${fort.name}`);
      assert.ok(['mouth','narrows','headland','river','waterfront','island','citadel'].includes(fort.role),`${id}: ${fort.name} ${fort.role}`);
      assert.ok(['star','headland','battery','drum','islet','fitted'].includes(fort.shape),`${id}: ${fort.name} ${fort.shape}`);
      const port=HISTORICAL_COLONIAL_PORTS.find(p=>p.id===id);
      assert.ok(Math.hypot(fort.lat-port.latitude,(fort.lon-port.longitude)*Math.cos(port.latitude*Math.PI/180))*111<25,`${id}: ${fort.name} is within 25 km of its port`);
    }
  }
  assert.ok(Object.keys(FORT_RECORDS).length>=40);
});

// The forts, batteries and watchtowers of a coast are its board's: the bake gathers what the record stands on its
// ground (scripts/bake-board.mjs), Castle and Commons sets each (scripts/board-forts.mjs) and the board builds it of
// the wall's own types (js/old-world-board.js). No port sites a fort of its own.
test('the forts the record names are works of the board, each on its ground, turned to the water',()=>{
  const baked=JSON.parse(fs.readFileSync(new URL('../assets/boards/san-juan-1550.json',import.meta.url),'utf8'));
  const works=baked.board.places.flatMap((place)=>place.works??[]);
  assert.deepEqual(works.map((work)=>work.name).sort(),['Castillo San Felipe del Morro','La Fortaleza']);
  for(const work of works)assert.ok(Number.isFinite(work.turn)&&work.face!==null,work.name);
  assert.deepEqual(baked.request.works.map((work)=>work.name).sort(),works.map((work)=>work.name).sort());
});
