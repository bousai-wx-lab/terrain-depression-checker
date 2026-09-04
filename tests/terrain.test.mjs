import assert from "node:assert/strict";
import {
  MAX_MAP_ZOOM,
  TILE_MAX_ZOOM,
  analysisSourceZoom,
  calculateRelativeDepth,
  decodeElevationRgb,
  depthColor,
  elevationDifference,
  lonLatToWorldPixel,
  metersPerPixel,
  minimumRingSamples,
  parseShareState,
  scaleBarSpec,
  serializeShareState,
  tileCoordinate,
  tileSourceZoom,
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
assert.equal(elevationDifference(8, 10), -2);
assert.equal(elevationDifference(12, 10), 2);
assert.equal(elevationDifference(10, 10), 0);
assert.equal(elevationDifference(Number.NaN, 10), null);

assert.equal(depthColor(0.49), null);
assert.deepEqual(depthColor(0.5), [102, 211, 242]);
assert.deepEqual(depthColor(0.99), [102, 211, 242]);
assert.deepEqual(depthColor(1), [69, 191, 234]);
assert.deepEqual(depthColor(1.5), [42, 165, 220]);
assert.deepEqual(depthColor(2), [22, 124, 193]);
assert.deepEqual(depthColor(3), [49, 95, 184]);
assert.deepEqual(depthColor(4), [77, 73, 181]);
assert.deepEqual(depthColor(5), [107, 56, 166]);
assert.deepEqual(depthColor(10), [157, 39, 125]);

const tokyo = lonLatToWorldPixel(139.767, 35.681, 14);
const roundTrip = worldPixelToLonLat(tokyo.x, tokyo.y, 14);
assert.ok(Math.abs(roundTrip.longitude - 139.767) < 1e-9);
assert.ok(Math.abs(roundTrip.latitude - 35.681) < 1e-9);
assert.ok(metersPerPixel(35.681, 14) > 7);
assert.ok(metersPerPixel(35.681, 14) < 9);
assert.deepEqual(tileCoordinate(513.9), { tile: 2, pixel: 1 });

assert.equal(MAX_MAP_ZOOM, 18);
assert.equal(TILE_MAX_ZOOM.std, 18);
assert.equal(TILE_MAX_ZOOM.pale, 18);
assert.equal(tileSourceZoom("std", 18), 18);
assert.equal(tileSourceZoom("pale", 22), 18);
assert.equal(tileSourceZoom("relief", 18), 15);
assert.equal(tileSourceZoom("hillshademap", 18), 16);
assert.throws(() => tileSourceZoom("unknown", 18), RangeError);

assert.equal(analysisSourceZoom(5), 5);
assert.equal(analysisSourceZoom(12), 12);
assert.equal(analysisSourceZoom(14), 14);
assert.equal(analysisSourceZoom(18), 14);

const scaleAtZoom14 = scaleBarSpec(35.681, 14, 120);
assert.equal(scaleAtZoom14.label, "500 m");
assert.ok(scaleAtZoom14.pixels >= 60 && scaleAtZoom14.pixels <= 120);
const scaleAtZoom5 = scaleBarSpec(35.681, 5, 120);
assert.equal(scaleAtZoom5.label, "200 km");
assert.ok(scaleAtZoom5.pixels >= 40 && scaleAtZoom5.pixels <= 120);
assert.equal(minimumRingSamples(500), 10);
assert.equal(minimumRingSamples(10000), 6);
assert.equal(minimumRingSamples(50000), 4);
assert.equal(minimumRingSamples(300000), 4);

const shareQuery = serializeShareState({
  latitude: 35.681234,
  longitude: 139.767456,
  zoom: 18,
  radius: 300000,
  threshold: 0.5,
  baseMap: "pale",
  baseMapOpacity: 45,
  terrain: false,
  terrainStyle: "color",
  terrainOpacity: 70,
  depressionOpacity: 90,
  centerMark: true,
  radiusGuide: true,
  selectedPoint: { latitude: 35.68, longitude: 139.77 },
});
const parsedShare = parseShareState(shareQuery);
assert.equal(parsedShare.latitude, 35.681234);
assert.equal(parsedShare.longitude, 139.767456);
assert.equal(parsedShare.zoom, 18);
assert.equal(parsedShare.radius, 300000);
assert.equal(parsedShare.threshold, 0.5);
assert.equal(parsedShare.baseMap, "pale");
assert.equal(parsedShare.baseMapOpacity, 45);
assert.equal(parsedShare.terrain, false);
assert.equal(parsedShare.terrainStyle, "color");
assert.equal(parsedShare.terrainOpacity, 70);
assert.equal(parsedShare.depressionOpacity, 90);
assert.equal(parsedShare.centerMark, true);
assert.equal(parsedShare.radiusGuide, true);
assert.deepEqual(parsedShare.selectedPoint, { latitude: 35.68, longitude: 139.77 });

const invalidShare = parseShareState("?v=1&lat=90&lon=200&z=99&radius=7&threshold=99&base=evil&baseOpacity=41&terrain=yes&terrainStyle=other&terrainOpacity=-5&depressionOpacity=100&centerMark=yes&radiusGuide=2");
assert.deepEqual(invalidShare, {});
assert.deepEqual(parseShareState("?v=1&centerMark=0&radiusGuide=0"), { centerMark: false, radiusGuide: false });
assert.deepEqual(parseShareState("?v=1"), {});
assert.deepEqual(parseShareState("?lat=35&lon=139&z=14"), {});

process.stdout.write("TERRAIN_ALGORITHM_TESTS_OK cases=51\nSHARE_STATE_TESTS_OK cases=18\n");
