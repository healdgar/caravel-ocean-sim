// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as victory from '../js/models/victory.js';
import {createVictoryMesh} from '../js/victory.js';
import {boatHydrodynamics,hullHydrostatics,SEAWATER_DENSITY} from '../js/boat.js';

const D=victory.VICTORY_DESIGN,width=victory.victoryHullHalfWidth,sheer=victory.victorySheer;
const scale=[D.runtime.beam/3.6,D.frame.verticalScale,D.runtime.length/12],groups=[],mesh=createVictoryMesh({groups});
const close=(a,b,limit,message)=>assert.ok(Math.abs(a-b)<=limit,`${message}: ${a} versus ${b}`);
const part=id=>{const group=groups.find(g=>g.id===id);assert.ok(group,`missing semantic part ${id}`);return mesh.subarray(group.firstVertex*9,(group.firstVertex+group.vertexCount)*9);};
const position=(data,i)=>[data[i],data[i+1],data[i+2]];
function hitDistance(data,origin,direction){
  let nearest=Infinity;
  for(let i=0;i<data.length;i+=27){
    const ax=data[i],ay=data[i+1],az=data[i+2],ex=data[i+9]-ax,ey=data[i+10]-ay,ez=data[i+11]-az,fx=data[i+18]-ax,fy=data[i+19]-ay,fz=data[i+20]-az;
    const px=direction[1]*fz-direction[2]*fy,py=direction[2]*fx-direction[0]*fz,pz=direction[0]*fy-direction[1]*fx,det=ex*px+ey*py+ez*pz;
    if(Math.abs(det)<1e-12)continue;
    const tx=origin[0]-ax,ty=origin[1]-ay,tz=origin[2]-az,u=(tx*px+ty*py+tz*pz)/det;if(u< -1e-7||u>1+1e-7)continue;
    const qx=ty*ez-tz*ey,qy=tz*ex-tx*ez,qz=tx*ey-ty*ex,v=(direction[0]*qx+direction[1]*qy+direction[2]*qz)/det;if(v< -1e-7||u+v>1+1e-7)continue;
    const t=(fx*qx+fy*qy+fz*qz)/det;if(t>=0&&t<nearest)nearest=t;
  }
  return nearest;
}
function triangleDistance(point,a,b,c){
  const sub=(u,v)=>u.map((n,i)=>n-v[i]),dot=(u,v)=>u.reduce((n,x,i)=>n+x*v[i],0),u=sub(b,a),v=sub(c,a),w=sub(point,a);
  const uu=dot(u,u),vv=dot(v,v),uv=dot(u,v),wu=dot(w,u),wv=dot(w,v),denominator=uu*vv-uv*uv;
  if(denominator>1e-16){
    const s=(wu*vv-wv*uv)/denominator,t=(wv*uu-wu*uv)/denominator;
    if(s>=-1e-8&&t>=-1e-8&&s+t<=1+1e-8)return Math.hypot(...w.map((n,i)=>n-s*u[i]-t*v[i]));
  }
  const segment=(start,end)=>{const d=sub(end,start),p=sub(point,start),t=Math.max(0,Math.min(1,dot(p,d)/Math.max(1e-20,dot(d,d))));return Math.hypot(...p.map((n,i)=>n-t*d[i]));};
  return Math.min(segment(a,b),segment(b,c),segment(c,a));
}

test('Victory body dimensions, forebody fairness and midbody tumblehome remain physically coherent',()=>{
  close(D.runtime.length,186*.3048,1e-10,'reported gundeck length');close(D.runtime.beam,52*.3048,1e-10,'reported breadth');
  let maximum=0;
  for(let z=-6;z<=6;z+=.08)for(let y=-D.hull.draft;y<=2.6;y+=.08){const w=width(z,y);assert.ok(Number.isFinite(w)&&w>=0);maximum=Math.max(maximum,w);}
  close(maximum*scale[0]*2,D.runtime.beam,.03,'the physical maximum beam is restored by the runtime transform');
  assert.equal(width(0,-D.hull.draft-.01),0,'below the keel is outside the hull');
  for(const z of [-1,0,1]){
    const lower=width(z,sheer(z)),upper=width(z,2.04+sheer(z));
    assert.ok(upper>lower*.5&&upper<lower*.97,'the upper midbody turns inward without collapsing its gun decks');
  }
  let flowing=0;
  for(const z of [-5.75,-5.3,-4.6,-3.7]){
    const h=.001,slope=(width(z+h,sheer(z+h))-width(z-h,sheer(z-h)))/(2*h);
    if(slope>.05)flowing++;
  }
  assert.ok(flowing>=3,'the fair forebody must not flatten its tangent at every old breadth-table station');
  // Compare each side of the same tangent, including old station locations and
  // upper/lower section transitions. Domain boundaries are tested by caps.
  for(const z of [-5.75,-5.3,-4.6,-3.7,-2.5,-1,0,1.5,3,4.5,5.35])for(const base of [-1.1,-.5,0,.5,1.17,1.67,2.15]){
    if(width(z,base+sheer(z))<.08)continue;
    const h=.0001,f=q=>width(q,base+sheer(q)),left=(f(z)-f(z-h))/h,right=(f(z+h)-f(z))/h;
    assert.ok(Math.abs(Math.atan(left*scale[0]/scale[2])-Math.atan(right*scale[0]/scale[2]))<.02,`longitudinal tangent kink at z=${z}, height=${base}`);
  }
});

