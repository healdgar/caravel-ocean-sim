// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Read-only adapters over the working ships. This module does not build geometry,
// advance simulation, register another playable backend or alter legacy nodes.
import {requirePlayableShipModel,resolveShipNode} from './ship-models.js';
import {deepFreeze} from './rig-definition.js';
import {NINA_DESIGN} from './models/nina.js';
import {VICTORY_DESIGN,VICTORY_MASTS,VICTORY_SAILS,victoryHullHalfWidth,victoryHullDeck,victoryVesselDeck,victoryDeckHalfWidth,victoryHullPoint,victoryMastPoint,victoryHatchPivot} from './models/victory.js';
import {hullHalfWidth,hullDeck,vesselDeck,deckHalfWidth,hullSurfacePoint,TILLER_PIVOT} from './hull.js';
import {SAIL_PLAN,lateenClothPoint,lateenYardPoint} from './lateen.js';
import {RIG_MASTS,mastPoint} from './rigging.js';
import {victoryPose,victoryClothPoint,victoryYardPoint} from './victory-motion.js';
import {BOAT_MANIFEST,DEFAULT_PROVISION_DAYS,boatHydrodynamics,boatRotate} from './boat.js';
import {createHullLateralDescriptor} from './hull-lateral.js';
import {createGunDefinitions} from './gunnery-models.js';
import {ANCHOR_LIMITS,VICTORY_ANCHOR_LIMITS} from './anchor-state.js';
import {ADDITIONAL_DESIGNS,additionalDesign,additionalHullWidth,additionalHullDeck,additionalDeck,additionalDeckWidth} from './models/additional.js';
import {additionalRigContext} from './additional-rig.js';
import {rigSurfacePose,surfaceClothPoint,surfaceYardPoint} from './rig-surface.js';
import {anchorEquipment} from './anchor-state.js';
import {hullLoftBottom,hullLoftPoint} from './hull-loft.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {LATER_SAIL_DESIGNS} from './models/later-sail.js';
import {proceduralDesign,proceduralHullWidth,proceduralHullDeck,proceduralDeck,proceduralDeckWidth,proceduralKeelHalfWidth,proceduralDraft,proceduralProvisionDays} from './models/procedural.js';
import {proceduralRigContext} from './additional-rig.js';
import {proceduralShipNodeTransform} from './procedural-models.js';
import {SHIP_SUB_ASSEMBLIES,PART_CUTAWAY_MODES} from './part-assembly.js';

const shipPartControlIDs=['fore','main','mizzen'],shipPartControlKeys=['sailFore','sailMain','sailMizzen'];
const shipPartStationRoles={ines:'captain',tomas:'mate',beatriz:'boatswain',duarte:'foremast-hand',joao:'mainmast-hand',catarina:'mainmast-hand',leonor:'sailmaker',rui:'carpenter',maria:'lookout',afonso:'foredeck-hand',isabel:'mizzen-hand',pedro:'helmsman'};
const shipPartAdapters=new Map(),shipPartIdentity=()=>[[1,0,0],[0,1,0],[0,0,1]];
const shipPartAdd=(a,b)=>a.map((v,i)=>v+b[i]),shipPartSubtract=(a,b)=>a.map((v,i)=>v-b[i]);
const shipPartCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const shipPartUnit=a=>{const n=Math.hypot(...a);if(!(n>1e-12))throw Error('Degenerate ship attachment basis');return a.map(v=>v/n);};
const shipPartYaw=(p,a)=>[Math.cos(a)*p[0]+Math.sin(a)*p[2],p[1],-Math.sin(a)*p[0]+Math.cos(a)*p[2]];
const shipPartPitch=(p,a)=>[p[0],Math.cos(a)*p[1]-Math.sin(a)*p[2],Math.sin(a)*p[1]+Math.cos(a)*p[2]];
const shipPartSpin=(p,a)=>[Math.cos(a)*p[0]-Math.sin(a)*p[1],Math.sin(a)*p[0]+Math.cos(a)*p[1],p[2]];
const shipPartRigid=(origin,evaluate)=>({position:evaluate(origin),basis:shipPartIdentity().map(e=>shipPartSubtract(evaluate(shipPartAdd(origin,e)),evaluate(origin))),kind:'rigid'});

