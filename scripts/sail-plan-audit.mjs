// Reproducible orthographic comparison; run: node scripts/sail-plan-audit.mjs
import fs from 'node:fs';
import { SAIL_PLAN, SAIL_AREAS } from '../js/sailing.js';
import { RIG_MASTS, SQUARE_RIG_MASTS } from '../js/rigging.js';
import { HULL_VERTICAL_SCALE as scale, hullDeck, vesselDeck } from '../js/hull.js';
import { LATEEN_RIG_PLATE } from '../js/rig-plan.js';

// Previous implementation at bd7daf81, retained only for the audit illustration.
const old=[[[0,7.7,-1.8],[0,2.1,-6.4],[.4,2.4,-.5]],
  [[0,9.2,2.8],[0,2.6,-3.4],[.6,2.5,3.2]],
  [[0,6.7,5.5],[0,2.5,1.35],[.7,3.7,6.2]]];
const colours=['#bd6f25','#287b88','#876ca4'],names=['Fore','Main','Mizzen'];
const f=n=>n.toFixed(1),world=SAIL_PLAN.map((s,i)=>({sail:names[i],area:SAIL_AREAS[i]*scale**2,
  luff:Math.hypot(...s.corners[0].map((v,j)=>v-s.corners[1][j]))*scale}));
const out=['<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="830" viewBox="0 0 1100 830">',
  '<rect width="1100" height="830" fill="#f7f6f0"/><g font-family="Arial,sans-serif" fill="#21333b">',
  '<text x="38" y="42" font-size="26" font-weight="700">Sail sizing · orthographic comparison</text>',
  '<text x="38" y="70" font-size="15">Same 20 m hull and equal horizontal/vertical scale. Flat canvas; no perspective or wind deformation.</text>'];
for(const [panel,sails,masts,label] of [[0,old,SQUARE_RIG_MASTS,'BEFORE · estimated triangles'],[1,SAIL_PLAN.map(s=>s.corners),RIG_MASTS,'AFTER · traced reconstruction']]){
  const x=z=>38+panel*550+(z*scale+11)*20,y=h=>565-h*scale*20;
  out.push(`<text x="${38+panel*550}" y="108" font-size="17" font-weight="700">${label}</text>`);
  for(let m=0;m<=20;m+=5)out.push(`<path d="M${x(-6.6)} ${565-m*20}H${x(6.5)}" stroke="#dce0de"/><text x="${x(-6.6)+3}" y="${560-m*20}" font-size="11" fill="#6c777b">${m} m</text>`);
  const hull=[];for(let z=-6.4;z<5.6;z+=.15)hull.push(`${x(z)},${y(hullDeck(z))}`);
  hull.push(`${x(5.6)},${y(hullDeck(5.6))}`,`${x(5.1)},${y(-1.2)}`,`${x(-4.95)},${y(-1.2)}`);
  out.push(`<polygon points="${hull.join(' ')}" fill="#ddd2bd" stroke="#655e50"/>`,
    `<path d="M${x(2.7)} ${y(vesselDeck(2.7))}H${x(5.6)}V${y(hullDeck(5.6))}M${x(2.7)} ${y(vesselDeck(2.7))}V${y(hullDeck(2.7))}" fill="none" stroke="#655e50"/>`);
  for(const [i,corners] of sails.entries()){
    const m=masts[i];out.push(`<path d="M${x(m.z)} ${y(vesselDeck(m.z))}L${x(m.z+m.rake)} ${y(m.height)}" stroke="#655e50" stroke-width="3"/>`,
      `<polygon points="${corners.map(p=>`${x(p[2])},${y(p[1])}`).join(' ')}" fill="${colours[i]}" fill-opacity=".13" stroke="${colours[i]}" stroke-width="2"/>`);
  }
  out.push(`<path d="M${x(-6.4)} 621H${x(5.6)}M${x(-6.4)} 615V627M${x(5.6)} 615V627" stroke="#21333b"/><text x="${x(-.4)}" y="642" text-anchor="middle" font-size="14">20 m hull · bow left</text>`);
}
out.push('<text x="38" y="685" font-size="17" font-weight="700">Flat sail area: 128 → 180 m²</text>');
world.forEach((s,i)=>out.push(`<text x="${38+i*350}" y="718" font-size="16" fill="${colours[i]}">${s.sail}: ${f(s.area)} m² · luff ${f(s.luff)} m</text>`));
out.push('<text x="38" y="751" font-size="14">Source: d’Albertis Niña (1892), side elevation reproduced by Navires Anciens; approximate pixel readings.</text>',
  '<text x="38" y="774" font-size="14">Rig translated upward 1.08 m to clear the retained quarterdeck. Areas and edge lengths are unchanged by this lift.</text>',
  '<text x="38" y="797" font-size="14">Reconstruction-based hybrid, not surveyed dimensions of the original Niña. See CARAVEL_RESEARCH.md.</text></g></svg>');
fs.mkdirSync(new URL('../research/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../research/lateen-sail-plan.svg',import.meta.url),out.join('\n'));
console.log(JSON.stringify({source:LATEEN_RIG_PLATE.source,canvas:world,total:world.reduce((n,s)=>n+s.area,0)},null,2));
