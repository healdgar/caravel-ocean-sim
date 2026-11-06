// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Holds the Pinta's and Santa María's bows, timber and fittings against the Niña,
// which is the reference for how these ships should read.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {vesselHull} from '../js/hull.js';
import {hullLoftStem,hullLoftSheer} from '../js/hull-loft.js';
import {ADDITIONAL_DESIGNS,additionalHullWidth,additionalDeck,additionalDeckWidth} from '../js/models/additional.js';
import {additionalRigContext} from '../js/additional-rig.js';
import {createAdditionalShipMesh} from '../js/additional-ships.js';
import {createCaravelMesh} from '../js/caravel.js';
import {CARAVEL} from '../js/wgsl/caravel.js';

const NEW_SHIPS=['pinta','santa-maria'],meshes=new Map();
function built(id){
  if(!meshes.has(id)){const parts=new Map(),groups=[],raw=createAdditionalShipMesh(id,{parts,groups});meshes.set(id,{raw,parts,groups});}
  return meshes.get(id);
}
const vertices=part=>Array.from({length:part.length/9},(_,i)=>part.subarray(i*9,i*9+9));

// All in fractions of the hull, so ships of different size compare directly.
function bowLines(id){
  const h=vesselHull(id),[fore,aft]=h.bounds,length=aft-fore,draft=h.datumDraft??h.draft;
  const stemAt=y=>{for(let z=fore;z<aft;z+=.001)if(h.halfWidth(z,y)>.002)return z;return NaN;};
  const beam=Math.max(...Array.from({length:240},(_,i)=>h.halfWidth(fore+length*i/239,0)));
  const stem=stemAt(0),entry=at=>h.halfWidth(stem+length*at,0)/beam;
  const sx=h.runtime.beam/h.frame.beam,sz=h.runtime.length/h.frame.length;
  const entryAngle=at=>Math.atan(h.halfWidth(stem+length*at,0)*sx/(length*at*sz))*180/Math.PI;
  const tenth=stem+length*.1,waterline=h.halfWidth(tenth,0);
  return {
    rake:(stem-fore)/length,
    plumbAboveWater:Math.abs(stemAt(.8)-stem)/length,
    entry5:entry(.05),entry10:entry(.10),entry15:entry(.15),entry20:entry(.20),angle10:entryAngle(.10),
    vSection:h.halfWidth(tenth,-draft*.3)/waterline,
    lowSection:h.halfWidth(tenth,-draft*.7)/waterline,
  };
}
const nina=bowLines('nina');

test('the bows rake like the Niña, from the keel right up to the rail',()=>{
  for(const id of NEW_SHIPS){
    const d=ADDITIONAL_DESIGNS[id],lines=bowLines(id),p=d.profile;
    assert.ok(lines.rake>=nina.rake*.9,`${id} stem stands ${lines.rake.toFixed(3)} aft of its head at the water; the Niña's stands ${nina.rake.toFixed(3)}`);
    assert.ok(lines.rake<.065,`${id} rake stays a stem, not a ram: ${lines.rake.toFixed(3)}`);
    assert.ok(lines.plumbAboveWater>.012,`${id} stem must lean above the water, not stand plumb: ${lines.plumbAboveWater.toFixed(3)}`);
    let previous=-Infinity;
    for(let i=0;i<=24;i++){
      const base=p.stemTop+(p.levels[0]-p.stemTop)*i/24,[,,z]=hullLoftStem(p,base);
      assert.ok(z>=previous,`${id} stem runs steadily aft as it falls to the keel`);previous=z;
    }
    assert.ok(Math.abs(hullLoftStem(p,p.levels[0])[2]-d.keel.bounds[0])<1e-9,`${id} keel starts at the foot of the stem`);
  }
});

test('the Pinta enters as finely as the Niña, and the Santa María is fuller but no box',()=>{
  const pinta=bowLines('pinta'),santa=bowLines('santa-maria');
  for(const key of ['entry5','entry10','entry15'])assert.ok(pinta[key]<=nina[key]*1.02,`Pinta ${key} ${pinta[key].toFixed(3)} against the Niña's ${nina[key].toFixed(3)}`);
  assert.ok(pinta.angle10<=nina.angle10+1,`Pinta half angle ${pinta.angle10.toFixed(1)} against the Niña's ${nina.angle10.toFixed(1)}`);
  for(const key of ['entry5','entry10','entry15','entry20']){
    assert.ok(santa[key]>pinta[key],`the nao stays fuller than the caravel at ${key}`);
    assert.ok(santa[key]<=nina[key]*1.25,`Santa María ${key} ${santa[key].toFixed(3)} against the Niña's ${nina[key].toFixed(3)}`);
  }
  assert.ok(santa.angle10<=nina.angle10+5,`Santa María half angle ${santa.angle10.toFixed(1)}`);
});

