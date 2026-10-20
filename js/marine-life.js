// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {createMarineLifeState,MARINE_ANIMAL_LIMIT,MARINE_EFFECT_LIMIT,MARINE_EFFECT_SECONDS} from './marine-life-state.js';
import {MARINE_LIFE_RENDER,MARINE_BLOW_SEGMENTS,MARINE_BLOW_ROWS} from './wgsl/marine-life.js';
import {DOLPHIN_RIPPLE_SEGMENTS,DOLPHIN_RIPPLE_RINGS,DOLPHIN_RIPPLE_ROWS,DOLPHIN_SHEET_SEGMENTS,DOLPHIN_SHEET_ROWS,DOLPHIN_DROP_COUNT} from './wgsl/dolphins.js';

// Original procedural marine-animal approximations, in physical metres. Whale:
// humpback-like long pectorals, broad head, ventral pleats and horizontal flukes.
// Shark: fusiform trunk, five gill slits, swept dorsal and vertical caudal fin.
export function createMarineMesh(type='whale'){
  if(type!=='whale'&&type!=='shark')throw new Error(`Unknown marine mesh: ${type}`);
  const whale=type==='whale',vertices=[],indices=[];
  const add=(p,n,c)=>{const id=vertices.length/9;vertices.push(...p,...n,...c);return id;};
  const unit=n=>{const l=Math.hypot(...n)||1;return n.map(v=>v/l);};
  const tri=(a,b,c,colour)=>{
    const u=b.map((v,i)=>v-a[i]),v=c.map((q,i)=>q-a[i]),n=unit([u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]);
    const id=add(a,n,colour);add(b,n,colour);add(c,n,colour);indices.push(id,id+1,id+2);
  };
  // z, transverse radius, vertical radius, vertical centre.
  const profile=whale?[[-6.65,.025,.035,-.16],[-6.57,.50,.19,-.12],[-6.35,.95,.36,-.06],[-5.85,1.30,.64,.04],[-4.8,1.65,1.00,.12],[-3.8,1.90,1.38,.10],[-1.5,2.02,1.65,0],
    [.4,1.86,1.53,-.04],[1.7,1.55,1.30,-.13],[3.4,.96,.86,-.2],[4.8,.45,.44,-.24],[5.8,.16,.18,-.22],[6.4,.08,.10,-.22]]:
    [[-2.45,.015,.025,-.04],[-2.15,.24,.17,-.02],[-1.7,.43,.36,.02],[-1,.56,.52,0],[-.1,.57,.56,-.02],
      [.7,.44,.43,-.07],[1.4,.22,.25,-.12],[1.95,.07,.12,-.12],[2.2,.035,.08,-.10]];
  // Shape-preserving C1 Hermite profiles share one derivative on both sides of
  // every station. Using those same derivatives for normals removes the hard
  // circumferential bands from independent piecewise-linear body sections.
  const tangents=profile.map((point,index)=>[1,2,3].map(component=>{
    if(index===0)return (profile[1][component]-point[component])/(profile[1][0]-point[0]);
    if(index===profile.length-1)return (point[component]-profile[index-1][component])/(point[0]-profile[index-1][0]);
    const before=profile[index-1],after=profile[index+1],h0=point[0]-before[0],h1=after[0]-point[0];
    const a=(point[component]-before[component])/h0,b=(after[component]-point[component])/h1;
    if(a*b<=0)return 0;
    const w0=2*h1+h0,w1=h1+2*h0;return (w0+w1)/(w0/a+w1/b);
  }));
  const sample=z=>{
    let k=0;while(k<profile.length-2&&profile[k+1][0]<z)k++;
    const a=profile[k],b=profile[k+1],d=b[0]-a[0],t=Math.max(0,Math.min(1,(z-a[0])/d)),t2=t*t,t3=t2*t;
    const values=[],derivatives=[];
    for(let component=1;component<=3;component++){
      const m0=tangents[k][component-1],m1=tangents[k+1][component-1];
      values.push((2*t3-3*t2+1)*a[component]+(t3-2*t2+t)*d*m0+(-2*t3+3*t2)*b[component]+(t3-t2)*d*m1);
      derivatives.push(((6*t2-6*t)*a[component]+(3*t2-4*t+1)*d*m0+(-6*t2+6*t)*b[component]+(3*t2-2*t)*d*m1)/d);
    }
    return [...values,...derivatives];
  };
  const rings=whale?76:56,sectors=whale?32:24;
  for(let r=0;r<=rings;r++){
    const along=.5-.5*Math.cos(Math.PI*r/rings);
    const z=profile[0][0]+along*(profile.at(-1)[0]-profile[0][0]),[w,h,y,dw,dh,dy]=sample(z);
    for(let sector=0;sector<=sectors;sector++){
      const theta=sector/sectors*Math.PI*2,c=Math.cos(theta),s=Math.sin(theta),n=unit([c/w,s/h,-c*c*dw/w-s*s*dh/h-s*dy/h]);
      const belly=Math.max(0,Math.min(1,(-s-.08)/.75));
      const pleat=whale?Math.max(0,-s)*Math.max(0,1-Math.abs(z+3)/3)*Math.sin(theta*28)*.012:0;
      const colour=whale?[.033+belly*.16+pleat,.049+belly*.17+pleat,.061+belly*.17+pleat]:[.075+belly*.17,.105+belly*.18,.12+belly*.18];
      add([c*w,y+s*h,z],n,colour);
    }
  }
  for(let r=0;r<rings;r++)for(let s=0;s<sectors;s++){const a=r*(sectors+1)+s,b=a+sectors+1;indices.push(a,a+1,b,a+1,b+1,b);}
  function fin(outline,axis,thickness,colour){
    const contour=[];
    for(let i=0;i<outline.length;i++)for(let subdivision=0;subdivision<2;subdivision++){
      const t=subdivision/2,t2=t*t,t3=t2*t,p0=outline[(i+outline.length-1)%outline.length],p1=outline[i],p2=outline[(i+1)%outline.length],p3=outline[(i+2)%outline.length];
      contour.push(p1.map((p,a)=>.5*((2*p)+(-p0[a]+p2[a])*t+(2*p0[a]-5*p+4*p2[a]-p3[a])*t2+(-p0[a]+3*p-3*p2[a]+p3[a])*t3)));
    }
    const centre=[0,0,0];for(const p of contour)for(let i=0;i<3;i++)centre[i]+=p[i]/contour.length;
    const firstVertex=vertices.length/9,firstIndex=indices.length,n=contour.length;
    const edge=contour.map(p=>add(p,[0,0,0],colour));
    for(const side of [-1,1]){
      const bodyColour=whale&&axis===1&&Math.max(...outline.map(p=>Math.abs(p[0])))>4&&side>0?[.052,.076,.086]:colour;
      const c=[...centre];c[axis]+=side*thickness;const centreId=add(c,[0,0,0],bodyColour);
      const mid=contour.map(p=>{const q=p.map((v,a)=>centre[a]+(v-centre[a])*.66);q[axis]+=side*thickness*.75;return add(q,[0,0,0],bodyColour);});
      for(let i=0;i<n;i++){
        const j=(i+1)%n;
        if(side>0)indices.push(centreId,mid[i],mid[j],mid[i],edge[i],edge[j],mid[i],edge[j],mid[j]);
        else indices.push(centreId,mid[j],mid[i],mid[i],edge[j],edge[i],mid[i],mid[j],edge[j]);
      }
    }
    // Area-weighted shared normals round both the domed foil and its closed rim.
    // Flip the whole component if its winding points toward the centre.
    const sums=Array.from({length:vertices.length/9-firstVertex},()=>[0,0,0]);
    for(let i=firstIndex;i<indices.length;i+=3){
      const ids=indices.slice(i,i+3),p=ids.map(id=>vertices.slice(id*9,id*9+3)),u=p[1].map((v,a)=>v-p[0][a]),v=p[2].map((q,a)=>q-p[0][a]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      for(const id of ids)for(let a=0;a<3;a++)sums[id-firstVertex][a]+=normal[a];
    }
    let orientation=1;
    for(let id=firstVertex;id<vertices.length/9;id++){
      const normal=unit(sums[id-firstVertex]),p=vertices.slice(id*9,id*9+3),dot=normal.reduce((s,v,a)=>s+v*(p[a]-centre[a]),0);
      if(Math.abs(dot)>.001){orientation=Math.sign(dot);break;}
    }
    for(let id=firstVertex;id<vertices.length/9;id++){
      const normal=unit(sums[id-firstVertex]).map(v=>v*orientation);vertices.splice(id*9+3,3,...normal);
    }
    if(orientation<0)for(let i=firstIndex;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]];
  }
  if(whale){
    fin([[0,1.04,1.4],[0,1.74,1.85],[0,1.95,2.35],[0,1.46,2.55],[0,.9,2.9]],0,.14,[.04,.055,.063]);
    for(const side of [-1,1]){
      fin([[side*1.35,-.25,-2.5],[side*2.1,-.32,-2.05],[side*3.6,-.58,-.4],[side*4.9,-.78,.95],[side*5.05,-.88,1.4],
        [side*4.65,-.9,1.6],[side*3.5,-.68,.98],[side*1.35,-.47,-.75]],1,.12,[.13,.16,.17]);
      fin([[0,-.22,6.1],[side*.9,-.15,5.75],[side*2.2,-.13,5.45],[side*3.25,-.12,5.65],[side*3.5,-.18,6.05],
        [side*2.45,-.22,6.85],[side*.5,-.22,7.35],[side*.06,-.22,7.05]],1,.14,[.045,.065,.077]);
    }
  }else{
    fin([[0,.45,-.55],[0,1.25,-.15],[0,1.45,.20],[0,.66,.33],[0,.40,.74]],0,.055,[.075,.105,.12]);
    fin([[0,.21,1.25],[0,.53,1.40],[0,.62,1.57],[0,.22,1.72]],0,.025,[.075,.105,.12]);
    fin([[0,-.10,1.98],[0,.62,2.33],[0,1.28,2.85],[0,1.20,3.02],[0,.20,2.61],[0,-.09,2.42],
      [0,-.76,2.82],[0,-.91,2.73],[0,-.55,2.19]],0,.045,[.075,.105,.12]);
    for(const side of [-1,1]){
      fin([[side*.46,-.18,-.75],[side*1.05,-.28,-.15],[side*1.75,-.38,.6],[side*1.52,-.40,.73],[side*.49,-.29,.22]],1,.045,[.085,.115,.125]);
      fin([[side*.28,-.33,.95],[side*.65,-.46,1.40],[side*.3,-.4,1.43]],1,.03,[.085,.115,.125]);
      for(let gill=0;gill<5;gill++){
        const z=-1.25+gill*.12,[w,h,y]=sample(z),x=side*(w+.005),dark=[.028,.043,.048];
        tri([x,y+h*.35,z],[x,y-h*.45,z+.04],[x,y-h*.45,z+.065],dark);
        tri([x,y+h*.35,z],[x,y-h*.45,z+.065],[x,y+h*.35,z+.025],dark);
      }
    }
  }
  // Eyes remain animal-scale; no cartoon smile or human expression.
  for(const side of [-1,1]){
    const z=whale?-4.8:-1.8,[w,h,y]=sample(z),eye=[side*w*.97,y+h*.12,z],radius=whale?.065:.033;
    for(let i=0;i<10;i++){const a=i*Math.PI/5,b=(i+1)*Math.PI/5;
      tri(eye,[eye[0]+side*.013,eye[1]+Math.sin(a)*radius,eye[2]+Math.cos(a)*radius],[eye[0]+side*.013,eye[1]+Math.sin(b)*radius,eye[2]+Math.cos(b)*radius],[.006,.009,.01]);}
    const start=whale?-6.63:-2.1,end=whale?-3.1:-1.1,segments=whale?28:14;
    for(let i=0;i<segments;i++){
      const za=start+(end-start)*i/segments,zb=start+(end-start)*(i+1)/segments;
      const point=(z,dy)=>{const[w,h,y]=sample(z),level=whale?-.22:-.50;return [side*(w*Math.sqrt(1-level*level)+.008),y+h*level+dy,z];};
      const half=whale?.018:.009;tri(point(za,-half),point(zb,-half),point(zb,half),[.013,.021,.025]);tri(point(za,-half),point(zb,half),point(za,half),[.013,.021,.025]);
    }
  }
  if(whale)for(const side of [-1,1]){
    // Paired baleen-whale blowholes sit on the head where the exhalation begins.
    const z=-3.6,[w,h,y]=sample(z),x=side*.15,top=y+h*Math.sqrt(1-x*x/(w*w));
    const centre=[x,top+.022,z],lip=[.047,.065,.073],dark=[.005,.009,.011];
    for(let i=0;i<12;i++){
      const a=i*Math.PI/6,b=(i+1)*Math.PI/6;
      const point=(angle,scale,lift)=>{const px=x+Math.cos(angle)*.072*scale,pz=z+Math.sin(angle)*.18*scale,[pw,ph,py]=sample(pz);
        return [px,py+ph*Math.sqrt(1-px*px/(pw*pw))+lift,pz];};
      tri(centre,point(a,1,.023),point(b,1,.023),dark);
      tri(point(a,1,.023),point(a,1.35,.012),point(b,1.35,.012),lip);
      tri(point(a,1,.023),point(b,1.35,.012),point(b,1,.023),lip);
    }
  }
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices)};
}

