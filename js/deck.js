import { DECK_COLS, DECK_ROWS, DECK_UPDATE, SCENE_DECK_UPDATE, DECK_RENDER } from './wgsl/deck.js';
import {surfaceWaveGroups} from './surface-bindings.js';

export async function createDeckWash({device,frameUBO,hullUBO,uniform,seaView,seaSampler,envView,transView,skyView=transView,sunVis,shader,computePipe,surfaceWaves=null}) {
  const textures=[0,1].map(i=>device.createTexture({label:'deck water '+i,size:[DECK_COLS,DECK_ROWS],format:'rgba32float',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC}));
  const views=textures.map(t=>t.createView());
  const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
  if(!sunVis){
    sunVis=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(sunVis,0,new Float32Array([1,1,1,1]));
  }
  const b=buffer=>({buffer});
  const bind=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({resource,binding}))});
  const [update,pipes]=await Promise.all([
    computePipe(surfaceWaves?SCENE_DECK_UPDATE:DECK_UPDATE,'deck wash'),
    shader(DECK_RENDER,'deck water').then(module=>Promise.all(['washVS','runoffVS'].map(entryPoint=>device.createRenderPipelineAsync({
      label:entryPoint,layout:'auto',vertex:{module,entryPoint},
      fragment:{module,entryPoint:'washFS',targets:[{format:'rgba16float',blend:{
        color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},
      }}]},primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:4},
    })))),
  ]);
  const groups=views.map((v,i)=>bind(update,[b(frameUBO),b(uniform),b(hullUBO),seaView,seaSampler,views[1-i],v]));
  const waveGroups=surfaceWaveGroups(device,update,surfaceWaves);
  // Four substeps always finish in texture zero; timber reads that same wetness field.
  const renderGroups=pipes.map(p=>bind(p,[b(frameUBO),b(hullUBO),views[0],sampler,envView,transView,b(sunVis),skyView]));
  let shadowGroups;
  return {
    textures,view:views[0],sampler,
    setShadows(shadows){shadowGroups=pipes.map(p=>shadows.bind(p));},
    encode(cp){
      cp.setPipeline(update);
      for(let s=0;s<4;s++){cp.setBindGroup(0,groups[1-s%2]);if(waveGroups)cp.setBindGroup(1,waveGroups[surfaceWaves.current]);cp.dispatchWorkgroups(DECK_COLS/8,DECK_ROWS/8);}
    },
    draw(pass){
      pass.setPipeline(pipes[0]);pass.setBindGroup(0,renderGroups[0]);pass.setBindGroup(1,shadowGroups[0]);pass.draw(DECK_COLS*DECK_ROWS*24);
      pass.setPipeline(pipes[1]);pass.setBindGroup(0,renderGroups[1]);pass.setBindGroup(1,shadowGroups[1]);pass.draw(8*6,2*(DECK_ROWS+DECK_COLS));
    },
  };
}
