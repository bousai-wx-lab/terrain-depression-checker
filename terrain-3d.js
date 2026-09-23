// A local WebGL terrain surface. The existing geographic analysis remains the
// source of both the color texture and the sampled ground elevations.
const VERTEX_SHADER = `
attribute vec3 a_position;
attribute vec2 a_uv;
uniform float u_pitch;
uniform float u_bearing;
uniform float u_distance;
uniform float u_focal;
uniform float u_aspect;
varying vec2 v_uv;
void main() {
  float cb = cos(u_bearing), sb = sin(u_bearing);
  vec3 turned = vec3(cb * a_position.x - sb * a_position.y,
                     sb * a_position.x + cb * a_position.y, a_position.z);
  float cp = cos(u_pitch), sp = sin(u_pitch);
  float y = cp * turned.y + sp * turned.z;
  float z = -sp * turned.y + cp * turned.z;
  float depth = u_distance - z;
  gl_Position = vec4(turned.x * u_focal / u_aspect, y * u_focal,
                     depth - 20.0, depth);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_map;
varying vec2 v_uv;
void main() { gl_FragColor = texture2D(u_map, v_uv); }
`;

const RADIANS = Math.PI / 180;
const FOCAL = 1 / Math.tan(45 * RADIANS / 2);

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`3D shader: ${message}`);
  }
  return shader;
}

function intersectTriangle(origin, direction, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [direction[1] * e2[2] - direction[2] * e2[1],
    direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0]];
  const determinant = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(determinant) < 1e-7) return null;
  const inverse = 1 / determinant;
  const t = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) * inverse;
  if (u < 0 || u > 1) return null;
  const q = [t[1] * e1[2] - t[2] * e1[1],
    t[2] * e1[0] - t[0] * e1[2],
    t[0] * e1[1] - t[1] * e1[0]];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inverse;
  if (v < 0 || u + v > 1) return null;
  const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inverse;
  return distance > 0 ? distance : null;
}

