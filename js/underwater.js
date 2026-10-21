// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {createUnderwaterMedium} from './wgsl/underwater.js';

// One optional HDR pass before bloom. It owns no simulation/readback and skips
// command encoding entirely outside the camera's near-surface inspection band.
export async function createUnderwater({device,shader,frameUBO,opticsUBO,transView,skyView,sampler,sunVis,
  derivView,seaSampler,cameraProbe=null,surfaceWaves=null,sceneShadows=null,format='rgba16float',samples=4,skipAir=false}){
  const module=await shader(createUnderwaterMedium({samples,cameraProbe:!!cameraProbe,surfaceWaves:!!surfaceWaves,shadows:!!sceneShadows,skipAir}),'underwater medium');
  const pipeline=await device.createRenderPipelineAsync({label:'underwater medium',layout:'auto',
    vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});
  const shadowGroup=sceneShadows?.bind(pipeline);
  const emptyGroup=surfaceWaves&&!shadowGroup?device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[]}):null;
  const waveGroups=surfaceWaves?.views.map(view=>device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[
    {binding:0,resource:{buffer:surfaceWaves.uniform}},{binding:1,resource:view}]}));
  let texture=null,view=null,group=null,width=0,height=0;
  const descriptor={label:'Underwater medium',colorAttachments:[{view:null,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]};
  return {
    get view(){return view;},pipeline,
    resize({width:w,height:h,hdrView,depthView,submergedView}){
      if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1)throw new RangeError('Underwater target dimensions must be positive integers');
      if(width!==w||height!==h||!texture){texture?.destroy();width=w;height=h;texture=device.createTexture({label:'underwater filtered HDR',size:[w,h],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});view=texture.createView();descriptor.colorAttachments[0].view=view;}
      const resources=[{buffer:frameUBO},hdrView,depthView,submergedView,{buffer:opticsUBO},transView,skyView,sampler,{buffer:sunVis},derivView,seaSampler,...(cameraProbe?[{buffer:cameraProbe}]:[])];
      group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      return view;
    },
    encode(encoder,active,timestampWrites){
      if(!active||!group)return false;
      descriptor.timestampWrites=timestampWrites;
      const pass=encoder.beginRenderPass(descriptor);pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      if(shadowGroup)pass.setBindGroup(1,shadowGroup);else if(emptyGroup)pass.setBindGroup(1,emptyGroup);
      if(waveGroups)pass.setBindGroup(2,waveGroups[surfaceWaves.current]);
      pass.draw(3);pass.end();return true;
    },
    destroy(){texture?.destroy();texture=null;view=null;group=null;width=height=0;},
  };
}
