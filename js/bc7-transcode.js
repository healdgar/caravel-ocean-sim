// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A BC7 picture for a device that reads neither BC nor ASTC: decoded on the GPU at load (AGENTS.md rule 2), level by
// level, into an rgba8 texture of the same size and levels, which samples as the BC7 one would (BC7 decodes exactly to
// eight bits a channel). One compute invocation decodes one 4x4 block into a staging buffer, whose rows the copy lays
// into the level; the picture's bytes are read once and nothing is decoded on the CPU.

// The modes' layouts (BC7: mode m is m zero bits then a one): subsets, partition bits, rotation bits, index-selection
// bits, colour and alpha endpoint bits, whether each endpoint or each subset carries a P-bit, and the index bits of
// the primary and secondary index sets.
const bc7Modes = Object.freeze([
  //  subsets partition rotation select colour alpha endpointP subsetP index secondary
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
]);
// The two- and three-subset partitions, a row of sixteen texels each (row-major), and each partition's anchors: the
// texel of its second subset (two subsets), and of its second and third (three), whose index drops its top bit.
const bc7Partitions2 = [
  '0011001100110011', '0001000100010001', '0111011101110111', '0001001100110111', '0000000100010011', '0011011101111111', '0001001101111111', '0000000100110111',
  '0000000000010011', '0011011111111111', '0000000101111111', '0000000000010111', '0001011111111111', '0000000011111111', '0000111111111111', '0000000000001111',
  '0000100011101111', '0111000100000000', '0000000010001110', '0111001100010000', '0011000100000000', '0000100011001110', '0000000010001100', '0111001100110001',
  '0011000100010000', '0000100010001100', '0110011001100110', '0011011001101100', '0001011111101000', '0000111111110000', '0111000110001110', '0011100110011100',
  '0101010101010101', '0000111100001111', '0101101001011010', '0011001111001100', '0011110000111100', '0101010110101010', '0110100101101001', '0101101010100101',
  '0111001111001110', '0001001111001000', '0011001001001100', '0011101111011100', '0110100110010110', '0011110011000011', '0110011010011001', '0000011001100000',
  '0100111001000000', '0010011100100000', '0000001001110010', '0000010011100100', '0110110010010011', '0011011011001001', '0110001110011100', '0011100111000110',
  '0110110011001001', '0110001100111001', '0111111010000001', '0001100011100111', '0000111100110011', '0011001111110000', '0010001011101110', '0100010001110111',
];
const bc7Partitions3 = [
  '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111', '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
  '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012', '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
  '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111', '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
  '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221', '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
  '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120', '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
  '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122', '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
  '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112', '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
  '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112', '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
];
const bc7Anchor2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];
const bc7Anchor3a = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
];
const bc7Anchor3b = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];
// Each partition as one word: a bit a texel (two subsets), two bits a texel (three).
const bc7PackPartition = (row, bits) => [...row].reduce((word, subset, texel) => (word | (Number(subset) << (texel * bits))) >>> 0, 0);
const bc7Words = (values) => values.map((v) => `${v >>> 0}u`).join(',');

