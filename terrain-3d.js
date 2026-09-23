import * as maplibregl from "./vendor/maplibre/maplibre-gl.mjs";
import { decodeElevationRgb, destinationPoint, lonLatToWorldPixel, worldPixelToLonLat } from "./terrain.js?v=20260923-2";

const GSI = "https://cyberjapandata.gsi.go.jp/xyz";
const SIZE = 256;
export function normalizeBearing(value) {
  return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

async function demPixels(name, z, x, y, signal) {
  const response = await fetch(`${GSI}/${name}/${z}/${x}/${y}.png`, {
    credentials: "omit", referrerPolicy: "no-referrer", signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`標高タイル ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, SIZE, SIZE).data;
}

function elevationAt(pixels, index) {
  if (!pixels || !pixels[index * 4 + 3]) return null;
  return decodeElevationRgb(pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]);
}

async function terrainTile(request, abortController) {
  const match = /^gsidem:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
  if (!match) throw new Error("標高タイルの座標が不正です");
  const z = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
  const signal = abortController.signal;
  const pixels = await demPixels("dem_png", z, x, y, signal);
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext("2d");
  const image = context.createImageData(SIZE, SIZE);
  for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
    const i = row * SIZE + col;
    const elevation = elevationAt(pixels, i);
    // Missing DEM stays visually flat; analysis missing-data rules remain separate.
    const encoded = Math.max(0, Math.min(0xffffff, Math.round(((elevation ?? 0) + 10000) * 10)));
    image.data[i * 4] = encoded >> 16;
    image.data[i * 4 + 1] = (encoded >> 8) & 255;
    image.data[i * 4 + 2] = encoded & 255;
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return { data: await createImageBitmap(canvas) };
}

maplibregl.setWorkerUrl(new URL("./vendor/maplibre/maplibre-gl-worker.mjs", import.meta.url).href);
maplibregl.addProtocol("gsidem", terrainTile);

const raster = (name, maxzoom) => ({
  type: "raster", tiles: [`${GSI}/${name}/{z}/{x}/{y}.png`], tileSize: 256,
  minzoom: 0, maxzoom, attribution: "国土地理院「地理院タイル」",
});
function style() {
  return { version: 8, sources: {
    std: raster("std", 18), pale: raster("pale", 18),
    hillshademap: raster("hillshademap", 16), relief: raster("relief", 15),
    elevation: { type: "raster-dem", tiles: ["gsidem://{z}/{x}/{y}"], tileSize: 256,
      minzoom: 0, maxzoom: 14, encoding: "mapbox" },
  }, layers: [
    { id: "base-std", type: "raster", source: "std" },
    { id: "base-pale", type: "raster", source: "pale", layout: { visibility: "none" } },
    { id: "base-hillshademap", type: "raster", source: "hillshademap", layout: { visibility: "none" } },
    { id: "relief-color", type: "raster", source: "relief" },
    { id: "relief-mono", type: "raster", source: "hillshademap", layout: { visibility: "none" } },
  ] };
}

function overlayCoordinates(longitude, latitude, zoom, width, height) {
  const center = lonLatToWorldPixel(longitude, latitude, zoom);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => {
    const p = worldPixelToLonLat(center.x + dx * width / 2, center.y + dy * height / 2, zoom);
    return [p.longitude, p.latitude];
  });
}

export class Terrain3DRenderer {
  constructor(container, view, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.overlay = document.createElement("canvas");
    this.loaded = false;
    this.options = null;
    this.map = new maplibregl.Map({
      container, style: style(), center: [view.longitude, view.latitude], zoom: view.zoom,
      pitch: view.pitch, bearing: view.bearing, minZoom: 5, maxZoom: 18, maxPitch: 70,
      maxBounds: [[118, 20], [154, 48]], preserveDrawingBuffer: true,
      attributionControl: false, maplibreLogo: false, aroundCenter: false,
      pitchWithRotate: true, touchPitch: true, touchZoomRotate: true, zoomSnap: 1,
    });
    this.map.on("load", () => {
      this.loaded = true;
      this.map.setTerrain({ source: "elevation", exaggeration: 1 });
      this.map.addSource("radius-guide", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      this.map.addLayer({ id: "radius-guide-halo", type: "line", source: "radius-guide",
        paint: { "line-color": "#ffffff", "line-width": 5, "line-dasharray": [2, 2] } });
      this.map.addLayer({ id: "radius-guide-line", type: "line", source: "radius-guide",
        paint: { "line-color": "#07507e", "line-width": 2, "line-dasharray": [2, 2] } });
      this.syncOptions(this.options);
      if (this.pendingOverlay) this.updateOverlay(...this.pendingOverlay);
    });
    this.map.on("move", () => {
      this.callbacks.onMove?.(this.camera());
      this.updateGuide();
    });
    this.map.on("moveend", () => this.callbacks.onMoveEnd?.(this.camera()));
    this.map.on("click", (event) => this.callbacks.onPick?.(event.lngLat));
    this.map.on("error", (event) => this.callbacks.onError?.(event.error));
  }

  camera() {
    const center = this.map.getCenter();
    return { longitude: center.lng, latitude: center.lat, zoom: this.map.getZoom(),
      pitch: this.map.getPitch(), bearing: this.map.getBearing() };
  }
  setOrientation(pitch, bearing) { this.map.jumpTo({ pitch, bearing }); }
  setZoom(zoom) { this.map.zoomTo(zoom, { duration: 180 }); }
  setCenter(longitude, latitude) { this.map.jumpTo({ center: [longitude, latitude] }); }
  resize() { this.map.resize(); }
  getCanvas() { return this.map.getCanvas(); }
  clearGeometry() { /* Retain the geo-referenced overlay until its replacement is ready. */ }
  pick(x, y) {
    const p = this.map.unproject([x, y]);
    return { longitude: p.lng, latitude: p.lat };
  }

  syncOptions(options) {
    if (!options) return;
    this.options = options;
    if (!this.loaded) return;
    for (const name of ["std", "pale", "hillshademap"]) {
      this.map.setLayoutProperty(`base-${name}`, "visibility", options.baseMap === name ? "visible" : "none");
      this.map.setPaintProperty(`base-${name}`, "raster-opacity", options.baseMapOpacity);
    }
    for (const [name, active] of [["color", options.terrainStyle === "color"], ["mono", options.terrainStyle === "mono"]]) {
      this.map.setLayoutProperty(`relief-${name}`, "visibility", options.terrain && active ? "visible" : "none");
      this.map.setPaintProperty(`relief-${name}`, "raster-opacity", options.terrainOpacity);
    }
    if (this.map.getLayer("depression-overlay")) this.map.setPaintProperty("depression-overlay", "raster-opacity", options.depressionOpacity);
    this.updateGuide();
  }

  updateGuide() {
    if (!this.loaded || !this.options) return;
    const source = this.map.getSource("radius-guide");
    if (!source) return;
    const center = this.map.getCenter();
    const coordinates = [];
    if (this.options.radiusGuide) for (let i = 0; i <= 96; i++) {
      const p = destinationPoint(center.lng, center.lat, this.options.radius, i * 2 * Math.PI / 96);
      coordinates.push([p.longitude, p.latitude]);
    }
    source.setData({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} });
    this.container.classList.toggle("show-center-cross", this.options.centerMark);
  }

  updateOverlay(result, longitude, latitude, zoom, width, height) {
    this.pendingOverlay = [result, longitude, latitude, zoom, width, height];
    if (!this.loaded || !result?.overlay) return;
    this.overlay.width = result.overlay.width;
    this.overlay.height = result.overlay.height;
    const context = this.overlay.getContext("2d");
    context.clearRect(0, 0, this.overlay.width, this.overlay.height);
    context.drawImage(result.overlay, 0, 0);
    // The detailed comparison has finite coverage. Fade only its outer edge
    // so the continuous basemap remains visible without a rectangular seam.
    context.save();
    context.globalCompositeOperation = "destination-in";
    for (const horizontal of [true, false]) {
      const length = horizontal ? this.overlay.width : this.overlay.height;
      const gradient = horizontal
        ? context.createLinearGradient(0, 0, length, 0)
        : context.createLinearGradient(0, 0, 0, length);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(0.12, "rgba(0,0,0,1)");
      gradient.addColorStop(0.88, "rgba(0,0,0,1)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, this.overlay.width, this.overlay.height);
    }
    context.restore();
    const coordinates = overlayCoordinates(longitude, latitude, zoom, width, height);
    const source = this.map.getSource("depression-overlay");
    if (source) source.setCoordinates(coordinates);
    else {
      this.map.addSource("depression-overlay", { type: "canvas", canvas: this.overlay, coordinates, animate: true });
      this.map.addLayer({ id: "depression-overlay", type: "raster", source: "depression-overlay",
        paint: { "raster-opacity": this.options?.depressionOpacity ?? 0.65, "raster-resampling": "nearest" } }, "radius-guide-halo");
    }
    this.map.triggerRepaint();
  }
}