function shipPartBuildAssemblyManifest(model,roles,guns=[]){
  const classifyRole=id=>{
    if(id.includes('keel')||id.includes('frame')||id.includes('sternpost'))return {subAssembly:'keel-and-frame',subAssemblyIndex:0,layer:0};
    if(id.startsWith('deck.')||id.startsWith('hatch.')||id.startsWith('station.'))return {subAssembly:'decks-and-interior',subAssemblyIndex:1,layer:1};
    if(id.startsWith('helm.')||id.startsWith('anchor.')||id.startsWith('gun.')||id.startsWith('rowing.'))return {subAssembly:'ordnance-and-helm',subAssemblyIndex:2,layer:2};
    if(id.startsWith('mast.')||id.startsWith('lookout.')||id.startsWith('yard.')||id.startsWith('spar.'))return {subAssembly:'masts-and-spars',subAssemblyIndex:4,layer:4};
    if(id.startsWith('rig.')||id.startsWith('sail.')||id.startsWith('stay.'))return {subAssembly:'rigging-and-sails',subAssemblyIndex:5,layer:5};
    return {subAssembly:'hull-and-bulwarks',subAssemblyIndex:3,layer:3};
  };
  const roleKeys=Object.keys(roles);
  const rawNodes=roleKeys.map((id,idx)=>{
    const node=model.nodes[id]??{};
    const c=classifyRole(id);
    const pivot=Array.isArray(node.position)?[...node.position]:Array.isArray(node.motion?.point)?[...node.motion.point]:[0,0,0];
    const side=id.includes('port')?-1:id.includes('starboard')?1:Math.abs(pivot[0])>.15?Math.sign(pivot[0]):0;
    const isMoving=Boolean(node.motion||id.startsWith('helm.')||id.startsWith('hatch.')||id.startsWith('yard.')||id.startsWith('sail.')||id.startsWith('rowing.'));
    const explodedOffset=[
      c.layer===2||c.layer===3?(side!==0?side*1.8:pivot[0]*.35):pivot[0]*.2,
      c.layer===0?-1.2:c.layer*1.1+Math.max(0,pivot[1])*.2,
      pivot[2]*.15,
    ];
    return {partNumber:idx,id,parent:node.parent??null,...c,cutawaySide:side,isMoving,pivot,explodedOffset};
  });
  for(const g of guns){
    const id=g.meshGroup??('gun.'+g.id);
    if(roles[id])continue;
    const pivot=g.breechDesign?[...g.breechDesign]:[0,0,0];
    const side=g.sideSign??(g.side==='port'?-1:1);
    rawNodes.push({partNumber:rawNodes.length,id,parent:'hull',subAssembly:'ordnance-and-helm',subAssemblyIndex:2,layer:2,cutawaySide:side,isMoving:true,pivot,explodedOffset:[side*2.2,pivot[1]*.2+0.6,pivot[2]*.15]});
  }
  const ordered=[...rawNodes].sort((a,b)=>a.layer-b.layer||a.pivot[1]-b.pivot[1]||a.pivot[2]-b.pivot[2]||a.partNumber-b.partNumber);
  const win=Math.min(.2,Math.max(.06,1.5/Math.max(1,ordered.length)));
  const windows=new Array(rawNodes.length);
  for(let r=0;r<ordered.length;r++){
    const n=ordered[r],frac=ordered.length>1?r/(ordered.length-1):0;
    const start=Math.min(1-win,(n.layer/6)*.35+frac*(1-win-(n.layer/6)*.35));
    windows[n.partNumber]=[+start.toFixed(5),+Math.min(1,start+win).toFixed(5)];
  }
  const nodes=rawNodes.map(n=>({...n,assemblyWindow:windows[n.partNumber]}));
  return {version:1,subAssemblies:SHIP_SUB_ASSEMBLIES,cutawayModes:PART_CUTAWAY_MODES,partCount:nodes.length,nodes,nodesById:Object.fromEntries(nodes.map(n=>[n.id,n]))};
}

// Contract shape for later craft. Empty rig arrays are valid for a sail-less
// craft; oars/paddles bind the same stroke, grip, blade and water-load evaluator.
export const SHIP_PART_CAPABILITIES=deepFreeze({version:1,
  rig:{optional:true,empty:{masts:[],surfaces:[],controlGroups:[]}},
  propulsion:{sails:'posed-cloth forces',oars:'posed stroke and immersed blade forces',paddles:'posed stroke and immersed blade forces'},
  strokeRequirements:['pivot','grip','blade','station','evaluateTransform','waterContact','force'],
  steeringKinds:['rudder','steering-oar','steering-paddle','differential-oars','paddles'],
  assembly:{subAssemblies:SHIP_SUB_ASSEMBLIES,cutawayModes:PART_CUTAWAY_MODES,perVertexAttributes:['partNumber','explodedOffset','pivot','layerAndFlags'],perPartState:['appear','explode','wearAndDamage','cutawayVisibility']},
  readiness:'Explicit ready model and part adapter required; no identity fallback.'});