// The decoder. Each invocation is a block of the level `bc7Level` names: its 16 bytes from `bc7Source` (four words,
// little-endian, bit 0 the low bit of the first byte), its texels within the level written to `bc7Texels` as rgba8 words
// along rows of `rowWords`. A block of the reserved mode (its first byte zero) decodes to transparent black.
export const BC7_TRANSCODE_WGSL = /* wgsl */`
struct BC7Level { first:u32, across:u32, down:u32, width:u32, height:u32, rowWords:u32, pad0:u32, pad1:u32 };
@group(0) @binding(0) var<storage,read> bc7Source:array<u32>;
@group(0) @binding(1) var<storage,read_write> bc7Texels:array<u32>;
@group(0) @binding(2) var<uniform> bc7Level:BC7Level;
const BC7_MODES=array<array<u32,10>,8>(${bc7Modes.map((m) => `array<u32,10>(${bc7Words(m)})`).join(',')});
const BC7_PARTITIONS2=array<u32,64>(${bc7Words(bc7Partitions2.map((r) => bc7PackPartition(r, 1)))});
const BC7_PARTITIONS3=array<u32,64>(${bc7Words(bc7Partitions3.map((r) => bc7PackPartition(r, 2)))});
const BC7_ANCHOR2=array<u32,64>(${bc7Words(bc7Anchor2)});
const BC7_ANCHOR3A=array<u32,64>(${bc7Words(bc7Anchor3a)});
const BC7_ANCHOR3B=array<u32,64>(${bc7Words(bc7Anchor3b)});
const BC7_WEIGHTS2=array<u32,4>(0u,21u,43u,64u);
const BC7_WEIGHTS3=array<u32,8>(0u,9u,18u,27u,37u,46u,55u,64u);
const BC7_WEIGHTS4=array<u32,16>(0u,4u,9u,13u,17u,21u,26u,30u,34u,38u,43u,47u,51u,55u,60u,64u);
var<private> bc7Block:array<u32,4>;
var<private> bc7Ends:array<vec4u,6>;
fn bc7Bits(at:u32,count:u32)->u32 {
  if(count==0u){return 0u;}
  let word=at>>5u;let shift=at&31u;
  var v=bc7Block[word]>>shift;
  if(shift+count>32u&&word<3u){v=v|(bc7Block[word+1u]<<(32u-shift));}
  return v&((1u<<count)-1u);
}
fn bc7Weight(bits:u32,index:u32)->u32 {
  if(bits==2u){return BC7_WEIGHTS2[index&3u];}
  if(bits==3u){return BC7_WEIGHTS3[index&7u];}
  return BC7_WEIGHTS4[index&15u];
}
// An endpoint channel of 'bits' bits widened to eight, its top bits repeated below.
fn bc7Widen(v:u32,bits:u32)->u32 { return ((v<<(8u-bits))|(v>>(2u*bits-8u)))&255u; }
fn bc7Mix(a:u32,b:u32,w:u32)->u32 { return ((64u-w)*a+w*b+32u)>>6u; }
@compute @workgroup_size(64) fn bc7Transcode(@builtin(global_invocation_id) id:vec3u) {
  let block=id.x;
  if(block>=bc7Level.across*bc7Level.down){return;}
  let at=bc7Level.first+block*4u;
  for(var i=0u;i<4u;i++){bc7Block[i]=bc7Source[at+i];}
  let bx=(block%bc7Level.across)*4u;let by=(block/bc7Level.across)*4u;
  let low=bc7Block[0]&255u;
  var texels:array<u32,16>;
  if(low!=0u){
    let mode=firstTrailingBit(low);
    let m=BC7_MODES[mode];
    let subsets=m[0];let colourBits=m[4];let alphaBits=m[5];let indexBits=m[8];let secondBits=m[9];
    var cursor=mode+1u;
    let shapeIndex=bc7Bits(cursor,m[1]);cursor+=m[1];
    let rotation=bc7Bits(cursor,m[2]);cursor+=m[2];
    let swapped=bc7Bits(cursor,m[3]);cursor+=m[3];
    let ends=subsets*2u;
    for(var c=0u;c<3u;c++){for(var e=0u;e<ends;e++){bc7Ends[e][c]=bc7Bits(cursor,colourBits);cursor+=colourBits;}}
    for(var e=0u;e<ends;e++){bc7Ends[e].w=bc7Bits(cursor,alphaBits);cursor+=alphaBits;}
    var pBits=0u;
    if(m[6]!=0u){
      pBits=1u;
      for(var e=0u;e<ends;e++){let p=bc7Bits(cursor,1u);cursor+=1u;bc7Ends[e]=(bc7Ends[e]<<vec4u(1u))|vec4u(p);}
    }else if(m[7]!=0u){
      pBits=1u;
      for(var s=0u;s<subsets;s++){let p=bc7Bits(cursor,1u);cursor+=1u;for(var k=0u;k<2u;k++){bc7Ends[s*2u+k]=(bc7Ends[s*2u+k]<<vec4u(1u))|vec4u(p);}}
    }
    for(var e=0u;e<ends;e++){
      let c=bc7Ends[e];let cb=colourBits+pBits;let ab=alphaBits+pBits;
      bc7Ends[e]=vec4u(bc7Widen(c.x,cb),bc7Widen(c.y,cb),bc7Widen(c.z,cb),select(255u,bc7Widen(c.w,ab),alphaBits>0u));
    }
    // Which subset each texel is of, and the anchors whose index drops its top bit.
    let shape=select(select(0u,BC7_PARTITIONS2[shapeIndex],subsets==2u),BC7_PARTITIONS3[shapeIndex],subsets==3u);
    let anchor1=select(BC7_ANCHOR2[shapeIndex],BC7_ANCHOR3A[shapeIndex],subsets==3u);
    let anchor2=BC7_ANCHOR3B[shapeIndex];
    var primary:array<u32,16>;var secondary:array<u32,16>;
    for(var t=0u;t<16u;t++){
      let anchored=t==0u||(subsets>1u&&t==anchor1)||(subsets>2u&&t==anchor2);
      let n=indexBits-select(0u,1u,anchored);
      primary[t]=bc7Bits(cursor,n);cursor+=n;
    }
    if(secondBits>0u){
      for(var t=0u;t<16u;t++){let n=secondBits-select(0u,1u,t==0u);secondary[t]=bc7Bits(cursor,n);cursor+=n;}
    }
    for(var t=0u;t<16u;t++){
      let subset=select(select(0u,(shape>>t)&1u,subsets==2u),(shape>>(t*2u))&3u,subsets==3u);
      let e0=bc7Ends[subset*2u];let e1=bc7Ends[subset*2u+1u];
      var cw=bc7Weight(indexBits,primary[t]);var aw=cw;
      if(secondBits>0u){
        let second=bc7Weight(secondBits,secondary[t]);
        cw=select(cw,second,swapped!=0u);aw=select(second,bc7Weight(indexBits,primary[t]),swapped!=0u);
      }
      var px=vec4u(bc7Mix(e0.x,e1.x,cw),bc7Mix(e0.y,e1.y,cw),bc7Mix(e0.z,e1.z,cw),bc7Mix(e0.w,e1.w,aw));
      if(rotation==1u){px=px.wyzx;}else if(rotation==2u){px=px.xwzy;}else if(rotation==3u){px=px.xywz;}
      texels[t]=px.x|(px.y<<8u)|(px.z<<16u)|(px.w<<24u);
    }
  }
  for(var t=0u;t<16u;t++){
    let x=bx+(t&3u);let y=by+(t>>2u);
    if(x<bc7Level.width&&y<bc7Level.height){bc7Texels[y*bc7Level.rowWords+x]=texels[t];}
  }
}
`;

