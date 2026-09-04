import {
  DEM_ZOOM,
  MAX_MAP_ZOOM,
  TILE_SIZE,
  analysisSourceZoom,
  calculateRelativeDepth,
  decodeElevationRgb,
  depthColor,
  lonLatToWorldPixel,
  metersPerPixel,
  minimumRingSamples,
  parseShareState,
  scaleBarSpec,
  serializeShareState,
  tileCoordinate,
  tileSourceZoom,
  worldPixelToLonLat,
} from "./terrain.js?v=20260905-1";

const GSI_ORIGIN = "https://cyberjapandata.gsi.go.jp";
const DEM_SOURCES = ["dem5a_png", "dem5b_png", "dem5c_png", "dem_png"];
const INITIAL_VIEW = Object.freeze({ longitude: 139.767, latitude: 35.681, zoom: 14 });
const MIN_ZOOM = 5;
const MAX_ZOOM = MAX_MAP_ZOOM;
const MAX_DEM_TILES = 72;
const MAP_TILE_CACHE_LIMIT = 120;
const DEM_TILE_CACHE_LIMIT = 80;
const RING_SAMPLE_COUNT = 16;

const elements = {
  canvasWrap: document.querySelector("#canvasWrap"),
  canvas: document.querySelector("#mapCanvas"),
  radius: document.querySelector("#radiusSelect"),
  threshold: document.querySelector("#thresholdSelect"),
  baseMap: document.querySelector("#baseMapSelect"),
  baseMapOpacity: document.querySelector("#baseMapOpacityRange"),
  baseMapOpacityValue: document.querySelector("#baseMapOpacityValue"),
  terrainToggle: document.querySelector("#terrainToggle"),
  terrainStyle: document.querySelector("#terrainStyleSelect"),
  terrainOpacity: document.querySelector("#terrainOpacityRange"),
  terrainOpacityValue: document.querySelector("#terrainOpacityValue"),
  opacity: document.querySelector("#opacityRange"),
  opacityValue: document.querySelector("#opacityValue"),
  zoomIn: document.querySelector("#zoomInButton"),
  zoomOut: document.querySelector("#zoomOutButton"),
  fit: document.querySelector("#fitButton"),
  zoomThumb: document.querySelector("#zoomThumb"),
  stampTitle: document.querySelector("#mapStampTitle"),
  stampStatus: document.querySelector("#mapStampStatus"),
  loading: document.querySelector("#loadingPanel"),
  tooltip: document.querySelector("#tooltip"),
  elevation: document.querySelector("#elevationValue"),
  surrounding: document.querySelector("#surroundingValue"),
  depth: document.querySelector("#depthValue"),
  coordinate: document.querySelector("#coordinateValue"),
  scale: document.querySelector("#mapScale"),
  scaleLabel: document.querySelector("#mapScaleLabel"),
  scaleLine: document.querySelector("#mapScaleLine"),
  copyLink: document.querySelector("#copyLinkButton"),
  copyLinkLabel: document.querySelector("#copyLinkLabel"),
  download: document.querySelector("#downloadButton"),
  downloadLabel: document.querySelector("#downloadLabel"),
  shareStatus: document.querySelector("#shareActionStatus"),
};

const context = elements.canvas.getContext("2d", { alpha: false });
const state = {
  longitude: INITIAL_VIEW.longitude,
  latitude: INITIAL_VIEW.latitude,
  zoom: INITIAL_VIEW.zoom,
  deviceScale: 1,
  mapTiles: new Map(),
  demTiles: new Map(),
  analysis: null,
  analysisSequence: 0,
  analyzeTimer: 0,
  drawPending: false,
  pointers: new Map(),
  gesture: null,
  moved: false,
  downPoint: null,
  selectedPoint: null,
};