export function getShipParts(modelId='nina'){
  const model=requirePlayableShipModel(modelId),key=model.id+':'+model.revision;
  if(shipPartAdapters.has(key))return shipPartAdapters.get(key);
  if(Object.hasOwn(ROWING_DESIGNS,model.id)||Object.hasOwn(LATER_SAIL_DESIGNS,model.id)){
    const parts=deepFreeze(shipPartProceduralAdapter(model));shipPartAdapters.set(key,parts);return parts;
  }
  if(ADDITIONAL_DESIGNS[model.id]){const parts=deepFreeze(shipPartAdditionalAdapter(model));shipPartAdapters.set(key,parts);return parts;}
  if(!['nina','victory'].includes(model.id))throw Error('No shared-part adapter for '+model.id);
  const victory=model.id==='victory',design=victory?VICTORY_DESIGN:NINA_DESIGN;
  const width=victory?victoryHullHalfWidth:hullHalfWidth,skinDeck=victory?victoryHullDeck:hullDeck;
  const weatherDeck=victory?victoryVesselDeck:vesselDeck,weatherWidth=victory?victoryDeckHalfWidth:deckHalfWidth;
  const bounds=victory?[-6,6]:[-6.4,5.6];
  const zones=victory?[
    {id:'main',role:'deck.main',bounds:[-6,6],exposedBounds:[design.decks.forecastle.end,design.decks.quarter.start]},
    {id:'forecastle',role:'deck.forecastle',bounds:[-6,design.decks.forecastle.end]},
    {id:'quarter',role:'deck.quarter',bounds:[design.decks.quarter.start,6],exposedBounds:[design.decks.quarter.start,design.decks.poop.start]},
    {id:'poop',role:'deck.poop',bounds:[design.decks.poop.start,6]},
  ]:[{id:'main',role:'deck.main',bounds:[-6.4,5.6],exposedBounds:[-6.4,design.quarterdeck.start]},
    {id:'quarter',role:'deck.quarter',bounds:[design.quarterdeck.start,5.6]}];
  const surfaces=model.rig.sails.map((s,i)=>({...s,index:i,role:'sail.'+(victory?VICTORY_SAILS[i].name:shipPartControlIDs[i]),
    shape:(victory?VICTORY_SAILS[i]:SAIL_PLAN[i]).corners.length===3?'triangle':'quadrilateral',
    poseBackend:victory?'square1805':'lateen3'}));
  const roles=Object.fromEntries(Object.entries(model.nodes).map(([id,n])=>[id,{kind:n.kind,source:'model-node'}]));
  // Niña's working rudder is a real mesh group although the legacy point graph
  // omitted it. Its animation pivot is explicit in VESSEL_RIG.
  roles['helm.rudder']={kind:'part',source:victory?'model-node':'mesh-group-and-VESSEL_RIG'};
  const manifest=victory?{...BOAT_MANIFEST,crew:820,casksKg:40000,sparesKg:60000}:{...BOAT_MANIFEST};
  const parts={version:1,modelId:model.id,modelCode:model.modelCode,revision:model.revision,
    frame:{...model.designFrame,axes:{x:'starboard',y:'up',z:'aft'},origin:victory?'chosen service waterline amidships':'design waterline amidships; loading adds sinkage'},
    runtime:{...model.runtime},roles,
    hull:{family:model.hullFamily,profile:{kind:victory?'section-loft':'analytic-caravel',bounds,draft:design.hull.draft,
      halfWidth:width,skinDeck,weatherDeck,weatherWidth,point:(z,y,side)=>[side*width(z,y),y,z],
      authoredSurface:victory?victoryHullPoint:hullSurfacePoint,
      authoredParameters:victory?['station','baseY','side']:['station','angle'],
      provenance:victory?'Authored underwater loft and reference-fitted upper shell; not Admiralty offsets.':'Authored reconstruction profile; not surveyed offsets.'},
      keel:victory?{kind:'integral-loft-bottom',meshGroup:'hull.planking',separateTimber:null,historicalEndpoints:null,
        note:'No independently identified historical keel/rabbet endpoints; the loft bottom is not a measured keel.'}:
        {kind:'separate-timber',meshGroup:'hull.keel-stem',centreline:[[0,-design.hull.draft,-6.4+design.hull.bowRake],[0,-design.hull.draft,5.6-design.hull.sternRake]],
          width:.13,depth:.15,exposedDepth:.075,historicalEndpoints:null,note:'Actual authored beam; endpoint length is not a historical keel measurement.'},
      lateral:{kind:'projected-immersed-hull',separateKeel:victory?false:true,
        create:boat=>createHullLateralDescriptor({modelId:model.id,length:boat.length,beam:boat.beam,waterline:boat.hydrodynamics?.sinkage??0}),
        note:'Passive force descriptor derived from the loaded hull silhouette; separate exposed timber included only on Niña.'}},
    decks:{zones,weatherDeck,weatherWidth,gunDeckSchedule:victory?design.gunDecks:[],
      note:'Weather deck zones and battery schedule are distinct; a battery row does not assert a full interior deck mesh.'},
    steering:{kind:'rudder',control:victory?'wheel-and-tiller':'direct-tiller',rudder:{role:'helm.rudder',axis:[0,1,0],pivot:victory?[...design.tiller.pivot]:[0,-.6,5.68]},
      tiller:{role:'helm.tiller',axis:[0,1,0],pivot:[...design.tiller.pivot]},
      wheel:victory?{role:'helm.wheel',axis:[0,0,1],pivot:[...design.wheel.centre],radiansPerRudderDegree:.07}:null,
      grip:'helm.grip',camera:'helm.camera'},
    rig:{backend:model.rig.backend,masts:model.rig.masts,surfaces,
      controlGroups:shipPartControlIDs.map((id,index)=>({id,index,key:shipPartControlKeys[index],surfaceIDs:surfaces.filter(s=>s.controlGroup===id).map(s=>s.id)})),
      transferYards:!victory},
    propulsion:{sails:{enabled:true,backend:model.rig.backend},oars:null,paddles:null},
    equipment:{anchor:{limits:victory?VICTORY_ANCHOR_LIMITS:ANCHOR_LIMITS,port:'anchor.port.fairlead',starboard:'anchor.starboard.fairlead'},guns:createGunDefinitions(model.id)},
    loading:{manifest,provisionDays:DEFAULT_PROVISION_DAYS,policy:victory?'default-manifest-in-design-waterline':'manifest-added-to-design-hull-mass',
      evaluate:boat=>boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes,model.id),
      note:'Authored loading and stability; reported capacity/tonnage is separate provenance, not displacement mass.'},
    crew:{representedCount:Object.keys(model.crewStations).length,loadedCount:manifest.crew,representativeWatch:victory,
      stations:Object.entries(model.crewStations).map(([id,p])=>({id,role:shipPartStationRoles[id],node:'station.crew.'+id,position:[p.x,weatherDeck(p.z),p.z],route:[...p.route]}))},
    assembly:shipPartBuildAssemblyManifest(model,roles,createGunDefinitions(model.id)),
  };
  const frozen=deepFreeze(parts);shipPartAdapters.set(key,frozen);return frozen;
}

