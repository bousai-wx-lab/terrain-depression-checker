#!/usr/bin/env python3
"""Build area-preserving DEM summaries; raw source tiles stay outside the repo.

Requires NumPy and Pillow. All input pixels contribute; ocean/no-data is never
replaced by zero elevation. A coverage hint selects source tiles, not samples.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request
import numpy as np
from PIL import Image

ORIGIN = "https://cyberjapandata.gsi.go.jp/xyz"
ROOT = Path(__file__).resolve().parents[1]
SOURCE_ZOOM = 12
MAX_ZOOM = 10
TILE = 128
LOCK = threading.Lock()
COUNTERS = {"requests": 0, "cache": 0, "bytes": 0, "missing": 0}

def world(lon, lat, z):
    n = 256 * 2**z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n

def row_weights(y0, length, z):
    y = np.arange(y0, y0 + length + 1, dtype=np.float64)
    phi = np.arctan(np.sinh(math.pi - 2 * math.pi * y / (256 * 2**z)))
    return np.sin(phi[:-1]) - np.sin(phi[1:])

def fetch(cache, source, z, x, y):
    path = cache / source / str(z) / str(x) / f"{y}.png"
    absent = path.with_suffix(".absent")
    if path.exists():
        data = path.read_bytes()
        with LOCK: COUNTERS["cache"] += 1
    elif absent.exists():
        with LOCK: COUNTERS["cache"] += 1
        return None
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(f"{ORIGIN}/{source}/{z}/{x}/{y}.png", timeout=30) as response:
                    if response.headers.get_content_type() != "image/png": raise RuntimeError("Not a PNG response")
                    data = response.read()
                with LOCK:
                    COUNTERS["requests"] += 1
                    COUNTERS["bytes"] += len(data)
                path.write_bytes(data)
                break
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    absent.write_text("404\n")
                    with LOCK:
                        COUNTERS["requests"] += 1
                        COUNTERS["missing"] += 1
                    return None
                if attempt == 2: raise
                time.sleep(.5 * (attempt + 1))
            except (TimeoutError, urllib.error.URLError):
                if attempt == 2: raise
                time.sleep(.5 * (attempt + 1))
    rgba = np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"))
    value = rgba[:, :, 0].astype(np.int32) * 65536 + rgba[:, :, 1].astype(np.int32) * 256 + rgba[:, :, 2]
    valid = (value != 8388608) & (rgba[:, :, 3] != 0)
    result = np.where(value < 8388608, value, value - 16777216).astype(np.float64) * .01
    result[~valid] = np.nan
    return result

def compact_tile(z, tx, ty, numerator, area, world_weights):
    total = world_weights[:, None]
    mean = np.divide(numerator, area, out=np.zeros_like(numerator), where=area > 0)
    fraction = area / total
    return {"v": 1, "z": z, "x": tx, "y": ty, "n": TILE,
            "e": np.rint(mean * 1000).astype(np.int32).ravel().tolist(),
            "a": np.clip(np.rint(fraction * 1e9), 0, 1e9).astype(np.int64).ravel().tolist()}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    cache = Path(args.cache).resolve()
    if cache == ROOT or ROOT in cache.parents: raise SystemExit("Source cache must be outside public repository")
    output = ROOT / "data" / "area-v1"
    output.mkdir(parents=True, exist_ok=True)
    # Analysis centers are 118..154E, 20..48N. The data envelope includes the
    # complete 300km halo. Japanese DEM tiles are absent outside their coverage;
    # foreign terrain is provided at runtime by the official global DEM layer.
    west, north = world(114, 51, 8)
    east, south = world(160, 17, 8)
    parents = [(x,y) for x in range(math.floor(west/256),math.floor(east/256)+1)
               for y in range(math.floor(north/256),math.floor(south/256)+1)]
    source_tiles = set()
    hints = {}
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks = {pool.submit(fetch,cache,"dem_png",8,x,y):(x,y) for x,y in parents}
        for count, future in enumerate(as_completed(tasks),1):
            x,y = tasks[future]; tile = future.result()
            if tile is not None:
                hints[(x,y)] = np.isfinite(tile)
                for dy in range(16):
                    for dx in range(16):
                        if np.isfinite(tile[dy*16:(dy+1)*16,dx*16:(dx+1)*16]).any():
                            source_tiles.add((x*16+dx,y*16+dy))
            if count % 200 == 0: print(json.dumps({"stage":"coverage","done":count,"total":len(parents)}),flush=True)
    # Accumulate unnormalised spherical-area sums at z10. Each output cell
    # holds 4x4 z12 pixels. Sea fraction remains separate from mean elevation.
    groups = {}
    for x,y in source_tiles:
        groups.setdefault((x//2,y//2),[]).append((x,y))
    raw = {}
    def build_group(key, children):
        tx,ty = key
        height_sum = np.zeros((TILE,TILE),dtype=np.float64)
        land_area = np.zeros_like(height_sum)
        weights = row_weights(ty*TILE*4,TILE*4,SOURCE_ZOOM)
        for x,y in children:
            tile = fetch(cache,"dem_png",SOURCE_ZOOM,x,y)
            if tile is None: continue
            valid = np.isfinite(tile)
            off_y,off_x = (y%2)*64,(x%2)*64
            w = weights[(y%2)*256:(y%2+1)*256,None]
            sums = (np.where(valid,tile,0)*w).reshape(64,4,64,4).sum(axis=(1,3))
            areas = (valid*w).reshape(64,4,64,4).sum(axis=(1,3))
            height_sum[off_y:off_y+64,off_x:off_x+64] = sums
            land_area[off_y:off_y+64,off_x:off_x+64] = areas
        # Convert source-pixel longitude width to the destination-pixel width.
        return key,(height_sum/4,land_area/4)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks = [pool.submit(build_group,key,children) for key,children in groups.items()]
        for count,future in enumerate(as_completed(tasks),1):
            key,value = future.result()
            if value[1].any(): raw[key] = value
            if count % 100 == 0: print(json.dumps({"stage":"summaries","done":count,"total":len(groups),**COUNTERS}),flush=True)
    index = {"version":1,"generated_at":datetime.now(timezone.utc).isoformat(),"source_zoom":SOURCE_ZOOM,
             "max_zoom":MAX_ZOOM,"tile_size":TILE,"analysis_bounds":[118,20,154,48],"halo_bounds":[114,17,160,51],
             "source":"GSI DEM10B PNG; area-weighted aggregation of every available z12 pixel",
             "source_url":f"{ORIGIN}/dem_png/{{z}}/{{x}}/{{y}}.png","tiles":{}}
    for z in range(MAX_ZOOM,4,-1):
        next_level = {}
        for (tx,ty),(sums,areas) in sorted(raw.items()):
            record = compact_tile(z,tx,ty,sums,areas,row_weights(ty*TILE,TILE,z))
            data = json.dumps(record,separators=(",",":"),ensure_ascii=True).encode()
            compressed = gzip.compress(data,compresslevel=9,mtime=0)
            relative = f"{z}/{tx}/{ty}.json.gz"
            path = output / relative; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(compressed)
            index["tiles"][f"{z}/{tx}/{ty}"] = {"bytes":len(compressed),"sha256":hashlib.sha256(compressed).hexdigest(),"raw_bytes":len(data)}
            parent = (tx//2,ty//2)
            if parent not in next_level: next_level[parent] = (np.zeros((TILE,TILE)),np.zeros((TILE,TILE)))
            ps,pa = next_level[parent]; ox,oy = (tx%2)*64,(ty%2)*64
            ps[oy:oy+64,ox:ox+64] += sums.reshape(64,2,64,2).sum(axis=(1,3))/2
            pa[oy:oy+64,ox:ox+64] += areas.reshape(64,2,64,2).sum(axis=(1,3))/2
        print(json.dumps({"stage":"output","zoom":z,"tiles":len(raw)}),flush=True)
        raw = next_level
    (ROOT/"data"/"area-index.json").write_text(json.dumps(index,separators=(",",":"))+"\n")
    evidence={"source_tiles":len(source_tiles),"coverage_tiles":len(parents),"output_tiles":len(index["tiles"]),
              "output_bytes":sum(v["bytes"] for v in index["tiles"].values()),"seconds":time.monotonic()-started,**COUNTERS}
    (cache/"build-evidence.json").write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps(evidence),flush=True)

if __name__ == "__main__": main()
