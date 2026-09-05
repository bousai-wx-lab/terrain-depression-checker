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
  };
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