test('the rendered bow and raked stern close the exact same loft used by the hull footprint',()=>{
  assert.equal(typeof victory.victoryHullPoint,'function','mesh and footprint need the same loft point evaluator');
  for(const [id,station,direction]of [['bow',-6,1],['stern',6,-1]]){
    const cap=groups.find(g=>g.id===`hull.closure.${id}`),data=part(cap?cap.id:'hull.planking');
    for(const base of [-1.5,-.8,-.2,.4,1.3]){
      const point=victory.victoryHullPoint(station,base,1),origin=[0,point[1],point[2]-direction];
      if(!cap)assert.ok(Math.abs(point[0])<1e-7,`${id} can omit a cap only when both side skins meet at the stem`);
      const distance=hitDistance(data,origin,[0,0,direction]);
      assert.ok(Number.isFinite(distance),`${id} has a visible centreline hole at height ${base}`);
      close(distance,1,.02/scale[2],`${id} cap joins the same raked loft at height ${base}`);
    }
  }
});

test('the forebody reaches the measured rounded nose instead of clipping every height at the gundeck endpoint',()=>{
  // Exact source sections reject the narrow projecting stem and broken head
  // rails. These are physical GLB coordinates, independent of the fore-only
  // runtime warp; retaining old widths while moving the stem must fail here.
  const metres=44.80215288399298,centre=.14729826190723827,waterline=-.4813768389280885;
  const samples=[[-.47,-.48,.06192675139],[-.47,-.46,.11181887500],
    [-.43,-.50,.03442839253],[-.43,-.49,.06523457334],[-.43,-.48,.08607798476],[-.43,-.46,.10703564834],
    [-.39,-.48,.08011642035],[-.39,-.46,.10885335753],
    [-.37,-.48,.07522562790],[-.37,-.46,.09718703660],
    [-.35,-.49,.06125283165],[-.35,-.48,.07161272314],[-.35,-.46,.09652310423]];
  for(const [sourceY,sourceX,halfBreadth]of samples){
    const z=(sourceX-centre)*metres/scale[2],base=(sourceY-waterline)*metres/scale[1];
    close(width(z,base+sheer(z))*scale[0],halfBreadth*metres,.12,`forward shell at ${sourceX},${sourceY}`);
  }
  const skin=part('hull.planking');
  for(const [sourceY,x,sourceX]of [[-.43,.015,-.50521],[-.37,.005,-.508455],[-.37,.015,-.506545],[-.35,.025,-.504765]]){
    const z=(sourceX-centre)*metres/scale[2],base=(sourceY-waterline)*metres/scale[1],y=base+sheer(z);
    const distance=hitDistance(skin,[x*metres/scale[0],y,z-1],[0,0,1]);
    assert.ok(Number.isFinite(distance),'the front ray must hit real planking');
    close(distance,1,.12/scale[2],`rendered rounded nose at source height ${sourceY}`);
  }
  const lower=victory.victoryHullPoint(-6,0,1),upper=victory.victoryHullPoint(-6,1.67,1);
  assert.ok((lower[2]-upper[2])*scale[2]>.95,'the upper stem projects forward of the waterline rather than ending at one vertical cut');
});

