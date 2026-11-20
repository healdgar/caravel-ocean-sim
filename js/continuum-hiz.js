// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared GPU Hierarchical-Z (Hi-Z) occlusion pyramid for the One Continuum (AGENTS.md rules 2 & 3.7).
// Built once per frame right after the opaque scene render pass from the live reverse-Z depth buffer (MSAA-safe min
// across every sample and every covered source pixel), then bound once per device in continuumSelect to conservatively
// cull occluded instances and clusters across every Continuum family (city, forest, people, ships, herds, meadow, etc.)
// while leaving shadows untouched and preventing any popping on fast camera turns or teleports.
import { requestOnce } from './gpu-program-cache.js';

export const CONTINUUM_HIZ_W = 512;
export const CONTINUUM_HIZ_H = 256;
export const CONTINUUM_HIZ_MIPS = 9; // 512x256 -> 256x128 -> ... -> 2x1
export const CONTINUUM_HIZ_TEXTURE_BINDING = 12;
export const CONTINUUM_HIZ_UNIFORM_BINDING = 13;
export const CONTINUUM_HIZ_UNIFORM_BYTES = 64; // 4 x vec4f

// Per-device shared Hi-Z pyramid texture + uniform buffer, initialized safely disabled (camPos.w = 0) so scenes
// created in tests or before frame 0 run identically with zero occlusion culling until main.js publishes frame depth.
const continuumHiZFields = new WeakMap();
export function continuumHiZField(device) {
  let field = continuumHiZFields.get(device);
  if (!field) {
    const T = globalThis.GPUTextureUsage;
    const B = globalThis.GPUBufferUsage;
    const texture = device.createTexture({
      label: 'continuum Hi-Z pyramid',
      size: [CONTINUUM_HIZ_W, CONTINUUM_HIZ_H],
      mipLevelCount: CONTINUUM_HIZ_MIPS,
      format: 'r32float',
      usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
    });
    const fullView = texture.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: CONTINUUM_HIZ_MIPS });
    const mipViews = Array.from({ length: CONTINUUM_HIZ_MIPS }, (_, m) =>
      texture.createView({ dimension: '2d', baseMipLevel: m, mipLevelCount: 1 }));
    const uniform = device.createBuffer({
      label: 'continuum Hi-Z uniform',
      size: CONTINUUM_HIZ_UNIFORM_BYTES,
      usage: B.UNIFORM | B.COPY_DST,
    });
    const uniformData = new Float32Array(CONTINUUM_HIZ_UNIFORM_BYTES / 4);
    device.queue.writeBuffer(uniform, 0, uniformData);
    field = { texture, view: fullView, mipViews, uniform, uniformData, valid: false };
    continuumHiZFields.set(device, field);
  }
  return field;
}
export const continuumHiZView = (device) => continuumHiZField(device).view;
export const continuumHiZUniform = (device) => continuumHiZField(device).uniform;

export function continuumHiZReset(device) {
  const field = continuumHiZFields.get(device);
  if (!field) return;
  field.valid = false;
  field.uniformData.fill(0);
  device.queue.writeBuffer(field.uniform, 0, field.uniformData);
}

