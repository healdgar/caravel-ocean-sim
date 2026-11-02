// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { deepFreeze } from '../rig-definition.js';
// Authored Niña interpretation, in the existing design frame. Historical and
// replica measurements belong to the registry; these values preserve the game.
export const NINA_DESIGN = deepFreeze({
  frame:{length:12,beam:3.6,verticalScale:20/12},
  runtime:{length:20,beam:6},
  hull:{draft:1.2,bowRake:1.45,sternRake:.5,sectionPower:.65,
    stations:[-6.4,-5.8,-4.8,-3.2,-1.6,0,1.4,2.8,4.2,5.6],
    breadths:[.045,.51,1.08,1.52,1.73,1.77,1.70,1.52,1.29,1.06]},
  quarterdeck:{start:2.7,height:2.3},
  tiller:{pivot:[0,1.38,5.68],handle:[0,1.43,3.95],crewDistance:.32},
  helm:{x:1.1,z:3.1,eyeAboveDeck:1.6},
  anchor:{z:-4.8,rootInset:.15,tipOutset:.27,rootRise:.58,tipRise:.78,fairleadRise:.76},
  tackles:[{mast:0,x:1.05,z:-1.4},{mast:1,x:-1.1,z:-.45},{mast:2,x:-.4,z:4.55}],
  crewStations:{
    ines:{x:-.68,z:4.15,route:[4.15,4.15],yaw:Math.PI},
    tomas:{x:.8,z:3.3,route:[3.3,3.3],yaw:Math.PI},
    beatriz:{x:-1.05,z:-2.1,route:[-2.1,-1.3]},
    duarte:{x:1.05,z:-1.4,route:[-2.1,-1.3]},
    joao:{x:-1.1,z:-.45,route:[-.45,.25]},
    catarina:{x:1.1,z:.2,route:[-.45,.25]},
    leonor:{x:-1.1,z:1.25,route:[1.15,1.85]},
    rui:{x:-.25,z:1.8,route:[1.8,1.8],yaw:Math.PI},
    maria:{x:.65,z:-4.7,route:[-4.7,-4.7],yaw:Math.PI},
    afonso:{x:-.65,z:-4.65,route:[-4.65,-4.65],yaw:Math.PI},
    isabel:{x:-.75,z:3.25,route:[3.25,3.25]},
    pedro:{x:0,z:3.95-.32/(20/12),route:[3.95-.32/(20/12),3.95-.32/(20/12)],yaw:0},
  },
  supplementalCrewStations:{
    nina_f1:{x:-.52,z:-4.15,route:[-4.20,-4.10],role:'Bow hand'},
    nina_f2:{x:.52,z:-4.15,route:[-4.20,-4.10],role:'Anchor hand'},
    nina_w1:{x:-1.12,z:-2.65,route:[-2.70,-2.60],role:'Fore tack hand'},
    nina_w2:{x:1.12,z:-2.65,route:[-2.70,-2.60],role:'Fore sheet hand'},
    nina_w3:{x:-1.18,z:-1.15,route:[-1.20,-1.10],role:'Waist deckhand'},
    nina_w4:{x:1.18,z:-.65,route:[-.70,-.60],role:'Waist deckhand'},
    nina_w5:{x:-1.18,z:.45,route:[.40,.50],role:'Main sheet hand'},
    nina_w6:{x:1.12,z:.55,route:[.50,.60],role:'Main brace hand'},
    nina_w7:{x:-1.12,z:1.65,route:[1.60,1.70],role:'Aft waist hand'},
    nina_w8:{x:-1.08,z:2.20,route:[2.15,2.25],role:'Mizzen tack hand'},
    nina_q1:{x:.62,z:3.65,route:[3.60,3.70],yaw:Math.PI,role:'Quarterdeck hand'},
    nina_q2:{x:-.62,z:3.65,route:[3.60,3.70],yaw:Math.PI,role:'Stern watch'},
  },
});

export const NINA_RIG_PLATE = deepFreeze({
  title:'Niña, d’Albertis reconstruction (1892)',
  source:'https://navires-anciens.be/wp-content/uploads/2020/06/Nina.jpg',
  width:669,height:473,bowX:88,sternX:391,waterlineY:320,deckLift:.65,
  sails:[
    {corners:[[302,22],[100,282],[302,281]],mastFoot:[201,301],mastHead:[198,106],radius:.15,belly:.90},
    {corners:[[370,106],[233,287],[371,272]],mastFoot:[304,277],mastHead:[301,151],radius:.115,belly:.65},
    {corners:[[407,169],[330,272],[407,265]],mastFoot:[372,269],mastHead:[369,194],radius:.095,belly:.35},
  ],
});
