import {
  MAX_MAP_ZOOM, TILE_SIZE, depthColor, destinationPoint, elevationDifference,
  lonLatToWorldPixel, metersPerPixel, parseShareState, scaleBarSpec,
  serializeShareState, tileSourceZoom, worldPixelToLonLat,
} from "./terrain.js?v=20260905-6";
import { beginPinchGesture, pinchZoomFromStart, pointerPairMetrics } from "./interaction.js?v=20260905-1";
const GSI_ORIGIN = "https://cyberjapandata.gsi.go.jp";

const INITIAL_VIEW = Object.freeze({ longitude: 139.767, latitude: 35.681, zoom: 14 });
const MIN_ZOOM = 5;
const MAX_ZOOM = MAX_MAP_ZOOM;
const MAP_TILE_CACHE_LIMIT = 120;

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
  centerMarkToggle: document.querySelector("#centerMarkToggle"),
  radiusGuideToggle: document.querySelector("#radiusGuideToggle"),
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
  topbar: document.querySelector(".topbar"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsPanel: document.querySelector("#settingsPanel"),
  settingsClose: document.querySelector("#settingsCloseButton"),
  settingsBackdrop: document.querySelector("#settingsBackdrop"),
  moreButton: document.querySelector("#moreButton"),
  headerActions: document.querySelector("#headerActions"),
  legendButton: document.querySelector("#legendButton"),
  legend: document.querySelector("#mapLegend"),
  mobilePointSummary: document.querySelector("#mobilePointSummary"),
  mobilePointSummaryValue: document.querySelector("#mobilePointSummaryValue"),
  pointHeading: document.querySelector("#pointHeading"),
};

const mobileLayout = window.matchMedia("(max-width: 820px), (max-width: 900px) and (max-height: 520px)");

const context = elements.canvas.getContext("2d", { alpha: false });
const state = {
  longitude: INITIAL_VIEW.longitude,
  latitude: INITIAL_VIEW.latitude,
  zoom: INITIAL_VIEW.zoom,
  deviceScale: 1,
  mapTiles: new Map(),
  pointSequence: 0,
  pendingSignature: '',
  analysis: null,
  analysisSequence: 0,
  analyzeTimer: 0,
  drawPending: false,
  pointers: new Map(),
  gesture: null,
  moved: false,
  downPoint: null,
  hadMultiplePointers: false,
  selectedPoint: null,
  settingsReturnFocus: null,
};

function setElementInert(element, inert) {
  if (inert) element.setAttribute("inert", "");
  else element.removeAttribute("inert");
}

function closeHeaderActions({ restoreFocus = false } = {}) {
  if (!mobileLayout.matches) return;
  if (elements.headerActions.contains(document.activeElement)) elements.moreButton.focus();
  elements.headerActions.classList.remove("is-open");
  elements.moreButton.setAttribute("aria-expanded", "false");
  elements.headerActions.setAttribute("aria-hidden", "true");
  setElementInert(elements.headerActions, true);
  if (restoreFocus) elements.moreButton.focus();
}

function toggleHeaderActions() {
  if (!mobileLayout.matches) return;
  const willOpen = !elements.headerActions.classList.contains("is-open");
  elements.headerActions.classList.toggle("is-open", willOpen);
  elements.moreButton.setAttribute("aria-expanded", String(willOpen));
  elements.headerActions.setAttribute("aria-hidden", String(!willOpen));
  setElementInert(elements.headerActions, !willOpen);
  if (willOpen) elements.headerActions.querySelector("button, a")?.focus();
}

function closeSettings({ restoreFocus = true } = {}) {
  if (!mobileLayout.matches) return;
  const wasOpen = elements.settingsPanel.classList.contains("is-open");
  elements.settingsPanel.classList.remove("is-open");
  elements.settingsBackdrop.classList.remove("is-open");
  elements.settingsButton.setAttribute("aria-expanded", "false");
  elements.settingsPanel.setAttribute("aria-hidden", "true");
  setElementInert(elements.settingsPanel, true);
  document.body.classList.remove("settings-open");
  if (wasOpen && restoreFocus) {
    const target = state.settingsReturnFocus?.isConnected ? state.settingsReturnFocus : elements.settingsButton;
    target.focus();
  }
  state.settingsReturnFocus = null;
}

