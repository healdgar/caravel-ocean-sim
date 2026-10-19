import { loadCrewGLB, gltfTRS } from './gltf.js';
import { hullDeck } from './hull.js';
import { CREW_RENDER, CREW_SHADOW } from './wgsl/crew.js';

// A bounded deck-walking demonstration; the task/rigging system in CREW.md is next.
// Policies choose intent. The executor alone changes position and animation.
export function deckhandDecision(observation) {
  if(observation.hazard)return 'brace';
  return observation.order==='patrol'?'patrol':'standby';
}
export function createDeckhand(policy=deckhandDecision) {
  return {x:-.95,z:-1.9,yaw:0,target:.1,wait:1,time:0,walkTime:0,walk:0,brace:0,
    decisionIn:0,intent:'standby',order:'patrol',policy,visible:true,
    observation:{order:'patrol',hazard:false,roll:0,rollRate:0,wind:0},
    transform:new Float32Array(16),position:new Float32Array(3),rotation:new Float32Array(4),scale:new Float32Array([.95,.95,.95])};
}
export function stepDeckhand(s,boat,dt,wind=0) {
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));s.time+=dt;
  const o=s.observation;o.order=s.order;o.roll=boat.roll??0;o.rollRate=boat.rollVelocity??0;o.wind=wind;
  // Hysteresis avoids oscillating between walking and bracing near the threshold.
  o.hazard=Math.abs(o.roll)>(s.intent==='brace'?.26:.36)||Math.abs(o.rollRate)>(s.intent==='brace'?.3:.5)||wind>(s.intent==='brace'?19:23);
  s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){
    let decision;try{decision=s.policy(o);}catch{decision=deckhandDecision(o);}
    s.intent=['patrol','standby','brace'].includes(decision)?decision:deckhandDecision(o);s.decisionIn=.5;
    if(o.hazard)s.intent='brace';
  }
  // Preserve human proportions when resizing the hull; do not squeeze a person
  // through a walkway narrower than their shoulders.
  s.visible=boat.beam>=2.8&&boat.length>=8;
  let moving=false;const lengthScale=boat.length/12;
  if(s.visible&&s.intent==='patrol'){
    if(s.wait>0)s.wait=Math.max(0,s.wait-dt);
    else {
      const desired=s.target>s.z?0:Math.PI,angle=Math.atan2(Math.sin(desired-s.yaw),Math.cos(desired-s.yaw));
      s.yaw+=Math.max(-dt*2.5,Math.min(dt*2.5,angle));
      if(Math.abs(angle)<.1){
        const delta=s.target-s.z,travel=Math.min(Math.abs(delta),.8*dt/lengthScale);s.z+=Math.sign(delta)*travel;moving=travel>0;
        if(Math.abs(s.z-s.target)<1e-5){s.target=s.target>0?-2.2:.1;s.wait=2.5;}
      }
    }
  }
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  s.walkTime+=dt*.8; // Authored stride cadence, independent of delivered FPS.
  s.position.set([s.x*boat.beam/3.6,hullDeck(s.z)+.028,s.z*lengthScale]);
  s.rotation.set([0,Math.sin(s.yaw/2),0,Math.cos(s.yaw/2)]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return s;
}

export async function createCrew({device,frameUBO,hullUBO,transView,sampClamp,envCubeView,sunVisBuf,shadows,shader,format='rgba16float',samples=4}) {
  const response=await fetch('assets/crew/sailor.glb');if(!response.ok)throw Error('Sailor asset unavailable');
  const model=loadCrewGLB(await response.arrayBuffer()),B=GPUBufferUsage;
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const vertex=buffer('crew vertices',model.vertices,B.VERTEX),index=buffer('crew indices',model.indices,B.INDEX);
  const bones=buffer('crew joints',model.animator.palette,B.STORAGE),actor=buffer('crew transform',new Float32Array(16),B.UNIFORM);
  const layout=[{arrayStride:60,attributes:[
    {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'uint16x4'},
    {shaderLocation:4,offset:44,format:'float32x4'},
  ]}];
  const module=await shader(CREW_RENDER,'crew'),shadowModule=await shader(CREW_SHADOW,'crew shadow');
  const pipeline=await device.createRenderPipelineAsync({label:'crew',layout:'auto',vertex:{module,entryPoint:'vs',buffers:layout},
    fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const shadowPipeline=await device.createRenderPipelineAsync({label:'crew shadow',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:layout},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}});
  const group=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const common=[{buffer:hullUBO},{buffer:bones},{buffer:actor}];
  const main=group(pipeline,[{buffer:frameUBO},...common,transView,sampClamp,envCubeView,{buffer:sunVisBuf}]);
  const shadow=group(shadowPipeline,[{buffer:shadows.uniform},...common]),lighting=shadows.bind(pipeline),state=createDeckhand();
  let enabled=true,drawEnabled=false;
  const bind=(pass,pipe,bg)=>{pass.setPipeline(pipe);pass.setBindGroup(0,bg);pass.setVertexBuffer(0,vertex);pass.setIndexBuffer(index,'uint32');};
  return {state,triangles:model.indices.length/3,joints:model.animator.joints.length,
    update(boat,dt,wind){
      stepDeckhand(state,boat,dt,wind);enabled=boat.crew!==false;drawEnabled=enabled&&boat.showProw&&state.visible;
      if(!drawEnabled)return;
      const a=model.animator;
      // Blend standing/walking, then blend the result into a crouched brace.
      a.sample('Idle',state.time,'Walk',state.walkTime,state.walk);
      if(state.brace>.001)a.blend('Brace',state.time,state.brace);
      device.queue.writeBuffer(bones,0,a.palette);device.queue.writeBuffer(actor,0,state.transform);
    },
    draw(pass){if(!drawEnabled)return;bind(pass,pipeline,main);pass.setBindGroup(1,lighting);pass.drawIndexed(model.indices.length);},
    drawShadow(pass){if(!drawEnabled)return;bind(pass,shadowPipeline,shadow);pass.drawIndexed(model.indices.length);},
    status(){return !enabled?'Hidden':!state.visible?'Needs a wider deck':state.intent==='brace'?'Bracing':state.walk>.3?'Walking the deck':state.order==='standby'?'Standing by':'On watch';},
    destroy(){for(const b of [vertex,index,bones,actor])b.destroy();},
  };
}