test('the sections forward are V shaped, not U shaped',()=>{
  for(const id of NEW_SHIPS){
    const lines=bowLines(id);
    assert.ok(lines.vSection<=.9,`${id} falls in below the waterline: ${lines.vSection.toFixed(3)}`);
    assert.ok(lines.lowSection<=nina.lowSection*1.3,`${id} is narrow low down: ${lines.lowSection.toFixed(3)} against ${nina.lowSection.toFixed(3)}`);
  }
});

test('other hulls with no stem height still stand plumb above the datum',()=>{
  const flat={stations:[-6,0,6],levels:[-1,0,1],bowRake:1,sheerFore:0,sheerAft:0,sheerDatum:0};
  assert.equal(hullLoftStem(flat,.5)[2],-6);assert.equal(hullLoftStem(flat,0)[2],-6);assert.equal(hullLoftStem(flat,-1)[2],-5);
  assert.equal(hullLoftStem({...flat,stemTop:1},1)[2],-6);assert.ok(hullLoftStem({...flat,stemTop:1},0)[2]>-6);
});

test('a tarred stem post runs from the keel to the rail, and the wales ride above the water in tarred timber',()=>{
  for(const id of NEW_SHIPS){
    const d=ADDITIONAL_DESIGNS[id],{parts}=built(id),stem=vertices(parts.get('hull.stem'));
    assert.ok(stem.every(v=>v[6]===16),'tarred timber, as on the Niña');
    const lowest=Math.min(...stem.map(v=>v[1])),highest=Math.max(...stem.map(v=>v[1]));
    assert.ok(lowest<=d.profile.levels[0]+hullLoftSheer(d.profile,d.keel.bounds[0])-d.keel.depth+1e-5,'it reaches the keel');
    assert.ok(highest>=d.profile.stemTop+hullLoftSheer(d.profile,d.profile.stations[0])-1e-5,'and the rail');
    for(const {y,half} of d.wales)assert.ok(y-half>0,'a wale under water would read as a dark patch low on the bow');
    for(const side of ['port','starboard'])assert.ok(vertices(parts.get('hull.wales.'+side)).every(v=>v[6]===16));
  }
});

test('timber carries the Niña’s grain at the same size in metres',()=>{
  // Niña hull: uv.y runs .6 per design unit over a hull 20 m long.
  const ninaAlong=.6/(20/12);
  const ninaParts=new Map();createCaravelMesh({parts:ninaParts});
  const scale=(part,axis,uvAxis)=>{
    // The typical rate over the part's triangle edges.
    const rates=[];
    for(let i=0;i+27<=part.length;i+=27)for(const [a,b] of [[0,9],[9,18],[0,18]]){
      const dp=Math.abs(part[i+a+axis]-part[i+b+axis]),du=Math.abs(part[i+a+7+uvAxis]-part[i+b+7+uvAxis]);
      if(dp>.01)rates.push(du/dp);
    }
    return rates.sort((x,y)=>x-y)[rates.length>>1];
  };
  assert.ok(Math.abs(scale(ninaParts.get('hull'),2,1)-.6)<.02,'the Niña reference has not moved');
  for(const id of NEW_SHIPS){
    const d=ADDITIONAL_DESIGNS[id],{parts}=built(id),sz=d.runtime.length/d.frame.length,sy=d.frame.verticalScale,sx=d.runtime.beam/d.frame.beam;
    const hull=parts.get('hull.planking');
    const alongPerMetre=scale(hull,2,1)/sz;
    assert.ok(Math.abs(alongPerMetre-ninaAlong)/ninaAlong<.05,`${id} hull grain along the ship: ${alongPerMetre.toFixed(3)} per metre against the Niña's ${ninaAlong.toFixed(3)}`);
    // Material 15 draws a seam each uv.x*18 = 1. Measure strake width on the topside,
    // where the planking runs nearly upright both amidships and near the stem.
    const strake=(fore,aft)=>{
      let lowU=Infinity,highU=-Infinity,lowY=Infinity,highY=-Infinity;
      for(const v of vertices(hull)){
        const base=v[1]-hullLoftSheer(d.profile,v[2]);
        if(v[0]<=0||v[2]<fore||v[2]>aft||base<.25||base>.65)continue;
        lowU=Math.min(lowU,v[7]);highU=Math.max(highU,v[7]);lowY=Math.min(lowY,base);highY=Math.max(highY,base);
      }
      return (highY-lowY)*sy/((highU-lowU)*18);
    };
    const amidships=strake(-.11,.11),forward=strake(-5.4,-5.2);
    assert.ok(amidships>.2&&amidships<.32,`${id} strakes are ${amidships.toFixed(3)} m wide amidships`);
    assert.ok(forward<amidships*.92,`${id} strakes narrow toward the stem: ${forward.toFixed(3)} m against ${amidships.toFixed(3)} m`);
    // A deck in the old writer default tiled oak three times over and faded to a flat pale colour.
    const deck=parts.get('deck.main.planks');
    const deckAlong=scale(deck,2,1)/sz;
    assert.ok(Math.abs(deckAlong-.33)<.02,`${id} deck grain along the ship: ${deckAlong.toFixed(3)} per metre`);
    const deckAcross=scale(deck,0,0)/sx;
    assert.ok(Math.abs(deckAcross-.96)<.1,`${id} deck grain across the ship: ${deckAcross.toFixed(3)} per metre`);
  }
});