const bc7Pipelines = new WeakMap();
const bc7Pipeline = (device) => {
  if (!bc7Pipelines.has(device)) {
    bc7Pipelines.set(device, device.createComputePipelineAsync({
      label: 'bc7 transcode', layout: 'auto', compute: { module: device.createShaderModule({ label: 'bc7 transcode', code: BC7_TRANSCODE_WGSL }), entryPoint: 'bc7Transcode' },
    }));
  }
  return bc7Pipelines.get(device);
};

// A texture of `format` (rgba8unorm-srgb for a picture baked in sRGB, rgba8unorm otherwise) holding the BC7 picture
// `bytes`, whose `levels` are { width, height, offset } (offset in bytes, a multiple of 16). Resolves once its decode
// and copies are submitted; the staging is freed when the queue has done with them.
export async function transcodeBC7Texture(device, { bytes, width, height, levels, format = 'rgba8unorm-srgb', label = 'bc7' }) {
  const pipeline = await bc7Pipeline(device);
  const B = GPUBufferUsage;
  const rowBytes = (w) => Math.ceil((w * 4) / 256) * 256;
  const source = device.createBuffer({ label: `${label} bc7 blocks`, size: Math.ceil(bytes.byteLength / 4) * 4, usage: B.STORAGE | B.COPY_DST });
  device.queue.writeBuffer(source, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 4));
  const staging = device.createBuffer({ label: `${label} bc7 texels`, size: Math.max(...levels.map((l) => rowBytes(l.width) * l.height)), usage: B.STORAGE | B.COPY_SRC });
  const params = device.createBuffer({ label: `${label} bc7 levels`, size: levels.length * 256, usage: B.UNIFORM | B.COPY_DST });
  const words = new Uint32Array(levels.length * 64);
  const texture = device.createTexture({ label, size: [width, height], mipLevelCount: levels.length, format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: `${label} bc7 transcode` });
  levels.forEach((level, mipLevel) => {
    const across = Math.ceil(level.width / 4), down = Math.ceil(level.height / 4);
    words.set([level.offset / 4, across, down, level.width, level.height, rowBytes(level.width) / 4, 0, 0], mipLevel * 64);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: staging } }, { binding: 2, resource: { buffer: params, offset: mipLevel * 256, size: 32 } }],
    });
    const pass = encoder.beginComputePass({ label: `${label} bc7 level ${mipLevel}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((across * down) / 64));
    pass.end();
    encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: rowBytes(level.width), rowsPerImage: level.height }, { texture, mipLevel }, [level.width, level.height]);
  });
  device.queue.writeBuffer(params, 0, words);
  device.queue.submit([encoder.finish()]);
  const release = () => { source.destroy(); staging.destroy(); params.destroy(); };
  device.queue.onSubmittedWorkDone().then(release, release);
  return texture;
}
