// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { NINA_DESIGN } from './models/nina.js';
import { deepFreeze, defineRig } from './rig-definition.js';
import { vesselDeck, anchorCathead, TILLER_PIVOT, TILLER_HANDLE, tillerPoint } from './hull.js';
import { RIG_MASTS, mastPoint, climbingPoint, workingTacklePoint } from './rigging.js';
import { SAIL_PLAN, lateenClothPoint, lateenYardPoint } from './lateen.js';

const MAST_IDS=['fore','main','mizzen'];
const structureNode=(id,position,parent='hull',kind='attachment',motion)=>({id,parent,kind,position,...(motion?{motion}:{})});
const delta=(a,b)=>a.map((v,i)=>v-b[i]);
function ninaNodes(){
  const nodes={},add=(...args)=>{const n=structureNode(...args);nodes[n.id]=n;return n;};
  add('hull',[0,0,0],null,'frame');add('deck.main',[0,.7,0],'hull','frame');
  add('deck.quarter',[0,NINA_DESIGN.quarterdeck.height,0],'hull','frame');
  add('helm.tiller',[...TILLER_PIVOT],'hull','part');
  add('helm.grip',[...TILLER_HANDLE],'hull','attachment',{type:'tiller-grip'});
  add('helm.camera',[NINA_DESIGN.helm.x,NINA_DESIGN.quarterdeck.height+NINA_DESIGN.helm.eyeAboveDeck/NINA_DESIGN.frame.verticalScale,NINA_DESIGN.helm.z]);
  add('hatch.main',[0,vesselDeck(-2.65)+.085,-2.65],'hull','part');
  add('station.hatch',[0,vesselDeck(-2.25),-2.25],'hull','station');
  for(const side of [-1,1]){
    const name=side<0?'port':'starboard',a=anchorCathead(side);
    for(const key of ['root','tip','fairlead'])add(`anchor.${name}.${key}`,[...a[key]]);
  }
  for(const [id,p]of Object.entries(NINA_DESIGN.crewStations))add(`station.crew.${id}`,[p.x,vesselDeck(p.z),p.z],'hull','station');
  for(const [mast,name]of MAST_IDS.entries()){
    const m=RIG_MASTS[mast],foot=mastPoint(mast,vesselDeck(m.z)),head=mastPoint(mast,m.height),sail=SAIL_PLAN[mast];
    add(`mast.${name}`,foot,'hull','frame');
    add(`mast.${name}.head`,delta(head,foot),`mast.${name}`);
    const runner=climbingPoint(mast,-1,0);
    add(`mast.${name}.runner`,delta(runner,foot),`mast.${name}`,'attachment',{type:'runner',mast});
    add(`rig.${name}.fall`,[0,0,0],'hull','attachment',{type:'working-fall',mast});
    add(`yard.${name}`,delta(sail.pivot,foot),`mast.${name}`,'part',{type:'lateen-yard',mast,point:[...sail.pivot]});
    add(`sail.${name}`,[0,0,0],`yard.${name}`,'part');
    add(`sail.${name}.clew`,[0,0,0],`yard.${name}`,'attachment',{type:'lateen-cloth',mast,u:0,v:1});
    for(const [i,end]of ['peak','tack'].entries())add(`yard.${name}.${end}`,[0,0,0],`yard.${name}`,'attachment',{type:'lateen-yard',mast,point:[...sail.corners[i]]});
    const haul=mast===1?[-.72,vesselDeck(2.03),2.03]:mast===2?[.15,vesselDeck(4.45),4.45]:(()=>{
      const p=workingTacklePoint(mast,vesselDeck(m.z)+.75);return [p[0]+Math.sign(p[0])*.35,vesselDeck(p[2]),p[2]];
    })();
    add(`station.haul.${name}`,haul,'hull','station');
  }
  return nodes;
}
function rigFor(id,kinds,nodes,{topsail=false,lookout=false}={}){
  const sails=MAST_IDS.map((mast,i)=>({id:mast+'-course',mast,kind:kinds[i],controlGroup:mast,yardNode:'yard.'+mast,
    clewNodes:kinds[i]==='lateen'?['sail.'+mast+'.clew']:['sail.'+mast+'.clew.port','sail.'+mast+'.clew.starboard']}));
  if(topsail){
    sails.push({id:'main-topsail',mast:'main',kind:'square',controlGroup:'main',yardNode:'yard.main.top',clewNodes:['sail.main.top.clew.port','sail.main.top.clew.starboard']});
    sails.push({id:'spritsail',mast:'fore',kind:'square',controlGroup:'fore',yardNode:'yard.bowsprit',clewNodes:['sail.bowsprit.clew.port','sail.bowsprit.clew.starboard']});
  }
  return defineRig({id:id+'-rig',backend:id==='nina'?'lateen3':'square-mixed-planned',
    masts:MAST_IDS.map(mast=>({id:mast,node:'mast.'+mast,headNode:'mast.'+mast+'.head',climbNode:'mast.'+mast+'.runner'})),sails,
    fittings:lookout?[{id:'foremast-lookout',kind:'crows-nest',mast:'fore',node:'lookout.fore',provenance:'user-requested; placement not historically verified'}]:[],
  },nodes,{planned:id!=='nina'});
}
function plannedNodes({topsail=false,lookout=false}={}){
  const nodes={hull:structureNode('hull',[0,0,0],null,'frame')};
  const add=(id,parent='hull',kind='attachment')=>{nodes[id]=structureNode(id,null,parent,kind);};
  for(const id of ['deck.main','deck.quarter','deck.forecastle'])add(id,'hull','frame');
  for(const id of ['helm.tiller','helm.grip','helm.camera','hatch.main','station.hatch'])add(id);
  for(const side of ['port','starboard'])for(const end of ['root','tip','fairlead'])add(`anchor.${side}.${end}`);
  for(const mast of MAST_IDS){
    add('mast.'+mast,'hull','frame');add('mast.'+mast+'.head','mast.'+mast);add('mast.'+mast+'.runner','mast.'+mast);
    add('yard.'+mast,'mast.'+mast,'part');add('sail.'+mast,'yard.'+mast,'part');
    for(const clew of mast==='mizzen'?['clew']:['clew.port','clew.starboard'])add('sail.'+mast+'.'+clew,'yard.'+mast);
    add('station.haul.'+mast);
  }
  if(topsail){
    add('yard.main.top','mast.main','part');add('yard.bowsprit','hull','part');
    for(const sail of ['main.top','bowsprit'])for(const side of ['port','starboard'])add(`sail.${sail}.clew.${side}`,'hull');
  }
  if(lookout)add('lookout.fore','mast.fore','station');
  return nodes;
}
const replicaReport=(id,name,dimensions,tonnage,source,notes)=>({id,subject:'modern-replica',name,dimensions,tonnage,source,notes});
const ninaDefinitionNodes=ninaNodes(),pintaDefinitionNodes=plannedNodes(),santaDefinitionNodes=plannedNodes({topsail:true,lookout:true});
export const SHIP_MODELS=deepFreeze({
  nina:{id:'nina',name:'Niña',revision:1,status:'ready',hullFamily:'caravel',geometry:'nina-procedural-v1',
    designFrame:NINA_DESIGN.frame,runtime:NINA_DESIGN.runtime,crewStations:NINA_DESIGN.crewStations,nodes:ninaDefinitionNodes,
    rig:rigFor('nina',['lateen','lateen','lateen'],ninaDefinitionNodes),
    referenceMeasurements:[replicaReport('sanger-nina','Sanger Ships Niña',[
      {kind:'deck-length',value:65,unit:'ft',metres:19.812},{kind:'beam',value:18,unit:'ft',metres:5.4864},{kind:'draught',value:7,unit:'ft',metres:2.1336}],
      {value:75,unit:null,kind:'tonnage-unspecified'},'https://www.ninapinta.org/index.html','Modern replica report. Neither historical offsets nor calibrated displacement; not applied to the current 20 × 6 m simulation.')],
  },
  pinta:{id:'pinta',name:'Pinta',revision:1,status:'planned',hullFamily:'caravel',geometry:null,designFrame:null,runtime:null,crewStations:null,nodes:pintaDefinitionNodes,
    rig:rigFor('pinta',['square','square','lateen'],pintaDefinitionNodes),
    referenceMeasurements:[replicaReport('sanger-pinta','Sanger Ships enlarged Pinta',[
      {kind:'deck-length',value:85,unit:'ft',metres:25.908},{kind:'beam',value:23,unit:'ft',metres:7.0104},{kind:'draught',value:7.5,unit:'ft',metres:2.286}],
      {value:101,unit:null,kind:'tonnage-unspecified'},'https://www.ninapinta.org/index.html','Modern replica enlarged for visitors. Do not use as original 1492 dimensions or physics mass.')],
  },
  'santa-maria':{id:'santa-maria',name:'Santa María',revision:1,status:'planned',hullFamily:'nao',geometry:null,designFrame:null,runtime:null,crewStations:null,nodes:santaDefinitionNodes,
    rig:rigFor('santa-maria',['square','square','lateen'],santaDefinitionNodes,{topsail:true,lookout:true}),
    referenceMeasurements:[replicaReport('nao-victoria-santa-maria','Fundación Nao Victoria Santa María',[
      {kind:'length-unspecified',value:28.30,unit:'m',metres:28.30},{kind:'maximum-beam',value:7.96,unit:'m',metres:7.96},{kind:'hull-depth',value:3.49,unit:'m',metres:3.49}],
      {value:200,unit:'toneladas',kind:'reported-weight',approximate:true},'https://www.fundacionnaovictoria.org/es/la-construccion-nao-santa-maria/','Modern replica; loading condition unspecified. Puntal is hull depth, not draught. Requires its own nao hull and deck geometry.')],
  },
});

