#!/usr/bin/env python3
"""Supplement the regional summaries with the official global DEM land grid."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np
from build_area_data import ROOT, TILE, fetch, world, row_weights, compact_tile

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cache',required=True);parser.add_argument('--workers',type=int,default=6)
    args=parser.parse_args();cache=Path(args.cache).resolve()
    if cache==ROOT or ROOT in cache.parents:raise SystemExit('Source cache must be outside public repository')
    index=json.loads((ROOT/'data/area-index.json').read_text())
    west,north=world(114,51,8);east,south=world(160,17,8)
    targets=[(x,y) for x in range(math.floor(west/256),math.floor(east/256)+1) for y in range(math.floor(north/256),math.floor(south/256)+1)]
    def source(key):
        x,y=key;gm=fetch(cache,'demgm_png',8,x,y)
        if gm is None:return []
        result=[]
        for dy in range(2):
            for dx in range(2):
                tx,ty=x*2+dx,y*2+dy;values=gm[dy*128:(dy+1)*128,dx*128:(dx+1)*128].copy()
                record=index['tiles'].get(f'8/{tx}/{ty}')
                if record:
                    domestic=json.loads(gzip.decompress((ROOT/f'data/area-v1/8/{tx}/{ty}.json.gz').read_bytes()))
                    values[np.array(domestic['a']).reshape(128,128)>0]=np.nan
                valid=np.isfinite(values)
                if valid.any():
                    weight=row_weights(ty*128,128,8)[:,None]
                    result.append(((tx,ty),(np.where(valid,values,0)*weight,valid*weight)))
        return result
    raw={}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks=[pool.submit(source,key) for key in targets]
        for count,future in enumerate(as_completed(tasks),1):
            for key,value in future.result():raw[key]=value
            if count%200==0:print(json.dumps({'stage':'global','done':count,'total':len(targets)}),flush=True)
    index['global_tiles']={};index['global_source_zoom']=8
    for z in range(8,4,-1):
        next_level={}
        for (tx,ty),(sums,areas) in sorted(raw.items()):
            record=compact_tile(z,tx,ty,sums,areas,row_weights(ty*128,128,z))
            data=json.dumps(record,separators=(',',':')).encode();compressed=gzip.compress(data,compresslevel=9,mtime=0)
            path=ROOT/f'data/global-v1/{z}/{tx}/{ty}.json.gz';path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(compressed)
            index['global_tiles'][f'{z}/{tx}/{ty}']={'bytes':len(compressed),'sha256':hashlib.sha256(compressed).hexdigest(),'raw_bytes':len(data)}
            parent=(tx//2,ty//2)
            if parent not in next_level:next_level[parent]=(np.zeros((128,128)),np.zeros((128,128)))
            ps,pa=next_level[parent];ox,oy=tx%2*64,ty%2*64
            ps[oy:oy+64,ox:ox+64]+=sums.reshape(64,2,64,2).sum(axis=(1,3))/2
            pa[oy:oy+64,ox:ox+64]+=areas.reshape(64,2,64,2).sum(axis=(1,3))/2
        print(json.dumps({'stage':'global-output','zoom':z,'tiles':len(raw)}),flush=True);raw=next_level
    (ROOT/'data/area-index.json').write_text(json.dumps(index,separators=(',',':'))+'\n')
    print(json.dumps({'global_tiles':len(index['global_tiles']),'global_bytes':sum(v['bytes'] for v in index['global_tiles'].values())}),flush=True)

if __name__=='__main__':main()
