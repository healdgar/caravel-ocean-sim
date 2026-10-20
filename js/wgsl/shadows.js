import { VESSEL_RIG, CANVAS_OPTICS } from './vessel.js';

export const SHADOW_FRAME = /* wgsl */ `
struct ShadowFrame { lightView:mat4x4f, origin:vec4f, sun:vec4f, texel:vec4f };
`;

export const SHADOW_CAST = SHADOW_FRAME + VESSEL_RIG + CANVAS_OPTICS + /* wgsl */ `
@group(0) @binding(0) var<uniform> hull:Hull;
@group(0) @binding(1) var<uniform> SH:ShadowFrame;
@group(0) @binding(2) var<storage,read> moisture:array<vec2f>;
@group(0) @binding(3) var<storage,read> wetLookup:array<u32>;
struct ShadowVertex {
  @builtin(position) position:vec4f,
  @location(0) normal:vec3f,
  @location(1) uv:vec2f,
  @location(2) @interpolate(flat) material:u32,
  @location(3) wet:f32,
};
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) material:f32,@location(3) uv:vec2f,@builtin(vertex_index) index:u32)->ShadowVertex {
  let rig=rigVertex(position,normal,material,uv);
  var out:ShadowVertex;
  out.position=SH.lightView*vec4f(rotateHull(rig.position*rig.scale),1.0);
  out.normal=normalize(rotateHull(rig.normal/rig.scale));out.uv=uv;out.material=u32(material);out.wet=moisture[wetLookup[index]].x;
  return out;
}
@fragment fn solidFS(){}
@fragment fn canvasFS(in:ShadowVertex)->@location(0) vec4f {
  return vec4f(canvasTransmission(canvasThickness(in.uv,in.material)*canvasWetDepth(in.wet),abs(dot(normalize(in.normal),SH.sun.xyz))),1.0);
}
`;

// Separate solid and cloth depths prevent translucent sails becoming opaque
// blockers. Only direct solar light is shadowed; sky and reflections remain.
export const SHADOW_SAMPLE = SHADOW_FRAME + /* wgsl */ `
@group(1) @binding(0) var<uniform> SH:ShadowFrame;
@group(1) @binding(1) var solidShadow:texture_depth_2d;
@group(1) @binding(2) var shadowCompare:sampler_comparison;
@group(1) @binding(3) var canvasShadow:texture_depth_2d;
@group(1) @binding(4) var canvasFilter:texture_2d<f32>;
@group(1) @binding(5) var shadowLinear:sampler;
fn vesselShadow(world:vec3f,normal:vec3f)->vec3f {
  if(SH.origin.w<0.5){return vec3f(1);}
  let facing=select(-1.0,1.0,dot(normal,SH.sun.xyz)>=0.0);
  let offset=normal*facing*0.008+SH.sun.xyz*0.006;
  let p=SH.lightView*vec4f(world-SH.origin.xyz+offset,1.0);
  let uv=p.xy*vec2f(0.5,-0.5)+0.5;
  if(any(uv<vec2f(0)) || any(uv>vec2f(1)) || p.z<0.0){return vec3f(1);}
  let dim=vec2i(textureDimensions(solidShadow));let at=clamp(vec2i(uv*vec2f(dim)),vec2i(0),dim-1);
  let blocker=min(textureLoad(solidShadow,at,0),textureLoad(canvasShadow,at,0));
  // Solar angular radius grows the penumbra with receiver distance. The cap
  // bounds the nine-tap filter cost and prevents thin rigging washing out.
  let distance=max(p.z-blocker,0.0)*SH.sun.w;
  let radius=clamp(distance*0.004675/SH.texel.xy,vec2f(0.8),vec2f(6.0))/vec2f(dim);
  let reference=min(p.z-0.00002,0.99999);
  let span=SH.texel.xy*vec2f(dim);
  let right=vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)*span.x*0.5;
  let up=vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)*span.y*0.5;
  let nl=dot(normal,SH.sun.xyz);
  let denominator=select(-1.0,1.0,nl>=0.0)*max(abs(nl),0.1)*SH.sun.w;
  let slope=vec2f(dot(normal,right),-dot(normal,up))*span/denominator;
  let offsets=array<vec2f,9>(vec2f(0,0),vec2f(0.334,0),vec2f(-0.348,0.319),vec2f(0.050,-0.575),
    vec2f(0.406,0.529),vec2f(-0.734,-0.130),vec2f(0.689,-0.438),vec2f(-0.229,0.852),vec2f(-0.435,-0.837));
  var result=vec3f(0);
  for(var i=0u;i<9u;i++){
    let delta=offsets[i]*radius;let q=uv+delta;
    // Follow the receiving plane across the filter, avoiding false self-shadow
    // on slanted sails without pushing contact shadows away from the geometry.
    let depth=min(reference+dot(slope,delta),0.99999);
    let solid=textureSampleCompareLevel(solidShadow,shadowCompare,q,depth);
    let cloth=textureSampleCompareLevel(canvasShadow,shadowCompare,q,depth);
    let transmission=textureSampleLevel(canvasFilter,shadowLinear,q,0.0).rgb;
    result+=solid*mix(transmission,vec3f(1),cloth);
  }
  return result/9.0;
}

// Water colour comes from a volume, not an opaque receiving sheet. Integrate
// sunlight entering around a refracted view ray. The optical length and diffuse
// spread are authored approximations; this is not a full underwater ray march.
fn waterVesselShadow(world:vec3f,normal:vec3f,view:vec3f,variance:f32)->vec3f {
  if(SH.origin.w<0.5){return vec3f(1);}
  let n=normalize(mix(vec3f(0,1,0),normal,0.8));
  let eyeRay=refract(-view,n,0.75);
  let sunRay=refract(-SH.sun.xyz,n,0.75);
  // Backtrack from points along the underwater view ray to the local surface.
  let entry=eyeRay-sunRay*(dot(eyeRay,n)/min(dot(sunRay,n),-0.1));
  let tangent=normalize(vec3f(n.y,-n.x,0));
  let bitangent=cross(n,tangent);
  let spread=0.22+0.7*sqrt(clamp(variance,0.0,0.25));
  let p=SH.lightView*vec4f(world-SH.origin.xyz+n*0.008+SH.sun.xyz*0.006,1);
  let shift=SH.lightView*vec4f(entry,0);
  let tx=SH.lightView*vec4f(tangent,0);
  let ty=SH.lightView*vec4f(bitangent,0);
  // Conservative bound around all sample footprints: no extra texture reads
  // across the rest of the ocean, including just outside the shadow-map border.
  let reach=abs(shift.xyz)*5.0+(abs(tx.xyz)+abs(ty.xyz))*(0.16+5.0*spread);
  if(any(abs(p.xy)>vec2f(1)+reach.xy) || p.z+reach.z<0.0){return vec3f(1);}
  var result=vec3f(0);
  for(var i=0u;i<32u;i++){
    // Equal-probability strata of an exponential optical path (mean 1.2 m).
    let path=-log(1.0-(f32(i)+0.5)/32.0)*1.2;
    let angle=f32(i)*2.399963;
    let radius=(0.16+path*spread)*sqrt((f32(i%4u)+0.5)/4.0);
    let q=p+shift*path+(tx*cos(angle)+ty*sin(angle))*radius;
    let uv=q.xy*vec2f(0.5,-0.5)+0.5;
    if(any(uv<vec2f(0)) || any(uv>vec2f(1)) || q.z<0.0){result+=vec3f(1);continue;}
    let depth=min(q.z-0.00002,0.99999);
    let solid=textureSampleCompareLevel(solidShadow,shadowCompare,uv,depth);
    let cloth=textureSampleCompareLevel(canvasShadow,shadowCompare,uv,depth);
    let transmission=textureSampleLevel(canvasFilter,shadowLinear,uv,0.0).rgb;
    result+=solid*mix(transmission,vec3f(1),cloth);
  }
  return result/32.0;
}
`;