export function getShipModel(id='nina'){
  if(!Object.hasOwn(SHIP_MODELS,id))throw Error('Unknown ship model: '+id);
  return SHIP_MODELS[id];
}
export function requirePlayableShipModel(id='nina'){
  const model=getShipModel(id);
  if(model.status!=='ready'||!model.geometry||!model.runtime||!model.designFrame||model.rig.backend!=='lateen3')throw Error(model.name+' is planned or not playable: geometry, rig animation/forces and clearance must be implemented first');
  return model;
}

// Points are authored in a model's design frame; output defaults to hull-local
// metres. Dynamic attachments use the same CPU deformation as mesh/forces.
// Each dynamic evaluator returns an absolute design point, including its parent.
export function resolveShipNode(boat,nodeId,{space='vessel',time=0,wind=0,side=-1,step=0,height=0,along=0,out=[0,0,0]}={}){
  const model=requirePlayableShipModel(boat.modelId??'nina'),node=model.nodes[nodeId];
  if(!node)throw Error('Unknown '+model.id+' structure node: '+nodeId);
  if(!['design','vessel'].includes(space))throw Error('Unknown structure coordinate space: '+space);
  if(!(boat.length>0&&boat.beam>0&&Number.isFinite(boat.length)&&Number.isFinite(boat.beam)))throw Error('Structure points require finite positive hull dimensions');
  // Avoid a divide/multiply round trip at the animated tiller grip.
  if(node.motion?.type==='tiller-grip'&&space==='vessel'){const p=tillerPoint(boat,along);for(let i=0;i<3;i++)out[i]=p[i];return out;}
  function position(n){
    const mast=n.motion?.mast,pose=boat.sailState?.rig?.[mast]??{side:-1,opening:.30,dip:0,fill:0,deployed:1,pressure:1};
    if(n.motion?.type==='lateen-cloth')return lateenClothPoint(mast,n.motion.u,n.motion.v,pose,time,wind);
    if(n.motion?.type==='lateen-yard')return lateenYardPoint(mast,n.motion.point,pose);
    if(n.motion?.type==='runner')return climbingPoint(mast,side,step,boat.sailState?.rig?.[mast]);
    if(n.motion?.type==='working-fall')return workingTacklePoint(mast,height);
    if(n.motion?.type==='tiller-grip'){const p=tillerPoint(boat,along);return [p[0]/(boat.beam/model.designFrame.beam),p[1]/model.designFrame.verticalScale,p[2]/(boat.length/model.designFrame.length)];}
    if(n.motion)throw Error('Unknown structure motion: '+n.motion.type);
    const p=[...n.position],parent=n.parent===null?null:position(model.nodes[n.parent]);
    if(parent)for(let i=0;i<3;i++)p[i]+=parent[i];return p;
  }
  const p=position(node);
  const f=model.designFrame,scale=space==='design'?[1,1,1]:[boat.beam/f.beam,f.verticalScale,boat.length/f.length];
  for(let i=0;i<3;i++)out[i]=p[i]*scale[i];return out;
}
