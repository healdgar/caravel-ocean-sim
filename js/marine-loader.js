// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {createMarineLifeState} from './marine-life-state.js';
import {createMarineLife} from './marine-life.js';

// Sailing does not depend on the large whale asset. Preserve encounter time
// while it loads, so a slow connection cannot skip the breach or spawn a toy.
export function createDeferredMarineLife(options,createRenderer=createMarineLife){
  const state=createMarineLifeState(options.random);
  let renderer=null,pending=null,error=null,destroyed=false;
  function load(){
    if(renderer)return Promise.resolve(renderer);
    if(pending)return pending;
    if(destroyed)return Promise.reject(new Error('Marine renderer was destroyed'));
    error=null;
    pending=Promise.resolve().then(()=>createRenderer({...options,state})).then(result=>{
      if(destroyed){result.destroy();return null;}
      renderer=result;return result;
    }).catch(reason=>{
      error=reason?.message||String(reason);state.clear();throw reason;
    }).finally(()=>{pending=null;});
    return pending;
  }
  Object.defineProperties(state,{
    loading:{get:()=>!!pending},loadError:{get:()=>error},
  });
  const trigger=state.trigger;
  state.trigger=(...args)=>{
    if(destroyed)return false;
    const accepted=trigger(...args);
    if(accepted)load().catch(()=>{});
    return accepted;
  };
  return {state,load,
    update(dt,boat,settings,terrain=null,vessels=[boat]){
      if(destroyed)return;
      if(renderer){renderer.update(dt,boat,settings,terrain,vessels);return;}
      if(!state.active)state.step(dt,boat,settings,terrain,vessels);
      if(state.active)load().catch(()=>{});
    },
    encode(pass){renderer?.encode(pass);},
    draw(pass){renderer?.draw(pass);},
    drawSubmerged(pass,above=false){renderer?.drawSubmerged(pass,above);},
    destroy(){destroyed=true;state.clear();renderer?.destroy();renderer=null;},
  };
}
