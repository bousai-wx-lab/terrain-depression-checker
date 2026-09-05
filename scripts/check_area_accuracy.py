#!/usr/bin/env python3
"""Compare area summaries with an independent per-source-pixel disk sum.

Run after the builders. Reads the source cache without requesting new tiles.
NumPy and Pillow required. Results are printed, not asserted as physical truth.
"""
import argparse
import gzip
import io
import json
import math
from pathlib import Path
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
R=6371008.8
CASES=[('Tokyo300',139.767,35.681,300000),('Hakodate300',140.729,41.768,300000),
       ('Chichijima300',142.2,27.09,300000),('Wakkanai300',141.67,45.415,300000),
       ('Tokyo100',139.767,35.681,100000),('Hakodate100',140.729,41.768,100000)]

def integrate(z,tx,ty,values,areas,totals):
    n=256*2**z;size=values.shape[0]
    phi=np.arctan(np.sinh(math.pi-2*math.pi*(ty*size+np.arange(size)+.5)/n))
    lat_edge=np.arctan(np.sinh(math.pi-2*math.pi*(ty*size+np.arange(size+1))/n))
    weights=(np.sin(lat_edge[:-1])-np.sin(lat_edge[1:]))[:,None]*2*math.pi/n
    lon=(tx*size+np.arange(size)+.5)*2*math.pi/n-math.pi
    for i,(_,cx,cy,radius) in enumerate(CASES):
        cp=math.radians(cy);cl=math.radians(cx)
        # Exact haversine cell-center membership (independent of row-prefix code).
        q=np.sin((phi[:,None]-cp)/2)**2+np.cos(cp)*np.cos(phi[:,None])*np.sin((lon[None,:]-cl)/2)**2
        inside=q<=math.sin(radius/R/2)**2
        w=inside*areas*weights
        totals[i,0]+=np.sum(values*w);totals[i,1]+=np.sum(w)

def decode(path):
    rgba=np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert('RGBA'))
    v=rgba[:,:,0].astype(np.int32)*65536+rgba[:,:,1].astype(np.int32)*256+rgba[:,:,2]
    a=((v!=8388608)&(rgba[:,:,3]!=0)).astype(np.float64)
    e=np.where(v<8388608,v,v-16777216)*.01
    return np.where(a>0,e,0),a

def nearby(z,tx,ty,size):
    n=256*2**z
    west=tx*size*360/n-180;east=(tx+1)*size*360/n-180
    north=math.degrees(math.atan(math.sinh(math.pi-2*math.pi*ty*size/n)))
    south=math.degrees(math.atan(math.sinh(math.pi-2*math.pi*(ty+1)*size/n)))
    return any(west<lon+5 and east>lon-5 and south<lat+3 and north>lat-3 for _,lon,lat,_ in CASES)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cache',required=True);args=parser.parse_args();cache=Path(args.cache)
    index=json.loads((ROOT/'data/area-index.json').read_text())
    ref=np.zeros((len(CASES),2));count=0
    for path in sorted((cache/'dem_png/12').glob('*/*.png')):
        tx=int(path.parent.name);ty=int(path.stem)
        if not nearby(12,tx,ty,256):continue
        e,a=decode(path);integrate(12,tx,ty,e,a,ref);count+=1
        if count%1000==0:print(json.dumps({'stage':'reference','tiles':count}),flush=True)
    for path in sorted((cache/'demgm_png/8').glob('*/*.png')):
        tx=int(path.parent.name);ty=int(path.stem)
        if not nearby(8,tx,ty,256):continue
        e,a=decode(path)
        for dy in range(2):
            for dx in range(2):
                key=f'8/{tx*2+dx}/{ty*2+dy}'
                if key in index['tiles']:
                    tile=json.loads(gzip.decompress((ROOT/f'data/area-v1/{key}.json.gz').read_bytes()))
                    a[dy*128:(dy+1)*128,dx*128:(dx+1)*128][np.array(tile['a']).reshape(128,128)>0]=0
        integrate(8,tx,ty,e,a,ref)
    output={'source_tiles':count,'cases':[],'reference':'all cached z12 domestic pixels plus disjoint z8 global land; spherical cell-center disks','levels':{}}
    for i,case in enumerate(CASES):output['cases'].append({'name':case[0],'mean':ref[i,0]/ref[i,1],'land_km2':ref[i,1]*R*R/1e6})
    for z in [8,9,10]:
        totals=np.zeros_like(ref)
        for kind,listing in [('area','tiles'),('global','global_tiles')]:
            gz=z if kind=='area' else min(z,8)
            for key in index[listing]:
                zz,tx,ty=map(int,key.split('/'))
                if zz!=gz or not nearby(gz,tx,ty,128):continue
                data=json.loads(gzip.decompress((ROOT/f'data/{kind}-v1/{key}.json.gz').read_bytes()))
                e=np.array(data['e']).reshape(128,128)*.001;a=np.array(data['a']).reshape(128,128)/1e9
                if gz<z:
                    factor=2**(z-gz);e=e.repeat(factor,0).repeat(factor,1);a=a.repeat(factor,0).repeat(factor,1)
                    # integrate accepts arbitrary block size at its own tile index.
                integrate(z,tx,ty,e,a,totals)
        output['levels'][str(z)]=[{'name':case[0],'mean':totals[i,0]/totals[i,1],'error_m':totals[i,0]/totals[i,1]-ref[i,0]/ref[i,1]} for i,case in enumerate(CASES)]
    print(json.dumps(output,ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':main()