function shipPartAdditionalAdapter(model){
  const d=additionalDesign(model.id),id=d.id,context=additionalRigContext(id),weatherDeck=z=>additionalDeck(id,z),weatherWidth=z=>additionalDeckWidth(id,z);
  const halfWidth=(z,y)=>additionalHullWidth(id,z,y),skinDeck=z=>additionalHullDeck(id,z);
  const surfaces=model.rig.sails.map(s=>({...s,index:d.surfaces.findIndex(v=>v.id===s.surfaceId),role:s.sailNode,
    shape:d.surfaces.find(v=>v.id===s.surfaceId).corners.length===3?'triangle':'quadrilateral',poseBackend:'surfaces-v1'}));
  const manifest={...BOAT_MANIFEST,...d.loading},controlGroups=shipPartControlIDs.map((name,index)=>({id:name,index,key:shipPartControlKeys[index],surfaceIDs:surfaces.filter(s=>s.controlGroup===name).map(s=>s.id)})).filter(g=>g.surfaceIDs.length);
  const roles=Object.fromEntries(Object.entries(model.nodes).map(([name,n])=>[name,{kind:n.kind,source:'model-node'}])),guns=createGunDefinitions(id);
  return {version:1,modelId:id,modelCode:model.modelCode,revision:model.revision,frame:{...d.frame,axes:{x:'starboard',y:'up',z:'aft'},origin:'authored loaded waterline; reference tonnage does not set displacement'},runtime:{...d.runtime},
    roles,
    hull:{family:d.family,profile:{kind:'section-loft',bounds:[d.profile.stations[0],d.profile.stations.at(-1)],draft:d.profile.draft??-d.profile.levels[0],halfWidth,skinDeck,weatherDeck,weatherWidth,
      point:(z,y,side)=>[side*halfWidth(z,y),y,z],authoredSurface:(station,baseY,side)=>hullLoftPoint(d.profile,station,baseY,side),authoredParameters:['station','baseY','side'],provenance:d.interpretation},
      keel:{kind:'separate-timber',meshGroup:'hull.keel',centreline:d.keel.bounds.map(z=>[0,hullLoftBottom(d.profile,z),z]),width:d.keel.width,depth:d.keel.depth,exposedDepth:d.keel.depth,historicalEndpoints:null,note:'Authored exposed timber; not recovered historical keel endpoints.'},
      lateral:{kind:'projected-immersed-hull',separateKeel:true,create:boat=>createHullLateralDescriptor({modelId:id,length:boat.length,beam:boat.beam,waterline:boat.hydrodynamics?.sinkage??0})}},
    decks:{zones:d.deckZones.map(z=>({...z,bounds:[...z.bounds],role:'deck.'+z.id})),weatherDeck,weatherWidth,gunDeckSchedule:[]},
    steering:{kind:d.steering.kind,control:d.steering.control,rudder:{role:'helm.rudder',axis:[0,1,0],pivot:[...d.steering.pivot]},tiller:{role:'helm.tiller',axis:[0,1,0],pivot:[...d.steering.pivot]},wheel:null,grip:'helm.grip',camera:'helm.camera'},
    rig:{backend:'surfaces-v1',masts:model.rig.masts,surfaces,controlGroups,transferYards:surfaces.some(s=>s.kind==='lateen'),context},
    propulsion:{sails:{enabled:surfaces.length>0,backend:'surfaces-v1'},oars:null,paddles:null},
    equipment:{anchor:{limits:anchorEquipment({modelId:id}),port:'anchor.port.fairlead',starboard:'anchor.starboard.fairlead'},guns},
    loading:{manifest,provisionDays:DEFAULT_PROVISION_DAYS,policy:d.loading.designIncludesManifest?'default-manifest-in-design-waterline':'manifest-added-to-design-hull-mass',evaluate:boat=>boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes,id),note:d.interpretation},
    crew:{representedCount:Object.keys(d.crewStations).length,loadedCount:d.loading.crew,representativeWatch:d.loading.crew>Object.keys(d.crewStations).length,
      stations:Object.entries(d.crewStations).map(([name,p])=>({id:name,role:shipPartStationRoles[name],node:'station.crew.'+name,position:[p.x,weatherDeck(p.z),p.z],route:[...p.route]}))},
    assembly:shipPartBuildAssemblyManifest(model,roles,guns)};
}

