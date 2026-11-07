// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The deck a body can stand on, as metres of clearance at any point. It comes from the mesh each ship draws
// (scripts/bake-crew-deck.mjs), plus the reserved recoil of her guns, and an edge that has lost its rail narrows it as it is asked.
import {CREW_DECK_MASKS} from './models/crew-deck-masks.js';
import {crewNavigationObstacles} from './crew-navigation.js';
import {crewOpenEdgeInset} from './crew-overboard.js';
import {modelDeck,modelDeckWidth,vesselVerticalScale} from './hull.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {LATER_SAIL_DESIGNS} from './models/later-sail.js';
import {proceduralDeck} from './models/procedural.js';

export const CREW_DECK_CELL_M=.08;
// The same standing-body clearance routes keep from equipment, with half a cell for the grid.
export const CREW_DECK_BODY_M=.30+CREW_DECK_CELL_M/2;
const CREW_DECK_CLEARANCE_STEP=.01,CREW_DECK_CLEARANCE_MAX=255,CREW_DECK_FAR=1e12;
const CREW_DECK_ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Run lengths of open and shut cells, alternating, shut first, as base-32 digits with a continuation bit.
export function crewDeckEncode(open){
  let text='',value=0,count=0;
  const flush=()=>{let n=count;while(n>=32){text+=CREW_DECK_ALPHABET[32+(n&31)];n=Math.floor(n/32);}text+=CREW_DECK_ALPHABET[n];count=0;};
  for(const cell of open){if(cell===value)count++;else{flush();value=cell;count=1;}}
  flush();return text;
}
export function crewDeckDecode(text,length){
  const open=new Uint8Array(length);let at=0,value=0,run=0,scale=1;
  for(let i=0;i<text.length;i++){
    const digit=CREW_DECK_ALPHABET.indexOf(text[i]);
    if(digit>=32){run+=(digit-32)*scale;scale*=32;continue;}
    run+=digit*scale;
    if(value)open.fill(1,at,at+run);
    at+=run;value=1-value;run=0;scale=1;
  }
  return open;
}
// Squared distance to the nearest shut cell along a line (Felzenszwalb and Huttenlocher). Rows and columns have their own metres.
function crewDeckTransform(cost,start,stride,count,cell,v,edge,out){
  let k=0;v[0]=0;edge[0]=-Infinity;edge[1]=Infinity;
  for(let q=1;q<count;q++){
    const f=cost[start+q*stride],Q=q*cell;
    let s;
    while(true){
      const V=v[k]*cell;
      s=(f+Q*Q-cost[start+v[k]*stride]-V*V)/(2*(Q-V));
      if(s>edge[k])break;
      k--;
    }
    k++;v[k]=q;edge[k]=s;edge[k+1]=Infinity;
  }
  k=0;
  for(let q=0;q<count;q++){
    const Q=q*cell;
    while(edge[k+1]<Q)k++;
    const V=v[k]*cell;out[q]=(Q-V)*(Q-V)+cost[start+v[k]*stride];
  }
  for(let q=0;q<count;q++)cost[start+q*stride]=out[q];
}
// The height a body walks at, in design units. crew-work.js asks this too.
export function crewDeckFloor(boat,z,x=0){
  const id=boat.modelId??'nina';
  return Object.hasOwn(ROWING_DESIGNS,id)||Object.hasOwn(LATER_SAIL_DESIGNS,id)?proceduralDeck(id,z,x):modelDeck(boat,z);
}
const crewDeckFields=new Map();
export function crewDeckField(boat){
  const id=boat.modelId??'nina',mask=CREW_DECK_MASKS[id];if(!mask)return null;
  const sx=(boat.beam??3.6)/3.6,sz=(boat.length??12)/12,key=id+'/'+sx+'/'+sz,known=crewDeckFields.get(key);
  if(known)return known;
  const {x0,z0,dx,dz,nx,nz}=mask,open=crewDeckDecode(mask.runs,nx*nz),cellX=dx*sx,cellZ=dz*sz,cost=new Float64Array(nx*nz);
  // A gun keeps the whole of its recoil to itself, whichever way it stands now.
  const sy=vesselVerticalScale(boat);
  for(const o of crewNavigationObstacles(boat)??[]){
    const i0=Math.max(0,Math.floor((o.min[0]/sx-x0)/dx)),i1=Math.min(nx-1,Math.ceil((o.max[0]/sx-x0)/dx)),j0=Math.max(0,Math.floor((o.min[2]/sz-z0)/dz)),j1=Math.min(nz-1,Math.ceil((o.max[2]/sz-z0)/dz));
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
      const at=j*nx+i;if(!open[at])continue;
      const y=crewDeckFloor(boat,z0+(j+.5)*dz,x0+(i+.5)*dx)*sy;
      if(o.max[1]>y&&o.min[1]<y+1.7)open[at]=0;
    }
  }
  for(let k=0;k<cost.length;k++)cost[k]=open[k]?CREW_DECK_FAR:0;
  const size=Math.max(nx,nz)+2,v=new Int32Array(size),edge=new Float64Array(size),out=new Float64Array(size);
  for(let j=0;j<nz;j++)crewDeckTransform(cost,j*nx,1,nx,cellX,v,edge,out);
  for(let i=0;i<nx;i++)crewDeckTransform(cost,i,nx,nz,cellZ,v,edge,out);
  const clearance=new Uint8Array(nx*nz);
  for(let k=0;k<cost.length;k++)clearance[k]=open[k]?Math.min(CREW_DECK_CLEARANCE_MAX,Math.max(0,Math.sqrt(cost[k])-Math.min(cellX,cellZ)/2)/CREW_DECK_CLEARANCE_STEP):0;
  const field={clearance,x0:x0*sx,z0:z0*sz,dx:cellX,dz:cellZ,nx,nz};
  crewDeckFields.set(key,field);return field;
}
// Metres to anything a body would strike, at a point in ship metres. No deck there reads as none.
export function crewDeckClearance(field,x,z){
  if(!field)return 0;
  const u=(x-field.x0)/field.dx-.5,w=(z-field.z0)/field.dz-.5,i=Math.floor(u),j=Math.floor(w);
  if(i<0||j<0||i>=field.nx-1||j>=field.nz-1)return 0;
  const fu=u-i,fw=w-j,c=field.clearance,at=j*field.nx+i,a=c[at],b=c[at+1],C=c[at+field.nx],d=c[at+field.nx+1];
  if(!a||!b||!C||!d)return 0;
  return (a+(b-a)*fu+(C-a)*fw+(a-b-C+d)*fu*fw)*CREW_DECK_CLEARANCE_STEP;
}
// As above, less what an open edge asks a hand to give up.
export function crewDeckRoom(field,boat,x,z){
  const room=crewDeckClearance(field,x,z);
  if(room<=0||!boat.damage?.fracture?.brokenCount)return room;
  const sx=(boat.beam??3.6)/3.6,sz=(boat.length??12)/12,zd=z/sz,inset=crewOpenEdgeInset(boat,zd,Math.sign(x));
  if(!inset)return room;
  return Math.min(room,(modelDeckWidth(boat,zd)-inset-Math.abs(x)/sx)*sx);
}
// The least room along a straight line, every half cell.
export function crewDeckLineRoom(field,boat,x0,z0,x1,z1){
  const count=Math.max(1,Math.ceil(Math.hypot(x1-x0,z1-z0)/(CREW_DECK_CELL_M/2)));let least=Infinity;
  for(let i=0;i<=count;i++){
    const room=crewDeckRoom(field,boat,x0+(x1-x0)*i/count,z0+(z1-z0)*i/count);
    if(room<least)least=room;
  }
  return least;
}