// Conservative reverse-Z sphere occlusion test injected into continuumSelect (group 0, bindings 12 & 13).
// Uses exact analytical tangent projection (Mara & McGuire 2013) against the previous frame's conservative min-depth
// pyramid, skipping viewport margins and near-camera spheres so fast pans never pop.
export function continuumHiZWGSL(group, texBinding = CONTINUUM_HIZ_TEXTURE_BINDING, uniBinding = CONTINUUM_HIZ_UNIFORM_BINDING) {
  return /* wgsl */`
const CONTINUUM_HIZ_W:u32=${CONTINUUM_HIZ_W}u;
const CONTINUUM_HIZ_H:u32=${CONTINUUM_HIZ_H}u;
const CONTINUUM_HIZ_MIPS:u32=${CONTINUUM_HIZ_MIPS}u;
struct ContinuumHiZ {
  camPos:vec4f,   // xyz = prevCamPos, w = enabled (1.0 valid, 0.0 disabled)
  camRight:vec4f, // xyz = unit prevRight, w = projX (1 / tanX)
  camUp:vec4f,    // xyz = unit prevUp,    w = projY (1 / tanY)
  camFwd:vec4f,   // xyz = unit prevFwd,   w = nearPlane (0.05)
};
@group(${group}) @binding(${texBinding}) var continuumHiZTexture:texture_2d<f32>;
@group(${group}) @binding(${uniBinding}) var<uniform> continuumHiZ:ContinuumHiZ;

fn continuumHiZOccluded(worldPos:vec3f,radius:f32,sea:bool)->bool {
  if(continuumHiZ.camPos.w<0.5){return false;}
  let camJump=F.camPos.xyz-continuumHiZ.camPos.xyz;
  if(dot(camJump,camJump)>625.0||dot(F.camFwd.xyz,continuumHiZ.camFwd.xyz)<0.90){return false;}
  let relRaw=worldPos+continuumShift()-continuumHiZ.camPos.xyz;
  let rel=select(earthCurve(relRaw,continuumHiZ.camPos.y),relRaw,sea);
  let r=max(radius,0.05)*1.08+0.25;
  let vz=dot(rel,continuumHiZ.camFwd.xyz);
  if(vz<=r+0.35){return false;}
  let vx=dot(rel,continuumHiZ.camRight.xyz);
  let vy=dot(rel,continuumHiZ.camUp.xyz);
  let r2=r*r;
  let xz2=vx*vx+vz*vz;
  if(xz2<=r2){return false;}
  let tx=sqrt(xz2-r2);
  let denomL=vz*tx+vx*r;
  let denomR=vz*tx-vx*r;
  if(denomL<=1e-4||denomR<=1e-4){return false;}
  let pX=continuumHiZ.camRight.w;
  let ndcMinX=((vx*tx-vz*r)/denomL)*pX;
  let ndcMaxX=((vx*tx+vz*r)/denomR)*pX;
  let yz2=vy*vy+vz*vz;
  if(yz2<=r2){return false;}
  let ty=sqrt(yz2-r2);
  let denomB=vz*ty+vy*r;
  let denomT=vz*ty-vy*r;
  if(denomB<=1e-4||denomT<=1e-4){return false;}
  let pY=continuumHiZ.camUp.w;
  let ndcMinY=((vy*ty-vz*r)/denomB)*pY;
  let ndcMaxY=((vy*ty+vz*r)/denomT)*pY;
  let uMin=ndcMinX*0.5+0.5;
  let uMax=ndcMaxX*0.5+0.5;
  let vMin=0.5-ndcMaxY*0.5;
  let vMax=0.5-ndcMinY*0.5;
  // Never cull spheres touching or outside the previous frame's viewport edges (zero popping during camera rotation).
  if(uMin<=0.008||uMax>=0.992||vMin<=0.008||vMax>=0.992){return false;}
  let pxW=(uMax-uMin)*f32(CONTINUUM_HIZ_W);
  let pxH=(vMax-vMin)*f32(CONTINUUM_HIZ_H);
  var mip=u32(clamp(ceil(log2(max(max(pxW,pxH),1.0))),0.0,f32(CONTINUUM_HIZ_MIPS-1u)));
  var mipW=max(CONTINUUM_HIZ_W>>mip,1u);
  var mipH=max(CONTINUUM_HIZ_H>>mip,1u);
  var x0=clamp(i32(floor(uMin*f32(mipW))),0,i32(mipW)-1);
  var x1=clamp(i32(floor(uMax*f32(mipW))),0,i32(mipW)-1);
  var y0=clamp(i32(floor(vMin*f32(mipH))),0,i32(mipH)-1);
  var y1=clamp(i32(floor(vMax*f32(mipH))),0,i32(mipH)-1);
  if((x1-x0>1||y1-y0>1)&&mip+1u<CONTINUUM_HIZ_MIPS){
    mip+=1u;
    mipW=max(CONTINUUM_HIZ_W>>mip,1u);
    mipH=max(CONTINUUM_HIZ_H>>mip,1u);
    x0=clamp(i32(floor(uMin*f32(mipW))),0,i32(mipW)-1);
    x1=clamp(i32(floor(uMax*f32(mipW))),0,i32(mipW)-1);
    y0=clamp(i32(floor(vMin*f32(mipH))),0,i32(mipH)-1);
    y1=clamp(i32(floor(vMax*f32(mipH))),0,i32(mipH)-1);
  }
  let mI=i32(mip);
  let d00=textureLoad(continuumHiZTexture,vec2i(x0,y0),mI).r;
  let d10=textureLoad(continuumHiZTexture,vec2i(x1,y0),mI).r;
  let d01=textureLoad(continuumHiZTexture,vec2i(x0,y1),mI).r;
  let d11=textureLoad(continuumHiZTexture,vec2i(x1,y1),mI).r;
  let hiZMin=min(min(d00,d10),min(d01,d11));
  let nearZ=continuumHiZ.camFwd.w/max(vz-r,continuumHiZ.camFwd.w);
  return nearZ<hiZMin*0.996;
}
`;
}

