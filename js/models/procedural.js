// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Strict shared geometry for authored lofts. A rim, an inner floor and a
// separate ballast/structural keel are distinct surfaces, never name fallbacks.
import {ADDITIONAL_DESIGNS,additionalDeck,additionalDeckWidth} from './additional.js';
import {ROWING_DESIGNS,rowingDeck,rowingDeckWidth} from './rowing.js';
import {LATER_SAIL_DESIGNS,laterSailDeck,laterSailDeckWidth,laterSailKeelHalfWidth} from './later-sail.js';
import {hullLoftWidth,hullLoftDeck,hullLoftBottom,hullLoftSheer} from '../hull-loft.js';

export const PROCEDURAL_DESIGNS=Object.freeze({...ADDITIONAL_DESIGNS,...ROWING_DESIGNS,...LATER_SAIL_DESIGNS});
export function isProceduralDesign(id){return typeof id==='string'&&Object.hasOwn(PROCEDURAL_DESIGNS,id);}
export function proceduralDesign(id){if(!isProceduralDesign(id))throw Error('No procedural vessel geometry: '+id);return PROCEDURAL_DESIGNS[id];}
export function proceduralHullWidth(id,z,y){return hullLoftWidth(proceduralDesign(id).profile,z,y);}
export function proceduralHullDeck(id,z){return hullLoftDeck(proceduralDesign(id).profile,z);}
export function proceduralDeck(id,z,x=0){
  proceduralDesign(id);
  if(Object.hasOwn(ROWING_DESIGNS,id))return rowingDeck(id,z);
  if(Object.hasOwn(LATER_SAIL_DESIGNS,id))return laterSailDeck(id,z,x);
  return additionalDeck(id,z);
}
export function proceduralDeckWidth(id,z){
  proceduralDesign(id);
  if(Object.hasOwn(ROWING_DESIGNS,id))return rowingDeckWidth(id,z);
  if(Object.hasOwn(LATER_SAIL_DESIGNS,id))return laterSailDeckWidth(id,z);
  return additionalDeckWidth(id,z);
}
export function proceduralDeckBarrier(id,z,x=0){
  const d=proceduralDesign(id);
  if(Object.hasOwn(ROWING_DESIGNS,id))return Math.max(0,proceduralHullDeck(id,z)-proceduralDeck(id,z,x));
  if(d.cockpit&&z>d.cockpit.bounds[0]&&z<d.cockpit.bounds[1]&&Math.abs(x)<d.cockpit.halfWidth)
    return Math.max(0,d.cockpit.coamingHeight+hullLoftSheer(d.profile,z)-proceduralDeck(id,z,x));
  return d.barrier??0;
}
export function proceduralKeelHalfWidth(id,z,y){
  const d=proceduralDesign(id),k=d.keel;if(!k)return 0;
  if(Object.hasOwn(LATER_SAIL_DESIGNS,id))return laterSailKeelHalfWidth(id,z,y);
  const bottom=hullLoftBottom(d.profile,z);
  return z>=k.bounds[0]&&z<=k.bounds[1]&&y>=bottom-k.depth&&y<=bottom?k.width*.5:0;
}
// Exact piecewise-linear fin intersection at a longitudinal station. These
// bounds describe geometry, while width is evaluated by its NACA section.
export function proceduralKeelBounds(id,z){
  const d=proceduralDesign(id),k=d.keel;if(!k||z<k.bounds[0]||z>k.bounds[1])return null;
  if(k.kind!=='profiled-ballast-fin'){const top=hullLoftBottom(d.profile,z);return {top,bottom:top-k.depth};}
  let bottom=Infinity,top=-Infinity;
  for(let i=0;i<k.sections.length-1;i++){
    const a=k.sections[i],b=k.sections[i+1];let lo=0,hi=1;
    for(const [p,q]of [[z-a.zFore,a.zFore-b.zFore],[a.zAft-z,b.zAft-a.zAft]]){
      if(Math.abs(q)<1e-14){if(p<0){lo=1;hi=0;}continue;}
      if(q>0)lo=Math.max(lo,-p/q);else hi=Math.min(hi,-p/q);
    }
    if(lo<=hi){bottom=Math.min(bottom,a.y+(b.y-a.y)*lo);top=Math.max(top,a.y+(b.y-a.y)*hi);}
  }
  return top>bottom?{top,bottom}:null;
}
export function proceduralBottom(id,z){const d=proceduralDesign(id),k=proceduralKeelBounds(id,z);return Math.min(hullLoftBottom(d.profile,z),k?.bottom??Infinity);}
export function proceduralDraft(id){const d=proceduralDesign(id),k=d.keel;return k?.kind==='profiled-ballast-fin'?-k.sections[0].y:-d.profile.levels[0]+(k?.depth??0);}
export function proceduralProvisionDays(id){const d=proceduralDesign(id);return d.loading?.defaultProvisionDays??60;}