export async function createMarineLife({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,random=Math.random,waterOptics=null}){
  const state=createMarineLifeState(random),B=GPUBufferUsage;
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const values=new Float32Array(MARINE_ANIMAL_LIMIT*8),effectValues=new Float32Array(MARINE_EFFECT_LIMIT*12);
  const animals=buffer('marine animal poses',values,B.STORAGE),effects=buffer('marine surface events',effectValues,B.STORAGE);
  const meshes={};for(const kind of ['shark','whale']){const mesh=createMarineMesh(kind);meshes[kind]={vertex:buffer(`${kind} vertices`,mesh.vertices,B.VERTEX),index:buffer(`${kind} indices`,mesh.indices,B.INDEX),count:mesh.indices.length};}
  const module=await shader(MARINE_LIFE_RENDER,'marine wildlife');
  const layout=[{arrayStride:36,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x3'}]}];
  const kinds=[['dolphin',layout,'marine animals'],['dolphinRipple',[],'marine ripples'],['dolphinSplash',[],'marine splash crowns'],['dolphinDrop',[],'marine spray'],['marineBlow',[],'whale blows']];
  const pipelines=await Promise.all(kinds.map(([kind,buffers,label],i)=>device.createRenderPipelineAsync({label,layout:'auto',
    vertex:{module,entryPoint:kind+'VS',buffers},fragment:{module,entryPoint:kind+'FS',targets:[{format,...(i?{blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}:{})}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:i===0,depthCompare:'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler,{buffer:animals},{buffer:effects}];
  const groups=pipelines.map((pipe,i)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource})).filter(e=>(i===0?[0,1,2,3,4,5,6,7,8]:[0,1,2,3,4,5,6,7,9]).includes(e.binding))}));
  const submerged=waterOptics?await waterOptics.capture({source:MARINE_LIFE_RENDER,pipeline:pipelines[0],vertex:{entryPoint:'dolphinVS',buffers:layout},entry:'dolphinFS',world:'v.world'}):null;
  const submergedGroup=submerged?.bindGroup(resources.slice(0,9));
  let waterCount=0,burstCount=0,blowCount=0;
  return {state,trigger:(type,boat,options)=>state.trigger(type,boat,options),encode(){},
    update(dt,boat,settings,terrain=null,vessels=[boat]){
      state.step(dt,boat,settings,terrain,vessels);waterCount=0;burstCount=0;blowCount=0;
      for(let i=0;i<state.count;i++){const a=state.animals[i];values.set([a.x,a.depth,a.z,a.heading,a.pitch,a.scale,a.phase,(a.type==='whale'?2:-2)+a.roll],i*8);}
      let count=0;
      // Stable pool order: impact bursts, ordinary surface trails, then blows.
      for(const category of [0,1,2])for(const e of state.effects){
        const type=e.kind==='blow'?2:e.kind==='trail'?1:0;
        if(type!==category||e.age<0||e.age>=MARINE_EFFECT_SECONDS||e.strength<=0)continue;
        const kind=e.kind==='trail'?0:e.kind==='emerge'?1:e.kind==='entry'?2:3;
        effectValues.set([e.x,e.z,e.age,e.strength,e.heading,e.seed,kind,e.scale,e.kind==='blow'?e.height:e.speed,e.windX,e.windZ,0],count++*12);
        if(type===0)burstCount++;if(type===2)blowCount++;else waterCount++;
      }
      if(state.active)device.queue.writeBuffer(animals,0,values);
      if(count)device.queue.writeBuffer(effects,0,effectValues,0,count*12);
    },
    drawSubmerged(pass){
      if(!submerged||!state.active)return;
      const mesh=meshes[state.animals[0].type];submerged.bind(pass);pass.setBindGroup(0,submergedGroup);pass.setVertexBuffer(0,mesh.vertex);pass.setIndexBuffer(mesh.index,'uint32');pass.drawIndexed(mesh.count,state.count);
    },
    draw(pass){
      if(state.active){const mesh=meshes[state.animals[0].type];pass.setPipeline(pipelines[0]);pass.setBindGroup(0,groups[0]);pass.setVertexBuffer(0,mesh.vertex);pass.setIndexBuffer(mesh.index,'uint32');pass.drawIndexed(mesh.count,state.count);}
      if(waterCount){pass.setPipeline(pipelines[1]);pass.setBindGroup(0,groups[1]);pass.draw(DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_RINGS*DOLPHIN_RIPPLE_ROWS*6,waterCount);}
      if(burstCount){pass.setPipeline(pipelines[2]);pass.setBindGroup(0,groups[2]);pass.draw(DOLPHIN_SHEET_SEGMENTS*DOLPHIN_SHEET_ROWS*6,burstCount);
        pass.setPipeline(pipelines[3]);pass.setBindGroup(0,groups[3]);pass.draw(6,burstCount*DOLPHIN_DROP_COUNT);}
      if(blowCount){pass.setPipeline(pipelines[4]);pass.setBindGroup(0,groups[4]);pass.draw(MARINE_BLOW_SEGMENTS*MARINE_BLOW_ROWS*6,blowCount,0,waterCount);}
    },
    destroy(){for(const b of [animals,effects,...Object.values(meshes).flatMap(m=>[m.vertex,m.index])])b.destroy();},
  };
}
