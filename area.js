import { SPHERICAL_EARTH_RADIUS_METERS, lonLatToWorldPixel, worldPixelToLonLat, metersPerPixel } from './terrain.js';

export const AREA_TILE_SIZE = 128;
export const MAX_PREFIX_CELLS = 8_500_000;
export const MIN_RADIUS_PIXELS = 8;
const R = SPHERICAL_EARTH_RADIUS_METERS;
const RAD = Math.PI / 180;

export function latitudeAt(y, zoom) {
  return Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / (256 * 2 ** zoom)));
}

export function areaBounds(longitude, latitude, viewZoom, zoom, radius, width, height, tileSize = AREA_TILE_SIZE) {
  const center = lonLatToWorldPixel(longitude, latitude, zoom);
  const ratio = 2 ** (zoom - viewZoom), delta = radius / R;
  const north = latitudeAt(center.y - height * ratio / 2, zoom);
  const south = latitudeAt(center.y + height * ratio / 2, zoom);
  const reach = Math.asin(Math.min(1, Math.sin(delta) / Math.cos(Math.max(Math.abs(north), Math.abs(south))))) / (2 * Math.PI) * 256 * 2 ** zoom;
  const top = lonLatToWorldPixel(longitude, Math.min(84, (north + delta) / RAD), zoom).y;
  const bottom = lonLatToWorldPixel(longitude, Math.max(-84, (south - delta) / RAD), zoom).y;
  const x0 = Math.floor((center.x - width * ratio / 2 - reach - 2) / tileSize) * tileSize;
  const x1 = Math.ceil((center.x + width * ratio / 2 + reach + 2) / tileSize) * tileSize;
  const y0 = Math.floor((top - 2) / tileSize) * tileSize;
  const y1 = Math.ceil((bottom + 2) / tileSize) * tileSize;
  return { zoom, x0, y0, width: x1 - x0, height: y1 - y0, center, ratio };
}

export function chooseAreaPlan(view) {
  const { longitude, latitude, zoom: viewZoom, radius, width, height } = view;
  const stored = radius >= 50000;
  const maximum = stored ? (radius >= 200000 ? 8 : radius >= 100000 ? 9 : 10) : radius >= 10000 ? 12 : 15;
  for (let zoom = Math.min(maximum, viewZoom + 1); zoom >= 5; zoom--) {
    const bounds = areaBounds(longitude, latitude, viewZoom, zoom, radius, width, height, stored ? 128 : 256);
    const tiles = bounds.width * bounds.height / (256 * 256);
    if (bounds.width * bounds.height <= MAX_PREFIX_CELLS && (stored || tiles <= 72)) {
      return { ...bounds, stored, sourceResolution: metersPerPixel(latitude, zoom),
        usable: radius / metersPerPixel(latitude, zoom) >= MIN_RADIUS_PIXELS };
    }
  }
  return { usable: false };
}

export function allocatePrefix(bounds) {
  const stride = bounds.width + 1;
  return { ...bounds, stride, sums: new Float64Array(stride * bounds.height),
    areas: new Float64Array(stride * bounds.height), weights: new Float64Array(bounds.height) };
}

export function finishPrefix(p) {
  for (let row = 0; row < p.height; row++) {
    p.weights[row] = Math.sin(latitudeAt(p.y0 + row, p.zoom)) - Math.sin(latitudeAt(p.y0 + row + 1, p.zoom));
    let sum = 0, area = 0;
    const offset = row * p.stride;
    for (let x = 1; x <= p.width; x++) {
      sum += p.sums[offset + x]; area += p.areas[offset + x];
      p.sums[offset + x] = sum; p.areas[offset + x] = area;
    }
  }
  return p;
}

export function diskRows(p, centerY, radius) {
  const phi = latitudeAt(centerY, p.zoom), delta = radius / R, n = 256 * 2 ** p.zoom;
  const top = lonLatToWorldPixel(0, (phi + delta) / RAD, p.zoom).y;
  const bottom = lonLatToWorldPixel(0, (phi - delta) / RAD, p.zoom).y;
  const first = Math.ceil(top - p.y0 - .5), last = Math.floor(bottom - p.y0 - .5);
  if (first < 0 || last >= p.height) return null;
  const sinHalf = Math.sin(delta / 2) ** 2, cosPhi = Math.cos(phi), rows = [];
  for (let row = first; row <= last; row++) {
    const rowPhi = latitudeAt(p.y0 + row + .5, p.zoom);
    const q = (sinHalf - Math.sin((rowPhi - phi) / 2) ** 2) / (cosPhi * Math.cos(rowPhi));
    if (q < 0) continue;
    const dx = Math.asin(Math.sqrt(Math.min(1, q))) / Math.PI * n;
    rows.push({ row, dx, offset: row * p.stride, weight: p.weights[row] });
  }
  return rows;
}

// Discrete source cells are selected by their centers. Every selected cell's
// complete land fraction contributes; there is no directional sampling.
export function queryDisk(p, worldX, rows) {
  if (!rows) return null;
  let sum = 0, area = 0, full = 0;
  const x = worldX - p.x0 - .5;
  for (const row of rows) {
    const left = Math.ceil(x - row.dx), right = Math.floor(x + row.dx) + 1;
    if (left < 0 || right > p.width) return null;
    if (right <= left) continue;
    sum += (p.sums[row.offset + right] - p.sums[row.offset + left]) * row.weight;
    area += (p.areas[row.offset + right] - p.areas[row.offset + left]) * row.weight;
    full += (right - left) * row.weight;
  }
  if (!(area > 0)) return null;
  return { mean: sum / area, landFraction: area / full };
}

export function calculateAreaRow(p, worldXs, worldY, radius) {
  const rows = diskRows(p, worldY, radius), count = worldXs.length;
  const sums = new Float64Array(count), areas = new Float64Array(count), full = new Float64Array(count);
  const means = new Float32Array(count), fractions = new Float32Array(count);
  const invalid = new Uint8Array(count);
  means.fill(NaN);
  if (!rows) return { means, fractions };
  for (const row of rows) {
    for (let x = 0; x < count; x++) {
      const center = worldXs[x] - p.x0 - .5;
      const left = Math.ceil(center - row.dx), right = Math.floor(center + row.dx) + 1;
      if (left < 0 || right > p.width) { invalid[x] = 1; continue; }
      if (right <= left) continue;
      sums[x] += (p.sums[row.offset + right] - p.sums[row.offset + left]) * row.weight;
      areas[x] += (p.areas[row.offset + right] - p.areas[row.offset + left]) * row.weight;
      full[x] += (right - left) * row.weight;
    }
  }
  for (let x = 0; x < count; x++) if (areas[x] > 0 && !invalid[x]) {
    means[x] = sums[x] / areas[x]; fractions[x] = areas[x] / full[x];
  }
  return { means, fractions };
}

export function positionInsideAnalysis(longitude, latitude) {
  return longitude >= 118 && longitude <= 154 && latitude >= 20 && latitude <= 48;
}

export function gridPositions(view, step) {
  const center = lonLatToWorldPixel(view.longitude, view.latitude, view.zoom);
  const columns = Math.ceil(view.width / step), rows = Math.ceil(view.height / step);
  const xs = Float64Array.from({ length: columns }, (_, x) => center.x + Math.min(view.width - .5, x * step + step / 2) - view.width / 2);
  const ys = Float64Array.from({ length: rows }, (_, y) => center.y + Math.min(view.height - .5, y * step + step / 2) - view.height / 2);
  return { columns, rows, xs, ys, center };
}

export { worldPixelToLonLat };
