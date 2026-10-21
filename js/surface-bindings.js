// Copyright (c) 2026 Six Cailloux, LLC. MIT.
export function surfaceWaveGroups(device,pipeline,surfaceWaves,index=1,uniformBinding=0,textureBinding=1){
  if(!surfaceWaves)return null;
  return surfaceWaves.views.map(view=>device.createBindGroup({layout:pipeline.getBindGroupLayout(index),entries:[
    {binding:uniformBinding,resource:{buffer:surfaceWaves.uniform}},
    {binding:textureBinding,resource:view},
  ]}));
}
