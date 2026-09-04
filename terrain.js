export const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
export const TILE_SIZE = 256;
export const DEM_ZOOM = 14;
export const MAX_MAP_ZOOM = 18;
export const TILE_MAX_ZOOM = Object.freeze({
  std: 18,
  pale: 18,
  relief: 15,
  hillshademap: 16,
});

export function analysisSourceZoom(viewZoom) {
  const zoom = Math.max(1, Math.round(Number(viewZoom)));
  return Math.min(DEM_ZOOM, zoom);
}

export function scaleBarSpec(latitude, zoom, maxWidth = 120) {
  const metersPerCssPixel = metersPerPixel(latitude, zoom);
  const maximumDistance = metersPerCssPixel * Math.max(1, Number(maxWidth));
  const magnitude = 10 ** Math.floor(Math.log10(maximumDistance));
  const candidates = [5, 2, 1].map((value) => value * magnitude);
  const meters = candidates.find((value) => value <= maximumDistance) ?? magnitude;
  const pixels = meters / metersPerCssPixel;
  const label = meters >= 1000
    ? `${Number((meters / 1000).toPrecision(3))} km`
    : `${Number(meters.toPrecision(3))} m`;
  return { meters, pixels, label };
}

export function minimumRingSamples(radiusMeters) {
  const radius = Number(radiusMeters);
  if (radius >= 50000) return 4;
  if (radius >= 10000) return 6;
  return 10;
}

export function tileSourceZoom(layer, requestedZoom) {
  if (!Object.hasOwn(TILE_MAX_ZOOM, layer)) throw new RangeError(`Unknown tile layer: ${layer}`);
  const zoom = Math.max(0, Math.round(Number(requestedZoom)));
  return Math.min(TILE_MAX_ZOOM[layer], zoom);
}

export function clampLatitude(latitude) {
  return Math.max(-85.05112878, Math.min(85.05112878, Number(latitude)));
}

export function lonLatToWorldPixel(longitude, latitude, zoom) {
  const scale = TILE_SIZE * (2 ** zoom);
  const lon = Number(longitude);
  const lat = clampLatitude(latitude) * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale,
  };
}

export function worldPixelToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * (2 ** zoom);
  const longitude = Number(x) / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * Number(y) / scale;
  const latitude = 180 / Math.PI * Math.atan(Math.sinh(n));
  return { longitude, latitude };
}

export function metersPerPixel(latitude, zoom) {
  const lat = clampLatitude(latitude) * Math.PI / 180;
  return Math.cos(lat) * EARTH_CIRCUMFERENCE_METERS / (TILE_SIZE * (2 ** zoom));
}

export function decodeElevationRgb(red, green, blue) {
  const value = (Number(red) << 16) + (Number(green) << 8) + Number(blue);
  if (value === 2 ** 23) return null;
  return (value < 2 ** 23 ? value : value - 2 ** 24) * 0.01;
}

export function calculateRelativeDepth(centerElevation, surroundingElevations, minimumValid = 10) {
  if (!Number.isFinite(centerElevation)) return null;
  const valid = surroundingElevations.filter(Number.isFinite);
  if (valid.length < minimumValid) return null;
  const surroundingMean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return {
    center: centerElevation,
    surroundingMean,
    depth: surroundingMean - centerElevation,
    sampleCount: valid.length,
  };
}

export function depthColor(depth) {
  if (!Number.isFinite(depth) || depth < 0.5) return null;
  if (depth < 2) return [87, 200, 242];
  if (depth < 5) return [22, 124, 193];
  if (depth < 10) return [77, 60, 180];
  return [157, 39, 125];
}

export function tileCoordinate(worldPixel) {
  const tile = Math.floor(Number(worldPixel) / TILE_SIZE);
  const pixel = Math.floor(Number(worldPixel) - tile * TILE_SIZE);
  return { tile, pixel };
}
