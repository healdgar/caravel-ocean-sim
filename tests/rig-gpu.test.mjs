import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

test('rendered lateen rig has physical clearance on both tacks, while reefing, luffing and transferring yards', {timeout:240000}, async()=>{
  const port=process.env.RIG_TEST_PORT||8085;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error(`Rig test server exited: ${code}`);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();
    await page.route('**/__rig',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__rig`);
    const result=await page.evaluate(async()=>{
      const {VESSEL_RIG}=await import('/js/wgsl/vessel.js');
      const {SAIL_PLAN,RIG_LINES,RIG_SEGMENTS,ropeParameter,lateenRestPoint,lateenClothPoint,lateenYardPoint,writeLateenUniform,createLateenPoses,requestYardTransfer}=await import('/js/lateen.js');
      const {RIG_MASTS,mastPoint}=await import('/js/rigging.js');
      const {vesselDeck}=await import('/js/hull.js');
      const {sailingState,advanceSails,sailForces}=await import('/js/sailing.js');
      const {createCaravelMesh}=await import('/js/caravel.js');
      const {rigClearance,segmentDistance}=await import('/scripts/rig-clearance.mjs');
      const raw=createCaravelMesh(),points=[],triangles=[],segments=[];
      for(let i=0;i<raw.length;i+=27)if(Math.floor(raw[i+6])===13){
        triangles.push({mast:Math.round(raw[i+6]%1*16)-1,index:points.length/9});points.push(...raw.subarray(i,i+27));
      }
      const clothCount=points.length/9;
      const add=(p,material,uv=[0,0])=>{const index=points.length/9;points.push(...p,1,0,0,material,...uv);return index;};
      for(const [i,l]of RIG_LINES.entries())for(let j=0;j<RIG_SEGMENTS;j++){
        const t=ropeParameter(l,j),u=ropeParameter(l,j+1),point=t=>l.a.map((x,k)=>x+(l.b[k]-x)*t);
        segments.push({...l,name:`${l.kind}${l.mast}:${l.side}:${j}`,a:add(point(t),12,[100+i,t]),b:add(point(u),12,[100+i,u]),
          attachment:l.kind==='halyard'&&j===RIG_SEGMENTS-1?'b':['sheet','tack'].includes(l.kind)&&j===0?'a':null});
      }
      for(let m=0;m<3;m++){
        const plan=SAIL_PLAN[m],mast=RIG_MASTS[m];
        segments.push({kind:'mast',mast:m,name:`mast${m}`,r:mast.r,a:add(mastPoint(m,vesselDeck(mast.z)),10),b:add(mastPoint(m,mast.height),10)});
        segments.push({kind:'yard',mast:m,name:`yard${m}`,r:.07,a:add(plan.corners[0].map((v,k)=>v+[0,.14,.12][k]),10+plan.id/16),b:add(plan.corners[1].map((v,k)=>v+[0,-.12,-.1][k]),10+plan.id/16)});
        for(const [a,b]of [[[0,0],[1,0]],[[1,0],[0,1]],[[0,1],[0,0]]])for(let j=0;j<26;j++){
          const uv=t=>a.map((v,k)=>v+(b[k]-v)*t),u=uv(j/26),v=uv((j+1)/26);
          segments.push({kind:'edge',mast:m,name:`edge${m}`,r:.015,a:add(lateenRestPoint(m,...u),19+plan.id/16,u),b:add(lateenRestPoint(m,...v),19+plan.id/16,v)});
        }
      }
      const n=points.length/9,device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,buffer=(size,usage)=>device.createBuffer({size,usage});
      const hull=buffer(208,B.UNIFORM|B.COPY_DST),input=buffer(points.length*4,B.STORAGE|B.COPY_DST),output=buffer(n*32,B.STORAGE|B.COPY_SRC),read=buffer(n*32,B.MAP_READ|B.COPY_DST);
      device.queue.writeBuffer(input,0,new Float32Array(points));
      const module=device.createShaderModule({code:VESSEL_RIG+`
        @group(0) @binding(0) var<uniform> hull:Hull;
        @group(0) @binding(1) var<storage,read> points:array<f32>;
        @group(0) @binding(2) var<storage,read_write> out:array<vec4f>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
          let i=id.x*9u;if(i+8u>=arrayLength(&points)){return;}
          let p=rigVertex(vec3f(points[i],points[i+1u],points[i+2u]),vec3f(points[i+3u],points[i+4u],points[i+5u]),points[i+6u],vec2f(points[i+7u],points[i+8u]));
          out[id.x*2u]=vec4f(p.position,1);out[id.x*2u+1u]=vec4f(p.normal,0);
        }`});
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[hull,input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const states=[];
      for(const [fill,time]of [[1,0],[1,.2],[0,0],[0,.2]]){
        const poses=createLateenPoses([1,1,1]);poses.forEach(p=>Object.assign(p,{opening:.6,fill}));states.push({poses,time,label:`motion ${fill}/${time}`});
      }
      for(const side of [-1,1])for(const opening of [.3,.6,1.15])for(const deployed of [0,.25,.5,1])for(const fill of [0,1])for(const pressure of [-1,0,1]){
        const poses=createLateenPoses([deployed,deployed,deployed],side);poses.forEach(p=>Object.assign(p,{opening,fill,pressure}));states.push({poses,time:states.length*.137,label:`set ${side}/${opening}/${deployed}/${fill}/${pressure}`});
      }
      for(const sides of [[-1,1,-1],[1,-1,1]])for(const pressure of [-1,0]){
        const poses=createLateenPoses([1,1,1]);poses.forEach((p,m)=>Object.assign(p,{side:sides[m],opening:.3,fill:1,pressure}));
        states.push({poses,time:0,label:`mixed supports ${sides.join(',')}/${pressure}`});
      }
      for(const wind of [0,Math.PI]){
        const b={length:20,beam:6,heading:0,sailFore:1,sailMain:1,sailMizzen:1};
        for(let i=0;i<60;i++)advanceSails(b,.1,12,wind);
        for(let i=0;i<80;i++)advanceSails(b,.1,12,wind+Math.PI);
        requestYardTransfer(sailingState(b));
        for(let i=0;i<800;i++){
          advanceSails(b,.1,12,wind+Math.PI);sailForces(b,12,wind+Math.PI,0);const s=sailingState(b);
          if(i%2===0)states.push({poses:s.rig.map(p=>({...p})),time:i*.1,label:`transfer ${wind}/${s.maneuver?.stage}/${s.maneuver?.mast}/${i}`});
          if(i>10&&!s.maneuver)break;
        }
      }
      // Follow actual trim/load transitions, including repeated wind reversals
      // in irons, rather than testing only perfectly settled end poses.
      for(const side of [-1,1]){
        const b={length:20,beam:6,heading:0,sailFore:1,sailMain:1,sailMizzen:1};
        for(let i=0;i<60;i++)advanceSails(b,.1,12,side<0?Math.PI:0);
        for(let i=0;i<200;i++){
          const wind=i<100?(side<0?0:Math.PI):Math.PI/2+.08*Math.sin(i*.2);
          advanceSails(b,.1,12,wind);sailForces(b,12,wind,0);const s=sailingState(b);
          if(i%4===0)states.push({poses:s.rig.map(p=>({...p})),time:i*.1,label:`routine ${side}/${i}`});
        }
      }
      const failures=[],captures=[];let parity=0,normalError=0;
      for(const [stateIndex,state]of states.entries()){
        const h=new Float32Array(52);h[12]=6;h[13]=20;h[19]=state.time;h[34]=14;writeLateenUniform(h,{rig:state.poses});device.queue.writeBuffer(hull,0,h);
        const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipe);cp.setBindGroup(0,group);cp.dispatchWorkgroups(Math.ceil(n/64));cp.end();enc.copyBufferToBuffer(output,0,read,0,n*32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=new Float32Array(read.getMappedRange()).slice();read.unmap();if(!values.every(Number.isFinite))throw Error('Non-finite rig vertex');
        const p=i=>Array.from(values.subarray(i*8,i*8+3));
        if(stateIndex<4)captures.push(values.slice(0,clothCount*8));
        const tris=triangles.map(t=>({mast:t.mast,points:[p(t.index),p(t.index+1),p(t.index+2)]})),lines=segments.map(l=>({...l,a:p(l.a),b:p(l.b)}));
        const clearance=rigClearance(tris,lines);
        if(Object.keys(clearance.failures).length)failures.push({state:state.label,hits:clearance.failures});
        for(let i=0;i<clothCount;i+=79){
          const m=Math.round(points[i*9+6]%1*16)-1,expected=lateenClothPoint(m,points[i*9+7],points[i*9+8],state.poses[m],state.time,14,true,state.poses);
          parity=Math.max(parity,Math.hypot(...p(i).map((v,k)=>v-expected[k])));
          normalError=Math.max(normalError,Math.abs(Math.hypot(...values.subarray(i*8+4,i*8+7))-1));
        }
        for(const yard of lines.filter(l=>l.kind==='yard'))for(const line of lines.filter(l=>['shroud','runner','stay','fall','forestay','mast'].includes(l.kind))){
          const gap=segmentDistance(yard.a,yard.b,line.a,line.b)-yard.r-line.r;
          if(gap<.003-1e-5)failures.push({state:state.label,yard:yard.name,rope:line.name,gap});
        }
      }
      const movement=(a,b)=>{let d=0;for(let i=0;i<clothCount;i++)d=Math.max(d,Math.hypot(...[0,1,2].map(k=>captures[a][i*8+k]-captures[b][i*8+k])));return d;};
      device.destroy();return {errors,failures,states:states.length,parity,normalError,loaded:movement(0,1),slack:movement(2,3)};
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.states>100);
    assert.ok(result.parity<.00002,`CPU/GPU pose error ${result.parity}`);assert.ok(result.normalError<.0001);
    assert.ok(result.loaded<.01);assert.ok(result.slack>.05);
    assert.deepEqual(result.failures,[],'actual cloth triangles, rope radii and yards must separate without masking');
    console.log(`Lateen clearance: ${result.states} GPU poses; CPU/GPU error ${result.parity.toExponential(2)}`);
  }finally{await browser?.close();server.kill();}
});
