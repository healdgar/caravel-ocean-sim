// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {pathToFileURL} from 'node:url';
import {lateenRestPoint,lateenClothPoint} from '../js/lateen.js';

export const SAIL_REST_INPUTS=Object.freeze({rows:26,sides:[-1,1],openings:[.3,.6,1.15],
  pressures:[-1,0,1],deployed:1,fill:1,dip:0,time:0,wind:0});
const length=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const area=(a,b,c)=>{
  const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  return .5*Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]);
};
const vector=(p,n)=>p?.length===n && Array.from(p).every(Number.isFinite);

/** Measure a shared triangular MATERIAL mesh before and after posing.
 * Coordinates and tolerances use the caller's length units. Edge excess is
 * posed minus rest length; maximumExcess is the greatest positive excess in
 * those units. Ratios and unsigned areas do not measure the complete textile
 * metric, orientation, self-intersection, contact clearance or physical force.
 * Invalid coordinates/topology are reported without returning partial totals.
 */
export function measureTriangularMaterialMesh({uv,triangles,restPoints,posedPoints}={},
  {lengthTolerance=1e-12,areaTolerance=1e-12}={}){
  if(!Number.isFinite(lengthTolerance) || lengthTolerance<0 || !Number.isFinite(areaTolerance) || areaTolerance<0)
    throw RangeError('Geometry tolerances must be finite and nonnegative');
  const count=Array.isArray(restPoints)?restPoints.length:0;
  const invalid={restVertices:[],posedVertices:[],uvVertices:[],triangles:[]},issues=[];
  const report={validGeometry:false,vertices:count,triangles:Array.isArray(triangles)?triangles.length:0,
    uniqueEdges:0,finite:false,invalid,edges:null,areas:null,degenerate:null,issues,
    units:'caller coordinate length units; area in squared units',
    limitations:['edge-chords-and-unsigned-areas-are-not-complete-textile-metric',
      'orientation-self-intersection-and-contact-clearance-unchecked']};
  if(count<3 || !Array.isArray(posedPoints) || posedPoints.length!==count
    || !Array.isArray(uv) || uv.length!==count || !Array.isArray(triangles) || triangles.length===0){
    issues.push('incompatible-or-empty-material-mesh-arrays');return report;
  }
  for(let i=0;i<count;i++){
    if(!vector(restPoints[i],3))invalid.restVertices.push(i);
    if(!vector(posedPoints[i],3))invalid.posedVertices.push(i);
    if(!vector(uv[i],2))invalid.uvVertices.push(i);
  }
  for(let i=0;i<triangles.length;i++){
    const tri=triangles[i];
    if(!tri || (!Array.isArray(tri)&&!ArrayBuffer.isView(tri)) || tri.length!==3 || new Set(tri).size!==3
      || !Array.from(tri).every(index=>Number.isInteger(index)&&index>=0&&index<count))invalid.triangles.push(i);
  }
  report.finite=invalid.restVertices.length+invalid.posedVertices.length+invalid.uvVertices.length===0;
  if(!report.finite)issues.push('non-finite-or-malformed-material-coordinates');
  if(invalid.triangles.length)issues.push('invalid-triangle-indices');
  if(issues.length)return report;
  const edges=new Map();
  for(const tri of triangles)for(let i=0;i<3;i++){
    const a=Math.min(tri[i],tri[(i+1)%3]),b=Math.max(tri[i],tri[(i+1)%3]);edges.set(`${a}/${b}`,[a,b]);
  }
  report.uniqueEdges=edges.size;
  const degenerate={lengthTolerance,areaTolerance,restEdges:[],posedEdges:[],restTriangles:[],posedTriangles:[]};
  const nonFiniteDerived={edges:[],triangles:[],metrics:[]};
  let minimum=null,maximum=null,maximumExcessEdge=null;
  for(const [key,indices] of edges){
    const [a,b]=indices,restLength=length(restPoints[a],restPoints[b]),posedLength=length(posedPoints[a],posedPoints[b]);
    if(!Number.isFinite(restLength) || !Number.isFinite(posedLength)){nonFiniteDerived.edges.push(key);continue;}
    if(restLength<=lengthTolerance)degenerate.restEdges.push(key);
    if(posedLength<=lengthTolerance)degenerate.posedEdges.push(key);
    if(restLength<=lengthTolerance)continue;
    if(!Number.isFinite(posedLength/restLength)){nonFiniteDerived.edges.push(key);continue;}
    const edge={indices,uv:indices.map(i=>Array.from(uv[i])),restLength,posedLength,
      ratio:posedLength/restLength,excess:posedLength-restLength};
    if(!minimum || edge.ratio<minimum.ratio)minimum=edge;
    if(!maximum || edge.ratio>maximum.ratio)maximum=edge;
    if(!maximumExcessEdge || edge.excess>maximumExcessEdge.excess)maximumExcessEdge=edge;
  }
  let restArea=0,posedArea=0;
  for(const [index,tri] of triangles.entries()){
    const rest=area(...Array.from(tri,i=>restPoints[i])),posed=area(...Array.from(tri,i=>posedPoints[i]));
    if(!Number.isFinite(rest) || !Number.isFinite(posed)){nonFiniteDerived.triangles.push(index);continue;}
    if(rest<=areaTolerance)degenerate.restTriangles.push(index);
    if(posed<=areaTolerance)degenerate.posedTriangles.push(index);
    restArea+=rest;posedArea+=posed;
  }
  report.edges=nonFiniteDerived.edges.length?null:{minimumRatio:minimum?.ratio??null,maximumRatio:maximum?.ratio??null,
    maximumExcess:Math.max(0,maximumExcessEdge?.excess??0),minimum,maximum,maximumExcessEdge};
  const areaRatio=restArea>0?posedArea/restArea:null;
  if(!Number.isFinite(restArea) || !Number.isFinite(posedArea) || areaRatio!==null&&!Number.isFinite(areaRatio))
    nonFiniteDerived.metrics.push('total-area-or-area-ratio');
  report.areas=nonFiniteDerived.triangles.length || nonFiniteDerived.metrics.length?null:
    {restTotal:restArea,posedTotal:posedArea,ratio:areaRatio};
  report.degenerate=degenerate;report.nonFiniteDerived=nonFiniteDerived;
  if(nonFiniteDerived.edges.length || nonFiniteDerived.triangles.length || nonFiniteDerived.metrics.length)issues.push('non-finite-derived-geometry');
  if(degenerate.restEdges.length || degenerate.restTriangles.length)issues.push('degenerate-rest-geometry');
  if(degenerate.posedEdges.length || degenerate.posedTriangles.length)issues.push('degenerate-posed-geometry');
  report.validGeometry=issues.length===0;
  return report;
}