function openSettings(focusTarget = elements.settingsClose) {
  if (!mobileLayout.matches) return;
  closeHeaderActions();
  cancelAllPointers();
  state.settingsReturnFocus = elements.settingsButton;
  elements.settingsPanel.classList.add("is-open");
  elements.settingsBackdrop.classList.add("is-open");
  elements.settingsButton.setAttribute("aria-expanded", "true");
  elements.settingsPanel.setAttribute("aria-hidden", "false");
  setElementInert(elements.settingsPanel, false);
  document.body.classList.add("settings-open");
  window.requestAnimationFrame(() => {
    focusTarget.focus();
    if (focusTarget === elements.pointHeading) focusTarget.scrollIntoView({ block: "start" });
  });
}

function focusableSettingsElements() {
  return [...elements.settingsPanel.querySelectorAll("button, select, input, summary, a[href], [tabindex]")]
    .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("tabindex") !== "-1");
}

function syncResponsiveAccessibility() {
  if (mobileLayout.matches) {
    elements.settingsPanel.setAttribute("role", "dialog");
    elements.settingsPanel.setAttribute("aria-modal", "true");
    elements.settingsPanel.setAttribute("aria-labelledby", "settingsPanelTitle");
    if (!elements.settingsPanel.classList.contains("is-open")) {
      elements.settingsPanel.setAttribute("aria-hidden", "true");
      setElementInert(elements.settingsPanel, true);
    }
    if (!elements.headerActions.classList.contains("is-open")) {
      elements.headerActions.setAttribute("aria-hidden", "true");
      setElementInert(elements.headerActions, true);
    }
    elements.legend.setAttribute("aria-hidden", String(!elements.legend.classList.contains("is-open")));
  } else {
    elements.settingsPanel.classList.remove("is-open");
    elements.settingsBackdrop.classList.remove("is-open");
    elements.settingsPanel.removeAttribute("role");
    elements.settingsPanel.removeAttribute("aria-modal");
    elements.settingsPanel.removeAttribute("aria-labelledby");
    elements.settingsPanel.removeAttribute("aria-hidden");
    setElementInert(elements.settingsPanel, false);
    elements.settingsButton.setAttribute("aria-expanded", "false");
    elements.headerActions.classList.remove("is-open");
    elements.headerActions.removeAttribute("aria-hidden");
    setElementInert(elements.headerActions, false);
    elements.moreButton.setAttribute("aria-expanded", "false");
    elements.legend.classList.remove("is-open");
    elements.legend.removeAttribute("aria-hidden");
    elements.legendButton.setAttribute("aria-expanded", "false");
    document.body.classList.remove("settings-open");
  }
}

let viewportFrame = 0;
function scheduleViewportSync() {
  if (viewportFrame) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = 0;
    const visualHeight = window.visualViewport?.height;
    const viewportHeight = Number.isFinite(visualHeight) ? visualHeight : window.innerHeight;
    const headerHeight = elements.topbar.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--mobile-viewport-height", `${Math.round(viewportHeight)}px`);
    document.documentElement.style.setProperty("--mobile-header-height", `${Math.ceil(headerHeight)}px`);
  });
}

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
  if (typeof shared.centerMark === "boolean") elements.centerMarkToggle.checked = shared.centerMark;
  if (typeof shared.radiusGuide === "boolean") elements.radiusGuideToggle.checked = shared.radiusGuide;
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
    centerMark: elements.centerMarkToggle.checked,
    radiusGuide: elements.radiusGuideToggle.checked,
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
  image.referrerPolicy = "no-referrer";
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
  ].join(":");
}

function drawAnalysis() {
  if (!state.analysis || state.analysis.signature !== analysisSignature()) return;
  context.save();
  context.globalAlpha = Number(elements.opacity.value) / 100;
  context.drawImage(state.analysis.overlay, 0, 0);
  context.restore();
}

