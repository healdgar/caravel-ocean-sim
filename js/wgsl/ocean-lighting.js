// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,ATMO_CORE_WGSL,ENV_MIPS} from './common.js';

// No approximation: these frame-wide values are the ocean fragment's original
// transmittance lookup and five environment lookups, in the original order.
// The first vec4 remains the sun-visibility producer's independent output.
export const OCEAN_LIGHTING=FRAME_WGSL+ATMO_CORE_WGSL+/* wgsl */ `
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var sampC:sampler;
@group(0)@binding(3)var envCube:texture_cube<f32>;
@group(0)@binding(4)var<storage,read_write>oceanLighting:array<vec4f,4>;
@compute @workgroup_size(1)fn main(){
  let sunlight=textureSampleLevel(transLUT,sampC,transRMuToUV(RG+F.atmo.y,F.sunDir.y),0.0).rgb*F.sunDir.w*oceanLighting[0].x;
  let skyUp=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),${ENV_MIPS-1}.0).rgb;
  let skyHemi=skyUp*0.4+0.15*(
    textureSampleLevel(envCube,sampC,vec3f(0.94,0.34,0.0),${ENV_MIPS-2}.0).rgb+
    textureSampleLevel(envCube,sampC,vec3f(-0.94,0.34,0.0),${ENV_MIPS-2}.0).rgb+
    textureSampleLevel(envCube,sampC,vec3f(0.0,0.34,0.94),${ENV_MIPS-2}.0).rgb+
    textureSampleLevel(envCube,sampC,vec3f(0.0,0.34,-0.94),${ENV_MIPS-2}.0).rgb);
  oceanLighting[1]=vec4f(sunlight,0);
  oceanLighting[2]=vec4f(skyUp,0);
  oceanLighting[3]=vec4f(skyHemi,0);
}
`;

function oceanLightingExpressionKey(expression){
  return expression.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'').replace(/\s+/g,'')
    .replace(/\b(\d+)\.0+\b/g,'$1').replace(/\b0\.(\d+)/g,'.$1').replace(/\b(\d+)u\b/g,'$1');
}

export function withCachedOceanLighting(source){
  // Preserve offsets while excluding comment braces and declarations. Coastal
  // helpers have their own local lighting; specialize only the ocean entrypoint.
  const code=source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,comment=>' '.repeat(comment.length));
  const visibility=/\bvar\s*<\s*storage\s*,\s*read\s*>\s*sunVis\s*:\s*array\s*<\s*f32\s*,\s*4u?\s*>\s*;/g;
  const visibilityMatches=[...code.matchAll(visibility)];
  if(visibilityMatches.length!==1)throw new Error('Unrecognized ocean lighting visibility buffer');
  const fragments=[...code.matchAll(/@fragment\s+fn\s+fs\s*\(\s*in\s*:\s*VSOut\s*\)\s*->\s*@location\s*\(\s*0u?\s*\)\s*vec4f\s*\{/g)];
  if(fragments.length!==1)throw new Error('Unrecognized ocean lighting fragment');
  const start=fragments[0].index+fragments[0][0].length;
  let end=start,depth=1;
  for(;end<code.length&&depth;end++){
    if(code[end]==='{')depth++;
    else if(code[end]==='}')depth--;
  }
  if(depth)throw new Error('Unrecognized ocean lighting fragment body');
  const fragment=code.slice(start,end-1),edits=[{
    index:visibilityMatches[0].index,length:visibilityMatches[0][0].length,value:'var<storage,read>sunVis:array<f32,16>;',
  }];
  const definitions=[
    ['sunlight','sunIlluminance()*sunVis[0]','vec3f(sunVis[4],sunVis[5],sunVis[6])'],
    ['skyUp','textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),ENV_MAXMIP).rgb','vec3f(sunVis[8],sunVis[9],sunVis[10])'],
    ['skyHemi',`skyUp*0.4+0.15*(
      textureSampleLevel(envCube,sampC,vec3f(0.94,0.34,0.0),ENV_MAXMIP-1.0).rgb+
      textureSampleLevel(envCube,sampC,vec3f(-0.94,0.34,0.0),ENV_MAXMIP-1.0).rgb+
      textureSampleLevel(envCube,sampC,vec3f(0.0,0.34,0.94),ENV_MAXMIP-1.0).rgb+
      textureSampleLevel(envCube,sampC,vec3f(0.0,0.34,-0.94),ENV_MAXMIP-1.0).rgb)`,
      'vec3f(sunVis[12],sunVis[13],sunVis[14])'],
  ];
  for(const [name,expected,value]of definitions){
    const pattern=new RegExp('\\blet\\s+'+name+'\\s*=\\s*([^;]+);','g'),matches=[...fragment.matchAll(pattern)];
    if(matches.length!==1||oceanLightingExpressionKey(matches[0][1])!==oceanLightingExpressionKey(expected))throw new Error('Unrecognized ocean lighting '+name);
    edits.push({index:start+matches[0].index,length:matches[0][0].length,value:'let '+name+'='+value+';'});
  }
  for(const edit of edits.sort((a,b)=>b.index-a.index))source=source.slice(0,edit.index)+edit.value+source.slice(edit.index+edit.length);
  return source;
}