function hizMip0WGSL(samples) {
  const depthType = samples === 1 ? 'texture_depth_2d' : 'texture_depth_multisampled_2d';
  const loadSample = samples === 1
    ? 'let d=textureLoad(srcDepth,vec2i(sx,sy),0);minD=min(minD,d);'
    : `for(var s=0;s<${samples};s++){let d=textureLoad(srcDepth,vec2i(sx,sy),s);minD=min(minD,d);}`;
  return /* wgsl */`
@group(0) @binding(0) var srcDepth:${depthType};
@group(0) @binding(1) var dstMip:texture_storage_2d<r32float,write>;
@group(0) @binding(2) var<uniform> srcSize:vec4u; // x=W, y=H, z=dstW, w=dstH
@compute @workgroup_size(8,8) fn hizMip0(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=srcSize.z||id.y>=srcSize.w){return;}
  let W=i32(srcSize.x);
  let H=i32(srcSize.y);
  let sx0=clamp(i32(floor(f32(id.x)*f32(W)/f32(srcSize.z))),0,W-1);
  let sx1=clamp(i32(ceil(f32(id.x+1u)*f32(W)/f32(srcSize.z)))-1,sx0,W-1);
  let sy0=clamp(i32(floor(f32(id.y)*f32(H)/f32(srcSize.w))),0,H-1);
  let sy1=clamp(i32(ceil(f32(id.y+1u)*f32(H)/f32(srcSize.w)))-1,sy0,H-1);
  var minD=1.0;
  for(var sy=sy0;sy<=sy1;sy++){
    for(var sx=sx0;sx<=sx1;sx++){
      ${loadSample}
    }
  }
  textureStore(dstMip,vec2i(id.xy),vec4f(minD,0.0,0.0,1.0));
}
`;
}

const HIZ_REDUCE_WGSL = /* wgsl */`
@group(0) @binding(0) var srcMip:texture_2d<f32>;
@group(0) @binding(1) var dstMip:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn hizReduce(@builtin(global_invocation_id) id:vec3u) {
  let dstDim=textureDimensions(dstMip);
  if(id.x>=dstDim.x||id.y>=dstDim.y){return;}
  let srcDim=vec2i(textureDimensions(srcMip,0));
  let base=vec2i(id.xy)*2;
  let d00=textureLoad(srcMip,min(base,srcDim-1),0).r;
  let d10=textureLoad(srcMip,min(base+vec2i(1,0),srcDim-1),0).r;
  let d01=textureLoad(srcMip,min(base+vec2i(0,1),srcDim-1),0).r;
  let d11=textureLoad(srcMip,min(base+vec2i(1,1),srcDim-1),0).r;
  textureStore(dstMip,vec2i(id.xy),vec4f(min(min(d00,d10),min(d01,d11)),0.0,0.0,1.0));
}
`;

