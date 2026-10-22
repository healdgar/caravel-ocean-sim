// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAdditionalShipMesh,createAdditionalAssetPose} from '../js/additional-ships.js';
import {ADDITIONAL_DESIGNS,additionalHullWidth,additionalDeck,additionalStairFlights} from '../js/models/additional.js';
import {hullLoftBottom,hullLoftSheer} from '../js/hull-loft.js';
import {additionalRigContext,additionalGunAttachments} from '../js/additional-rig.js';
import {surfaceRestPoint,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint} from '../js/rig-surface.js';
import {indexCaravelMesh} from '../js/caravel.js';
import {createGunRecoilMap} from '../js/gunnery-models.js';

const additionalMeshTestNear=(a,b,e=2e-5)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const additionalMeshTestKey=p=>p.map(x=>Math.round(x*1e5)).join('/');
const additionalMeshTestAssets=new Map();
function additionalMeshTestAsset(id){
  if(!additionalMeshTestAssets.has(id)){
    const groups=[],parts=new Map(),raw=createAdditionalShipMesh(id,{groups,parts}),indexed=indexCaravelMesh(raw);
    additionalMeshTestAssets.set(id,{model:{id},raw,groups,parts,...indexed});
  }
  return additionalMeshTestAssets.get(id);
}
function additionalMeshTestPositions(mesh){const result=[];for(let i=0;i<mesh.length;i+=9)result.push(Array.from(mesh.subarray(i,i+3)));return result;}
const additionalMeshTestDesigns=Object.values(ADDITIONAL_DESIGNS);

test('additional meshes have finite unit-normal independent hulls, complete decks and bounded geometry',()=>{
  for(const d of additionalMeshTestDesigns){
    const a=additionalMeshTestAsset(d.id),names=new Set(a.groups.map(g=>g.id));
    assert.equal(a.raw.length%27,0);assert.ok(a.raw.length/27<60_000);assert.ok(a.raw.every(Number.isFinite));
    for(let i=0;i<a.raw.length;i+=9)additionalMeshTestNear(Math.hypot(a.raw[i+3],a.raw[i+4],a.raw[i+5]),1,1e-6);
    for(const id of ['hull.planking','hull.keel','hull.frames','hull.sternpost','hull.wales.port','hull.wales.starboard',
      'hull.closure.stern','stern.windows','bulwark.port','bulwark.starboard','helm.tiller','helm.rudder','hatch.main','hatch.coaming',
      'mast.fore','mast.main','mast.mizzen','rig.standing','rig.running','anchor.port','anchor.starboard','bow.bowsprit'])assert.ok(names.has(id),d.id+' '+id);
    for(const deck of d.deckZones){assert.ok(names.has('deck.'+deck.id+'.planks'));if(deck.id!=='main')assert.ok(names.has('deck.bulkhead.'+deck.id));}
    assert.equal(names.has('lookout.fore'),Boolean(d.lookout));
    for(const group of a.groups){assert.equal(group.firstVertex%3,0);assert.equal(group.vertexCount%3,0);assert.ok(group.firstVertex+group.vertexCount<=a.raw.length/9);}
    assert.equal(a.groups.filter(g=>g.id.startsWith('gun.')).length,4);
    assert.equal(createGunRecoilMap(a).guns.length,4,'each movable barrel has isolated vertices and stable gun ID');
    for(const gun of additionalGunAttachments(d.id))assert.ok(additionalMeshTestPositions(a.parts.get('gun.'+gun.id)).some(p=>Math.hypot(...p.map((v,i)=>v-gun.muzzleDesign[i]))<.04),'barrel and ballistic muzzle share the same attachment');
  }
  assert.notDeepEqual(additionalMeshTestAsset('pinta').parts.get('hull.planking'),additionalMeshTestAsset('santa-maria').parts.get('hull.planking'));
});

test('rendered stair flights use exactly the crew route lanes and deck endpoints',()=>{
  for(const d of additionalMeshTestDesigns){
    const a=additionalMeshTestAsset(d.id);
    for(const f of additionalStairFlights(d.id)){
      const part=a.parts.get('deck.stairs.'+f.id),positions=additionalMeshTestPositions(part);assert.ok(part?.length);
      for(const [z,y] of [[f.z0,f.y0],[f.z1,f.y1]])for(const side of [-1,1]){
        const point=[f.x+side*f.width*.55,y,z];
        assert.ok(positions.some(p=>p.every((v,i)=>Math.abs(v-point[i])<2e-6)),'stringers join the route at both physical decks');
      }
      for(const zone of d.deckZones){
        const deck=a.parts.get('deck.'+zone.id+'.planks');
        for(let i=0;i<deck.length;i+=27){
          const x=(deck[i]+deck[i+9]+deck[i+18])/3,z=(deck[i+2]+deck[i+11]+deck[i+20])/3,y=(deck[i+1]+deck[i+10]+deck[i+19])/3;
          if(x>f.x-f.width*.5+1e-5&&x<f.x+f.width*.5-1e-5&&z>f.z0+1e-5&&z<f.z1-1e-5)
            assert.ok(y<=f.y0+(f.y1-f.y0)*(z-f.z0)/(f.z1-f.z0)+.016,'deck cap cannot seal the walking flight from above');
        }
      }
    }
  }
});

