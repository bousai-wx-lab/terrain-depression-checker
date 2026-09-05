export const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
export const SPHERICAL_EARTH_RADIUS_METERS = 6371008.8;
export const TILE_SIZE = 256;
export const DEM_ZOOM = 15;
export const MAX_MAP_ZOOM = 18;
export const SHARE_STATE_VERSION = "1";
export const RING_SECTOR_COUNT = 16;
export const MIN_RING_COVERAGE_RATIO = 0.2;
export const MIN_RING_SECTORS = 4;
export const MIN_RING_QUADRANTS = 3;
export const MIN_RADIUS_SOURCE_PIXELS = 2;
export const TILE_MAX_ZOOM = Object.freeze({
  std: 18,
  pale: 18,
  relief: 15,
  hillshademap: 16,
});

const SHARE_RADIUS_VALUES = new Set([250, 500, 1000, 10000, 50000, 100000, 150000, 200000, 300000]);
const SHARE_THRESHOLD_VALUES = new Set([0.5, 1, 2, 5]);
const SHARE_BASE_MAP_VALUES = new Set(["std", "pale", "hillshademap"]);
const SHARE_TERRAIN_STYLE_VALUES = new Set(["color", "mono"]);

function finiteInRange(value, minimum, maximum) {
  if (value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function integerInRange(value, minimum, maximum) {
  if (value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function optionValue(value, allowed) {
  return allowed.has(value) ? value : null;
}

function opacityValue(value, minimum = 0, maximum = 100) {
  const number = integerInRange(value, minimum, maximum);
  return number !== null && number % 5 === 0 ? number : null;
}

export function parseShareState(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  if (params.get("v") !== SHARE_STATE_VERSION) return {};

  const parsed = {};
  const latitude = finiteInRange(params.get("lat"), 20, 48);
  const longitude = finiteInRange(params.get("lon"), 118, 154);
  if (latitude !== null && longitude !== null) {
    parsed.latitude = latitude;
    parsed.longitude = longitude;
  }

  const zoom = integerInRange(params.get("z"), 5, MAX_MAP_ZOOM);
  if (zoom !== null) parsed.zoom = zoom;

  const radius = optionValue(Number(params.get("radius")), SHARE_RADIUS_VALUES);
  if (radius !== null) parsed.radius = radius;
  const threshold = optionValue(Number(params.get("threshold")), SHARE_THRESHOLD_VALUES);
  if (threshold !== null) parsed.threshold = threshold;
  const baseMap = optionValue(params.get("base"), SHARE_BASE_MAP_VALUES);
  if (baseMap !== null) parsed.baseMap = baseMap;

  const baseMapOpacity = opacityValue(params.get("baseOpacity"));
  if (baseMapOpacity !== null) parsed.baseMapOpacity = baseMapOpacity;
  if (["0", "1"].includes(params.get("terrain"))) parsed.terrain = params.get("terrain") === "1";
  const terrainStyle = optionValue(params.get("terrainStyle"), SHARE_TERRAIN_STYLE_VALUES);
  if (terrainStyle !== null) parsed.terrainStyle = terrainStyle;
  const terrainOpacity = opacityValue(params.get("terrainOpacity"));
  if (terrainOpacity !== null) parsed.terrainOpacity = terrainOpacity;
  const depressionOpacity = opacityValue(params.get("depressionOpacity"), 20, 90);
  if (depressionOpacity !== null) parsed.depressionOpacity = depressionOpacity;
  if (["0", "1"].includes(params.get("centerMark"))) parsed.centerMark = params.get("centerMark") === "1";
  if (["0", "1"].includes(params.get("radiusGuide"))) parsed.radiusGuide = params.get("radiusGuide") === "1";

  const pointLatitude = finiteInRange(params.get("pointLat"), 20, 48);
  const pointLongitude = finiteInRange(params.get("pointLon"), 118, 154);
  if (pointLatitude !== null && pointLongitude !== null) {
    parsed.selectedPoint = { latitude: pointLatitude, longitude: pointLongitude };
  }
  return parsed;
}

export function serializeShareState(view) {
  const params = new URLSearchParams();
  params.set("v", SHARE_STATE_VERSION);
  params.set("lat", Number(view.latitude).toFixed(6));
  params.set("lon", Number(view.longitude).toFixed(6));
  params.set("z", String(Math.round(Number(view.zoom))));
  params.set("radius", String(Number(view.radius)));
  params.set("threshold", String(Number(view.threshold)));
  params.set("base", String(view.baseMap));
  params.set("baseOpacity", String(Math.round(Number(view.baseMapOpacity))));
  params.set("terrain", view.terrain ? "1" : "0");
  params.set("terrainStyle", String(view.terrainStyle));
  params.set("terrainOpacity", String(Math.round(Number(view.terrainOpacity))));
  params.set("depressionOpacity", String(Math.round(Number(view.depressionOpacity))));
  params.set("centerMark", view.centerMark ? "1" : "0");
  params.set("radiusGuide", view.radiusGuide ? "1" : "0");
  if (view.selectedPoint) {
    params.set("pointLat", Number(view.selectedPoint.latitude).toFixed(6));
    params.set("pointLon", Number(view.selectedPoint.longitude).toFixed(6));
  }
  return params.toString();
}

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

export function destinationPoint(longitude, latitude, distanceMeters, bearingRadians) {
  const angularDistance = Number(distanceMeters) / SPHERICAL_EARTH_RADIUS_METERS;
  const bearing = Number(bearingRadians);
  const latitude1 = clampLatitude(latitude) * Math.PI / 180;
  const longitude1 = Number(longitude) * Math.PI / 180;
  const latitude2 = Math.asin(
    Math.sin(latitude1) * Math.cos(angularDistance)
      + Math.cos(latitude1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const longitude2 = longitude1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude1),
    Math.cos(angularDistance) - Math.sin(latitude1) * Math.sin(latitude2),
  );
  return {
    longitude: ((longitude2 * 180 / Math.PI + 540) % 360) - 180,
    latitude: latitude2 * 180 / Math.PI,
  };
}

export function greatCircleDistanceMeters(first, second) {
  const latitude1 = Number(first.latitude) * Math.PI / 180;
  const latitude2 = Number(second.latitude) * Math.PI / 180;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = (Number(second.longitude) - Number(first.longitude)) * Math.PI / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return SPHERICAL_EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function ringSamplingSpec(radiusMeters, sourceResolutionMeters) {
  const radius = Math.max(1, Number(radiusMeters));
  const sourceResolution = Math.max(0.01, Number(sourceResolutionMeters));
  const targetArcSpacing = Math.max(sourceResolution * 4, radius / 96);
  const rawCount = Math.ceil(2 * Math.PI * radius / targetArcSpacing);
  const sampleCount = Math.max(96, Math.min(256, Math.ceil(rawCount / RING_SECTOR_COUNT) * RING_SECTOR_COUNT));
  return {
    sampleCount,
    sectorCount: RING_SECTOR_COUNT,
    minimumCoverageRatio: MIN_RING_COVERAGE_RATIO,
    minimumSectorCount: MIN_RING_SECTORS,
    minimumQuadrantCount: MIN_RING_QUADRANTS,
  };
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

export function calculateDirectionalRelativeDepth(centerElevation, surroundingElevations, specification) {
  if (!Number.isFinite(centerElevation)) return null;
  const sampleCount = surroundingElevations.length;
  const sectorCount = Number(specification?.sectorCount ?? RING_SECTOR_COUNT);
  if (!Number.isInteger(sectorCount) || sectorCount < 4 || sampleCount < sectorCount || sampleCount % sectorCount !== 0) {
    throw new RangeError("Directional ring samples must divide evenly into at least four sectors");
  }

  const samplesPerSector = sampleCount / sectorCount;
  const minimumPerSector = Math.max(2, Math.ceil(samplesPerSector * 0.25));
  const minimumCoverageRatio = Number(specification?.minimumCoverageRatio ?? MIN_RING_COVERAGE_RATIO);
  const minimumSectorCount = Number(specification?.minimumSectorCount ?? MIN_RING_SECTORS);
  const minimumQuadrantCount = Number(specification?.minimumQuadrantCount ?? MIN_RING_QUADRANTS);
  const sectorMeans = [];
  const quadrantIndexes = new Set();
  let validCount = 0;
  let usableSampleCount = 0;

  for (let sector = 0; sector < sectorCount; sector += 1) {
    let sectorSum = 0;
    let sectorValid = 0;
    const start = sector * samplesPerSector;
    for (let offset = 0; offset < samplesPerSector; offset += 1) {
      const elevation = surroundingElevations[start + offset];
      if (!Number.isFinite(elevation)) continue;
      sectorSum += elevation;
      sectorValid += 1;
      validCount += 1;
    }
    if (sectorValid < minimumPerSector) continue;
    sectorMeans.push(sectorSum / sectorValid);
    usableSampleCount += sectorValid;
    quadrantIndexes.add(Math.min(3, Math.floor(sector * 4 / sectorCount)));
  }

  const coverageRatio = usableSampleCount / sampleCount;
  if (
    coverageRatio < minimumCoverageRatio
    || sectorMeans.length < minimumSectorCount
    || quadrantIndexes.size < minimumQuadrantCount
  ) return null;

  const surroundingMean = sectorMeans.reduce((sum, value) => sum + value, 0) / sectorMeans.length;
  return {
    center: centerElevation,
    surroundingMean,
    depth: surroundingMean - centerElevation,
    sampleCount: validCount,
    usableSampleCount,
    sampleCapacity: sampleCount,
    coverageRatio,
    sectorCount: sectorMeans.length,
    quadrantCount: quadrantIndexes.size,
  };
}

export function elevationDifference(centerElevation, surroundingMean) {
  if (!Number.isFinite(centerElevation) || !Number.isFinite(surroundingMean)) return null;
  return Number(centerElevation) - Number(surroundingMean);
}

export function depthColor(depth) {
  if (!Number.isFinite(depth) || depth < 0.5) return null;
  if (depth < 1) return [102, 211, 242];
  if (depth < 1.5) return [69, 191, 234];
  if (depth < 2) return [42, 165, 220];
  if (depth < 3) return [22, 124, 193];
  if (depth < 4) return [49, 95, 184];
  if (depth < 5) return [77, 73, 181];
  if (depth < 10) return [107, 56, 166];
  return [157, 39, 125];
}

export function tileCoordinate(worldPixel) {
  const tile = Math.floor(Number(worldPixel) / TILE_SIZE);
  const pixel = Math.floor(Number(worldPixel) - tile * TILE_SIZE);
  return { tile, pixel };
}
