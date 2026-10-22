import { WEATHER_RENDER } from './wgsl/weather.js';
import {CELESTIAL_FRAME_BYTES} from './wgsl/celestial.js';

export async function createWeatherRenderer({device,frameUBO,hullUBO,transView,skyView,sampler,shader,format,samples}){
  const module=await shader(WEATHER_RENDER,'precipitation and lightning');
  const uniform=device.createBuffer({label:'weather motion',size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const values=new Float32Array(12);let count=0,flash=0;
  const pipes=await Promise.all(['rain','bolt'].map(kind=>device.createRenderPipelineAsync({label:kind==='rain'?'precipitation':'lightning',layout:'auto',
    vertex:{module,entryPoint:kind+'VS'},fragment:{module,entryPoint:kind+'FS',targets:[{format,blend:{
      color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,{buffer:uniform},{buffer:hullUBO}];
  // Lunar precipitation samples atmospheric transmittance. The isolated legacy
  // Frame keeps a zero-Moon stub, so binding1 is absent from its auto layout.
  const rainBindings=frameUBO.size>=CELESTIAL_FRAME_BYTES?[0,1,2,3,4,5]:[0,2,3,4,5];
  const groups=pipes.map((pipe,i)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource})).filter(e=>i===0?rainBindings.includes(e.binding):[0,4].includes(e.binding))}));
  return {
    update(weather,settings,dt){
      const angle=settings.windDir*Math.PI/180;
      values[2]=Math.cos(angle)*settings.windSpeed;values[3]=Math.sin(angle)*settings.windSpeed;
      values[0]+=values[2]*dt;values[1]+=values[3]*dt;
      if(weather.strike){const s=weather.strike;values.set([s.x,s.z,s.height,s.seed],4);values[8]=weather.time-s.at;}
      // Fixed particle budget, no per-particle CPU simulation or readback.
      count=Math.round((weather.type===1?6000:24000)*weather.intensity);flash=weather.flash;
      device.queue.writeBuffer(uniform,0,values);
    },
    draw(pass){
      if(flash>.005){pass.setPipeline(pipes[1]);pass.setBindGroup(0,groups[1]);pass.draw(6,48*3);}
      if(count){pass.setPipeline(pipes[0]);pass.setBindGroup(0,groups[0]);pass.draw(6,count);}
    },
    destroy(){uniform.destroy();},
  };
}