test('wales join actual skin vertices; rectangular exposed timber follows this hull bottom exactly',()=>{
  for(const d of additionalMeshTestDesigns){
    const a=additionalMeshTestAsset(d.id),skin=new Set(additionalMeshTestPositions(a.parts.get('hull.planking')).map(additionalMeshTestKey));
    for(const side of ['port','starboard']){
      const positions=additionalMeshTestPositions(a.parts.get('hull.wales.'+side));let inner=0,outer=0;
      for(const p of positions){
        if(skin.has(additionalMeshTestKey(p)))inner++;
        else if(Math.abs(Math.abs(p[0])-additionalHullWidth(d.id,p[2],p[1])-.026)<.006)outer++;
      }
      assert.ok(inner>100,'wales contain welded return edges, not detached dark strips');assert.ok(outer>100);
    }
    for(const [x,y,z] of additionalMeshTestPositions(a.parts.get('hull.keel'))){
      additionalMeshTestNear(Math.abs(x),d.keel.width*.5);assert.ok(z>=d.keel.bounds[0]-1e-6&&z<=d.keel.bounds[1]+1e-6);
      const gap=hullLoftBottom(d.profile,z)-y;
      assert.ok(Math.min(Math.abs(gap),Math.abs(gap-d.keel.depth))<2e-6,'every keel ring uses the shared loft ordinate');
    }
  }
});

test('deck boundaries share the loft skin; transom windows remain supported and lookout meets its mast',()=>{
  for(const d of additionalMeshTestDesigns){
    const a=additionalMeshTestAsset(d.id),skin=new Set(additionalMeshTestPositions(a.parts.get('hull.planking')).map(additionalMeshTestKey));
    for(const zone of d.deckZones){
      let joined=0;
      for(const p of additionalMeshTestPositions(a.parts.get('deck.'+zone.id+'.planks'))){
        additionalMeshTestNear(p[1],zone.height+hullLoftSheer(d.profile,p[2]));
        assert.ok(Math.abs(p[0])<=additionalHullWidth(d.id,p[2],p[1])+2e-5);
        if(skin.has(additionalMeshTestKey(p)))joined++;
      }
      assert.ok(joined>8,'deck edge joins the same triangulated side skin');
    }
    const stern=d.profile.stations.at(-1);
    for(const p of additionalMeshTestPositions(a.parts.get('stern.windows'))){
      assert.ok(p[2]>=stern-.02&&p[2]<=stern+.025);assert.ok(Math.abs(p[0])<=additionalHullWidth(d.id,stern,p[1])+.03);
    }
    if(d.lookout){
      const centre=additionalRigContext(d.id).mastPoint(d.lookout.mast,d.lookout.height);
      assert.ok(additionalMeshTestPositions(a.parts.get('lookout.fore')).some(p=>p.every((v,i)=>Math.abs(v-centre[i])<2e-6)));
    }
    const hatch=a.parts.get('hatch.coaming');assert.ok(hatch.some((_,i)=>i%9===1&&hatch[i]<additionalDeck(d.id,d.hatch.centre[2])-.20),'opening has a recessed hold, not a lid over a solid painted deck');
  }
});

test('each separately rigged sail retains exact corners, real UVs and its own yard identity',()=>{
  for(const d of additionalMeshTestDesigns){
    const a=additionalMeshTestAsset(d.id);
    for(const s of d.surfaces){
      const sail=a.parts.get('sail.'+s.name),yard=a.parts.get('yard.'+s.name);assert.ok(sail?.length&&yard?.length);
      const corners=s.corners.length===3?[[0,0],[1,0],[0,1]]:[[0,0],[1,0],[1,1],[0,1]];
      for(let i=0;i<sail.length;i+=9){
        const u=sail[i+7],v=sail[i+8],point=surfaceRestPoint(s,u,v);assert.equal(sail[i+6],(s.corners.length===3?13:9)+s.id/64);
        assert.ok(u>=0&&u<=1&&v>=0&&v<=1&&(s.corners.length!==3||u+v<=1+1e-7));
        for(let j=0;j<3;j++)additionalMeshTestNear(sail[i+j],point[j],1e-6);
      }
      for(const [u,v] of corners)assert.ok(Array.from({length:sail.length/9},(_,i)=>i*9).some(i=>sail[i+7]===u&&sail[i+8]===v),'all corners survive tessellation');
      for(let i=6;i<yard.length;i+=9)assert.equal(yard[i],10+s.id/64);
    }
    assert.equal(a.groups.filter(g=>g.id.startsWith('sail.')).length,d.surfaces.length);
  }
});

