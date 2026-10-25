import {createDolphinEncounter,DOLPHIN_LIMIT,DOLPHIN_SPLASH_LIMIT,DOLPHIN_SPLASH_SECONDS} from './dolphin-state.js';
import {createDolphinMesh} from './dolphin-mesh.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {surfaceWaveGroups} from './surface-bindings.js';
import {DOLPHIN_RENDER,DOLPHIN_RIPPLE_SEGMENTS,DOLPHIN_RIPPLE_RINGS,DOLPHIN_RIPPLE_ROWS,DOLPHIN_SHEET_SEGMENTS,DOLPHIN_SHEET_ROWS,DOLPHIN_DROP_COUNT} from './wgsl/dolphins.js';

export async function createDolphins({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,random=Math.random,waterOptics=null,surfaceWaves=null}){
  const state=createDolphinEncounter(random),mesh=createDolphinMesh(),B=GPUBufferUsage;
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const values=new Float32Array(DOLPHIN_LIMIT*8),splashValues=new Float32Array(DOLPHIN_SPLASH_LIMIT*12);
  const animals=buffer('dolphin poses',values,B.STORAGE),splashes=buffer('dolphin water entries',splashValues,B.STORAGE);
  const vertex=buffer('dolphin vertices',mesh.vertices,B.VERTEX),index=buffer('dolphin indices',mesh.indices,B.INDEX);
  const source=surfaceWaves?coupleSurfaceHeight(DOLPHIN_RENDER,'dolphinSea(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'seaSampler'}):DOLPHIN_RENDER;
  const module=await shader(source,'dolphins');
  const layout=[{arrayStride:36,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x3'}]}];
  const kinds=[['dolphin',layout],['dolphinRipple',[]],['dolphinSplash',[]],['dolphinDrop',[]]];
  const pipelines=await Promise.all(kinds.map(([kind,buffers],i)=>device.createRenderPipelineAsync({label:['dolphins','dolphin ripples','dolphin splash crowns','dolphin spray'][i],layout:'auto',
    vertex:{module,entryPoint:kind+'VS',buffers},fragment:{module,entryPoint:kind+'FS',targets:[{format,...(i?{blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}:{})}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:i===0,depthCompare:'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler,{buffer:animals},{buffer:splashes}];
  const groups=pipelines.map((pipe,i)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource})).filter(e=>(i===0?[0,1,2,3,4,5,6,7,8]:[0,1,2,3,4,5,6,7,9]).includes(e.binding))}));
  const waveGroups=pipelines.map(pipe=>surfaceWaveGroups(device,pipe,surfaceWaves));
  const submerged=waterOptics?await waterOptics.capture({source,pipeline:pipelines[0],vertex:{entryPoint:'dolphinVS',buffers:layout},entry:'dolphinFS',world:'v.world',groups:surfaceWaves?2:1}):null;
  const submergedGroup=submerged?.bindGroup(resources.slice(0,9));
  const submergedWaves=submerged?surfaceWaveGroups(device,submerged.pipeline,surfaceWaves):null;
  const bind=(pass,i)=>{pass.setPipeline(pipelines[i]);pass.setBindGroup(0,groups[i]);if(waveGroups[i])pass.setBindGroup(1,waveGroups[i][surfaceWaves.current]);};
  let splashCount=0,burstCount=0;
  return {state,triangles:mesh.indices.length/3,
    update(dt,boat,settings,terrain=null,vessels=[boat]){
      state.step(dt,boat,settings,terrain,vessels);splashCount=0;burstCount=0;
      for(let i=0;i<state.count;i++){
        const a=state.animals[i];values.set([a.x,a.depth,a.z,a.heading,a.pitch,a.scale,a.phase*Math.PI*2,1],i*8);
      }
      // Burst records come first: surface swimming draws rings only, while
      // emergence/reentry also draws a short connected sheet and secondary drops.
      for(const trail of [false,true])for(const s of state.splashes){
        if(s.age<0||s.age>=DOLPHIN_SPLASH_SECONDS||s.strength<=0||(s.kind==='trail')!==trail)continue;
        const kind=trail?0:s.kind==='emerge'?1:2;
        splashValues.set([s.x,s.z,s.age,s.strength,s.heading,s.seed,kind,s.scale??1,s.speed??0,0,0,0],splashCount++*12);
        if(!trail)burstCount++;
      }
      if(state.active)device.queue.writeBuffer(animals,0,values);if(splashCount)device.queue.writeBuffer(splashes,0,splashValues,0,splashCount*12);
    },
    drawSubmerged(pass,above=false){
      if(!submerged||!state.active)return;
      submerged.bind(pass,above);pass.setBindGroup(0,submergedGroup);if(submergedWaves)pass.setBindGroup(1,submergedWaves[surfaceWaves.current]);pass.setVertexBuffer(0,vertex);pass.setIndexBuffer(index,'uint32');pass.drawIndexed(mesh.indices.length,state.count);
    },
    draw(pass){
      if(state.active){bind(pass,0);pass.setVertexBuffer(0,vertex);pass.setIndexBuffer(index,'uint32');pass.drawIndexed(mesh.indices.length,state.count);}
      if(splashCount){bind(pass,1);pass.draw(DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_RINGS*DOLPHIN_RIPPLE_ROWS*6,splashCount);}
      if(burstCount){
        bind(pass,2);pass.draw(DOLPHIN_SHEET_SEGMENTS*DOLPHIN_SHEET_ROWS*6,burstCount);
        bind(pass,3);pass.draw(6,burstCount*DOLPHIN_DROP_COUNT);
      }
    },
    destroy(){for(const b of [animals,splashes,vertex,index])b.destroy();},
  };
}