function canvasCssSize() {
  const rect = elements.canvas.getBoundingClientRect();
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

function resizeCanvas() {
  const { width, height } = canvasCssSize();
  const deviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const nextWidth = Math.round(width * deviceScale);
  const nextHeight = Math.round(height * deviceScale);
  if (elements.canvas.width === nextWidth && elements.canvas.height === nextHeight) return;
  elements.canvas.width = nextWidth;
  elements.canvas.height = nextHeight;
  state.deviceScale = deviceScale;
  invalidateAnalysis("画面サイズが変わりました", { preserveSelection: true });
}

function currentCenterWorld(zoom = state.zoom) {
  return lonLatToWorldPixel(state.longitude, state.latitude, zoom);
}

function cssPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function cssToLonLat(x, y, zoom = state.zoom) {
  const size = canvasCssSize();
  const center = currentCenterWorld(zoom);
  return worldPixelToLonLat(center.x + x - size.width / 2, center.y + y - size.height / 2, zoom);
}

function clampView() {
  state.longitude = Math.max(118, Math.min(154, state.longitude));
  state.latitude = Math.max(20, Math.min(48, state.latitude));
}

function updateZoomControl() {
  const ratio = (state.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM);
  elements.zoomThumb.style.setProperty("--thumb-top", `${62 - ratio * 48}px`);
  elements.zoomIn.disabled = state.zoom >= MAX_ZOOM;
  elements.zoomOut.disabled = state.zoom <= MIN_ZOOM;
}

function updateScaleBar() {
  const spec = scaleBarSpec(state.latitude, state.zoom, canvasCssSize().width <= 520 ? 90 : 120);
  elements.scaleLabel.textContent = spec.label;
  elements.scaleLine.style.width = `${Math.round(spec.pixels)}px`;
  elements.scale.setAttribute("aria-label", `縮尺 ${spec.label}`);
}

function applySharedViewState() {
  const shared = parseShareState(window.location.search);
  if (Number.isFinite(shared.longitude) && Number.isFinite(shared.latitude)) {
    state.longitude = shared.longitude;
    state.latitude = shared.latitude;
  }
  if (Number.isInteger(shared.zoom)) state.zoom = shared.zoom;
  if (Number.isFinite(shared.radius)) elements.radius.value = String(shared.radius);
  if (Number.isFinite(shared.threshold)) elements.threshold.value = String(shared.threshold);
  if (shared.baseMap) elements.baseMap.value = shared.baseMap;
  if (Number.isFinite(shared.baseMapOpacity)) elements.baseMapOpacity.value = String(shared.baseMapOpacity);
  if (typeof shared.terrain === "boolean") elements.terrainToggle.checked = shared.terrain;
  if (shared.terrainStyle) elements.terrainStyle.value = shared.terrainStyle;
  if (Number.isFinite(shared.terrainOpacity)) elements.terrainOpacity.value = String(shared.terrainOpacity);
  if (Number.isFinite(shared.depressionOpacity)) elements.opacity.value = String(shared.depressionOpacity);
  if (shared.selectedPoint) state.selectedPoint = shared.selectedPoint;
  clampView();
  return Object.keys(shared).length > 0;
}

function syncTerrainControls() {
  const disabled = !elements.terrainToggle.checked;
  elements.terrainStyle.disabled = disabled;
  elements.terrainOpacity.disabled = disabled;
}

function currentShareUrl() {
  const url = new URL(window.location.href);
  url.search = serializeShareState({
    latitude: state.latitude,
    longitude: state.longitude,
    zoom: state.zoom,
    radius: elements.radius.value,
    threshold: elements.threshold.value,
    baseMap: elements.baseMap.value,
    baseMapOpacity: elements.baseMapOpacity.value,
    terrain: elements.terrainToggle.checked,
    terrainStyle: elements.terrainStyle.value,
    terrainOpacity: elements.terrainOpacity.value,
    depressionOpacity: elements.opacity.value,
    selectedPoint: state.selectedPoint,
  });
  url.hash = "";
  return url.toString();
}

function setZoom(nextZoom, anchorX, anchorY) {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(nextZoom)));
  if (zoom === state.zoom) return;
  const size = canvasCssSize();
  const x = Number.isFinite(anchorX) ? anchorX : size.width / 2;
  const y = Number.isFinite(anchorY) ? anchorY : size.height / 2;
  const anchor = cssToLonLat(x, y);
  state.zoom = zoom;
  const anchorWorld = lonLatToWorldPixel(anchor.longitude, anchor.latitude, zoom);
  const centerWorld = {
    x: anchorWorld.x - x + size.width / 2,
    y: anchorWorld.y - y + size.height / 2,
  };
  const center = worldPixelToLonLat(centerWorld.x, centerWorld.y, zoom);
  state.longitude = center.longitude;
  state.latitude = center.latitude;
  clampView();
  updateZoomControl();
  invalidateAnalysis("表示範囲が変わりました");
}

function panBy(deltaX, deltaY) {
  const center = currentCenterWorld();
  const moved = worldPixelToLonLat(center.x - deltaX, center.y - deltaY, state.zoom);
  state.longitude = moved.longitude;
  state.latitude = moved.latitude;
  clampView();
  invalidateAnalysis("表示範囲が変わりました");
}

function resetView() {
  state.longitude = INITIAL_VIEW.longitude;
  state.latitude = INITIAL_VIEW.latitude;
  state.zoom = INITIAL_VIEW.zoom;
  updateZoomControl();
  invalidateAnalysis("最初の範囲へ戻しました");
}

function mapTileUrl(layer, zoom, x, y) {
  return `${GSI_ORIGIN}/xyz/${layer}/${zoom}/${x}/${y}.png`;
}

function trimMapTileCache() {
  if (state.mapTiles.size <= MAP_TILE_CACHE_LIMIT) return;
  for (const [key, entry] of state.mapTiles) {
    if (state.mapTiles.size <= MAP_TILE_CACHE_LIMIT) break;
    if (entry.status === "loading") continue;
    state.mapTiles.delete(key);
  }
}

function getMapTile(layer, zoom, x, y) {
  const url = mapTileUrl(layer, zoom, x, y);
  let entry = state.mapTiles.get(url);
  if (entry) return entry;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  entry = { image, status: "loading" };
  state.mapTiles.set(url, entry);
  image.addEventListener("load", () => {
    entry.status = "loaded";
    trimMapTileCache();
    scheduleDraw();
  }, { once: true });
  image.addEventListener("error", () => {
    entry.status = "missing";
    trimMapTileCache();
    scheduleDraw();
  }, { once: true });
  image.src = url;
  return entry;
}