export async function createContinuumHiZ({ device, shader, samples = 4 }) {
  const field = continuumHiZField(device);
  const { mip0Pipe, reducePipe } = await requestOnce(device, `continuum hiz pipes ${samples}`, async () => {
    const [m0Mod, redMod] = await Promise.all([
      shader(hizMip0WGSL(samples), `continuum hiz mip0 x${samples}`),
      shader(HIZ_REDUCE_WGSL, 'continuum hiz reduce'),
    ]);
    const [mip0Pipe, reducePipe] = await Promise.all([
      device.createComputePipelineAsync({ label: `continuum hiz mip0 x${samples}`, layout: 'auto', compute: { module: m0Mod, entryPoint: 'hizMip0' } }),
      device.createComputePipelineAsync({ label: 'continuum hiz reduce', layout: 'auto', compute: { module: redMod, entryPoint: 'hizReduce' } }),
    ]);
    return { mip0Pipe, reducePipe };
  });

  const srcSizeBuf = device.createBuffer({
    label: 'continuum hiz size', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const stagingUniform = device.createBuffer({
    label: 'continuum hiz staging', size: CONTINUUM_HIZ_UNIFORM_BYTES, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const srcSizeU32 = new Uint32Array([0, 0, CONTINUUM_HIZ_W, CONTINUUM_HIZ_H]);

  const reduceLayout = reducePipe.getBindGroupLayout(0);
  const reduceGroups = [];
  for (let m = 1; m < CONTINUUM_HIZ_MIPS; m++) {
    reduceGroups.push({
      w: Math.max(1, CONTINUUM_HIZ_W >> m),
      h: Math.max(1, CONTINUUM_HIZ_H >> m),
      bg: device.createBindGroup({
        label: `continuum hiz reduce m${m}`,
        layout: reduceLayout,
        entries: [
          { binding: 0, resource: field.mipViews[m - 1] },
          { binding: 1, resource: field.mipViews[m] },
        ],
      }),
    });
  }

  let enabled = true;
  let lastDepthView = null;
  let mip0BG = null;
  let lastW = 0, lastH = 0;
  let hasPrev = false;
  let prevX = 0, prevY = 0, prevZ = 0, prevFx = 0, prevFy = 0, prevFz = 1;

  return {
    get enabled() { return enabled; },
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) {
        hasPrev = false;
        continuumHiZReset(device);
      }
    },
    reset() {
      hasPrev = false;
      continuumHiZReset(device);
    },
    // Call right after the main scene render pass ends (before submit) to build the conservative reverse-Z depth pyramid
    // and publish the camera basis for next frame's continuumSelect pass.
    encode(encoder, { depthView, width, height, camPos, camRight, camUp, camFwd, projX, projY, near = 0.05, timestampWrites } = {}) {
      if (!enabled || !depthView || !(width > 0) || !(height > 0)) {
        if (field.valid) continuumHiZReset(device);
        hasPrev = false;
        return;
      }
      if (depthView !== lastDepthView) {
        lastDepthView = depthView;
        mip0BG = device.createBindGroup({
          label: 'continuum hiz mip0',
          layout: mip0Pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: depthView },
            { binding: 1, resource: field.mipViews[0] },
            { binding: 2, resource: { buffer: srcSizeBuf } },
          ],
        });
        hasPrev = false; // Resize invalidated previous frame's depth buffer
      }
      if (width !== lastW || height !== lastH) {
        lastW = width; lastH = height;
        srcSizeU32[0] = width >>> 0; srcSizeU32[1] = height >>> 0;
        device.queue.writeBuffer(srcSizeBuf, 0, srcSizeU32);
      }

      const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
      pass.setPipeline(mip0Pipe);
      pass.setBindGroup(0, mip0BG);
      pass.dispatchWorkgroups(Math.ceil(CONTINUUM_HIZ_W / 8), Math.ceil(CONTINUUM_HIZ_H / 8));
      pass.setPipeline(reducePipe);
      for (let i = 0; i < reduceGroups.length; i++) {
        const g = reduceGroups[i];
        pass.setBindGroup(0, g.bg);
        pass.dispatchWorkgroups(Math.ceil(g.w / 8), Math.ceil(g.h / 8));
      }
      pass.end();

      // Guard against camera teleports or sudden cuts: disable occlusion for 1 frame if camera jumped >25m or >25 deg.
      const cx = camPos[0], cy = camPos[1], cz = camPos[2];
      const fx = camFwd[0], fy = camFwd[1], fz = camFwd[2];
      let validNext = 1.0;
      if (hasPrev) {
        const moveSq = (cx - prevX) ** 2 + (cy - prevY) ** 2 + (cz - prevZ) ** 2;
        const dotF = fx * prevFx + fy * prevFy + fz * prevFz;
        if (moveSq > 625 || dotF < 0.90) validNext = 0.0;
      }
      hasPrev = true;
      prevX = cx; prevY = cy; prevZ = cz;
      prevFx = fx; prevFy = fy; prevFz = fz;

      const u = field.uniformData;
      u[0] = cx; u[1] = cy; u[2] = cz; u[3] = validNext;
      u[4] = camRight[0]; u[5] = camRight[1]; u[6] = camRight[2]; u[7] = projX;
      u[8] = camUp[0]; u[9] = camUp[1]; u[10] = camUp[2]; u[11] = projY;
      u[12] = fx; u[13] = fy; u[14] = fz; u[15] = near;
      field.valid = validNext > 0.5;
      // Write staging before command execution, then copy to field.uniform AFTER this frame's continuumSelect & Hi-Z build
      // so frame N's continuumSelect always sees frame N-1's exact (pyramid, camera) pair with zero 1-frame skew.
      device.queue.writeBuffer(stagingUniform, 0, u);
      encoder.copyBufferToBuffer(stagingUniform, 0, field.uniform, 0, CONTINUUM_HIZ_UNIFORM_BYTES);
    },
    destroy() {
      srcSizeBuf.destroy();
      stagingUniform.destroy();
      continuumHiZReset(device);
    },
  };
}