test('planked deck edges follow both ends of each curved strip and bulkheads follow the side at both heights',()=>{
  for(const id of ['main','forecastle','quarter','poop']){
    const data=part(`deck.${id}.planks`),waterway=part(`deck.${id}.waterway`),rows=new Map(),triangles=[];
    for(let i=0;i<waterway.length;i+=27)triangles.push([0,9,18].map(j=>position(waterway,i+j).map((v,k)=>v*scale[k])));
    for(let i=0;i<data.length;i+=9){
      const p=position(data,i),key=p[2].toFixed(5),row=rows.get(key)??{z:p[2],y:p[1],edge:0};row.edge=Math.max(row.edge,Math.abs(p[0]));rows.set(key,row);
    }
    assert.ok(rows.size>5,`${id} deck retains longitudinal shape samples`);
    for(const row of rows.values()){
      const point=[row.edge*scale[0],row.y*scale[1],row.z*scale[2]];
      const distance=Math.min(...triangles.map(triangle=>triangleDistance(point,...triangle)));
      assert.ok(distance<.012,`${id} planks must meet the continuous waterway at z=${row.z}, gap ${distance}m`);
    }
    const outerRows=new Map();
    for(let i=0;i<waterway.length;i+=9){const p=position(waterway,i),key=p[2].toFixed(5),row=outerRows.get(key)??{z:p[2],y:p[1],edge:0};row.edge=Math.max(row.edge,Math.abs(p[0]));outerRows.set(key,row);}
    for(const row of outerRows.values())close(row.edge,width(row.z,row.y),.012/scale[0],`${id} waterway meets the skin at z=${row.z}`);
  }
  const bulkheads=groups.filter(g=>g.id.startsWith('deck.bulkhead.'));assert.equal(bulkheads.length,3);
  for(const group of bulkheads){
    const data=part(group.id),levels=new Set();
    for(let i=0;i<data.length;i+=9){const p=position(data,i);levels.add(p[1].toFixed(5));close(Math.abs(p[0]),width(p[2],p[1]),.012/scale[0],`${group.id} meets the side at height ${p[1]}`);}
    assert.ok(levels.size>=2);
  }
});

test('proud wales have returns joining the skin along every band instead of floating detached ribbons',()=>{
  for(const side of ['port','starboard']){
    const data=part(`hull.wales.${side}`),rows=new Map();
    for(let i=0;i<data.length;i+=9){
      const p=position(data,i),base=p[1]-sheer(p[2]);
      const band=[.035,.635,1.135].reduce((a,b)=>Math.abs(base-a)<Math.abs(base-b)?a:b),key=p[2].toFixed(5)+','+band;
      const gap=Math.abs(p[0])-width(p[2],p[1]),row=rows.get(key)??{skin:Infinity,outer:-Infinity};row.skin=Math.min(row.skin,Math.abs(gap));row.outer=Math.max(row.outer,gap);rows.set(key,row);
    }
    assert.ok(rows.size>90);
    for(const [key,row]of rows){
      assert.ok(row.skin*scale[0]<.012,`${side} wale return is detached at ${key}: ${row.skin*scale[0]}m`);
      assert.ok(row.outer*scale[0]>.025&&row.outer*scale[0]<.2,`${side} wale retains finite proud timber at ${key}`);
    }
  }
});

test('the tops of the rendered stanchions intersect the actual rail volume through the tumblehome',()=>{
  for(const side of [-1,1]){
    const rail=part(`bulwark.${side}.rail`),triangles=[],axes=[];
    for(let i=0;i<rail.length;i+=27){
      triangles.push([0,9,18].map(j=>position(rail,i+j).map((v,k)=>v*scale[k])));
      // Recover each actual tube axis from its radius and radial normals. This
      // remains valid for uncapped tubes and makes no vertex-count assumption.
      const centres=[0,9,18].map(j=>[0,1,2].map(k=>(rail[i+j+k]-.025*rail[i+j+3+k])*scale[k]));
      let longest=0,pair;
      for(const [a,b]of [[0,1],[1,2],[0,2]]){const d=centres[a].reduce((n,v,k)=>n+(v-centres[b][k])**2,0);if(d>longest){longest=d;pair=[centres[a],centres[b]];}}
      if(longest>1e-10)axes.push(pair);
    }
    const posts=groups.filter(g=>g.id.startsWith(`bulwark.${side}.stanchion.`));assert.ok(posts.length>15);
    for(const group of posts){
      const data=part(group.id),points=new Map(),n=Array.from(data.subarray(3,6));let axis;
      for(let i=0;i<data.length;i+=9){
        const p=position(data,i);points.set(p.map(v=>v.toFixed(7)).join(','),p);
        if(!axis){const q=data.subarray(i+3,i+6),cross=[n[1]*q[2]-n[2]*q[1],n[2]*q[0]-n[0]*q[2],n[0]*q[1]-n[1]*q[0]],length=Math.hypot(...cross);if(length>.5)axis=cross.map(v=>v/length);}
      }
      assert.ok(axis,`${group.id} has a finite cylinder axis`);if(axis[1]<0)axis=axis.map(v=>-v);
      // Radial normals recover the tube axis independently of whether hidden
      // caps were omitted. Average the end ring to obtain its true centre.
      const along=p=>p.reduce((n,v,i)=>n+v*axis[i],0),values=[...points.values()],maximum=Math.max(...values.map(along));
      const end=values.filter(p=>Math.abs(along(p)-maximum)<1e-5);assert.ok(end.length>=3);
      const top=[0,1,2].map(k=>end.reduce((n,p)=>n+p[k],0)/end.length*scale[k]);let distance=Infinity;
      for(const triangle of triangles)distance=Math.min(distance,triangleDistance(top,...triangle));
      // A centreline endpoint fully inside the four-sided rail is a valid
      // weld even though the nearest external face is beyond the post radius.
      const inscribed=.025*Math.min(...scale)/Math.SQRT2;
      const contained=axes.some(([a,b])=>{
        const d=b.map((v,i)=>v-a[i]),p=top.map((v,i)=>v-a[i]),denominator=d.reduce((n,v)=>n+v*v,0),t=p.reduce((n,v,i)=>n+v*d[i],0)/denominator;
        return t>=-1e-5&&t<=1+1e-5&&Math.hypot(...p.map((v,i)=>v-t*d[i]))<inscribed-.001;
      });
      assert.ok(contained||distance<=.013*Math.max(...scale)+.008,`${group.id} stops short of its rail: ${distance}m`);
    }
  }
});

