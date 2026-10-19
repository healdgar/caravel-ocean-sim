import {sailForces,sailingState} from '../js/sailing.js';
import {lateenSheetTarget} from '../js/lateen.js';
// Fixed pose, stationary hull, 7 m/s wind at 10 m. Not an equilibrium-speed polar.
const report=[];
for(const angle of [0,30,45,60,75,90,105,120,150,180])for(const badTack of [false,true]){
  const boat={heading:0,length:20,beam:6,sailFore:1,sailMain:1,sailMizzen:1},direction=(angle+90)*Math.PI/180;
  const s=sailingState(boat);sailForces(boat,7,direction,0);
  s.rig.forEach((p,i)=>Object.assign(p,{opening:lateenSheetTarget(s.lateenTarget,i),side:badTack?s.tack:-s.tack,pressure:badTack?-1:1,fill:1}));
  sailForces(boat,7,direction,0);
  report.push({angle,badTack,forwardN:Math.round(s.forward),sideN:Math.round(s.side),rollNm:Math.round(s.rollMoment),pitchNm:Math.round(s.pitchMoment)});
}
console.log(JSON.stringify(report,null,2));