function drawCenterGuides() {
  if (!elements.centerMarkToggle.checked && !elements.radiusGuideToggle.checked) return;
  const scale = state.deviceScale;
  const centerX = elements.canvas.width / 2;
  const centerY = elements.canvas.height / 2;

  context.save();
  if (elements.radiusGuideToggle.checked) {
    context.beginPath();
    for (let i = 0; i <= 128; i++) {
      const point = lonLatToCss(destinationPoint(state.longitude, state.latitude, Number(elements.radius.value), i * Math.PI / 64));
      if (i === 0) context.moveTo(point.x * scale, point.y * scale);
      else context.lineTo(point.x * scale, point.y * scale);
    }
    context.closePath();
    context.setLineDash([7 * scale, 5 * scale]);
    context.lineWidth = 5 * scale;
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.stroke();
    context.lineWidth = 2 * scale;
    context.strokeStyle = "rgba(4, 75, 120, 0.9)";
    context.stroke();
  }

  if (elements.centerMarkToggle.checked) {
    const arm = 12 * scale;
    context.setLineDash([]);
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(centerX - arm, centerY);
    context.lineTo(centerX + arm, centerY);
    context.moveTo(centerX, centerY - arm);
    context.lineTo(centerX, centerY + arm);
    context.lineWidth = 6 * scale;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.stroke();
    context.lineWidth = 2.5 * scale;
    context.strokeStyle = "#063f68";
    context.stroke();
  }
  context.restore();
}

function draw() {
  state.drawPending = false;
  resizeCanvas();
  drawBaseMap();
  drawTerrainLayer();
  drawAnalysis();
  drawCenterGuides();
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

function updateStamp(message, gridSpacingMeters = null) {
  const gridLabel = Number.isFinite(gridSpacingMeters) ? `・格子${resolutionLabel(gridSpacingMeters).replace("/画素", "")}` : "";
  elements.stampTitle.textContent = `周囲より低い量（半径${radiusLabel()}・着色${thresholdLabel()}${gridLabel}）`;
  elements.stampStatus.textContent = message;
  elements.canvasWrap.dataset.status = message;
}

function scheduleAnalysis() {
  window.clearTimeout(state.analyzeTimer);
  state.analyzeTimer = window.setTimeout(() => {
    if (!state.pointers.size) analyzeVisibleArea();
  }, 120);
}

function invalidateAnalysis(message, { preserveSelection = false } = {}) {
  state.analysisSequence += 1;
  analysisWorker.postMessage({ type: "cancel", id: state.analysisSequence });
  state.pointSequence += 1;
  state.analysis = null;
  elements.download.disabled = true;
  elements.canvasWrap.dataset.ready = "false";
  clearPointReadout({ clearSelection: !preserveSelection });
  updateStamp(message);
  hideLoading();
  scheduleDraw();
  scheduleAnalysis();
}



function formatMeters(value, signed = false) {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const prefix = rounded < 0 ? "−" : signed && rounded > 0 ? "+" : "";
  return `${prefix}${Math.abs(rounded).toFixed(1)} m`;
}

function buildOverlay(result, width, height) {
  const cells = document.createElement("canvas");
  cells.width = result.columns; cells.height = result.rows;
  const cellContext = cells.getContext("2d"), pixels = cellContext.createImageData(result.columns, result.rows);
  const threshold = Number(elements.threshold.value);
  let coloredCount = 0;
  for (let i = 0; i < result.depths.length; i++) {
    const depth = result.depths[i];
    if (result.statuses[i] === 2 || result.statuses[i] === 3) {
      pixels.data.set([105, 115, 122, 90], i * 4);
    } else if (result.statuses[i] === 1 && Number.isFinite(depth) && depth >= threshold) {
      const color = depthColor(depth);
      if (color) { pixels.data.set([...color, 209], i * 4); coloredCount++; }
    }
  }
  cellContext.putImageData(pixels, 0, 0);
  const overlay = document.createElement("canvas");
  overlay.width = elements.canvas.width; overlay.height = elements.canvas.height;
  const overlayContext = overlay.getContext("2d");
  overlayContext.imageSmoothingEnabled = false;
  overlayContext.drawImage(cells, 0, 0, result.columns * result.step * state.deviceScale, result.rows * result.step * state.deviceScale);
  Object.assign(result, { overlay, coloredCount, width, height });
}

function resolutionLabel(meters) {
  if (meters >= 1000) return `約${Number((meters / 1000).toPrecision(2))}km/画素`;
  if (meters >= 10) return `約${Math.round(meters)}m/画素`;
  return `約${meters.toFixed(1)}m/画素`;
}

const analysisWorker = new Worker("./analysis-worker.js?v=20260905-7", { type: "module", credentials: "omit" });

function analysisMessage(result) {
  return `円内の陸地平均・集計格子${resolutionLabel(result.sourceResolution).replace("/画素", "")}・${(result.elapsedMs / 1000).toFixed(2)}秒`;
}

analysisWorker.addEventListener("message", ({ data }) => {
  if (data.type === "point") {
    if (data.analysisId !== state.analysisSequence || data.pointId !== state.pointSequence || !state.selectedPoint) return;
    updatePointReadout(state.selectedPoint, data.value);
    return;
  }
  if (data.id !== state.analysisSequence || state.pendingSignature !== analysisSignature()) return;
  if (data.type === "progress") { showLoading(data.message); updateStamp(data.message); return; }
  if (data.type === "error" || data.type === "unavailable") {
    state.analysis = null;
    updateStamp(data.message); showLoading(data.message);
    elements.canvasWrap.dataset.ready = "error";
    if (data.type === "error") {
      const retry = document.createElement("button");
      retry.type = "button"; retry.textContent = "再試行";
      retry.addEventListener("click", () => invalidateAnalysis("再試行します", { preserveSelection: true }));
      elements.loading.append(document.createTextNode(" "), retry);
    }
    scheduleDraw(); return;
  }
  if (data.type !== "result") return;
  const { width, height } = canvasCssSize();
  const result = { ...data, signature: state.pendingSignature, radiusMeters: Number(elements.radius.value) };
  result.gridSpacing = result.step * metersPerPixel(state.latitude, state.zoom);
  buildOverlay(result, width, height);
  state.analysis = result;
  elements.canvasWrap.dataset.ready = "true";
  for (const key of ["elapsedMs", "fetchMs", "calculationMs", "prefixMiB", "analysisZoom", "validCount"]) elements.canvasWrap.dataset[key] = String(result[key]);
  elements.download.disabled = false;
  updateStamp(analysisMessage(result), result.gridSpacing);
  if (result.validCount) hideLoading();
  else showLoading("この範囲には判定できる陸地がありません。灰色は範囲外・判定不能です");
  restoreSelectedPoint(); scheduleDraw();
});
analysisWorker.addEventListener("error", () => {
  state.analysis = null; elements.canvasWrap.dataset.ready = "error";
  const message = "計算機能を起動できませんでした。ページを再読み込みしてください";
  showLoading(message); updateStamp(message); scheduleDraw();
});

function analyzeVisibleArea() {
  const id = ++state.analysisSequence, { width, height } = canvasCssSize();
  state.pendingSignature = analysisSignature();
  elements.canvasWrap.dataset.ready = "false";
  elements.download.disabled = true;
  showLoading("円内の陸地平均を準備中");
  analysisWorker.postMessage({ type: "analyze", id, view: {
    longitude: state.longitude, latitude: state.latitude, zoom: state.zoom,
    radius: Number(elements.radius.value), width, height,
  } });
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
    elevationDifference: elevationDifference(result.elevations[index], result.surroundings[index]),
    status: result.statuses[index],
    landFraction: result.landFractions[index],
  };
}