test('all three stern galleries have arched raked skins with windows supported by the same curved surface',()=>{
  let previousArch=0;
  for(let level=0;level<3;level++){
    const skin=part(`stern.gallery.${level}.rear`),windows=part(`stern.gallery.${level}.windows`),returns=part(`stern.gallery.${level}.returns`);
    const points=[];for(let i=0;i<skin.length;i+=9)points.push(position(skin,i));
    const centres=points.filter(p=>Math.abs(p[0])<1e-6);
    assert.ok(centres.length>4,'the actual timber skin carries transverse and vertical shape samples');
    const top=Math.max(...centres.map(p=>p[1])),bottom=Math.min(...centres.map(p=>p[1]));
    // Tumblehome makes the lower edge wider, so compare the upper corners
    // within the physically shallow crown band rather than the whole box.
    const crown=points.filter(p=>p[1]>top-.65/scale[1]),halfWidth=Math.max(...crown.map(p=>Math.abs(p[0])));
    const edges=crown.filter(p=>Math.abs(p[0])>halfWidth*.99);assert.ok(edges.some(p=>p[0]<0)&&edges.some(p=>p[0]>0),'both upper corners remain represented');
    const arch=(top-Math.max(...edges.map(p=>p[1])))*scale[1];
    assert.ok(arch>.10&&arch<.65,`gallery ${level} retains a shallow physical arch: ${arch}m`);
    assert.ok(arch>previousArch,'the upper gallery crown rises more than the lower rows');previousArch=arch;
    const high=centres.find(p=>Math.abs(p[1]-top)<1e-6),low=centres.find(p=>Math.abs(p[1]-bottom)<1e-6);
    assert.ok((low[2]-high[2])*scale[2]>.05,'the actual rear timber rakes inward toward the upper edge');
    const bow=(Math.max(...centres.map(p=>p[2]))-Math.max(...edges.map(p=>p[2])))*scale[2];
    assert.ok(bow>.08&&bow<.5,'the square stern has a restrained horizontal bow, rather than a flat shelf');
    let checked=0;
    for(let i=0;i<windows.length;i+=9)if(Math.floor(windows[i+6])===11){
      const p=position(windows,i),distance=hitDistance(skin,p,[0,0,-1]);
      assert.ok(Number.isFinite(distance)&&distance*scale[2]<.045,`gallery ${level} glazing is detached from its arched timber: ${distance*scale[2]}m`);checked++;
    }
    assert.ok(checked>50,'all nine windows contribute their actual subdivided glass vertices');
    let contact=0;
    for(let i=0;i<returns.length;i+=9){
      const p=position(returns,i);
      if(Math.abs(p[2]-victory.victoryHullPoint(6,p[1]-sheer(p[2]),1)[2])<1e-6){
        assert.ok(Math.abs(p[0])<=width(p[2],p[1])+1e-6,'arched gallery returns reach into the parent transom instead of hanging behind it');contact++;
      }
    }
    assert.ok(contact>20,'the curved gallery has a continuous structural return to the hull');
  }
});

