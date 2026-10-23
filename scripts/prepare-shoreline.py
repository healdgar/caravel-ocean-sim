#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT. Output OSM data is ODbL1.0.
"""Extract directed closed coastline rings from a cached Overpass JSON reply.

Does not download, infer shore from colours, or include beach polygons as land.
The recorded query and source hash accompany the independently licensed data.
"""
import argparse,json,hashlib
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source',type=Path)
parser.add_argument('--out',type=Path,default=Path(__file__).resolve().parents[1]/'assets/world/saba/wells-bay-shoreline.geojson')
args=parser.parse_args()
p=args.source;d=json.loads(p.read_text());nodes={e['id']:[e['lon'],e['lat']] for e in d['elements'] if e['type']=='node'}
ways=[e for e in d['elements'] if e['type']=='way' and e.get('tags',{}).get('natural')=='coastline'];chains=[(w['nodes'][:],[w['id']]) for w in ways];rings=[]
while chains:
 chain,ids=chains.pop(0)
 while chain[-1]!=chain[0]:
  found=next((i for i,(c,_) in enumerate(chains) if c[0]==chain[-1]),None)
  if found is None:raise ValueError(f'Open coastline {ids}')
  c,ii=chains.pop(found);chain+=c[1:];ids+=ii
 rings.append({'type':'Feature','properties':{'natural':'coastline','osmWayIds':ids},'geometry':{'type':'Polygon','coordinates':[[nodes[i] for i in chain]]}})
result={'type':'FeatureCollection','licence':'ODbL 1.0','attribution':'© OpenStreetMap contributors','source':'https://www.openstreetmap.org/copyright','sourceQueryURL':'https://overpass.kumi.systems/api/interpreter','sourceQuery':'[out:json][timeout:30];(way["natural"="coastline"](17.59,-63.29,17.68,-63.19);way["natural"="beach"](17.59,-63.29,17.68,-63.19);relation["natural"="beach"](17.59,-63.29,17.68,-63.19););out body;>;out skel qt;','sourceSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'snapshot':d['osm3s']['timestamp_osm_base'],'accessed':'2026-10-22','features':rings}
out=args.out;out.write_text(json.dumps(result,separators=(',',':'))+'\n');print('rings',len(rings),'bytes',out.stat().st_size,'sha256',hashlib.sha256(out.read_bytes()).hexdigest())
