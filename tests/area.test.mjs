import assert from 'node:assert/strict';
import { allocatePrefix, finishPrefix, latitudeAt, diskRows, queryDisk, calculateAreaRow, chooseAreaPlan, gridPositions } from '../area.js';
import { lonLatToWorldPixel, SPHERICAL_EARTH_RADIUS_METERS as R } from '../terrain.js';

// Independent reference: enumerate every cell and test its great-circle
// distance, without row extents, prefix sums, or queryDisk.
let cases=0;
for(const latitude of [20,35.68,45.5,48])for(const zoom of [8,11,15]) {
  const center=lonLatToWorldPixel(139,latitude,zoom),width=128,height=128;
  const bounds={zoom,x0:Math.floor(center.x)-64,y0:Math.floor(center.y)-64,width,height};
  for(const kind of ['constant','negative','slope','bowl','coast','island','missing']) {
    const p=allocatePrefix(bounds),values=[],fractions=[];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const value=kind==='negative'?-4:kind==='slope'?x+2*y:kind==='bowl'?Math.hypot(x-64,y-64):37.5;
      const area=kind==='coast'?(x<63?0:x===63?.03:1):kind==='island'?(x===61&&y===66?.002:0):kind==='missing'?0:1;
      const i=y*width+x;values[i]=value;fractions[i]=area;
      p.sums[y*p.stride+x+1]=value*area;p.areas[y*p.stride+x+1]=area;
    }
    finishPrefix(p);
    for(const radiusPixels of [8,27,45])for(const offset of [0,.31]) {
      const wx=center.x+offset,wy=center.y-offset;
      const radius=radiusPixels*Math.cos(latitude*Math.PI/180)*2*Math.PI*R/(256*2**zoom);
      let sum=0,area=0,full=0;
      const phi=latitudeAt(wy,zoom);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const rowPhi=latitudeAt(bounds.y0+y+.5,zoom);
        const dl=(bounds.x0+x+.5-wx)*2*Math.PI/(256*2**zoom);
        const distance=2*R*Math.asin(Math.sqrt(Math.sin((rowPhi-phi)/2)**2+Math.cos(phi)*Math.cos(rowPhi)*Math.sin(dl/2)**2));
        if(distance>radius)continue;
        const weight=Math.sin(latitudeAt(bounds.y0+y,zoom))-Math.sin(latitudeAt(bounds.y0+y+1,zoom));
        const i=y*width+x;sum+=values[i]*fractions[i]*weight;area+=fractions[i]*weight;full+=weight;
      }
      const actual=queryDisk(p,wx,diskRows(p,wy,radius));
      const row=calculateAreaRow(p,[wx],wy,radius);
      if(area>0) {
        assert.ok(actual);assert.ok(Math.abs(actual.mean-sum/area)<1e-8);
        assert.ok(Math.abs(actual.landFraction-area/full)<1e-10);
        assert.ok(Math.abs(row.means[0]-sum/area)<2e-5);
      } else { assert.equal(actual,null);assert.ok(Number.isNaN(row.means[0])); }
      cases++;
    }
    const outside=calculateAreaRow(p,[bounds.x0],center.y,1000000);
    assert.ok(Number.isNaN(outside.means[0]));cases++;
  }
}
// Every usable view has a complete halo, at both visible edges and poles of
// its circular neighbourhood. Unusable zoom/radius pairs are not rendered.
const radii=[250,500,1000,10000,50000,100000,150000,200000,300000];
for(const latitude of [20,35.68,48])for(let zoom=5;zoom<=18;zoom++)for(const radius of radii)for(const size of [[911,586],[374,500],[1600,900]]) {
  const view={longitude:139,latitude,zoom,radius,width:size[0],height:size[1]},p=chooseAreaPlan(view);
  if(!p.usable){cases++;continue;}
  const positions=gridPositions(view,6),scale=2**(p.zoom-zoom);
  p.stride=p.width+1;p.weights=new Float64Array(p.height).fill(1);
  for(const y of [positions.ys[0],positions.ys.at(-1)]) {
    const rows=diskRows(p,y*scale,radius);assert.ok(rows);
    for(const x of [positions.xs[0],positions.xs.at(-1)])for(const row of rows) {
      const cx=x*scale-p.x0-.5;
      assert.ok(Math.ceil(cx-row.dx)>=0);assert.ok(Math.floor(cx+row.dx)+1<=p.width);
    }
  }
  cases++;
}
console.log(`AREA_MEAN_TESTS_OK cases=${cases}`);
