// WebGL2 renderer: runs the per-pixel part of the Reefhue engine on the GPU.
//
// The Rust engine still does all the thinking: it analyses each frame,
// builds the tone curve and the clarity grid and derives every constant
// (engine.gpuFrame). This shader only evaluates the same formula as
// `process` in engine/src/lib.rs, so CPU and GPU output match to within
// rounding (checked by tests/parity).

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform sampler2D uTone;   // 2048x1 R32F, input 0..2
uniform sampler2D uGrid;   // gw x gh R32F, clarity base luminance
uniform vec3 uM, uO;
uniform float uKRed, uWg, uKBlue, uVref, uVeil;
uniform float uClarity, uStrength, uSat, uVib, uWSat, uWLum, uWHue;
uniform mat3 uHue;
uniform vec2 uGridSize;
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float donor(float g, float b) {
  float d = uWg * g + (1.0 - uWg) * b;
  float veil = b - g - uVref;
  return veil > 0.0 ? max(d - uVeil * veil, 0.0) : d;
}
float tone(float v) {
  float i = v * 1024.0;
  if (i <= 0.0) return texelFetch(uTone, ivec2(0, 0), 0).r;
  if (i >= 2047.0) return texelFetch(uTone, ivec2(2047, 0), 0).r;
  float i0 = floor(i);
  float a = texelFetch(uTone, ivec2(int(i0), 0), 0).r;
  float b = texelFetch(uTone, ivec2(int(i0) + 1, 0), 0).r;
  return mix(a, b, i - i0);
}
float grid(vec2 uv) {
  vec2 f = clamp(uv * uGridSize - 0.5, vec2(0.0), uGridSize - 1.0);
  ivec2 p0 = ivec2(f);
  ivec2 p1 = min(p0 + 1, ivec2(uGridSize) - 1);
  vec2 t = f - vec2(p0);
  float a = mix(texelFetch(uGrid, p0, 0).r, texelFetch(uGrid, ivec2(p1.x, p0.y), 0).r, t.x);
  float b = mix(texelFetch(uGrid, ivec2(p0.x, p1.y), 0).r, texelFetch(uGrid, p1, 0).r, t.x);
  return mix(a, b, t.y);
}
void main() {
  vec3 c0 = texture(uSrc, vUv).rgb;
  float r2 = c0.r + uKRed * (1.0 - c0.r) * donor(c0.g, c0.b);
  float b2 = c0.b + uKBlue * (1.0 - c0.b) * c0.g;
  vec3 c = vec3(r2, c0.g, b2) * uM + uO;
  if (uClarity > 0.0) {
    float d = clamp(dot(c, LUMA), 0.0, 1.5) - grid(vUv);
    c += uClarity * d / (1.0 + 4.0 * abs(d));
  }
  vec3 v = vec3(tone(c.r), tone(c.g), tone(c.b));
  if (uWLum != 0.0 || uWHue != 0.0) {
    float water = clamp((min(v.g, v.b) - v.r) * 3.0, 0.0, 1.0);
    if (water > 0.0) {
      if (uWHue != 0.0) v += (uHue * v - v) * water;
      if (uWLum != 0.0) v *= 1.0 + uWLum * 0.6 * water;
    }
  }
  float yv = dot(v, LUMA);
  float s = max(v.r, max(v.g, v.b)) - min(v.r, min(v.g, v.b));
  float f = uSat;
  if (uVib != 0.0) f *= 1.0 + uVib * (1.0 - s) * (uVib > 0.0 ? 1.0 : s + 0.3);
  if (uWSat != 0.0) f *= 1.0 + uWSat * clamp((min(v.g, v.b) - v.r) * 3.0, 0.0, 1.0);
  v = yv + (v - yv) * f;
  if (uStrength < 1.0) v = c0 + (v - c0) * uStrength;
  outColor = vec4(clamp(v, 0.0, 1.0), 1.0);
}`;

export class GpuRenderer {
  /** Returns a renderer, or null when WebGL2 is unavailable. */
  static create() {
    try {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
      });
      if (!gl) return null;
      return new GpuRenderer(canvas, gl);
    } catch {
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    gl.useProgram(p);
    this.u = {};
    for (const n of ['uSrc', 'uTone', 'uGrid', 'uM', 'uO', 'uKRed', 'uWg', 'uKBlue', 'uVref', 'uVeil', 'uClarity',
      'uStrength', 'uSat', 'uVib', 'uWSat', 'uWLum', 'uWHue', 'uHue', 'uGridSize']) this.u[n] = gl.getUniformLocation(p, n);
    gl.uniform1i(this.u.uSrc, 0);
    gl.uniform1i(this.u.uTone, 1);
    gl.uniform1i(this.u.uGrid, 2);
    const tex = (filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tSrc = tex(gl.LINEAR);
    this.tTone = tex(gl.NEAREST);
    this.tGrid = tex(gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DITHER);
  }

  get ok() { return !this.lost && !this.gl.isContextLost(); }

  /**
   * Render `source` (VideoFrame, ImageBitmap, canvas, video or ImageData) at
   * w×h with the constants from engine.gpuFrame(). The result stays in
   * this.canvas, ready for `new VideoFrame(renderer.canvas, ...)`.
   */
  render(source, w, h, frame) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tSrc);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tTone);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, frame.tone.length, 1, 0, gl.RED, gl.FLOAT, frame.tone);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tGrid);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, frame.gw, frame.gh, 0, gl.RED, gl.FLOAT, frame.grid);
    const P = frame.params, u = this.u;
    gl.uniform3f(u.uM, P[0], P[1], P[2]);
    gl.uniform3f(u.uO, P[3], P[4], P[5]);
    gl.uniform1f(u.uKRed, P[6]);
    gl.uniform1f(u.uWg, P[7]);
    gl.uniform1f(u.uKBlue, P[8]);
    gl.uniform1f(u.uVref, P[9]);
    gl.uniform1f(u.uClarity, P[10]);
    gl.uniform1f(u.uStrength, P[11]);
    gl.uniform1f(u.uSat, P[12]);
    gl.uniform1f(u.uVib, P[13]);
    gl.uniform1f(u.uWSat, P[14]);
    gl.uniform1f(u.uWLum, P[15]);
    gl.uniformMatrix3fv(u.uHue, true, P.subarray(16, 25));
    gl.uniform2f(u.uGridSize, frame.gw, frame.gh);
    gl.uniform1f(u.uWHue, P[27]);
    gl.uniform1f(u.uVeil, P[28]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read the last render back as top-down RGBA (for previews and tests). */
  read() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(w * h * 4), row = w * 4;
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
}