function shipPartProceduralAdapter(model){
  const id=model.id,d=proceduralDesign(id),row=Object.hasOwn(ROWING_DESIGNS,id),context=proceduralRigContext(id),width=(z,y)=>proceduralHullWidth(id,z,y),skinDeck=z=>proceduralHullDeck(id,z),weatherDeck=(z,x=0)=>proceduralDeck(id,z,x),weatherWidth=z=>proceduralDeckWidth(id,z);
  const surfaces=model.rig.sails.map((s,index)=>({...s,index,role:s.sailNode,shape:d.surfaces.find(v=>v.id===s.surfaceId).corners.length===3?'triangle':'quadrilateral',poseBackend:'surfaces-v1'}));
  const controls=shipPartControlIDs.map((name,index)=>({id:name,index,key:shipPartControlKeys[index],surfaceIDs:surfaces.filter(s=>s.controlGroup===name).map(s=>s.id),station:context.controlStations?.[name]??null})).filter(g=>g.surfaceIDs.length);
  const keel=!d.keel?null:d.keel.kind==='profiled-ballast-fin'?{kind:d.keel.kind,meshGroup:'hull.keel',definition:d.keel,sections:d.keel.sections,
    halfWidth:(z,y)=>proceduralKeelHalfWidth(id,z,y),historicalEndpoints:null,note:d.keel.provenance}:
    {kind:'separate-timber',meshGroup:'hull.keel',definition:d.keel,centreline:d.keel.bounds.map(z=>[0,hullLoftBottom(d.profile,z),z]),
      width:d.keel.width,depth:d.keel.depth,exposedDepth:d.keel.depth,historicalEndpoints:null,note:d.keel.provenance??'Authored exposed timber; not recovered historical endpoints.'};
  const zones=(d.deckZones??[{id:'main',bounds:[d.profile.stations[0],d.profile.stations.at(-1)],height:d.floorHeight}]).map(z=>({...z,bounds:[...z.bounds],role:'deck.'+z.id}));
  if(d.cockpit)zones.push({id:'cockpit',bounds:[...d.cockpit.bounds],height:d.cockpit.floorHeight,halfWidth:d.cockpit.halfWidth,role:'deck.cockpit'});
  const anchor=!!(row?d.equipment.anchor:d.equipment.anchors),oar=row&&d.propulsion.kind==='oar',paddle=row&&d.propulsion.kind==='paddle';
  const represented=Object.keys(d.crewStations).length,steering=d.steering,hasTiller=Object.hasOwn(model.nodes,'helm.tiller'),hasWheel=Object.hasOwn(model.nodes,'helm.wheel');
  const roles=Object.fromEntries(Object.entries(model.nodes).map(([name,n])=>[name,{kind:n.kind,source:'model-node'}]));
  return {version:1,modelId:id,modelCode:model.modelCode,revision:model.revision,
    frame:{...d.frame,axes:{x:'starboard',y:'up',z:'aft'},origin:'authored loaded waterline; reported tonnage does not set displacement'},runtime:{...d.runtime},
    roles,
    hull:{family:d.family,profile:{kind:'section-loft',bounds:[d.profile.stations[0],d.profile.stations.at(-1)],draft:-d.profile.levels[0],appendageDraft:proceduralDraft(id),
      halfWidth:width,skinDeck,weatherDeck,weatherWidth,point:(z,y,side)=>[side*width(z,y),y,z],
      authoredSurface:(station,baseY,side)=>hullLoftPoint(d.profile,station,baseY,side),authoredParameters:['station','baseY','side'],provenance:d.interpretation},keel,
      lateral:{kind:'projected-immersed-hull',separateKeel:!!d.keel,
        create:boat=>createHullLateralDescriptor({modelId:id,length:boat.length,beam:boat.beam,waterline:boat.hydrodynamics?.sinkage??0}),
        note:'Loaded hull plus actual exposed appendage; geometric lateral area is not a calibrated historical dynamic CLR.'}},
    decks:{zones,weatherDeck,weatherWidth,gunDeckSchedule:[],structures:d.structures??[],cockpit:d.cockpit??null},
    steering:{kind:steering.kind,control:row?steering.kind:steering.control,rudder:{role:'helm.rudder',pivot:[...steering.pivot],axis:[0,1,0]},
      tiller:hasTiller?{role:'helm.tiller',pivot:[...steering.pivot],axis:[0,1,0]}:null,
      wheel:hasWheel?{role:'helm.wheel',pivot:[...steering.wheel.centre],axis:[...steering.wheel.axis],radiansPerRudderDegree:(steering.wheel.turnRatio??12)*Math.PI/180}:null,
      steeringOar:row?{role:'helm.steering-oar',pivot:[...steering.pivot],kind:steering.kind}:null,grip:'helm.grip',camera:'helm.camera'},
    rig:{backend:'surfaces-v1',masts:model.rig.masts,surfaces,controlGroups:controls,transferYards:surfaces.some(s=>s.kind==='lateen'),context},
    propulsion:{sails:{enabled:surfaces.length>0,backend:'surfaces-v1'},
      oars:oar?{enabled:true,backend:'rowing-stroke-v1',stations:d.stations,definition:d.propulsion}:null,
      paddles:paddle?{enabled:true,backend:'rowing-stroke-v1',stations:d.stations,definition:d.propulsion}:null,
      engine:d.equipment.engine?{...d.equipment.engine,enabled:false}:null},
    equipment:{anchor:anchor?{limits:anchorEquipment({modelId:id}),port:'anchor.port.fairlead',starboard:'anchor.starboard.fairlead'}:null,guns:[]},
    loading:{manifest:{...d.loading},provisionDays:proceduralProvisionDays(id),policy:d.loading.designIncludesManifest?'default-manifest-in-design-waterline':'manifest-added-to-design-hull-mass',
      evaluate:boat=>boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes,id),note:d.loading.interpretation??d.loading.provenance??d.interpretation},
    crew:{representedCount:represented,loadedCount:d.loading.crew,representativeWatch:d.loading.crew>represented,
      stations:Object.entries(d.crewStations).map(([name,p])=>({id:name,role:p.role??p.roles?.[0]??shipPartStationRoles[name]??'sailor',node:'station.crew.'+name,
        position:[p.x,p.y??weatherDeck(p.z,p.x),p.z],route:p.route?[...p.route]:[p.z,p.z],...(p.stationId?{rowingStation:p.stationId}:{})}))},
    assembly:shipPartBuildAssemblyManifest(model,roles,[])};
}