function requestSelectedPoint() {
  if (!state.analysis || !state.selectedPoint) return;
  const pointId = ++state.pointSequence;
  updatePointReadout(state.selectedPoint, null);
  elements.elevation.textContent = "計算中";
  elements.surrounding.textContent = "計算中";
  elements.depth.textContent = "計算中";
  elements.mobilePointSummary.hidden = false;
  elements.mobilePointSummaryValue.textContent = "標高差を計算中";
  analysisWorker.postMessage({ type: "point", pointId, analysisId: state.analysisSequence, position: state.selectedPoint });
}

function clearPointReadout({ clearSelection = false } = {}) {
  if (clearSelection) state.selectedPoint = null;
  elements.elevation.textContent = "--";
  elements.surrounding.textContent = "--";
  elements.depth.textContent = "--";
  elements.coordinate.textContent = "地図をクリックまたはタップ";
  elements.tooltip.hidden = true;
  elements.mobilePointSummary.hidden = true;
}

function updatePointReadout(position, value) {
  elements.coordinate.textContent = `緯度 ${position.latitude.toFixed(5)} / 経度 ${position.longitude.toFixed(5)}`;
  elements.elevation.textContent = value ? formatMeters(value.elevation) : "データなし";
  elements.surrounding.textContent = value ? formatMeters(value.surrounding) : "データなし";
  elements.depth.textContent = value ? formatMeters(value.elevationDifference, true) : "データなし";
  elements.mobilePointSummary.hidden = false;
  elements.mobilePointSummaryValue.textContent = value
    ? `標高差 ${formatMeters(value.elevationDifference, true)}`
    : "選択地点：データなし";
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
  requestSelectedPoint();
}

