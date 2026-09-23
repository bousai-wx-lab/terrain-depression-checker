export function pointerPairMetrics(points) {
  const values = Array.from(points);
  if (values.length < 2) return null;
  const [first, second] = values;
  const distance = Math.hypot(second.x - first.x, second.y - first.y);
  if (!Number.isFinite(distance)) return null;
  return {
    distance,
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    angle: Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI,
  };
}

export function angleDelta(from, to) {
  return ((to - from + 180) % 360 + 360) % 360 - 180;
}

export function classifyTwoFingerGesture(gesture, metrics, points) {
  if (!gesture || !metrics || points.length < 2) return null;
  const [first, second] = points;
  const [startFirst, startSecond] = gesture.startPoints;
  const firstX = first.x - startFirst.x, firstY = first.y - startFirst.y;
  const secondX = second.x - startSecond.x, secondY = second.y - startSecond.y;
  const bothMoved = Math.hypot(firstX, firstY) >= 6 && Math.hypot(secondX, secondY) >= 6;
  const twist = Math.abs(angleDelta(gesture.startAngle, metrics.angle));
  const distanceChange = Math.abs(Math.log(metrics.distance / gesture.startDistance));
  const x = metrics.x - gesture.startX, y = metrics.y - gesture.startY;
  if (distanceChange >= Math.log(1.08)) return "pinch";
  if (twist >= 12 && (bothMoved || twist >= 25)) return "rotate";
  if (bothMoved && Math.sign(firstY) === Math.sign(secondY) &&
      Math.min(Math.abs(firstY), Math.abs(secondY)) >= 8 &&
      Math.abs(y) >= 12 && Math.abs(y) > Math.abs(x) * 1.2) return "tilt";
  if (bothMoved && Math.hypot(x, y) >= 12) return "pan";
  return null;
}

export function beginPinchGesture(metrics, zoom) {
  if (!metrics || !Number.isFinite(metrics.distance) || metrics.distance <= 0) return null;
  return {
    kind: "pinch",
    startDistance: metrics.distance,
    startZoom: zoom,
    x: metrics.x,
    y: metrics.y,
  };
}

export function pinchZoomFromStart(gesture, metrics, minimumZoom, maximumZoom) {
  if (!gesture || gesture.kind !== "pinch" || !metrics || metrics.distance <= 0) return null;
  const distanceRatio = metrics.distance / gesture.startDistance;
  const zoomDelta = Math.round(Math.log2(distanceRatio));
  return Math.max(minimumZoom, Math.min(maximumZoom, gesture.startZoom + zoomDelta));
}
