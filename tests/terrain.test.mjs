import assert from "node:assert/strict";
import {
  calculateRelativeDepth,
  decodeElevationRgb,
  depthColor,
  lonLatToWorldPixel,
  metersPerPixel,
  tileCoordinate,
  worldPixelToLonLat,
} from "../terrain.js";

assert.equal(decodeElevationRgb(0, 0, 1), 0.01);
assert.equal(decodeElevationRgb(0, 1, 0), 2.56);
assert.equal(decodeElevationRgb(128, 0, 0), null);
assert.equal(decodeElevationRgb(255, 255, 255), -0.01);

const result = calculateRelativeDepth(8, [10, 10, 11, 9, 10, 10, 11, 9, 10, 10]);
assert.ok(result);
assert.equal(result.center, 8);
assert.equal(result.surroundingMean, 10);
assert.equal(result.depth, 2);
assert.equal(calculateRelativeDepth(8, [10, 11], 10), null);
assert.equal(calculateRelativeDepth(Number.NaN, Array(10).fill(10)), null);

assert.equal(depthColor(0.49), null);
assert.deepEqual(depthColor(0.5), [87, 200, 242]);
assert.deepEqual(depthColor(2), [22, 124, 193]);
assert.deepEqual(depthColor(5), [77, 60, 180]);
assert.deepEqual(depthColor(10), [157, 39, 125]);

const tokyo = lonLatToWorldPixel(139.767, 35.681, 14);
const roundTrip = worldPixelToLonLat(tokyo.x, tokyo.y, 14);
assert.ok(Math.abs(roundTrip.longitude - 139.767) < 1e-9);
assert.ok(Math.abs(roundTrip.latitude - 35.681) < 1e-9);
assert.ok(metersPerPixel(35.681, 14) > 7);
assert.ok(metersPerPixel(35.681, 14) < 9);
assert.deepEqual(tileCoordinate(513.9), { tile: 2, pixel: 1 });

process.stdout.write("TERRAIN_ALGORITHM_TESTS_OK cases=20\n");
