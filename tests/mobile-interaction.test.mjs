import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { angleDelta, beginPinchGesture, classifyTwoFingerGesture, pinchZoomFromStart, pointerPairMetrics } from "../interaction.js";

function metricsForDistance(distance, x = 180, y = 260) {
  return pointerPairMetrics([
    { x: x - distance / 2, y },
    { x: x + distance / 2, y },
  ]);
}

const outward = Array.from({ length: 51 }, (_, index) => 100 + index * 2);
const outwardGesture = beginPinchGesture(metricsForDistance(outward[0]), 14);
const outwardZooms = outward.map((distance) =>
  pinchZoomFromStart(outwardGesture, metricsForDistance(distance), 5, 18));
assert.equal(outwardZooms[0], 14);
assert.equal(outwardZooms.at(-1), 15);
assert.ok(outward.slice(1).every((distance, index) => distance / outward[index] < 1.03));

const inward = Array.from({ length: 51 }, (_, index) => 200 - index * 2);
const inwardGesture = beginPinchGesture(metricsForDistance(inward[0]), 14);
const inwardZooms = inward.map((distance) =>
  pinchZoomFromStart(inwardGesture, metricsForDistance(distance), 5, 18));
assert.equal(inwardZooms[0], 14);
assert.equal(inwardZooms.at(-1), 13);
assert.ok(inward.slice(1).every((distance, index) => distance / inward[index] > 0.97));

const movedMidpoint = metricsForDistance(120, 42, 73);
assert.deepEqual(movedMidpoint, { distance: 120, x: 42, y: 73, angle: 0 });
assert.equal(pinchZoomFromStart(beginPinchGesture(metricsForDistance(100), 18), metricsForDistance(300), 5, 18), 18);
assert.equal(pinchZoomFromStart(beginPinchGesture(metricsForDistance(200), 5), metricsForDistance(50), 5, 18), 5);
assert.equal(pinchZoomFromStart(beginPinchGesture(metricsForDistance(100), 14), metricsForDistance(101), 5, 18), 14);
assert.equal(beginPinchGesture({ distance: 0, x: 0, y: 0 }, 14), null);

const startPoints = [{ x: 100, y: 200 }, { x: 200, y: 200 }];
const start = pointerPairMetrics(startPoints);
const twoFingerGesture = {
  ...beginPinchGesture(start, 14), startX: start.x, startY: start.y,
  startAngle: start.angle, startPoints,
};
const classify = (points) => classifyTwoFingerGesture(twoFingerGesture, pointerPairMetrics(points), points);
assert.equal(classify([{ x: 100, y: 180 }, { x: 200, y: 200 }]), null);
assert.equal(classify([{ x: 100, y: 170 }, { x: 200, y: 170 }]), "tilt");
assert.equal(classify([{ x: 100, y: 230 }, { x: 200, y: 230 }]), "tilt");
assert.equal(classify([{ x: 108, y: 180 }, { x: 192, y: 220 }]), "rotate");
assert.equal(classify([{ x: 75, y: 200 }, { x: 225, y: 200 }]), "pinch");
assert.equal(classify([{ x: 65, y: 200 }, { x: 165, y: 200 }]), "pan");
assert.equal(angleDelta(170, -170), 20);
assert.equal(angleDelta(-170, 170), -20);

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length);
for (const id of ["usageGuideLink", "settingsButton", "settingsPanel", "settingsCloseButton", "moreButton", "legendButton", "mobilePointSummary", "terrain3dCanvas", "compassButton", "threeDButton", "twoDButton"]) {
  assert.ok(ids.includes(id));
}
assert.ok(html.includes('content="width=device-width, initial-scale=1"'));
assert.ok(html.includes('href="./styles.css?v=20260924-1"'));
assert.ok(html.includes('id="threeDButton" type="button" aria-pressed="false"'));
const usageGuideLink = html.match(/<a\s+id="usageGuideLink"[\s\S]*?>使い方<\/a>/)?.[0] || "";
assert.ok(usageGuideLink.includes('href="https://bousai-wx-lab.com/terrain-depression-checker/"'));
assert.ok(usageGuideLink.includes('target="_blank"'));
assert.ok(usageGuideLink.includes('rel="noopener noreferrer"'));
assert.ok(!html.includes(">地形判読<"));
const radiusOptions = html.match(/<select id="radiusSelect">([\s\S]*?)<\/select>/)?.[1] || "";
const thresholdOptions = html.match(/<select id="thresholdSelect">([\s\S]*?)<\/select>/)?.[1] || "";
assert.match(radiusOptions, /<option value="1000" selected>1 km<\/option>/);
assert.match(radiusOptions, /<option value="5000">5 km<\/option>/);
assert.match(thresholdOptions, /<option value="0\.5" selected>0\.5 m以上<\/option>/);
assert.ok(html.includes('id="mapStampTitle">周囲より低い量（半径1km・着色0.5m以上）'));
assert.ok(!html.includes("user-scalable=no"));
assert.ok(!html.includes("maximum-scale=1"));
assert.ok(css.includes("--mobile-viewport-height"));
assert.ok(css.includes("100dvh"));
assert.ok(css.includes("safe-area-inset-bottom"));
assert.ok(css.includes(".tool-chip:focus-visible"));
assert.match(css, /\.tool-chip\s*\{[\s\S]*?min-height:\s*28px;[\s\S]*?padding:\s*5px 11px;[\s\S]*?font-size:\s*11px;/);
assert.ok(css.includes(".controls.is-open"));
assert.ok(css.includes("(max-width: 900px) and (max-height: 520px)"));
assert.ok(!css.includes("height: 590px"));
assert.ok(!css.includes("height: 620px"));
assert.ok(app.includes('pointercancel", (event) => finishPointer(event, { cancelled: true })'));
assert.ok(app.includes('lostpointercapture", (event) => finishPointer(event, { cancelled: true, releaseCapture: false })'));
assert.ok(app.includes('visibilitychange'));
assert.ok(app.includes('visualViewport?.addEventListener("resize"'));

process.stdout.write("MOBILE_INTERACTION_TESTS_OK slow_pinch_steps=102 bounds=2 midpoint=1 ui_contract=28\n");
