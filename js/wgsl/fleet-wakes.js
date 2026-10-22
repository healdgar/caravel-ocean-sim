// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {INTERACTION_TYPES,FLEET_WAKE_SAMPLE} from './interaction.js';
import {SCENE_WAKE_SAMPLE} from './surface-coupling.js';

// Preserve isolated two-ship shader contracts for tools. Production replaces
// the complete known sampler and its declarations, with explicit failure guards.
export function withPooledFleetWakes(source,count){
  if(!Number.isSafeInteger(count)||count<1||count>9)throw new RangeError('Invalid fleet wake count');
  const scene=source.includes(SCENE_WAKE_SAMPLE),sample=scene?SCENE_WAKE_SAMPLE:FLEET_WAKE_SAMPLE;
  if(source.split(sample).length!==2)throw new Error('Unrecognized fleet wake sampler');
  const name=scene?'vesselWakeAt':'wakeAt';
  let pooled=INTERACTION_TYPES+`
fn ${name}(p:vec2f)->vec4f{
  var total=vec4f(0);
  for(var slot=0u;slot<${count}u;slot++){
    let domain=fleetInteractions[slot];
    let uv=(p-domain.domain.xy)/domain.domain.z+.5;
    let edge=max(abs(uv.x-.5),abs(uv.y-.5));
    if(domain.motion.y>.5&&edge<.495){
      total+=textureSampleLevel(fleetWakeTex,wakeSamp,uv,i32(slot),0.0)*(1.0-smoothstep(.45,.495,edge))*domain.motion.y;
    }
  }
  return total;
}
`;
  if(scene)pooled+='fn wakeAt(p:vec2f)->vec4f{return vesselWakeAt(p)+surfaceWaveAt(p);}\n';
  source=source.replace(sample,pooled);
  const declarations=[
    [/var\s*<\s*uniform\s*>\s*I\s*:\s*Interaction\s*;/g,'var<uniform>fleetInteractions:array<Interaction,'+count+'>;'],
    [/var\s+wakeTex\s*:\s*texture_2d\s*<\s*f32\s*>\s*;/g,'var fleetWakeTex:texture_2d_array<f32>;'],
  ];
  for(const [pattern,value]of declarations){if([...source.matchAll(pattern)].length!==1)throw new Error('Unrecognized fleet wake declaration');source=source.replace(pattern,value);}
  for(const name of ['I2','wakeTex2']){
    const declaration=new RegExp('@group\\(\\s*\\d+\\s*\\)\\s*@binding\\(\\s*\\d+\\s*\\)\\s*var(?:\\s*<\\s*uniform\\s*>)?\\s*'+name+'\\s*:[^;]+;','g');
    if([...source.matchAll(declaration)].length!==1)throw new Error('Unrecognized secondary fleet wake declaration');
    source=source.replace(declaration,'');
  }
  return source.replace(/\bI\.domain\.w\b/g,'fleetInteractions[0].domain.w');
}