test('indexed CPU pose follows the approved mixed-rig evaluator through fill, luff, transfer and furl',()=>{
  for(const d of additionalMeshTestDesigns){
    const asset=additionalMeshTestAsset(d.id),pose=createAdditionalAssetPose(asset),target=new Float32Array(asset.vertices),context=additionalRigContext(d.id),surfaces=new Map(d.surfaces.map(s=>[s.id,s]));
    const states=[
      {squareYaw:.35,set:[1,1,1],windSide:7,windForward:4,rig:[{fill:1},{fill:.9},{fill:.8,side:-1,opening:.55,deployed:1,pressure:1}]},
      {squareYaw:-.30,set:[1,1,1],windSide:-.2,windForward:1,rig:[{fill:0},{fill:.1},{fill:0,side:1,opening:.2,deployed:1,pressure:-.3}]},
      {squareYaw:.1,set:[.2,0,.5],windSide:3,windForward:-2,rig:[{fill:.2},{fill:0},{fill:.2,side:.1,opening:.15,dip:.8,deployed:.5,pressure:.4}]},
    ];
    for(const state of states){
      const time=2.75,wind=9,boat={modelId:d.id,sailState:state,rudder:20,hatchesClosed:.35};assert.equal(pose(boat,time,wind,target),true);
      const full={...context,state,poses:new Map(d.surfaces.map(s=>[s.id,rigSurfacePose(s,state)])),time,wind};let checked=0;
      for(let i=0;i<target.length;i+=9){
        assert.ok(Number.isFinite(target[i])&&Number.isFinite(target[i+1])&&Number.isFinite(target[i+2]));
        additionalMeshTestNear(Math.hypot(target[i+3],target[i+4],target[i+5]),1,1e-5);
        const kind=Math.floor(asset.vertices[i+6]),surface=surfaces.get(Math.round((asset.vertices[i+6]-kind)*64));
        if((kind===9||kind===13)&&checked++%53===0){
          const expected=surfaceClothPoint(surface,asset.vertices[i+7],asset.vertices[i+8],full.poses.get(surface.id),full,time,wind);
          for(let j=0;j<3;j++)additionalMeshTestNear(target[i+j],expected[j],2e-6);
        }
        if(kind===10&&i%63===0){
          const expected=surfaceYardPoint(surface,Array.from(asset.vertices.subarray(i,i+3)),full.poses.get(surface.id));
          for(let j=0;j<3;j++)additionalMeshTestNear(target[i+j],expected[j],2e-6);
        }
        if(kind===12&&i%117===0){
          const line=full.lines[Math.round(asset.vertices[i+7]-100)],centre=surfaceRopePoint(line,asset.vertices[i+8],full);
          assert.ok(Math.hypot(...centre.map((v,j)=>target[i+j]-v))<.025,'running rope remains a tube around its actual posed lead');
        }
      }
      assert.ok(checked>200);
    }
  }
});

test('posing changes only dynamic records and preserves existing gun recoil and immutable asset bytes',()=>{
  for(const d of additionalMeshTestDesigns){
    const asset=additionalMeshTestAsset(d.id),sourceBits=new Uint32Array(asset.vertices.buffer).slice(),target=new Float32Array(asset.vertices),recoil=createGunRecoilMap(asset),at=recoil.guns[0].indices[0]*9;
    target[at]+=.0123;const before=new Uint32Array(target.buffer).slice(),pose=createAdditionalAssetPose(asset);
    pose({modelId:d.id,sailState:{set:[1,1,1],squareYaw:.3,rig:[{fill:1},{fill:1},{fill:1,side:1,opening:.6,pressure:1}]},rudder:-25,hatchesClosed:0},1.2,8,target);
    const bits=new Uint32Array(target.buffer);let changed=0;
    for(let i=0;i<asset.vertices.length;i+=9){
      const kind=Math.floor(asset.vertices[i+6]),dynamic=[7,9,10,13,14,18].includes(kind)||(kind===12&&asset.vertices[i+7]>=100);
      for(let j=0;j<9;j++){
        if(!dynamic||j>=6)assert.equal(bits[i+j],before[i+j]);
        if(bits[i+j]!==before[i+j])changed++;
      }
    }
    assert.ok(changed>100);assert.equal(bits[at],before[at]);assert.deepEqual(new Uint32Array(asset.vertices.buffer),sourceBits);
    assert.throws(()=>pose({},0,0,new Float32Array(9)),/wrong shape/);
  }
  assert.throws(()=>createAdditionalShipMesh('missing'),/No additional vessel/);
});