const shipPartDefaultLateen={side:-1,opening:.30,dip:0,fill:0,deployed:1,pressure:1};
const shipPartDefaultVictory={squareYaw:0,lateenYaw:0,windSide:0,windForward:0,set:[1,1,1],rig:[{fill:0},{fill:0},{fill:0}]};
function shipPartClothFrame(evaluate,u,v){
  const e=.0005,p=evaluate(u,v),du=shipPartSubtract(evaluate(u+e,v),evaluate(u-e,v)).map(x=>x/(2*e)),dv=shipPartSubtract(evaluate(u,v+e),evaluate(u,v-e)).map(x=>x/(2*e));
  return {position:p,basis:[du,dv,shipPartUnit(shipPartCross(du,dv))],kind:'surface',parameters:{u,v}};
}
function shipPartDesignTransform(boat,model,role,options){
  if(Object.hasOwn(ROWING_DESIGNS,model.id)||Object.hasOwn(LATER_SAIL_DESIGNS,model.id))return proceduralShipNodeTransform(boat,model,model.nodes[role],options);
  if(model.rig.backend==='surfaces-v1')return shipPartAdditionalTransform(boat,model,role,options);
  const victory=model.id==='victory',node=model.nodes[role],rudder=(boat.rudder??0)*Math.PI/180;
  if(role==='helm.rudder'||role==='helm.tiller'){
    const pivot=role==='helm.rudder'?(victory?VICTORY_DESIGN.tiller.pivot:[0,-.6,5.68]):(victory?VICTORY_DESIGN.tiller.pivot:TILLER_PIVOT);
    return shipPartRigid(pivot,p=>shipPartAdd(pivot,shipPartYaw(shipPartSubtract(p,pivot),rudder)));
  }
  if(role==='helm.wheel'){
    const pivot=VICTORY_DESIGN.wheel.centre;return shipPartRigid(pivot,p=>shipPartAdd(pivot,shipPartSpin(shipPartSubtract(p,pivot),(boat.rudder??0)*.07)));
  }
  if(role==='helm.grip'){
    const position=resolveShipNode(boat,role,{...options,space:'design'});
    const angle=victory?((options.along??0)<0?Math.PI-.6:.6)+Math.sin((boat.rudder??0)*.07)*.12:rudder;
    return {position,basis:shipPartIdentity().map(e=>victory?shipPartSpin(e,angle):shipPartYaw(e,angle)),kind:'rigid'};
  }
  if(role==='hatch.main'){
    const pivot=victory?victoryHatchPivot():[0,hullDeck(-2.65)+.085,-2.65];
    const a=(1-Math.max(0,Math.min(1,boat.hatchesClosed??0)))*Math.PI/2*(victory?-1:1);
    return shipPartRigid(pivot,p=>shipPartAdd(pivot,shipPartPitch(shipPartSubtract(p,pivot),a)));
  }
  if(victory&&(role.startsWith('sail.')||role.startsWith('yard.'))){
    const sail=VICTORY_SAILS.find(s=>role==='yard.'+s.name||role==='sail.'+s.name||role.startsWith('sail.'+s.name+'.'));
    if(!sail)throw Error('No authoritative Victory surface for '+role);
    const pose=victoryPose(sail,boat.sailState??shipPartDefaultVictory);
    if(role.startsWith('yard.'))return shipPartRigid(sail.pivot,p=>victoryYardPoint(sail.id,p,pose));
    const root=role==='sail.'+sail.name,triangle=sail.corners.length===3;
    const u=options.u??(root?(triangle?1/3:.5):(sail.kind==='headsail'||role.endsWith('.port')?0:1)),v=options.v??(root?(triangle?1/3:.5):1);
    return shipPartClothFrame((u,v)=>victoryClothPoint(sail.id,u,v,pose,options.time??0,options.wind??0),u,v);
  }
  const mast=node?.motion?.mast??shipPartControlIDs.findIndex(id=>role==='sail.'+id);
  if(!victory&&(node?.motion?.type==='lateen-yard'||role.startsWith('sail.'))){
    const m=mast>=0?mast:shipPartControlIDs.findIndex(id=>role.startsWith('sail.'+id+'.'));
    if(m<0)throw Error('No authoritative lateen surface for '+role);
    const pose=boat.sailState?.rig?.[m]??shipPartDefaultLateen;
    if(node?.motion?.type==='lateen-yard')return shipPartRigid(node.motion.point,p=>lateenYardPoint(m,p,pose));
    const u=options.u??node?.motion?.u??1/3,v=options.v??node?.motion?.v??1/3;
    return shipPartClothFrame((u,v)=>lateenClothPoint(m,u,v,pose,options.time??0,options.wind??0),u,v);
  }
  if(role.startsWith('mast.')){
    const m=shipPartControlIDs.findIndex(id=>role==='mast.'+id||role.startsWith('mast.'+id+'.'));
    if(m<0)throw Error('No authoritative mast for '+role);
    const position=resolveShipNode(boat,role,{...options,space:'design'});
    let axis;
    if(role.endsWith('.runner')){
      const step=options.step??0,a=resolveShipNode(boat,role,{...options,space:'design',step:step-.01}),b=resolveShipNode(boat,role,{...options,space:'design',step:step+.01});
      axis=shipPartSubtract(b,a);
      if(Math.hypot(...axis)<1e-12)axis=shipPartSubtract(resolveShipNode(boat,role,{...options,space:'design',step:1000}),resolveShipNode(boat,role,{...options,space:'design',step:0}));
    }else axis=victory?shipPartSubtract(victoryMastPoint(m,VICTORY_MASTS[m].height),victoryMastPoint(m,victoryVesselDeck(VICTORY_MASTS[m].z))):shipPartSubtract(mastPoint(m,RIG_MASTS[m].height),mastPoint(m,vesselDeck(RIG_MASTS[m].z)));
    const y=shipPartUnit(axis),z=shipPartUnit(shipPartCross([1,0,0],y)),x=shipPartUnit(shipPartCross(y,z));return {position,basis:[x,y,z],kind:'rigid'};
  }
  if(role.startsWith('rig.')&&role.endsWith('.fall')){
    const position=resolveShipNode(boat,role,{...options,space:'design'}),h=options.height??0;
    let direction=shipPartSubtract(resolveShipNode(boat,role,{...options,space:'design',height:h+.01}),resolveShipNode(boat,role,{...options,space:'design',height:h-.01}));
    if(Math.hypot(...direction)<1e-12)direction=shipPartSubtract(resolveShipNode(boat,role,{...options,space:'design',height:30}),resolveShipNode(boat,role,{...options,space:'design',height:-10}));
    const y=shipPartUnit(direction),z=shipPartUnit(shipPartCross([1,0,0],y)),x=shipPartUnit(shipPartCross(y,z));return {position,basis:[x,y,z],kind:'rigid'};
  }
  if(node?.motion&&node.motion.type!=='working-fall')throw Error('No authoritative transform evaluator for '+role);
  // These roles are hull-fixed. Refuse unknown descendants of moving parts;
  // adding a parent's animated translation is not a rigid attachment transform.
  for(let parent=node?.parent;parent;parent=model.nodes[parent]?.parent){
    const p=model.nodes[parent];if(p?.motion||parent.startsWith('yard.')||parent.startsWith('sail.'))throw Error('No authoritative moving-parent transform for '+role);
  }
  return {position:resolveShipNode(boat,role,{...options,space:'design'}),basis:shipPartIdentity(),kind:'rigid'};
}

