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
struct ShadowTentAxis {position:vec3f,weight:vec3f};
fn shadowTentIntegral(x:f32,radius:f32)->f32 {
  let q=clamp(x,-radius,radius);
  if(q<=0.0){return .5*(q+radius)*(q+radius);}
  return radius*radius-.5*(radius-q)*(radius-q);
}
// Integrate a tent over each depth texel, then pair adjacent texel weights
// into one bilinear comparison fetch. Contact shadows need at most four taps;
// wider physical penumbrae use nine. Positions and normalized weights vary
// continuously with subtexel receiver motion, unlike a sparse disk stencil.
fn shadowTentAxis(uv:f32,size:f32,radius:f32)->ShadowTentAxis {
  let pixel=uv*size;let base=floor(pixel-radius);
  var result:ShadowTentAxis;
  for(var pair=0u;pair<3u;pair++){
    let left=base+f32(pair*2u);
    let a=shadowTentIntegral(left+1.0-pixel,radius)-shadowTentIntegral(left-pixel,radius);
    let b=shadowTentIntegral(left+2.0-pixel,radius)-shadowTentIntegral(left+1.0-pixel,radius);
    let sum=max(a+b,0.0);
    result.position[pair]=(left+.5+b/max(sum,.000001))/size;
    result.weight[pair]=sum/(radius*radius);
  }
  return result;
}
fn shadowCanvasTransmission(sample:vec4f)->vec3f {
  // RGB is coverage-premultiplied by rasterization/filtering. White clear plus
  // a second visibility blend would attenuate the edge's coverage twice.
  return select(vec3f(1),clamp(sample.rgb/max(sample.a,.000001),vec3f(0),vec3f(1)),sample.a>.000001);
}
fn vesselShadow(world:vec3f,normal:vec3f)->vec3f {
  if(SH.origin.w<0.5){return vec3f(1);}
  let facing=select(-1.0,1.0,dot(normal,SH.sun.xyz)>=0.0);
  let offset=normal*facing*0.008+SH.sun.xyz*0.006;
  let p=SH.lightView*vec4f(world-SH.origin.xyz+offset,1.0);
  let uv=p.xy*vec2f(0.5,-0.5)+0.5;
  if(any(uv<vec2f(0)) || any(uv>vec2f(1)) || p.z<0.0){return vec3f(1);}
  let dim=vec2i(textureDimensions(solidShadow));
  let texel=uv*vec2f(dim)-.5;let cell=vec2i(floor(texel));let phase=fract(texel);
  var blockerSum=0.0;var blockerWeight=0.0;
  for(var corner=0u;corner<4u;corner++){
    let step=vec2i(i32(corner&1u),i32(corner>>1u));let at=clamp(cell+step,vec2i(0),dim-1);
    let weight=select(1.0-phase.x,phase.x,step.x==1)*select(1.0-phase.y,phase.y,step.y==1);
    let depth=min(textureLoad(solidShadow,at,0),textureLoad(canvasShadow,at,0));
    // Clear/further depth is not a blocker and must not drag the estimated
    // separation toward the far plane at a magnified shadow silhouette.
    if(depth<p.z-.00002){blockerSum+=depth*weight;blockerWeight+=weight;}
  }
  let blocker=select(p.z,blockerSum/max(blockerWeight,.000001),blockerWeight>.000001);
  // Solar angular radius grows the penumbra with receiver distance. The cap
  // bounds the nine-tap filter cost and prevents thin rigging washing out.
  let distance=max(p.z-blocker,0.0)*SH.sun.w;
  let radius=clamp(distance*0.004675/SH.texel.xy,vec2f(1.5),vec2f(6.0));
  let tentRadius=min(radius,vec2f(2.5));let spread=max(radius/2.5,vec2f(1));
  let horizontal=shadowTentAxis(uv.x,f32(dim.x),tentRadius.x);
  let vertical=shadowTentAxis(uv.y,f32(dim.y),tentRadius.y);
  let reference=min(p.z-0.00002,0.99999);
  let span=SH.texel.xy*vec2f(dim);
  let right=vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)*span.x*0.5;
  let up=vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)*span.y*0.5;
  let nl=dot(normal,SH.sun.xyz);
  let denominator=select(-1.0,1.0,nl>=0.0)*max(abs(nl),0.1)*SH.sun.w;
  let slope=vec2f(dot(normal,right),-dot(normal,up))*span/denominator;
  var result=vec3f(0);
  for(var i=0u;i<9u;i++){
    let x=i%3u;let y=i/3u;let weight=horizontal.weight[x]*vertical.weight[y];
    if(weight<=.000001){continue;}
    let delta=(vec2f(horizontal.position[x],vertical.position[y])-uv)*spread;let q=uv+delta;
    // Follow the receiving plane across the tent; the residual bias below is
    // limited to one comparison-texel footprint, independent of penumbra width.
    // A bilinear comparison fetch still tests ONE reference against four
    // distinct texel centres. Bound the nearer-plane discrepancy within that
    // exact footprint too; correcting only q leaves a repeating lattice of
    // false canvas blockers as the paired tent positions cross depth texels.
    let samplePhase=fract(q*vec2f(dim)-.5);
    let footprintBias=dot(max(slope,vec2f(0)),samplePhase/vec2f(dim))
      +dot(max(-slope,vec2f(0)),(vec2f(1)-samplePhase)/vec2f(dim));
    let depth=min(reference+dot(slope,delta)-footprintBias,0.99999);
    let solid=textureSampleCompareLevel(solidShadow,shadowCompare,q,depth);
    let cloth=textureSampleCompareLevel(canvasShadow,shadowCompare,q,depth);
    let transmission=shadowCanvasTransmission(textureSampleLevel(canvasFilter,shadowLinear,q,0.0));
    result+=solid*mix(transmission,vec3f(1),cloth)*weight;
  }
  return result;
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
    let transmission=shadowCanvasTransmission(textureSampleLevel(canvasFilter,shadowLinear,uv,0.0));
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