function drawTileLayer(layer, opacity = 1) {
  const scale = state.deviceScale;
  const width = elements.canvas.width;
  const height = elements.canvas.height;
  const cssWidth = width / scale;
  const cssHeight = height / scale;
  const center = currentCenterWorld();
  const sourceZoom = tileSourceZoom(layer, state.zoom);
  const tileViewSize = TILE_SIZE * (2 ** (state.zoom - sourceZoom));
  const xMin = Math.floor((center.x - cssWidth / 2) / tileViewSize);
  const xMax = Math.floor((center.x + cssWidth / 2) / tileViewSize);
  const yMin = Math.floor((center.y - cssHeight / 2) / tileViewSize);
  const yMax = Math.floor((center.y + cssHeight / 2) / tileViewSize);
  const tileCount = 2 ** sourceZoom;

  context.save();
  context.globalAlpha = opacity;
  context.imageSmoothingEnabled = true;

  for (let tileX = xMin; tileX <= xMax; tileX += 1) {
    const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
    for (let tileY = yMin; tileY <= yMax; tileY += 1) {
      if (tileY < 0 || tileY >= tileCount) continue;
      const entry = getMapTile(layer, sourceZoom, wrappedX, tileY);
      if (entry.status !== "loaded") continue;
      const left = (tileX * tileViewSize - center.x + cssWidth / 2) * scale;
      const top = (tileY * tileViewSize - center.y + cssHeight / 2) * scale;
      context.drawImage(entry.image, left, top, tileViewSize * scale + 1, tileViewSize * scale + 1);
    }
  }
  context.restore();
}

function drawBaseMap() {
  context.fillStyle = "#dce8ee";
  context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
  drawTileLayer(elements.baseMap.value, Number(elements.baseMapOpacity.value) / 100);
}

function drawTerrainLayer() {
  if (!elements.terrainToggle.checked) return;
  const layer = elements.terrainStyle.value === "mono" ? "hillshademap" : "relief";
  drawTileLayer(layer, Number(elements.terrainOpacity.value) / 100);
}

function analysisSignature() {
  const size = canvasCssSize();
  return [
    state.longitude.toFixed(6),
    state.latitude.toFixed(6),
    state.zoom,
    Math.round(size.width),
    Math.round(size.height),
    elements.radius.value,
    elements.threshold.value,
  ].join(":");
}

function drawAnalysis() {
  if (!state.analysis || state.analysis.signature !== analysisSignature()) return;
  context.save();
  context.globalAlpha = Number(elements.opacity.value) / 100;
  context.drawImage(state.analysis.overlay, 0, 0);
  context.restore();
}

function draw() {
  state.drawPending = false;
  resizeCanvas();
  drawBaseMap();
  drawTerrainLayer();
  drawAnalysis();
  updateScaleBar();
}

function scheduleDraw() {
  if (state.drawPending) return;
  state.drawPending = true;
  window.requestAnimationFrame(draw);
}

function showLoading(message) {
  elements.loading.textContent = message;
  elements.loading.hidden = false;
}

function hideLoading() {
  elements.loading.hidden = true;
  elements.loading.textContent = "";
}

function radiusLabel() {
  const meters = Number(elements.radius.value);
  if (meters >= 1000) return `${Number((meters / 1000).toPrecision(3))}km`;
  return `${meters}m`;
}

function thresholdLabel() {
  return `${Number(Number(elements.threshold.value).toPrecision(3))}m以上`;
}

function updateStamp(message) {
  elements.stampTitle.textContent = `周囲平均との差（半径${radiusLabel()}・着色${thresholdLabel()}）`;
  elements.stampStatus.textContent = message;
}

function scheduleAnalysis() {
  window.clearTimeout(state.analyzeTimer);
  state.analyzeTimer = window.setTimeout(() => {
    void analyzeVisibleArea();
  }, 420);
}

function invalidateAnalysis(message, { preserveSelection = false } = {}) {
  state.analysisSequence += 1;
  state.analysis = null;
  clearPointReadout({ clearSelection: !preserveSelection });
  updateStamp(message);
  hideLoading();
  scheduleDraw();
  scheduleAnalysis();
}

