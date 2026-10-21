// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {SURFACE_WAVE_SAMPLE} from './surface-waves.js';
import {FLEET_WAKE_SAMPLE} from './interaction.js';

// Scene variants retain the isolated shader interfaces used by asset tools.
// Sampling is uniform-gated while dormant; no impact list runs per fragment.
export function surfaceWaveSource(group,uniformBinding,textureBinding,samplerName='wakeSamp'){
  return SURFACE_WAVE_SAMPLE.replaceAll('wakeSamp',samplerName)+`
@group(${group}) @binding(${uniformBinding}) var<uniform> SW:SurfaceWaveUniform;
@group(${group}) @binding(${textureBinding}) var surfaceWaveTex:texture_2d_array<f32>;
`;
}
export const SCENE_WAKE_SAMPLE=FLEET_WAKE_SAMPLE.replace('fn wakeAt(', 'fn vesselWakeAt(')+`
fn wakeAt(p:vec2f)->vec4f{return vesselWakeAt(p)+surfaceWaveAt(p);}
`;

export function coupleSurfaceHeight(source,returnValue,position,{group=0,uniformBinding,textureBinding,samplerName='wakeSamp'}={}){
  const marker='return '+returnValue+';';
  if(!source.includes(marker))throw new Error('Missing surface query: '+returnValue);
  return source.replace(marker,'return '+returnValue+'+surfaceWaveAt('+position+').x;')
    +surfaceWaveSource(group,uniformBinding,textureBinding,samplerName);
}