test('the fair above-water hull agrees with clean held-out sections from the supplied reference GLB',t=>{
  // Independent exact mesh sections, source SHA256:
  // f54976c233c708811065981f00a1be9ff6b3c6a56880b34b36d391720cd3453e.
  // These X stations are absent from the production fit grid. Rejected values
  // (-.30,-.35) and (.60,-.33) cross fittings, not the hull shell.
  const heights=[-.47,-.43,-.39,-.37,-.35,-.33],sections=[
    [-.30,[.16390962898731232,.15451813489198685,.14207451045513153,.1375730112195015,null,.1307665929198265]],
    [.10,[.17739447951316833,.17170248180627823,.15927866846323013,.15410682559013367,.14952649176120758,.14221996068954468]],
    [.40,[.170000322163105,.1622926965355873,.14854956418275833,.14204900711774826,.1363396793603897,.13092755526304245]],
    [.60,[.15763495117425919,.15406310558319092,.1399971917271614,.13524224609136581,.12739868462085724,null]],
  ];
  // Authored registration: retain the reported beam/gundeck length and align
  // the reference upper floor to our upper deck. The source has no marked
  // waterline; this does not turn its display mesh into surveyed underwater data.
  const metres=44.80215288399298,centre=.78-D.runtime.length/metres/2,waterline=-.358-D.decks.upper*scale[1]/metres;
  let squares=0,maximum=0,count=0;
  for(const [sourceX,values]of sections)for(let j=0;j<values.length;j++){
    if(values[j]===null)continue;
    const z=(sourceX-centre)*metres/scale[2],base=(heights[j]-waterline)*metres/scale[1];
    const expected=values[j]*metres,actual=width(z,base+sheer(z))*scale[0],error=Math.abs(actual-expected);
    squares+=error*error;maximum=Math.max(maximum,error);count++;
  }
  const rmse=Math.sqrt(squares/count);assert.equal(count,22);
  assert.ok(rmse<.2&&maximum<.4,`reference section mismatch: RMSE ${rmse}m, max ${maximum}m`);
  t.diagnostic(`Held-out reference sections: ${count}, RMSE ${rmse.toFixed(4)}m, maximum ${maximum.toFixed(4)}m`);
});

function integrateVictory(nz,ny){
  const draft=D.hull.draft,dz=12/nz,dy=draft/ny;let volume=0,moment=0,area=0,transverse=0,longitudinal=0,first=0;
  for(let i=0;i<nz;i++){
    const z=-6+(i+.5)*dz,w=width(z,0);area+=2*w*dz;transverse+=2/3*w**3*dz;longitudinal+=2*w*z*z*dz;first+=2*w*z*dz;
    for(let j=0;j<ny;j++){const y=-draft+(j+.5)*dy,dv=2*width(z,y)*dz*dy;volume+=dv;moment+=dv*y;}
  }
  return {volume:volume*scale[0]*scale[1]*scale[2],area:area*scale[0]*scale[2],transverse:transverse*scale[0]**3*scale[2],
    longitudinal:(longitudinal-first*first/area)*scale[0]*scale[2]**3,centre:draft*scale[1]+moment/volume*scale[1]};
}
test('independent hydrostatic quadrature converges and the fitted hull obeys Archimedes and load bookkeeping',()=>{
  const coarse=integrateVictory(480,300),fine=integrateVictory(960,600),actual=hullHydrostatics(D.runtime.length,D.runtime.beam,0,'victory');
  for(const key of ['volume','area','transverse','longitudinal'])assert.ok(Math.abs(coarse[key]/fine[key]-1)<.001,`independent ${key} integral must converge`);
  for(const [key,value]of [['volume',actual.volume],['area',actual.waterplaneArea],['transverse',actual.waterplaneMoment],['longitudinal',actual.longitudinalMoment]]){
    assert.ok(Math.abs(value/fine[key]-1)<.004,`cached ${key} integration differs from the independent fine grid`);
  }
  close(actual.centreOfBuoyancy,fine.centre,.015,'centre of buoyancy');
  const standard=boatHydrodynamics(D.runtime.length,D.runtime.beam,60,0,'victory');
  for(const [days,cargo]of [[0,0],[60,0],[90,20]]){
    const h=boatHydrodynamics(D.runtime.length,D.runtime.beam,days,cargo,'victory');
    close(h.mass,h.volume*SEAWATER_DENSITY,.01,'Archimedean supported mass');
    close(h.mass,h.fixedMass+h.crewMass+h.waterMass+h.foodMass+h.storesMass+h.cargoMass,.001,'all declared mass remains accounted for');
    assert.ok(h.metacentricHeight>0&&h.rollInertia>0&&h.pitchInertia>0&&h.heaveOmega>0&&h.freeboard>0&&h.overloadKg===0,'normal service manifests remain stable and supported');
    if(days===90)assert.ok(h.mass>standard.mass&&h.draft>standard.draft,'extra stores and cargo settle deeper');
  }
});