test('masts carry their grain up the spar, not around it',()=>{
  for(const id of NEW_SHIPS){
    const mast=vertices(built(id).parts.get('mast.main')).filter(v=>v[6]===1&&Math.hypot(v[3],v[5])>.9);
    const dv=Math.max(...mast.map(v=>v[8]))-Math.min(...mast.map(v=>v[8])),du=Math.max(...mast.map(v=>v[7]))-Math.min(...mast.map(v=>v[7]));
    assert.ok(dv>du*3,`${id} main mast v spans ${dv.toFixed(2)}, u ${du.toFixed(2)}`);
  }
});

test('the hull shader reaches these two ships by their model code',()=>{
  // rig.w holds the model code. A gate of rig.w<.5 left these timber branches dead.
  assert.ok(CARAVEL.includes('let isAdditionalIberian=hull.rig.w>1.5 && hull.rig.w<3.5;'));
  assert.ok(CARAVEL.includes('(isProceduralFleet || isAdditionalIberian) && in.material==0u'));
  assert.ok(CARAVEL.includes('(isProceduralFleet || isAdditionalIberian) && in.material == 1u'));
  for(const id of NEW_SHIPS){const code=ADDITIONAL_DESIGNS[id].modelCode;assert.ok(code>1.5&&code<3.5);}
});

test('catheads lie over the rail, and anchors hang clear of the planking',()=>{
  for(const id of NEW_SHIPS){
    const d=ADDITIONAL_DESIGNS[id],context=additionalRigContext(id);
    for(const side of [-1,1]){
      const cat=context.anchorCathead(side),rail=additionalDeck(id,-4.8)+d.barrier;
      assert.ok(side*cat.root[0]<additionalDeckWidth(id,cat.root[2]),'the heel sits inboard of the rail');
      assert.ok(side*cat.tip[0]>additionalHullWidth(id,cat.tip[2],rail),'the tip stands outboard of the hull');
      assert.ok(cat.root[1]>=rail-.03&&cat.tip[1]>cat.root[1],'it lies on the rail and rises as it reaches out');
    }
    // The spare is the same iron as the working anchor, so this covers both.
    const iron=vertices(built(id).parts.get('anchor.starboard')).filter(v=>v[6]===3);
    assert.ok(iron.length>=284*3,'the starboard cathead carries its spare');
    let lowest=Infinity;
    for(const v of iron){
      lowest=Math.min(lowest,v[1]);
      assert.ok(v[0]>=additionalHullWidth(id,v[2],v[1])-.01,`${id} spare anchor stays outside the planking at ${v[2].toFixed(2)}, ${v[1].toFixed(2)}`);
    }
    assert.ok(lowest>0,'it hangs above the water');
  }
});

test('the fore stay comes down to the bowsprit, which passes over the stem head',()=>{
  for(const id of NEW_SHIPS){
    const d=ADDITIONAL_DESIGNS[id],{a,b}=d.bowsprit,context=additionalRigContext(id);
    const stay=context.supports.find(s=>s.kind==='stay'&&s.mast===0);
    const at=z=>a[1]+(b[1]-a[1])*(z-a[2])/(b[2]-a[2]);
    assert.ok(Math.abs(stay.a[1]-at(stay.a[2]))<1e-9,`${id} stay meets the spar`);
    const stemHead=d.profile.stemTop+hullLoftSheer(d.profile,d.profile.stations[0]);
    assert.ok(at(d.profile.stations[0])>=stemHead,`${id} spar clears the stem head rather than running through the planking`);
    assert.ok(a[1]>additionalDeck(id,a[2]),`${id} heel stands above its deck`);
  }
});
