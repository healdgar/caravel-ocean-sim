// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone runs rendered checks.
// Bounded appearance witnesses, not a global LOD certification. Both sides use
// the SAME mature source pack; no invented crowns, texture or source response.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('actual mature native trees and their depth impostors preserve silhouette and integrated coverage',{timeout:600000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest_appearance',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__forest_appearance');
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js');
      const {loadForestScenery,createForestLeafSurfaces,FOREST_VERTEX_WGSL,FOREST_VERTEX_LAYOUT}=await import('/js/forest-scenery.js');
      const {createForestImpostorResources}=await import('/js/forest-impostor.js');
      const pack=await loadForestScenery();if(!pack.impostors)throw Error('Actual native atlases required: '+pack.impostorError);
      if(pack.manifest.nativeSource?.mode!=='catalog-mature-usdz')throw Error('This witness requires the actual catalogued mature native assets');
      if(pack.manifest.prototypes.length!==5||pack.impostors.manifest.layout.grid[0]!==16||!pack.impostors.manifest.layout.views.some(v=>v.direction[1]<0))throw Error('Five full-sphere mature specimens required');
      const projections=pack.impostors.manifest.prototypes.map((p,i)=>{
        const identity=pack.manifest.prototypes[i],projection=p.projection;
        if(p.id!==identity.id||p.radius!==identity.radius||p.centre.some((v,k)=>v!==identity.centre[k]))throw Error('Native identity bounds changed');
        if(!projection?.centre?.every(Number.isFinite)||projection.centre.length!==3||!(projection.supportRadius>0)||projection.groundPlaneY!==0||!projection.coverageBounds)throw Error('Exact above-ground projection metadata required');
        return projection;
      });
      const source=await pack.loadNative(),device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);device.lost.then(info=>{if(info.reason!=='destroyed')errors.push(info.message);});
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      const code=FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(1);}
`+FOREST_VERTEX_WGSL;
      const module=await shader(code,'actual forest silhouette shaders'),surfaces=await createForestLeafSurfaces({device,shader,pack:source});
      const atlas=await createForestImpostorResources({device,shader,pack:pack.impostors,forest:pack.manifest}),B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage;
      const allocated=[],make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);allocated.push(b);return b;};
      const frameData=new Float32Array(96),frame=make(frameData,B.UNIFORM),vertices=make(source.vertices,B.VERTEX),indices=make(source.indices,B.INDEX);
      // Keep the complete specimen/bound, but seat its collar as the actual
      // placement pack does. Exposing underground roots against empty sky would
      // test a tree floating in a void, not the game's above-ground forest.
      const sinks=pack.manifest.prototypes.map(p=>{const sink=pack.roots[p.firstRoot*12+9];if(!p.rootCount||!Number.isFinite(sink)||sink<0)throw Error('Recorded native collar sink required');return sink;});
      const roots=make(new Float32Array(pack.manifest.prototypes.flatMap(p=>[0,-sinks[p.id],0,1,0,1,1,1,p.id,sinks[p.id],0,0])),B.STORAGE);
      const visible=make(new Uint32Array(pack.manifest.prototypes.map(p=>p.id)),B.STORAGE),materials=make(surfaces.optics,B.STORAGE);
      const uniform={type:'uniform'},storage={type:'read-only-storage'},texture={viewDimension:'2d-array'};
      const layout0=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:uniform}]}),layout1=device.createBindGroupLayout({entries:[]});
      const entries=[0,1,2].map(binding=>({binding,visibility:S.VERTEX|S.FRAGMENT,buffer:binding===2?uniform:storage}));
      entries.push({binding:5,visibility:S.FRAGMENT,sampler:{}},{binding:6,visibility:S.FRAGMENT,buffer:storage},{binding:13,visibility:S.FRAGMENT,sampler:{}});
      for(const binding of [3,4,7,8,9,10,11,12])entries.push({binding,visibility:S.FRAGMENT,texture});
      const layout2=device.createBindGroupLayout({entries}),layout3=device.createBindGroupLayout({entries:[
        {binding:0,visibility:S.FRAGMENT,texture},{binding:1,visibility:S.FRAGMENT,texture},{binding:2,visibility:S.FRAGMENT,sampler:{}},{binding:3,visibility:S.VERTEX|S.FRAGMENT,buffer:storage}]});
      const layout=device.createPipelineLayout({bindGroupLayouts:[layout0,layout1,layout2,layout3]});
      const pipeline=(entryPoint,impostor=false)=>device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:impostor?'forestImpostorVS':'forestCanopyVS',buffers:impostor?[]:[FOREST_VERTEX_LAYOUT]},
        fragment:{module,entryPoint,targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list',cullMode:'none'},
        depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4,alphaToCoverageEnabled:entryPoint!=='forestNativeOpaqueFS'}});
      const opaque=await pipeline('forestNativeOpaqueFS'),leaf=await pipeline('forestNativeLeafFS'),impostor=await pipeline('forestImpostorFS',true);
      const groundCode=await shader(FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
@vertex fn groundVS(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
 let q=array<vec2f,6>(vec2f(-4096,-4096),vec2f(-4096,4096),vec2f(4096,-4096),vec2f(4096,-4096),vec2f(-4096,4096),vec2f(4096,4096));
 return F.viewProj*vec4f(vec3f(q[i].x,0,q[i].y)-F.camPos.xyz,1);
}
@fragment fn groundFS()->@location(0)vec4f{return vec4f(0,0,0,1);}`,'same opaque ground for both representations');
      const ground=await device.createRenderPipelineAsync({layout,vertex:{module:groundCode,entryPoint:'groundVS'},fragment:{module:groundCode,entryPoint:'groundFS',targets:[{format:'rgba16float'}]},
        primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4}});
      const group0=device.createBindGroup({layout:layout0,entries:[{binding:0,resource:{buffer:frame}}]}),group1=device.createBindGroup({layout:layout1,entries:[]}),group3=atlas.bind(impostor);
      const sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'}),repeatSampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      let materialBase=0;const groups=pack.manifest.prototypes.map(p=>{
        const bin=make(new Uint32Array([p.id,materialBase,p.nativeMaterials.length,0]),B.UNIFORM);materialBase+=p.nativeMaterials.length;
        const e=[roots,visible,bin].map((buffer,binding)=>({binding,resource:{buffer}}));e.push({binding:5,resource:sampler},{binding:6,resource:{buffer:materials}},{binding:13,resource:repeatSampler});
        for(let family=0;family<4;family++){const f=surfaces.families[family]??surfaces.families[0],first=family?5+family*2:3;e.push({binding:first,resource:f.albedo.createView({dimension:'2d-array'})},{binding:first+1,resource:f.normal.createView({dimension:'2d-array'})});}
        return device.createBindGroup({layout:layout2,entries:e});
      });
      const W=384,H=384,NATIVE_SCALE=4,textures=[];
      const targetFor=scale=>{
        const size=[W*scale,H*scale],target=device.createTexture({size,format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC});
        const msaa=device.createTexture({size,format:'rgba16float',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size,format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});
        textures.push(target,msaa,depth);return {target,msaa,depth};
      };
      const logical=targetFor(1),supersampled=targetFor(NATIVE_SCALE);
      const averageModule=await shader(`@group(0)@binding(0)var source:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position)pixel:vec4f)->@location(0)vec4f{
 let p=vec2i(pixel.xy)*4;var coverage=0.;
 for(var y=0;y<4;y++){for(var x=0;x<4;x++){coverage+=textureLoad(source,p+vec2i(x,y),0).r;}}
 return vec4f(coverage/16.,0,0,1);
}`,'native reference GPU 4x4 linear coverage area average');
      const averagePipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:averageModule,entryPoint:'vs'},fragment:{module:averageModule,entryPoint:'fs',targets:[{format:'rgba16float'}]}});
      const averageGroup=device.createBindGroup({layout:averagePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:supersampled.target.createView()}]});
      const half=(view,offset)=>{const h=view.getUint16(offset,true),sign=h&0x8000?-1:1,e=(h>>10)&31,m=h&1023;return e===0?sign*m*2**-24:e===31?(m?NaN:sign*Infinity):sign*(1+m/1024)*2**(e-15);};
      const render=async(p,mode,scale=1)=>{
        const output=scale===NATIVE_SCALE?supersampled:logical;
        // Change only physical pixel dimensions: the logical camera/projection
        // and immutable native geometry stay identical in all three witnesses.
        frameData.set([W*scale,H*scale,1/(W*scale),1/(H*scale)],36);device.queue.writeBuffer(frame,0,frameData);
        const read=device.createBuffer({size:W*H*8,usage:B.COPY_DST|B.MAP_READ}),encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({
          colorAttachments:[{view:output.msaa.createView(),resolveTarget:output.target.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:output.depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:0}});
        pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.setBindGroup(2,groups[p.id]);pass.setBindGroup(3,group3);
        // A real shared depth plane occludes buried source roots AND any atlas
        // reconstruction behind that ground. No colour/vertex clipping shortcut.
        pass.setPipeline(ground);pass.draw(6);
        if(mode==='native'){pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.setPipeline(opaque);pass.drawIndexed(p.wood.indexCount,1,p.wood.firstIndex);pass.setPipeline(leaf);pass.drawIndexed(p.leaf.indexCount,1,p.leaf.firstIndex);}
        else{pass.setPipeline(impostor);pass.setIndexBuffer(atlas.indices,'uint32');pass.drawIndexed(6,1);}
        pass.end();
        if(scale===NATIVE_SCALE){const average=encoder.beginRenderPass({colorAttachments:[{view:logical.target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});average.setPipeline(averagePipeline);average.setBindGroup(0,averageGroup);average.draw(3);average.end();}
        encoder.copyTextureToBuffer({texture:logical.target},{buffer:read,bytesPerRow:W*8},[W,H]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        // White R preserves actual area. Never measure resolved alpha (alpha²)
        // or threshold tiny leaves before GPU averaging the64 native samples.
        const bytes=new DataView(read.getMappedRange()),coverage=Float32Array.from({length:W*H},(_,i)=>half(bytes,i*8));read.unmap();read.destroy();return coverage;
      };
      const normalize=a=>a.map(x=>x/Math.hypot(...a)),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      const camera=(p,requested,diameter)=>{
        const projection=projections[p.id],tan=.5,focal=H/(2*tan),distance=projection.supportRadius*Math.sqrt(1+(2*focal/diameter)**2),centre=[projection.centre[0],projection.centre[1]-sinks[p.id],projection.centre[2]];
        // A distant -0.2Y ray to a low crown can put the camera underground.
        // Keep the original bound and its requested projected diameter; only
        // lower the ray as far as a real 1.7m above-ground eye permits. Report
        // the actual angle instead of claiming the impossible requested angle.
        const minimumY=(1.7-centre[1])/distance,y=Math.max(requested[1],minimumY);if(y>=1)throw Error('Cannot place requested above-ground camera');
        const horizontal=Math.hypot(requested[0],requested[2]),span=Math.sqrt(Math.max(0,1-y*y));
        const d=[requested[0]/horizontal*span,y,requested[2]/horizontal*span],r=normalize(cross([0,1,0],d)),u=cross(d,r);
        frameData.fill(0);for(let k=0;k<3;k++){frameData[k*4]=r[k]/tan;frameData[k*4+1]=u[k]/tan;frameData[k*4+3]=-d[k];}
        frameData[14]=.1;frameData.set(centre.map((v,k)=>v+d[k]*distance),16);frameData.set(r.map(v=>v*tan),20);frameData.set(u.map(v=>v*tan),24);frameData.set(d.map(v=>-v),28);frameData.set([0,1,0,1],32);frameData.set([W,H,1/W,1/H],36);device.queue.writeBuffer(frame,0,frameData);
        return {requestedDirection:requested,actualDirection:d,eye:Array.from(frameData.slice(16,19)),lowerClamped:Math.abs(y-requested[1])>1e-8,distance,rootSink:sinks[p.id],sourceRoot:p.firstRoot,projectionCentre:projection.centre,supportRadius:projection.supportRadius,identityCentre:p.centre,identityRadius:p.radius};
      };
      // Exact squared Euclidean distance transform, not a 4-neighbour/chamfer
      // approximation that could conceal more than the allowed 3px displacement.
      const distances=mask=>{
        const data=Float64Array.from(mask,v=>v?0:1e12),v=new Int32Array(Math.max(W,H)),z=new Float64Array(v.length+1);
        const line=f=>{const out=new Float64Array(f.length);let k=0;v[0]=0;z[0]=-Infinity;z[1]=Infinity;
          for(let q=1;q<f.length;q++){let s;do{s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]));if(s<=z[k])k--;else break;}while(k>=0);k++;v[k]=q;z[k]=s;z[k+1]=Infinity;}
          k=0;for(let q=0;q<f.length;q++){while(z[k+1]<q)k++;out[q]=(q-v[k])**2+f[v[k]];}return out;};
        for(let y=0;y<H;y++)data.set(line(data.slice(y*W,(y+1)*W)),y*W);
        for(let x=0;x<W;x++){const column=line(Float64Array.from({length:H},(_,y)=>data[y*W+x]));for(let y=0;y<H;y++)data[y*W+x]=column[y];}return data;
      };
      const compare=(native,atlas)=>{
        const a=native.map(v=>v>0?1:0),b=atlas.map(v=>v>0?1:0),toA=distances(a),toB=distances(b);let nativeSum=0,atlasSum=0,nativePixels=0,atlasPixels=0,lost=0,added=0,intersection=0,union=0;
        for(let i=0;i<a.length;i++){nativeSum+=native[i];atlasSum+=atlas[i];if(a[i]){nativePixels++;lost=Math.max(lost,toB[i]);}if(b[i]){atlasPixels++;added=Math.max(added,toA[i]);}intersection+=a[i]&&b[i]?1:0;union+=a[i]||b[i]?1:0;}
        return {nativeSum,atlasSum,nativePixels,atlasPixels,relativeCoverageError:(atlasSum-nativeSum)/Math.max(nativeSum,1e-8),nativeToAtlas:Math.sqrt(lost),atlasToNative:Math.sqrt(added),iou:intersection/Math.max(union,1)};
      };
      const nearest=target=>pack.impostors.manifest.layout.views.reduce((best,view)=>view.direction.reduce((s,v,k)=>s+v*target[k],0)>best.direction.reduce((s,v,k)=>s+v*target[k],0)?view:best);
      // Horizontal exact source views remain physical above-ground cameras at
      // every tested size; lower off-frame views below use the eye-height rule.
      const sourceViews=[nearest(normalize([1,0,0])),nearest(normalize([0,0,1]))];
      const directions=[['horizontal-east',[1,0,0]],['horizontal-west',[-1,0,0]],['horizontal-north',[0,0,-1]],['horizontal-south',[0,0,1]],['lower-ne',[1,-.2,1]],['lower-sw',[-1,-.2,-1]],['above-nw',[1,.5,-1]],['above-se',[-1,.5,1]],...sourceViews.map(v=>['source-frame-'+v.index,v.direction])].map(([name,d])=>({name,d:normalize(d)}));
      const rows=[],witnesses=[];
      for(const p of pack.manifest.prototypes){let worst=null;
        for(const direction of directions)for(const diameter of [32,48,64,128,256]){
          const placement=camera(p,direction.d,diameter),native1x=await render(p,'native'),native=await render(p,'native',NATIVE_SCALE),atlas=await render(p,'atlas'),metric=compare(native,atlas);
          const row={species:p.species,direction:direction.name,diameter,...placement,...metric,native1xDiagnostic:compare(native1x,atlas),native1xVsSupersampled:compare(native,native1x)};rows.push(row);
          const score=Math.max(metric.nativeToAtlas/3,metric.atlasToNative/3,metric.nativeSum>=10?Math.abs(metric.relativeCoverageError)/.2:0);if(!worst||score>worst.score)worst={score,row,native,atlas};
        }
        const canvas=new OffscreenCanvas(W*3,H+20),context=canvas.getContext('2d'),image=context.createImageData(W*3,H);for(let i=0;i<W*H;i++){
          const x=i%W,y=Math.floor(i/W),a=worst.native[i]*255,b=worst.atlas[i]*255;for(let col=0;col<3;col++){const at=(y*W*3+col*W+x)*4;image.data.set(col===0?[a,a,a,255]:col===1?[b,b,b,255]:[Math.max(0,b-a),0,Math.max(0,a-b),255],at);}}
        context.fillStyle='#000';context.fillRect(0,0,canvas.width,canvas.height);context.putImageData(image,0,20);context.fillStyle='#fff';context.font='10px monospace';context.fillText('native4x + MSAA4 area average | depth atlas | excess red / loss blue',3,12);
        const name='forest-appearance-'+p.species+'-'+worst.row.direction+'-'+worst.row.diameter+'.png';const response=await fetch('/__shot?name='+encodeURIComponent(name),{method:'POST',body:await canvas.convertToBlob({type:'image/png'})});if(!response.ok)throw Error('Witness write failed');witnesses.push({file:'shots/'+name,...worst.row});
      }
      await device.queue.onSubmittedWorkDone();atlas.destroy();surfaces.destroy();for(const b of allocated)b.destroy();for(const t of textures)t.destroy();device.destroy();
      const report={format:'waterworld.forest-atlas-appearance',version:2,qualification:'250 bounded grounded mature/source-frame/off-frame witnesses; global appearanceErrorSupported remains false; whole-support3px fallback unchanged',
        fixture:{groundY:0,minimumEyeHeight:1.7,rootCollar:'First actual root sink per source prototype; instance scale1/yaw0; source geometry/bounds unchanged',cameraMapping:'Projection centre and supportRadius set requested above-ground body diameter; full native identity centre/radius remain unchanged and independently verified',mask:'Linear white R coverage, not alpha squared',logicalPixels:[W,H],diameters:[32,48,64,128,256],nativeReference:{scale:NATIVE_SCALE,physicalPixels:[W*NATIVE_SCALE,H*NATIVE_SCALE],msaa:4,logicalPixelSamples:64,filter:'GPU 4x4 arithmetic area average of resolved linear R; native1x MSAA4 diagnostic retained separately'},silhouetteTolerancePixels:3,coverageTolerance:.2,coverageMinimumReferenceSum:10},
        errors,rows,witnesses,sourceFiles:pack.manifest.files,atlasSourceFiles:pack.impostors.manifest.source.files,nativeMode:pack.manifest.nativeSource.mode,views:pack.impostors.manifest.layout.views.length};
      const response=await fetch('/__shot?name=forest-atlas-appearance-report.json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report,null,2)});if(!response.ok)throw Error('Appearance JSON report write failed');
      return {...report,reportFile:'shots/forest-atlas-appearance-report.json'};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.nativeMode,'catalog-mature-usdz');assert.equal(result.views,256);assert.equal(result.rows.length,250);
    for(const name of ['vertices.bin','indices.bin','roots.bin'])assert.deepEqual(result.sourceFiles[name].sha256,result.atlasSourceFiles[name].sha256,'same actual source '+name);
    assert.ok(result.rows.every(row=>row.eye[1]>=1.7-1e-4),'every comparison camera stays above physical ground');
    assert.ok(result.rows.filter(row=>row.direction.startsWith('lower-')).every(row=>row.actualDirection[1]<0),'lower witnesses still look upward from below the crown centre');
    assert.ok(result.rows.filter(row=>row.direction.startsWith('source-frame-')).every(row=>!row.lowerClamped),'exact source-frame witnesses retain their actual source direction');
    const failed=result.rows.filter(row=>!row.nativePixels||!row.atlasPixels||row.nativeToAtlas>3||row.atlasToNative>3||(row.nativeSum>=10&&Math.abs(row.relativeCoverageError)>.2));
    t.diagnostic(JSON.stringify({report:result.reportFile,cases:result.rows.length,failed:failed.length,qualification:result.qualification,worstBySpecies:result.witnesses}));
    assert.equal(failed.length,0,'Native-vs-atlas displacement exceeds3px or integrated coverage differs by more than20% (nativeSum>=10); inspect '+result.reportFile);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