function selectPoint(x, y) {
  const position = cssToLonLat(x, y);
  state.selectedPoint = position;
  requestSelectedPoint();
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
  elements.tooltip.textContent = `標高 ${formatMeters(value.elevation)}\n円内陸地平均 ${formatMeters(value.surrounding)}\n標高差（地点−周囲平均） ${formatMeters(value.elevationDifference, true)}`;
  elements.tooltip.style.left = `${Math.min(point.x + 14, canvasCssSize().width - 205)}px`;
  elements.tooltip.style.top = `${Math.min(point.y + 14, canvasCssSize().height - 92)}px`;
  elements.tooltip.hidden = false;
}

function pointerMetrics() {
  return pointerPairMetrics(state.pointers.values());
}

elements.canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  event.preventDefault();
  const point = cssPoint(event);
  const startsGesture = state.pointers.size === 0;
  state.pointers.set(event.pointerId, point);
  elements.canvas.setPointerCapture?.(event.pointerId);
  if (startsGesture) {
    state.moved = false;
    state.hadMultiplePointers = false;
    state.downPoint = point;
    state.gesture = point;
  } else if (state.pointers.size >= 2) {
    state.moved = true;
    state.hadMultiplePointers = true;
    state.gesture = beginPinchGesture(pointerMetrics(), state.zoom);
  }
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
    let gesture = state.gesture;
    if (current && (!gesture || gesture.kind !== "pinch")) {
      gesture = beginPinchGesture(current, state.zoom);
    }
    if (current && gesture) {
      panBy(current.x - gesture.x, current.y - gesture.y);
      const nextZoom = pinchZoomFromStart(gesture, current, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom !== null && nextZoom !== state.zoom) setZoom(nextZoom, current.x, current.y);
      state.gesture = { ...gesture, x: current.x, y: current.y };
      state.moved = true;
    }
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

function finishPointer(event, { cancelled = false, releaseCapture = true } = {}) {
  if (!state.pointers.has(event.pointerId)) return;
  event.preventDefault();
  const point = state.pointers.get(event.pointerId);
  const wasTap = !cancelled && state.pointers.size === 1 && !state.moved && !state.hadMultiplePointers && point;
  state.pointers.delete(event.pointerId);
  if (releaseCapture) {
    try {
      elements.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
  }
  if (state.pointers.size >= 2) {
    state.gesture = beginPinchGesture(pointerMetrics(), state.zoom);
    state.moved = true;
  } else if (state.pointers.size === 1) {
    state.gesture = [...state.pointers.values()][0];
    state.moved = true;
  } else if (state.pointers.size === 0) {
    state.gesture = null;
    state.downPoint = null;
    elements.canvasWrap.classList.remove("dragging");
    if (wasTap) selectPoint(point.x, point.y);
    else scheduleAnalysis();
    state.moved = false;
    state.hadMultiplePointers = false;
  }
}

elements.canvas.addEventListener("pointerup", finishPointer);
elements.canvas.addEventListener("pointercancel", (event) => finishPointer(event, { cancelled: true }));
elements.canvas.addEventListener("lostpointercapture", (event) => finishPointer(event, { cancelled: true, releaseCapture: false }));
elements.canvas.addEventListener("pointerleave", (event) => {
  if (!state.pointers.has(event.pointerId)) elements.tooltip.hidden = true;
});

elements.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const point = cssPoint(event);
  setZoom(state.zoom + (event.deltaY < 0 ? 1 : -1), point.x, point.y);
}, { passive: false });

function cancelAllPointers() {
  if (!state.pointers.size) return;
  const pointerIds = [...state.pointers.keys()];
  state.pointers.clear();
  for (const pointerId of pointerIds) {
    try {
      elements.canvas.releasePointerCapture?.(pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
  }
  state.gesture = null;
  state.downPoint = null;
  state.moved = false;
  state.hadMultiplePointers = false;
  elements.canvasWrap.classList.remove("dragging");
  elements.tooltip.hidden = true;
  scheduleAnalysis();
}

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
  const usesColorRelief =
    elements.terrainToggle.checked &&
    elements.terrainStyle.value === "color" &&
    Number(elements.terrainOpacity.value) > 0;
  const footerLines = [
    "出典：国土地理院「地理院タイル」",
    "地理院タイル（標高タイル）を加工／Bousai Wx Lab 作成",
    ...(usesColorRelief ? ["色別標高図の海域部：海上保安庁海洋情報部の資料を使用して作成"] : []),
    "周囲との標高差です。浸水想定・災害危険度ではありません。",
    "避難・土地利用は公式ハザードマップと現地状況を確認してください。",
  ];
  const footerLineHeight = compact ? 14 : 15;
  const footerHeight = (compact ? 12 : 14) + footerLines.length * footerLineHeight;
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
  footerLines.forEach((line, index) => {
    fittedCanvasText(exportContext, line, 12, footerTop + (compact ? 15 : 17) + index * footerLineHeight, width - 24);
  });
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
    elements.download.disabled = !state.analysis;
  }
}