async function imageFromBlob(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", reject, { once: true });
      image.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function demSourcesForZoom(zoom) {
  return zoom <= 12 ? ["dem_png"] : DEM_SOURCES;
}

async function fetchDemSource(source, zoom, tileX, tileY) {
  const url = `${GSI_ORIGIN}/xyz/${source}/${zoom}/${tileX}/${tileY}.png`;
  const response = await fetch(url, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    cache: "force-cache",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (blob.type && blob.type !== "image/png") return null;
  const image = await imageFromBlob(blob);
  const tileCanvas = document.createElement("canvas");
  tileCanvas.width = TILE_SIZE;
  tileCanvas.height = TILE_SIZE;
  const tileContext = tileCanvas.getContext("2d", { willReadFrequently: true });
  tileContext.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
  if (typeof image.close === "function") image.close();
  return tileContext.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

async function loadDemTile(zoom, tileX, tileY) {
  const key = `${zoom}/${tileX}/${tileY}`;
  if (state.demTiles.has(key)) return state.demTiles.get(key);

  const promise = (async () => {
    const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
    elevations.fill(Number.NaN);
    const sources = new Uint8Array(TILE_SIZE * TILE_SIZE);
    const usedSources = new Set();
    let validCount = 0;

    const demSources = demSourcesForZoom(zoom);
    for (let sourceIndex = 0; sourceIndex < demSources.length; sourceIndex += 1) {
      let pixels = null;
      try {
        pixels = await fetchDemSource(demSources[sourceIndex], zoom, tileX, tileY);
      } catch {
        pixels = null;
      }
      if (!pixels) continue;
      for (let index = 0; index < elevations.length; index += 1) {
        if (Number.isFinite(elevations[index])) continue;
        const offset = index * 4;
        const elevation = decodeElevationRgb(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        if (elevation === null) continue;
        elevations[index] = elevation;
        sources[index] = sourceIndex + 1;
        usedSources.add(demSources[sourceIndex]);
        validCount += 1;
      }
      if (validCount === elevations.length) break;
    }
    return { elevations, sources, usedSources, validCount };
  })();

  state.demTiles.set(key, promise);
  if (state.demTiles.size > DEM_TILE_CACHE_LIMIT) {
    for (const cacheKey of state.demTiles.keys()) {
      if (state.demTiles.size <= DEM_TILE_CACHE_LIMIT) break;
      if (cacheKey === key) continue;
      state.demTiles.delete(cacheKey);
    }
  }
  return promise;
}

async function runPool(tasks, concurrency, onProgress) {
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      await tasks[index]();
      completed += 1;
      onProgress(completed, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

function demTileAt(tileMap, zoom, worldX, worldY) {
  const xCoordinate = tileCoordinate(worldX);
  const yCoordinate = tileCoordinate(worldY);
  const key = `${zoom}/${xCoordinate.tile}/${yCoordinate.tile}`;
  const tile = tileMap.get(key);
  if (!tile) return Number.NaN;
  return tile.elevations[yCoordinate.pixel * TILE_SIZE + xCoordinate.pixel];
}

function formatMeters(value, signed = false) {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const prefix = signed && rounded > 0 ? "+" : "";
  return `${prefix}${rounded.toFixed(1)} m`;
}

function buildOverlay(result, width, height) {
  const overlay = document.createElement("canvas");
  overlay.width = elements.canvas.width;
  overlay.height = elements.canvas.height;
  const overlayContext = overlay.getContext("2d");
  overlayContext.scale(state.deviceScale, state.deviceScale);
  const threshold = Number(elements.threshold.value);
  let coloredCount = 0;
  for (let row = 0; row < result.rows; row += 1) {
    for (let column = 0; column < result.columns; column += 1) {
      const index = row * result.columns + column;
      const depth = result.depths[index];
      if (!Number.isFinite(depth) || depth < threshold) continue;
      const color = depthColor(depth);
      if (!color) continue;
      overlayContext.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]} / 82%)`;
      overlayContext.fillRect(column * result.step, row * result.step, result.step + 1, result.step + 1);
      coloredCount += 1;
    }
  }
  result.overlay = overlay;
  result.coloredCount = coloredCount;
  result.width = width;
  result.height = height;
}

function makeAnalysisPlan(zoom, width, height, radiusMeters) {
  const centerDem = currentCenterWorld(zoom);
  const demPerCssPixel = 2 ** (zoom - state.zoom);
  const radiusPixels = radiusMeters / metersPerPixel(state.latitude, zoom);
  const buffer = Math.max(1, radiusPixels * 1.08);
  const left = centerDem.x - width / 2 * demPerCssPixel - buffer;
  const right = centerDem.x + width / 2 * demPerCssPixel + buffer;
  const top = centerDem.y - height / 2 * demPerCssPixel - buffer;
  const bottom = centerDem.y + height / 2 * demPerCssPixel + buffer;
  const xMin = Math.floor(left / TILE_SIZE);
  const xMax = Math.floor(right / TILE_SIZE);
  const yMin = Math.floor(top / TILE_SIZE);
  const yMax = Math.floor(bottom / TILE_SIZE);
  const tileKeys = [];
  for (let tileX = xMin; tileX <= xMax; tileX += 1) {
    for (let tileY = yMin; tileY <= yMax; tileY += 1) {
      tileKeys.push({ tileX, tileY, key: `${zoom}/${tileX}/${tileY}` });
    }
  }
  return { zoom, centerDem, demPerCssPixel, radiusPixels, tileKeys };
}

function chooseAnalysisPlan(width, height, radiusMeters) {
  const highestZoom = analysisSourceZoom(state.zoom);
  for (let zoom = highestZoom; zoom >= MIN_ZOOM; zoom -= 1) {
    const plan = makeAnalysisPlan(zoom, width, height, radiusMeters);
    if (plan.tileKeys.length <= MAX_DEM_TILES) return plan;
  }
  return makeAnalysisPlan(MIN_ZOOM, width, height, radiusMeters);
}

function resolutionLabel(meters) {
  if (meters >= 1000) return `約${Number((meters / 1000).toPrecision(2))}km/画素`;
  if (meters >= 10) return `約${Math.round(meters)}m/画素`;
  return `約${meters.toFixed(1)}m/画素`;
}

async function analyzeVisibleArea() {
  const sequence = state.analysisSequence + 1;
  state.analysisSequence = sequence;
  const signature = analysisSignature();
  const { width, height } = canvasCssSize();
  const radiusMeters = Number(elements.radius.value);
  const requiredSampleCount = minimumRingSamples(radiusMeters);
  const plan = chooseAnalysisPlan(width, height, radiusMeters);
  const { centerDem, demPerCssPixel, radiusPixels, tileKeys } = plan;
  const sourceResolution = metersPerPixel(state.latitude, plan.zoom);

  if (tileKeys.length > MAX_DEM_TILES) {
    updateStamp("この表示範囲は解析できません。少し拡大してください");
    showLoading("解析範囲が広すぎます");
    return;
  }

  showLoading(`標高タイルを取得中 0/${tileKeys.length}`);
  updateStamp(`国土地理院の標高タイルを取得中・${resolutionLabel(sourceResolution)}`);

  const loadedTiles = new Map();
  const tasks = tileKeys.map(({ tileX, tileY, key }) => async () => {
    const tile = await loadDemTile(plan.zoom, tileX, tileY);
    loadedTiles.set(key, tile);
  });
  try {
    await runPool(tasks, 6, (completed, total) => {
      if (sequence === state.analysisSequence) showLoading(`標高タイルを取得中 ${completed}/${total}`);
    });
  } catch {
    if (sequence !== state.analysisSequence) return;
    showLoading("標高データを取得できませんでした。通信状態を確認してください");
    updateStamp("標高データを取得できませんでした");
    return;
  }

  if (sequence !== state.analysisSequence || signature !== analysisSignature()) return;
  showLoading("周囲との標高差を計算中");
  await new Promise((resolve) => window.requestAnimationFrame(resolve));

  const baseStep = width <= 520 ? 5 : 6;
  const step = Math.min(
    Math.max(width, height),
    Math.max(baseStep, Math.ceil(1 / demPerCssPixel)),
  );
  const columns = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const depths = new Float32Array(columns * rows);
  const elevations = new Float32Array(columns * rows);
  const surroundings = new Float32Array(columns * rows);
  depths.fill(Number.NaN);
  elevations.fill(Number.NaN);
  surroundings.fill(Number.NaN);
  const angles = Array.from({ length: RING_SAMPLE_COUNT }, (_, index) => index * Math.PI * 2 / RING_SAMPLE_COUNT);
  const sourceNames = new Set();
  let validCount = 0;

  for (const tile of loadedTiles.values()) {
    for (const source of tile.usedSources) sourceNames.add(source);
  }

  for (let row = 0; row < rows; row += 1) {
    const cssY = Math.min(height - 1, row * step + step / 2);
    const worldY = centerDem.y + (cssY - height / 2) * demPerCssPixel;
    for (let column = 0; column < columns; column += 1) {
      const cssX = Math.min(width - 1, column * step + step / 2);
      const worldX = centerDem.x + (cssX - width / 2) * demPerCssPixel;
      const centerElevation = demTileAt(loadedTiles, plan.zoom, worldX, worldY);
      const surrounding = angles.map((angle) => demTileAt(
        loadedTiles,
        plan.zoom,
        worldX + Math.cos(angle) * radiusPixels,
        worldY + Math.sin(angle) * radiusPixels,
      ));
      const value = calculateRelativeDepth(centerElevation, surrounding, requiredSampleCount);
      if (!value) continue;
      const index = row * columns + column;
      depths[index] = value.depth;
      elevations[index] = value.center;
      surroundings[index] = value.surroundingMean;
      validCount += 1;
    }
    if (row % 20 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (sequence !== state.analysisSequence) return;
  }

  if (signature !== analysisSignature()) return;
  const result = {
    signature,
    step,
    columns,
    rows,
    depths,
    elevations,
    surroundings,
    validCount,
    sourceNames: [...sourceNames],
    analysisZoom: plan.zoom,
    sourceResolution,
    radiusPixels,
    requiredSampleCount,
  };
  buildOverlay(result, width, height);
  state.analysis = result;
  hideLoading();
  const sourceLabel = result.sourceNames.length ? result.sourceNames.map((name) => name.replace("_png", "").toUpperCase()).join(" / ") : "標高データなし";
  const resolution = resolutionLabel(result.sourceResolution);
  const resolutionNote = result.radiusPixels < 1
    ? `・半径が${resolution}未満のため着色は限定的`
    : "";
  updateStamp(`${result.coloredCount.toLocaleString("ja-JP")}格子を着色・標高 ${sourceLabel}・解析${resolution}・有効${result.requiredSampleCount}方向以上${resolutionNote}`);
  restoreSelectedPoint();
  scheduleDraw();
}

function analysisAtCss(x, y) {
  const result = state.analysis;
  if (!result || result.signature !== analysisSignature()) return null;
  const column = Math.max(0, Math.min(result.columns - 1, Math.floor(x / result.step)));
  const row = Math.max(0, Math.min(result.rows - 1, Math.floor(y / result.step)));
  const index = row * result.columns + column;
  if (!Number.isFinite(result.elevations[index])) return null;
  return {
    elevation: result.elevations[index],
    surrounding: result.surroundings[index],
    depth: result.depths[index],
  };
}

function clearPointReadout({ clearSelection = false } = {}) {
  if (clearSelection) state.selectedPoint = null;
  elements.elevation.textContent = "--";
  elements.surrounding.textContent = "--";
  elements.depth.textContent = "--";
  elements.coordinate.textContent = "地図をクリックまたはタップ";
  elements.tooltip.hidden = true;
}

function updatePointReadout(position, value) {
  elements.coordinate.textContent = `緯度 ${position.latitude.toFixed(5)} / 経度 ${position.longitude.toFixed(5)}`;
  elements.elevation.textContent = value ? formatMeters(value.elevation) : "データなし";
  elements.surrounding.textContent = value ? formatMeters(value.surrounding) : "データなし";
  elements.depth.textContent = value ? formatMeters(value.depth, true) : "データなし";
}

function lonLatToCss(position) {
  const size = canvasCssSize();
  const center = currentCenterWorld();
  const target = lonLatToWorldPixel(position.longitude, position.latitude, state.zoom);
  const worldWidth = TILE_SIZE * (2 ** state.zoom);
  let deltaX = target.x - center.x;
  if (deltaX > worldWidth / 2) deltaX -= worldWidth;
  if (deltaX < -worldWidth / 2) deltaX += worldWidth;
  return { x: size.width / 2 + deltaX, y: size.height / 2 + target.y - center.y };
}

function restoreSelectedPoint() {
  if (!state.selectedPoint || !state.analysis) return;
  const point = lonLatToCss(state.selectedPoint);
  const size = canvasCssSize();
  if (point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) {
    clearPointReadout({ clearSelection: true });
    return;
  }
  updatePointReadout(state.selectedPoint, analysisAtCss(point.x, point.y));
}

function selectPoint(x, y) {
  const position = cssToLonLat(x, y);
  state.selectedPoint = position;
  updatePointReadout(position, analysisAtCss(x, y));
}

function updateTooltip(event) {
  if (event.pointerType === "touch" || state.pointers.size) {
    elements.tooltip.hidden = true;
    return;
  }
  const point = cssPoint(event);
  const value = analysisAtCss(point.x, point.y);
  if (!value) {
    elements.tooltip.hidden = true;
    return;
  }
  elements.tooltip.textContent = `標高 ${formatMeters(value.elevation)}\n周囲平均 ${formatMeters(value.surrounding)}\n周囲との差 ${formatMeters(value.depth, true)}`;
  elements.tooltip.style.left = `${Math.min(point.x + 14, canvasCssSize().width - 205)}px`;
  elements.tooltip.style.top = `${Math.min(point.y + 14, canvasCssSize().height - 92)}px`;
  elements.tooltip.hidden = false;
}

function pointerMetrics() {
  const points = [...state.pointers.values()];
  if (points.length < 2) return null;
  const [first, second] = points;
  return {
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

elements.canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  event.preventDefault();
  const point = cssPoint(event);
  state.pointers.set(event.pointerId, point);
  elements.canvas.setPointerCapture?.(event.pointerId);
  state.moved = false;
  state.downPoint = point;
  state.gesture = state.pointers.size >= 2 ? pointerMetrics() : point;
  elements.canvasWrap.classList.add("dragging");
  elements.tooltip.hidden = true;
});

elements.canvas.addEventListener("pointermove", (event) => {
  if (!state.pointers.has(event.pointerId)) {
    updateTooltip(event);
    return;
  }
  event.preventDefault();
  const point = cssPoint(event);
  state.pointers.set(event.pointerId, point);

  if (state.pointers.size >= 2) {
    const current = pointerMetrics();
    const previous = state.gesture;
    if (current && previous && Number.isFinite(previous.distance)) {
      panBy(current.x - previous.x, current.y - previous.y);
      const ratio = previous.distance > 0 ? current.distance / previous.distance : 1;
      if (ratio > 1.18) {
        setZoom(state.zoom + 1, current.x, current.y);
        current.distance = current.distance / ratio;
      } else if (ratio < 0.84) {
        setZoom(state.zoom - 1, current.x, current.y);
        current.distance = current.distance / ratio;
      }
      state.moved = true;
    }
    state.gesture = current;
    return;
  }

  const previous = state.gesture;
  if (previous && Number.isFinite(previous.x)) {
    const deltaX = point.x - previous.x;
    const deltaY = point.y - previous.y;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 0) panBy(deltaX, deltaY);
    if (state.downPoint && Math.hypot(point.x - state.downPoint.x, point.y - state.downPoint.y) > 6) state.moved = true;
  }
  state.gesture = point;
});

function finishPointer(event) {
  if (!state.pointers.has(event.pointerId)) return;
  event.preventDefault();
  const point = state.pointers.get(event.pointerId);
  const wasTap = state.pointers.size === 1 && !state.moved && point;
  state.pointers.delete(event.pointerId);
  try {
    elements.canvas.releasePointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture can already be released by the browser.
  }
  if (state.pointers.size === 1) {
    state.gesture = [...state.pointers.values()][0];
    state.moved = true;
  } else if (state.pointers.size === 0) {
    state.gesture = null;
    state.downPoint = null;
    elements.canvasWrap.classList.remove("dragging");
    if (wasTap) selectPoint(point.x, point.y);
  }
}

elements.canvas.addEventListener("pointerup", finishPointer);
elements.canvas.addEventListener("pointercancel", finishPointer);
elements.canvas.addEventListener("pointerleave", (event) => {
  if (!state.pointers.has(event.pointerId)) elements.tooltip.hidden = true;
});

elements.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const point = cssPoint(event);
  setZoom(state.zoom + (event.deltaY < 0 ? 1 : -1), point.x, point.y);
}, { passive: false });

async function writeTextToClipboard(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function setActionStatus(button, label, status, text, announcement) {
  window.clearTimeout(button._statusResetTimer);
  button.classList.toggle("is-success", status === "success");
  button.classList.toggle("is-error", status === "error");
  label.textContent = text;
  elements.shareStatus.textContent = announcement;
  if (status === "idle") return;
  button._statusResetTimer = window.setTimeout(() => {
    button.classList.remove("is-success", "is-error");
    label.textContent = button === elements.copyLink ? "リンク取得" : "PNG保存";
    elements.shareStatus.textContent = "";
  }, 2600);
}

async function copyShareLink() {
  setActionStatus(elements.copyLink, elements.copyLinkLabel, "idle", "コピー中", "共有リンクをコピーしています");
  const copied = await writeTextToClipboard(currentShareUrl());
  setActionStatus(
    elements.copyLink,
    elements.copyLinkLabel,
    copied ? "success" : "error",
    copied ? "コピー済" : "失敗",
    copied ? "現在の表示を開ける共有リンクをコピーしました" : "共有リンクをコピーできませんでした",
  );
}

function fittedCanvasText(exportContext, text, x, y, maxWidth) {
  if (exportContext.measureText(text).width <= maxWidth) {
    exportContext.fillText(text, x, y);
    return;
  }
  let shortened = text;
  while (shortened.length > 1 && exportContext.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  exportContext.fillText(`${shortened}…`, x, y);
}

function drawExportLegend(exportContext, width, mapTop, compact) {
  const legendWidth = compact ? 132 : 156;
  const legendHeight = compact ? 184 : 220;
  const left = width - legendWidth - 12;
  const top = mapTop + (compact ? 54 : 12);
  exportContext.fillStyle = "rgb(255 255 255 / 94%)";
  exportContext.fillRect(left, top, legendWidth, legendHeight);
  exportContext.strokeStyle = "rgb(42 127 120 / 85%)";
  exportContext.lineWidth = 2;
  exportContext.strokeRect(left, top, legendWidth, legendHeight);
  exportContext.fillStyle = "#17344b";
  exportContext.font = `800 ${compact ? 11 : 13}px sans-serif`;
  exportContext.fillText("周囲より低い", left + 9, top + 19);
  const entries = [
    ["#66d3f2", "0.5–1 m"],
    ["#45bfea", "1–1.5 m"],
    ["#2aa5dc", "1.5–2 m"],
    ["#167cc1", "2–3 m"],
    ["#315fb8", "3–4 m"],
    ["#4d49b5", "4–5 m"],
    ["#6b38a6", "5–10 m"],
    ["#9d277d", "10 m以上"],
  ];
  exportContext.font = `700 ${compact ? 9 : 11}px sans-serif`;
  entries.forEach(([color, text], index) => {
    const rowTop = top + (compact ? 27 : 31) + index * (compact ? 18 : 21);
    exportContext.fillStyle = color;
    exportContext.fillRect(left + 9, rowTop, compact ? 20 : 25, compact ? 9 : 11);
    exportContext.fillStyle = "#33414e";
    exportContext.fillText(text, left + (compact ? 35 : 41), rowTop + (compact ? 8 : 10));
  });
  exportContext.fillStyle = "#8a3127";
  exportContext.font = `800 ${compact ? 8 : 9}px sans-serif`;
  exportContext.fillText("危険度ではありません", left + 9, top + legendHeight - 8);
}

function createExportCanvas() {
  const { width, height } = canvasCssSize();
  const compact = width <= 520;
  const headerHeight = compact ? 58 : 64;
  const footerHeight = compact ? 58 : 42;
  const exportScale = Math.min(2, Math.max(1, state.deviceScale));
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.round(width * exportScale);
  exportCanvas.height = Math.round((headerHeight + height + footerHeight) * exportScale);
  const exportContext = exportCanvas.getContext("2d", { alpha: false });
  if (!exportContext) throw new Error("Export canvas unavailable");
  exportContext.scale(exportScale, exportScale);

  const headerGradient = exportContext.createLinearGradient(0, 0, width, 0);
  headerGradient.addColorStop(0, "#062846");
  headerGradient.addColorStop(0.55, "#0b4f7b");
  headerGradient.addColorStop(1, "#1677a3");
  exportContext.fillStyle = headerGradient;
  exportContext.fillRect(0, 0, width, headerHeight);
  exportContext.fillStyle = "#55c4dc";
  exportContext.fillRect(0, headerHeight - 3, width, 3);
  exportContext.fillStyle = "#fff";
  exportContext.font = `850 ${compact ? 16 : 21}px sans-serif`;
  fittedCanvasText(exportContext, "周囲より低い地形チェッカー", 14, compact ? 24 : 28, width - 28);
  exportContext.fillStyle = "#cde5f0";
  exportContext.font = `700 ${compact ? 9 : 11}px sans-serif`;
  fittedCanvasText(exportContext, `Bousai Wx Lab｜${elements.stampTitle.textContent}`, 14, compact ? 43 : 49, width - 28);

  exportContext.drawImage(elements.canvas, 0, headerHeight, width, height);
  const stampWidth = Math.max(130, Math.min(compact ? width - 24 : 540, width - 188));
  exportContext.fillStyle = "rgb(5 43 75 / 92%)";
  exportContext.fillRect(12, headerHeight + 12, stampWidth, compact ? 34 : 40);
  exportContext.fillStyle = "#fff";
  exportContext.font = `800 ${compact ? 11 : 14}px sans-serif`;
  fittedCanvasText(exportContext, elements.stampTitle.textContent, 21, headerHeight + (compact ? 34 : 38), stampWidth - 18);
  drawExportLegend(exportContext, width, headerHeight, compact);

  const scaleSpec = scaleBarSpec(state.latitude, state.zoom, compact ? 90 : 120);
  const scaleTop = headerHeight + height - 36;
  exportContext.fillStyle = "rgb(5 43 75 / 88%)";
  exportContext.fillRect(12, scaleTop, Math.round(scaleSpec.pixels) + 16, 28);
  exportContext.fillStyle = "#fff";
  exportContext.font = `800 ${compact ? 9 : 10}px sans-serif`;
  exportContext.fillText(scaleSpec.label, 18, scaleTop + 12);
  exportContext.strokeStyle = "#fff";
  exportContext.lineWidth = 2;
  exportContext.beginPath();
  exportContext.moveTo(18, scaleTop + 17);
  exportContext.lineTo(18, scaleTop + 24);
  exportContext.lineTo(18 + scaleSpec.pixels, scaleTop + 24);
  exportContext.lineTo(18 + scaleSpec.pixels, scaleTop + 17);
  exportContext.stroke();

  const footerTop = headerHeight + height;
  exportContext.fillStyle = "#062846";
  exportContext.fillRect(0, footerTop, width, footerHeight);
  exportContext.fillStyle = "#d9e8f2";
  exportContext.font = `650 ${compact ? 8 : 9}px sans-serif`;
  fittedCanvasText(exportContext, "出典：国土地理院「地理院タイル」・標高タイルを加工", 12, footerTop + 17, width - 24);
  fittedCanvasText(exportContext, "周囲との標高差を示す参考表示です。浸水想定や災害危険度ではありません。", 12, footerTop + (compact ? 36 : 32), width - 24);
  if (compact) {
    fittedCanvasText(exportContext, "避難や土地利用は公式ハザードマップと現地状況も確認してください。", 12, footerTop + 51, width - 24);
  }
  return exportCanvas;
}

function exportFileName() {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  return `terrain-depression-z${state.zoom}-${radiusLabel()}-${timestamp}.png`;
}

async function downloadCurrentMap() {
  setActionStatus(elements.download, elements.downloadLabel, "idle", "生成中", "PNG画像を生成しています");
  elements.download.disabled = true;
  try {
    scheduleDraw();
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    const exportCanvas = createExportCanvas();
    const blob = await new Promise((resolve, reject) => {
      exportCanvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG export failed")), "image/png");
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setActionStatus(elements.download, elements.downloadLabel, "success", "保存済", "現在の地図をPNG画像として保存しました");
  } catch {
    setActionStatus(elements.download, elements.downloadLabel, "error", "失敗", "PNG画像を保存できませんでした");
  } finally {
    elements.download.disabled = false;
  }
}

elements.zoomIn.addEventListener("click", () => setZoom(state.zoom + 1));
elements.zoomOut.addEventListener("click", () => setZoom(state.zoom - 1));
elements.fit.addEventListener("click", resetView);

elements.radius.addEventListener("change", () => invalidateAnalysis("判定半径を変更しました", { preserveSelection: true }));
elements.threshold.addEventListener("change", () => invalidateAnalysis("表示下限を変更しました", { preserveSelection: true }));
elements.baseMap.addEventListener("change", scheduleDraw);
elements.baseMapOpacity.addEventListener("input", () => {
  elements.baseMapOpacityValue.value = `${elements.baseMapOpacity.value}%`;
  scheduleDraw();
});
elements.terrainToggle.addEventListener("change", () => {
  syncTerrainControls();
  scheduleDraw();
});
elements.terrainStyle.addEventListener("change", scheduleDraw);
elements.terrainOpacity.addEventListener("input", () => {
  elements.terrainOpacityValue.value = `${elements.terrainOpacity.value}%`;
  scheduleDraw();
});
elements.opacity.addEventListener("input", () => {
  elements.opacityValue.value = `${elements.opacity.value}%`;
  scheduleDraw();
});
elements.copyLink.addEventListener("click", () => void copyShareLink());
elements.download.addEventListener("click", () => void downloadCurrentMap());

const resizeObserver = new ResizeObserver(() => {
  resizeCanvas();
  scheduleDraw();
});
resizeObserver.observe(elements.canvasWrap);

const restoredSharedView = applySharedViewState();
syncTerrainControls();
updateZoomControl();
elements.opacityValue.value = `${elements.opacity.value}%`;
elements.terrainOpacityValue.value = `${elements.terrainOpacity.value}%`;
elements.baseMapOpacityValue.value = `${elements.baseMapOpacity.value}%`;
updateStamp(restoredSharedView ? "共有リンクの表示を復元し、標高を解析します" : "標高を解析します");
resizeCanvas();
scheduleDraw();
scheduleAnalysis();