export function normalizeBearing(value) {
  return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

export class Terrain3DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!this.gl) throw new Error("この端末では3D表示を利用できません");
    const gl = this.gl;
    const program = gl.createProgram();
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("3D表示を開始できません");
    this.program = program;
    this.attributes = {
      position: gl.getAttribLocation(program, "a_position"),
      uv: gl.getAttribLocation(program, "a_uv"),
    };
    this.uniforms = Object.fromEntries(["pitch", "bearing", "distance", "focal", "aspect", "map"]
      .map((key) => [key, gl.getUniformLocation(program, `u_${key}`)]));
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.pitch = 55;
    this.bearing = 0;
    this.vertices = null;
    this.indices = null;
    this.textureReady = false;
  }

  setOrientation(pitch, bearing) {
    this.pitch = Math.max(0, Math.min(70, Number(pitch)));
    this.bearing = normalizeBearing(bearing);
    this.render();
  }

  clearGeometry() {
    this.vertices = null;
    this.indices = null;
    this.render();
  }

  setGeometry(result, width, height, metersPerCssPixel) {
    const gl = this.gl;
    const gridStep = Math.max(12, Math.ceil(18 / result.step) * result.step);
    const columns = Math.ceil(width / gridStep) + 1;
    const rows = Math.ceil(height / gridStep) + 1;
    if (columns * rows > 65535) throw new Error("3D表示範囲が広すぎます");
    const centerColumn = Math.min(result.columns - 1, Math.floor(width / 2 / result.step));
    const centerRow = Math.min(result.rows - 1, Math.floor(height / 2 / result.step));
    let referenceElevation = result.elevations[centerRow * result.columns + centerColumn];
    for (let ring = 1; !Number.isFinite(referenceElevation) && ring <= 5; ring++) {
      for (let y = Math.max(0, centerRow - ring); y <= Math.min(result.rows - 1, centerRow + ring); y++) {
        for (let x = Math.max(0, centerColumn - ring); x <= Math.min(result.columns - 1, centerColumn + ring); x++) {
          const candidate = result.elevations[y * result.columns + x];
          if (Number.isFinite(candidate)) referenceElevation = candidate;
        }
      }
    }
    if (!Number.isFinite(referenceElevation)) referenceElevation = 0;
    const vertices = new Float32Array(columns * rows * 5);
    const positions = new Float32Array(columns * rows * 3);
    for (let row = 0; row < rows; row += 1) {
      const y = Math.min(height, row * gridStep);
      const sourceRow = Math.min(result.rows - 1, Math.floor(y / result.step));
      for (let col = 0; col < columns; col += 1) {
        const x = Math.min(width, col * gridStep);
        const sourceCol = Math.min(result.columns - 1, Math.floor(x / result.step));
        const elevation = result.elevations[sourceRow * result.columns + sourceCol];
        const heightPixels = (Number.isFinite(elevation) ? elevation : 0) / metersPerCssPixel
          - referenceElevation / metersPerCssPixel;
        const index = row * columns + col;
        const offset = index * 5;
        vertices.set([x - width / 2, height / 2 - y, heightPixels, x / width, 1 - y / height], offset);
        positions.set([vertices[offset], vertices[offset + 1], vertices[offset + 2]], index * 3);
      }
    }
    const indices = new Uint16Array((columns - 1) * (rows - 1) * 6);
    let at = 0;
    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < columns - 1; col += 1) {
        const a = row * columns + col, b = a + 1, c = a + columns, d = c + 1;
        indices.set([a, c, b, b, c, d], at);
        at += 6;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.vertices = positions;
    this.indices = indices;
    this.surfaceWidth = width;
    this.surfaceHeight = height;
    this.render();
  }

  updateTexture(sourceCanvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    this.textureReady = true;
    this.render();
  }

  render() {
    const gl = this.gl;
    const bounds = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.82, 0.89, 0.94, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.vertices || !this.indices || !this.textureReady) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.pitch, this.pitch * RADIANS);
    gl.uniform1f(this.uniforms.bearing, this.bearing * RADIANS);
    gl.uniform1f(this.uniforms.distance, bounds.height * FOCAL / 2);
    gl.uniform1f(this.uniforms.focal, FOCAL);
    gl.uniform1f(this.uniforms.aspect, bounds.width / bounds.height);
    gl.uniform1i(this.uniforms.map, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(this.attributes.position);
    gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.attributes.uv);
    gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.indices.length, gl.UNSIGNED_SHORT, 0);
  }

  pick(cssX, cssY) {
    if (!this.vertices || !this.indices) return null;
    const bounds = this.canvas.getBoundingClientRect();
    const aspect = bounds.width / bounds.height;
    const pitch = this.pitch * RADIANS, bearing = this.bearing * RADIANS;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cb = Math.cos(bearing), sb = Math.sin(bearing);
    const distance = bounds.height * FOCAL / 2;
    const origin = [-sb * sp * distance, -cb * sp * distance, cp * distance];
    const cameraDirection = [(2 * cssX / bounds.width - 1) * aspect / FOCAL,
      (1 - 2 * cssY / bounds.height) / FOCAL, -1];
    const beforeBearingY = cp * cameraDirection[1] - sp * cameraDirection[2];
    const direction = [cb * cameraDirection[0] + sb * beforeBearingY,
      -sb * cameraDirection[0] + cb * beforeBearingY,
      sp * cameraDirection[1] + cp * cameraDirection[2]];
    let closest = Infinity;
    for (let i = 0; i < this.indices.length; i += 3) {
      const triangle = [0, 1, 2].map((corner) => {
        const at = this.indices[i + corner] * 3;
        return this.vertices.subarray(at, at + 3);
      });
      const hit = intersectTriangle(origin, direction, ...triangle);
      if (hit !== null && hit < closest) closest = hit;
    }
    if (!Number.isFinite(closest)) return null;
    const x = origin[0] + closest * direction[0];
    const y = origin[1] + closest * direction[1];
    return { x: x + this.surfaceWidth / 2, y: this.surfaceHeight / 2 - y };
  }
}
