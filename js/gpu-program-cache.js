// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Immutable programs are device-local. Buffers and bind groups stay with their
// original owners. Keys include the final WGSL, after fleet/frame rewriting.
export function createGPUProgramCache({device,prepare=code=>code,report=()=>{}}){
  const modules=new Map(),computes=new Map();
  function remember(cache,key,create){
    if(cache.has(key))return cache.get(key);
    const pending=Promise.resolve().then(create);cache.set(key,pending);
    pending.catch(()=>{if(cache.get(key)===pending)cache.delete(key);});
    return pending;
  }
  function moduleFor(code,label){
    return remember(modules,code,async()=>{
      const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();
      report(info.messages,code,label);
      if(info.messages.some(message=>message.type==='error'))throw Error('Shader compile error in '+label);
      return module;
    });
  }
  return {
    shader(code,label){return moduleFor(prepare(code),label);},
    computePipe(code,label){
      const finalCode=prepare(code);
      // This factory has one compute descriptor: automatic layout and main.
      return remember(computes,finalCode,async()=>device.createComputePipelineAsync({label,layout:'auto',compute:{module:await moduleFor(finalCode,label),entryPoint:'main'}}));
    },
  };
}