// Identical filtering, with one independently fitted footprint per ship. Array
// layers retain the same three sampled textures even in a coastal scene.
export const SCENE_SHADOW_SAMPLE = SHADOW_SAMPLE
  .replace(/var<uniform>\s*SH:ShadowFrame;/,'var<uniform> shadowFrames:array<ShadowFrame,2>;')
  .replaceAll('texture_depth_2d;','texture_depth_2d_array;')
  .replace(/var\s+canvasFilter:texture_2d<f32>;/,'var canvasFilter:texture_2d_array<f32>;')
  .replace(/fn vesselShadow\(world:vec3f,normal:vec3f\)->vec3f\s*\{/,'fn vesselLayerShadow(world:vec3f,normal:vec3f,layer:i32)->vec3f {\n  let SH=shadowFrames[layer];')
  .replace(/fn waterVesselShadow\(world:vec3f,normal:vec3f,view:vec3f,variance:f32\)->vec3f\s*\{/,'fn waterVesselLayerShadow(world:vec3f,normal:vec3f,view:vec3f,variance:f32,layer:i32)->vec3f {\n  let SH=shadowFrames[layer];')
  .replaceAll('textureLoad(solidShadow,at,0)','textureLoad(solidShadow,at,layer,0)')
  .replaceAll('textureLoad(canvasShadow,at,0)','textureLoad(canvasShadow,at,layer,0)')
  .replaceAll('shadowCompare,q,depth','shadowCompare,q,layer,depth')
  .replaceAll('shadowCompare,uv,depth','shadowCompare,uv,layer,depth')
  .replaceAll('canvasFilter,shadowLinear,q,0.0','canvasFilter,shadowLinear,q,layer,0.0')
  .replaceAll('canvasFilter,shadowLinear,uv,0.0','canvasFilter,shadowLinear,uv,layer,0.0') + /* wgsl */ `
fn vesselShadow(world:vec3f,normal:vec3f)->vec3f {
  return vesselLayerShadow(world,normal,0)*vesselLayerShadow(world,normal,1);
}
fn waterVesselShadow(world:vec3f,normal:vec3f,view:vec3f,variance:f32)->vec3f {
  return waterVesselLayerShadow(world,normal,view,variance,0)*waterVesselLayerShadow(world,normal,view,variance,1);
}
`;
