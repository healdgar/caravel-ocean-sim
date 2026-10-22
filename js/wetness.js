import { WET_CLEAR, WET_DEPOSIT, WET_SEA, WET_UPDATE, WET_GRID, WET_SEA_SIZE } from './wgsl/wetness.js';
import { HULL_VERTICAL_SCALE, vesselVerticalScale } from './hull.js';
import { SPRAY_COUNT } from './wgsl/interaction.js';

// Moisture belongs to material probes, so furling, steering and crew movement
// carry it along. Nearby vertices of the same material share a bounded probe.
export function createWetnessData(mesh,crewCount=12) {
  if(!Number.isSafeInteger(crewCount)||crewCount<0||crewCount>128)throw Error('Wetness requires an explicit crew count between zero and 128');
  const points=[0,0,0,0,0,0,0,0],sourceVertices=[0],lookup=new Uint32Array(mesh.length/9),seen=new Map();
  for(let i=0;i<mesh.length;i+=9){
    const material=mesh[i+6],base=Math.floor(material);
    // Kind3 remains reserved for the dynamic crew probes. Iron carries only
    // a draining surface film (kind4), never the timber absorption response.
    const kind=[3,8].includes(base)?4:[2,12,19].includes(base)?1:[9,13].includes(base)?2:[0,1,5,6,7,10,14,15,16,17,18,20,21,23,24,25,26].includes(base)?0:-1;
    if(kind<0)continue;
    const key=[material,...[0,1,2].map(j=>Math.round(mesh[i+j]/.15)),(Math.round(material%1*16)&8)?mesh[i+8]:0].join('/');
    let probe=seen.get(key);
    if(probe===undefined){probe=points.length/8;seen.set(key,probe);sourceVertices.push(i);points.push(...mesh.subarray(i,i+3),material,mesh[i+7],mesh[i+8],kind,1);}
    lookup[i/9]=probe;
  }
  const crewOffset=points.length/8;
  return {points:new Float32Array([...points,...new Float32Array(crewCount*4*8)]),lookup,crewOffset,crewCount,sourceVertices:new Uint32Array(sourceVertices)};
}

// Four persistent material samples per actual actor. Posed seated bodies supply
// pelvis/torso/head samples; standing legacy actors retain their original leads.
export function writeCrewWetnessData(data,company,boat){
  const count=data.crewCount??(data.points.length/8-data.crewOffset)/4,crew=company?.crew??[];
  if(crew.length>count)throw Error('Crew exceeds this vessel’s allocated wetness probes');
  const sx=boat.beam/3.6,sy=vesselVerticalScale(boat),sz=boat.length/12;
  data.points.fill(0,data.crewOffset*8);
  for(const [i,s]of crew.entries())for(let h=0;h<4;h++){
    const p=s.moisturePoints?.[h]??[s.position[0],s.position[1]+[.08,.5,1.08,1.55][h]*s.scale[1],s.position[2]];
    if(!p||p.length!==3||!Array.from(p).every(Number.isFinite))throw Error('Non-finite crew wetness point');
    data.points.set([p[0]/sx,p[1]/sy,p[2]/sz,20,0,0,3,Number(s.visible)],(data.crewOffset+i*4+h)*8);
  }
  return data.points.subarray(data.crewOffset*8);
}

// The hull's probe layout is model data; crew positions and GPU moisture remain
// vessel state. Weak ownership releases the template with its source mesh.
const wetnessTemplates=new WeakMap();

export async function createSurfaceWetness({device,mesh,hullUBO,frameUBO,computePipe,crewCount=12}) {
  let templates=wetnessTemplates.get(mesh);if(!templates){templates=new Map();wetnessTemplates.set(mesh,templates);}
  let template=templates.get(crewCount);
  if(!template){template=createWetnessData(mesh,crewCount);templates.set(crewCount,template);}
  const data={points:template.points.slice(),lookup:template.lookup,crewOffset:template.crewOffset,crewCount:template.crewCount},B=GPUBufferUsage,T=GPUTextureUsage;
  const buffer=(label,size,usage)=>device.createBuffer({label,size,usage});
  const points=buffer('wetness probes',data.points.byteLength,B.STORAGE|B.COPY_DST);
  const lookup=buffer('wetness vertex lookup',data.lookup.byteLength,B.STORAGE|B.COPY_DST);
  const state=buffer('surface moisture',data.points.length/8*8,B.STORAGE|B.COPY_SRC|B.COPY_DST);
  device.queue.writeBuffer(points,0,data.points);device.queue.writeBuffer(lookup,0,data.lookup);
  const mist=buffer('wetting spray grid',WET_GRID.reduce((a,b)=>a*b)*4,B.STORAGE);
  const sea=device.createTexture({label:'wetting sea heights',size:[WET_SEA_SIZE,WET_SEA_SIZE],format:'r32float',usage:T.STORAGE_BINDING|T.TEXTURE_BINDING});
  const view=sea.createView();
  const pipes=await Promise.all([[WET_CLEAR,'wetting grid clear'],[WET_DEPOSIT,'spray deposition'],[WET_SEA,'wetting sea heights'],[WET_UPDATE,'surface moisture']].map(([code,label])=>computePipe(code,label)));
  const bind=(p,resources)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const b=buffer=>({buffer});let groups,needsClear=true;
  return {state,lookup,points,crewOffset:data.crewOffset,crewCount:data.crewCount,probeCount:data.points.length/8,
    connect(interaction,spindrift,seaView,seaSampler){
      groups=[bind(pipes[0],[b(mist)]),
        bind(pipes[1],[b(hullUBO),b(interaction.uniform),b(mist),b(interaction.drops),b(interaction.sheets),b(spindrift.plumes)]),
        bind(pipes[2],[b(frameUBO),b(hullUBO),seaView,seaSampler,view]),
        bind(pipes[3],[b(hullUBO),b(interaction.uniform),b(points),b(state),b(mist),view,interaction.deck.view])];
    },
    updateGeometry(posedMesh){
      if(posedMesh.length!==mesh.length)throw Error('Wetness geometry must match its source asset');
      for(let i=1;i<data.crewOffset;i++){
        const from=template.sourceVertices[i],to=i*8;
        data.points[to]=posedMesh[from];data.points[to+1]=posedMesh[from+1];data.points[to+2]=posedMesh[from+2];
      }
      device.queue.writeBuffer(points,0,data.points.subarray(0,data.crewOffset*8));
    },
    updateCrew(company,boat){
      const crewPoints=writeCrewWetnessData(data,company,boat);
      if(crewPoints.byteLength)device.queue.writeBuffer(points,data.crewOffset*32,crewPoints);
    },
    encode(pass,enabled=true){
      if(!enabled && !needsClear)return;
      needsClear=enabled;
      for(let i=enabled?0:3;i<4;i++){
        pass.setPipeline(pipes[i]);pass.setBindGroup(0,groups[i]);
        if(i===2)pass.dispatchWorkgroups(WET_SEA_SIZE/8,WET_SEA_SIZE/8);
        else pass.dispatchWorkgroups(Math.ceil((i===0?WET_GRID.reduce((a,b)=>a*b):i===1?SPRAY_COUNT:data.points.length/8)/64));
      }
    },
    destroy(){for(const resource of [points,lookup,state,mist,sea])resource.destroy();},
  };
}
