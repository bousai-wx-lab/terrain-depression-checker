import assert from 'node:assert/strict';
import {parseShareState,serializeShareState,depthColor,elevationDifference} from '../terrain.js';
let cases=0;
for(const radius of [250,500,1000,10000,50000,100000,150000,200000,300000])
for(let zoom=5;zoom<=18;zoom++)for(const threshold of [.5,1,2,5])
for(const baseMap of ['std','pale','hillshademap'])for(const terrain of [false,true])
for(const terrainStyle of ['mono','color'])for(const centerMark of [false,true])for(const radiusGuide of [false,true]) {
  const value={latitude:35.681,longitude:139.767,zoom,radius,threshold,baseMap,terrain,terrainStyle,
    centerMark,radiusGuide,baseMapOpacity:100,terrainOpacity:35,depressionOpacity:65,selectedPoint:{latitude:35.682,longitude:139.768}};
  const parsed=parseShareState('?'+serializeShareState(value));
  for(const key of Object.keys(value))assert.deepEqual(parsed[key],value[key]);
  for(const depth of [-100,-1,0,.49,.5,.99,1,1.5,2,3,4,5,10,1000]) {
    const color=depth>=threshold?depthColor(depth):null;
    assert.equal(Boolean(color),depth>=threshold);
    assert.equal(elevationDifference(0,depth),depth===0?0:-depth);
  }
  cases++;
}
console.log(`DISPLAY_CONTRACT_TESTS_OK combinations=${cases}`);