function shipPartAdditionalTransform(boat,model,role,options){
  const d=additionalDesign(model.id),context=additionalRigContext(model.id),node=model.nodes[role],motion=node.motion,angle=(boat.rudder??0)*Math.PI/180;
  if(motion?.type==='surface-yard'||motion?.type==='surface-cloth'){
    const surface=d.surfaces.find(s=>s.id===motion.surface),pose=rigSurfacePose(surface,boat.sailState??{});
    if(motion.type==='surface-yard')return shipPartRigid(motion.point,p=>surfaceYardPoint(surface,p,pose));
    const u=options.u??motion.u,v=options.v??motion.v;
    return shipPartClothFrame((u,v)=>surfaceClothPoint(surface,u,v,pose,context,options.time??0,options.wind??0),u,v);
  }
  if(motion?.type==='surface-tiller')return shipPartRigid(node.position,p=>shipPartAdd(d.steering.pivot,shipPartYaw(shipPartSubtract(p,d.steering.pivot),angle)));
  if(motion?.type==='surface-tiller-grip')return {position:resolveShipNode(boat,role,{...options,space:'design'}),basis:shipPartIdentity().map(e=>shipPartYaw(e,angle)),kind:'rigid'};
  if(motion?.type==='surface-hatch'){
    const a=-(1-Math.max(0,Math.min(1,boat.hatchesClosed??0)))*Math.PI/2;
    return shipPartRigid(node.position,p=>shipPartAdd(node.position,shipPartPitch(shipPartSubtract(p,node.position),a)));
  }
  if(role.startsWith('mast.')||motion?.type==='surface-working-fall'){
    const mast=motion?.mast??d.masts.findIndex(m=>role==='mast.'+m.id||role.startsWith('mast.'+m.id+'.'));
    let axis;
    if(motion?.type==='surface-runner')axis=shipPartSubtract(resolveShipNode(boat,role,{...options,space:'design',step:node.motion.rungs}),resolveShipNode(boat,role,{...options,space:'design',step:0}));
    else if(motion?.type==='surface-working-fall'){
      const line=context.lines.find(l=>l.kind==='working-fall'&&l.mast===mast);if(!line)throw Error('Missing physical working fall for '+role);axis=shipPartSubtract(line.a,line.b);
    }else axis=shipPartSubtract(context.masts[mast].head,context.masts[mast].foot);
    const y=shipPartUnit(axis),z=shipPartUnit(shipPartCross([1,0,0],y)),x=shipPartUnit(shipPartCross(y,z));
    return {position:resolveShipNode(boat,role,{...options,space:'design'}),basis:[x,y,z],kind:'rigid'};
  }
  if(motion)throw Error('No authoritative additional transform for '+role);
  return {position:resolveShipNode(boat,role,{...options,space:'design'}),basis:shipPartIdentity(),kind:'rigid'};
}