elements.zoomIn.addEventListener("click", () => setZoom(state.zoom + 1));
elements.zoomOut.addEventListener("click", () => setZoom(state.zoom - 1));
elements.fit.addEventListener("click", resetView);

elements.radius.addEventListener("change", () => invalidateAnalysis("判定半径を変更しました", { preserveSelection: true }));
elements.threshold.addEventListener("change", () => {
  if (state.analysis) {
    buildOverlay(state.analysis, state.analysis.width, state.analysis.height);
    updateStamp(analysisMessage(state.analysis), state.analysis.gridSpacing);
  } else updateStamp("円内の陸地平均を準備中");
  scheduleDraw();
});
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
elements.centerMarkToggle.addEventListener("change", scheduleDraw);
elements.radiusGuideToggle.addEventListener("change", scheduleDraw);
elements.copyLink.addEventListener("click", () => { closeHeaderActions(); void copyShareLink(); });
elements.download.addEventListener("click", () => { closeHeaderActions(); void downloadCurrentMap(); });
elements.settingsButton.addEventListener("click", () => openSettings());
elements.settingsClose.addEventListener("click", () => closeSettings());
elements.settingsBackdrop.addEventListener("click", () => closeSettings());
elements.moreButton.addEventListener("click", toggleHeaderActions);
elements.headerActions.querySelector(".sns-link")?.addEventListener("click", () => closeHeaderActions());
elements.legendButton.addEventListener("click", () => {
  const willOpen = !elements.legend.classList.contains("is-open");
  elements.legend.classList.toggle("is-open", willOpen);
  elements.legendButton.setAttribute("aria-expanded", String(willOpen));
  elements.legend.setAttribute("aria-hidden", String(!willOpen));
});
elements.mobilePointSummary.addEventListener("click", () => {
  elements.pointHeading.tabIndex = -1;
  openSettings(elements.pointHeading);
});

document.addEventListener("pointerdown", (event) => {
  if (!elements.headerActions.classList.contains("is-open")) return;
  if (elements.headerActions.contains(event.target) || elements.moreButton.contains(event.target)) return;
  closeHeaderActions();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (elements.settingsPanel.classList.contains("is-open")) closeSettings();
    else closeHeaderActions({ restoreFocus: true });
    return;
  }
  if (event.key !== "Tab" || !elements.settingsPanel.classList.contains("is-open")) return;
  const focusable = focusableSettingsElements();
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
});

mobileLayout.addEventListener("change", () => {
  cancelAllPointers();
  syncResponsiveAccessibility();
  scheduleViewportSync();
});
window.addEventListener("resize", scheduleViewportSync);
window.addEventListener("orientationchange", () => {
  cancelAllPointers();
  scheduleViewportSync();
});
window.addEventListener("pagehide", cancelAllPointers);
window.addEventListener("blur", cancelAllPointers);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelAllPointers();
});
window.visualViewport?.addEventListener("resize", scheduleViewportSync);
window.visualViewport?.addEventListener("scroll", scheduleViewportSync);

const resizeObserver = new ResizeObserver(() => {
  resizeCanvas();
  scheduleDraw();
});
resizeObserver.observe(elements.canvasWrap);

const restoredSharedView = applySharedViewState();
syncResponsiveAccessibility();
scheduleViewportSync();
syncTerrainControls();
updateZoomControl();
elements.opacityValue.value = `${elements.opacity.value}%`;
elements.terrainOpacityValue.value = `${elements.terrainOpacity.value}%`;
elements.baseMapOpacityValue.value = `${elements.baseMapOpacity.value}%`;
updateStamp(restoredSharedView ? "共有リンクの表示を復元し、標高を解析します" : "標高を解析します");
resizeCanvas();
scheduleDraw();
scheduleAnalysis();