export function createTriangularMaterialTopology(rows=26){
  if(!Number.isInteger(rows) || rows<1)throw RangeError('rows must be a positive integer');
  const uv=[],triangles=[],indices=new Map();
  for(let i=0;i<=rows;i++)for(let j=0;j<=rows-i;j++){
    indices.set(`${i}/${j}`,uv.length);uv.push([i/rows,j/rows]);
  }
  const at=(i,j)=>indices.get(`${i}/${j}`);
  for(let i=0;i<rows;i++)for(let j=0;j<rows-i;j++){
    triangles.push([at(i,j),at(i+1,j),at(i,j+1)]);
    if(i+j<rows-1)triangles.push([at(i+1,j),at(i+1,j+1),at(i,j+1)]);
  }
  return {uv,triangles};
}

export function sampleLateenMaterialMesh(mast,pose,{rows=26,time=0,wind=0,clothPoint=lateenClothPoint}={}){
  if(!Number.isInteger(mast) || mast<0 || mast>2)throw RangeError('mast must be 0, 1 or 2');
  const topology=createTriangularMaterialTopology(rows);
  return {...topology,restPoints:topology.uv.map(([u,v])=>lateenRestPoint(mast,u,v)),
    posedPoints:topology.uv.map(([u,v])=>clothPoint(mast,u,v,pose,time,wind,true))};
}

export function auditLateenRest({rows=SAIL_REST_INPUTS.rows,clothPoint=lateenClothPoint}={}){
  const records=[];
  for(const side of SAIL_REST_INPUTS.sides)for(const opening of SAIL_REST_INPUTS.openings)
    for(const pressure of SAIL_REST_INPUTS.pressures)for(let mast=0;mast<3;mast++){
      const pose={side,opening,pressure,deployed:1,fill:1,dip:0};
      records.push({mast,name:['fore','main','mizzen'][mast],pose,
        measurement:measureTriangularMaterialMesh(sampleLateenMaterialMesh(mast,pose,{rows,clothPoint,time:0,wind:0}))});
    }
  return {schema:'sail-rest-audit/v1',model:'production-nina-lateen',coordinateSpace:'canonical design coordinates',
    inputs:{...SAIL_REST_INPUTS,rows,contact:true},records,
    invalidGeometryCount:records.filter(record=>!record.measurement.validGeometry).length,
    scope:'Measurements only. Stretch is reported; no cloth validity, textile metric or clearance certification.'};
}

// Fixed pose material audit, like sail-force-audit; no equilibrium or physics
// advancement. Exit status concerns invalid geometry, never measured stretch.
export function runSailRestAuditCLI(args=process.argv.slice(2)){
  const report=auditLateenRest();
  if(args.includes('--json'))console.log(JSON.stringify(report,null,2));
  else{
    console.log('26-row lateen rest audit; deployed=fill=1, dip=time=wind=0; canonical design coordinates');
    console.log('mast    side open press  edge min/max       max excess  area ratio geometry');
    const fixed=value=>Number.isFinite(value)?value.toFixed(4):'invalid';
    for(const {name,pose,measurement:m} of report.records){
      const ratios=`${fixed(m.edges?.minimumRatio)}/${fixed(m.edges?.maximumRatio)}`;
      const excess=Number.isFinite(m.edges?.maximumExcess)?m.edges.maximumExcess.toExponential(2):'invalid';
      console.log(`${name.padEnd(7)} ${String(pose.side).padStart(3)} ${pose.opening.toFixed(2)} ${String(pose.pressure).padStart(5)}  ${ratios.padEnd(18)} ${excess.padStart(10)} ${fixed(m.areas?.ratio).padStart(11)} ${m.validGeometry?'finite':'INVALID'}`);
    }
    console.log(report.scope);
  }
  return report.invalidGeometryCount?1:0;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=runSailRestAuditCLI();