// Basis columns map local coordinates to the requested space. Rigid parts use
// local XYZ; cloth uses local (u,v,normal). Columns include design→metre scaling
// and need not be unit length. This preserves anisotropic transforms faithfully.
// Surface root roles default to their centroid; clews keep their exact UVs.
export function resolveShipTransform(boat,role,{space='vessel',...options}={}){
  const parts=getShipParts(boat.modelId??'nina'),model=requirePlayableShipModel(parts.modelId);
  if(!Object.hasOwn(parts.roles,role))throw Error('Absent '+parts.modelId+' structure role: '+role);
  if(!['design','vessel','world'].includes(space))throw Error('Unknown ship transform space: '+space);
  if(![boat.length,boat.beam].every(v=>Number.isFinite(v)&&v>0))throw Error('Ship transform requires finite positive dimensions');
  const transform=shipPartDesignTransform(boat,model,role,options),scale=space==='design'?[1,1,1]:[boat.beam/parts.frame.beam,parts.frame.verticalScale,boat.length/parts.frame.length];
  const vector=p=>{
    const q=p.map((v,i)=>v*scale[i]);if(space!=='world')return q;
    const out=[0,0,0];boatRotate(out,...q,(boat.heading??0)*Math.PI/180,boat.pitch??0,boat.roll??0);return out;
  };
  const basis=transform.basis.map(vector);
  // A surface normal is a covector: recompute it after nonuniform scaling.
  if(transform.kind==='surface')basis[2]=shipPartUnit(shipPartCross(basis[0],basis[1]));
  let position=vector(transform.position);
  if(space==='world')position=shipPartAdd(position,[boat.x??0,boat.heave??0,boat.z??0]);
  return {...transform,modelId:parts.modelId,role,space,position,basis};
}
