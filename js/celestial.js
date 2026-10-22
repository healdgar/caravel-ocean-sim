import { propagatedStars } from './astronomy.js';
import { OCEAN_CONSTELLATIONS } from './star-catalog.js';
import { CELESTIAL_STARS, CELESTIAL_LINES } from './wgsl/celestial.js';

export async function createCelestialRenderer({device,shader,frameUBO,clock,sampler,format,samples}){
  const size=512,U=GPUTextureUsage,B=GPUBufferUsage;
  const texture=device.createTexture({label:'geographic stellar sky',size:[size,size,6],format:'rgba16float',usage:U.TEXTURE_BINDING|U.RENDER_ATTACHMENT});
  const stars=propagatedStars(clock.state.date),starData=new Float32Array(stars.length*6),starIndices=new Map(stars.map((s,i)=>[s.hip,i]));
  const edges=[];for(const path of OCEAN_CONSTELLATIONS)for(let i=1;i<path.length;i++)if(starIndices.has(path[i-1])&&starIndices.has(path[i]))edges.push(starIndices.get(path[i-1]),starIndices.get(path[i]));
  const lineData=new Float32Array(edges.length*3);
  const vertex=device.createBuffer({label:'proper-motion star catalogue',size:starData.byteLength,usage:B.VERTEX|B.COPY_DST});
  const lineVertex=device.createBuffer({label:'asterism connections',size:Math.max(12,lineData.byteLength),usage:B.VERTEX|B.COPY_DST});
  const [starModule,lineModule]=await Promise.all([shader(CELESTIAL_STARS,'catalogue stars'),shader(CELESTIAL_LINES,'constellation overlays')]);
  const blend={color:{srcFactor:'one',dstFactor:'one',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one',operation:'add'}};
  const starPipeline=await device.createRenderPipelineAsync({label:'stellar cube',layout:'auto',vertex:{module:starModule,entryPoint:'vs',buffers:[{arrayStride:24,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}]},fragment:{module:starModule,entryPoint:'fs',targets:[{format:'rgba16float',blend}]},primitive:{topology:'triangle-list'}});
  const linePipeline=await device.createRenderPipelineAsync({label:'constellation overlay',layout:'auto',vertex:{module:lineModule,entryPoint:'vs',buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment:{module:lineModule,entryPoint:'fs',targets:[{format,blend}]},primitive:{topology:'line-list'},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater-equal'},multisample:{count:samples}});
  const faces=Array.from({length:6},(_,face)=>{const uniform=device.createBuffer({size:16,usage:B.UNIFORM|B.COPY_DST});device.queue.writeBuffer(uniform,0,new Float32Array([face,size,0,0]));return {uniform,view:texture.createView({dimension:'2d',baseArrayLayer:face,arrayLayerCount:1}),group:device.createBindGroup({layout:starPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frameUBO}},{binding:1,resource:{buffer:uniform}}]})};});
  const lineGroups=new WeakMap();let lastDate='',lastTime=-Infinity,lastRevision=-1,dirty=true;
  function update(){
    const date=clock.state.date;
    if(!lastDate||Math.abs(Date.parse(date)-Date.parse(lastDate))>86400000){
      const moved=propagatedStars(date);
      for(let i=0;i<moved.length;i++){
        const s=moved[i],bv=Math.max(-.4,Math.min(2,s.colorIndex)),temperature=4600*(1/(.92*bv+1.7)+1/(.92*bv+.62));
        // Smooth blackbody-inspired RGB, normalized; no authored celestial positions.
        const color=[Math.min(1,Math.pow(6500/temperature,.45)),Math.min(1,Math.pow(temperature/6500,.12)),Math.min(1,Math.pow(temperature/6500,.8))];
        const norm=Math.max(...color),flux=14*Math.pow(10,-.4*(s.magnitude+26.74));
        starData.set(s.direction,i*6);for(let k=0;k<3;k++)starData[i*6+3+k]=color[k]/norm*flux;
      }
      for(let i=0;i<edges.length;i++)lineData.set(moved[edges[i]].direction,i*3);
      device.queue.writeBuffer(vertex,0,starData);if(lineData.length)device.queue.writeBuffer(lineVertex,0,lineData);lastDate=date;dirty=true;
    }
    const time=clock.epochMs+clock.elapsedSeconds*1000;
    if(Math.abs(time-lastTime)>=2000||lastRevision!==clock.revision){dirty=true;lastTime=time;lastRevision=clock.revision;}
    return dirty;
  }
  function encode(encoder){if(!dirty)return;for(const face of faces){const pass=encoder.beginRenderPass({label:'stellar cube face',colorAttachments:[{view:face.view,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});pass.setPipeline(starPipeline);pass.setBindGroup(0,face.group);pass.setVertexBuffer(0,vertex);pass.draw(6,stars.length);pass.end();}dirty=false;}
  function drawLines(pass,cloud){if(clock.mode!=='astronomy'||!clock.constellations||!lineData.length)return;let group=lineGroups.get(cloud);if(!group){group=device.createBindGroup({layout:linePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frameUBO}},{binding:1,resource:cloud.createView()},{binding:2,resource:sampler}]});lineGroups.set(cloud,group);}pass.setPipeline(linePipeline);pass.setBindGroup(0,group);pass.setVertexBuffer(0,lineVertex);pass.draw(edges.length);}
  return {texture,view:texture.createView({dimension:'cube'}),update,encode,drawLines,destroy(){texture.destroy();vertex.destroy();lineVertex.destroy();for(const face of faces)face.uniform.destroy();}};
}
