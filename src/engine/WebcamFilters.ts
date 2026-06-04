/**
 * WebcamFilters — interactive AI/artistic shader pipeline applied to the live
 * webcam stream. Each filter is a fragment shader that runs on a WebGL2 quad,
 * reading a VideoTexture every frame and writing to a display canvas that sits
 * where the MirrorView <video> used to. Filters can read live audio (bass/mid/
 * high), pose joints and hand positions from senseBus, making them part of the
 * same reactive ecosystem as the organisms.
 *
 * The pipeline is intentionally small : single pass, no offscreen RT chain, no
 * Three.js. We want filter ↔ webcam latency near zero and we don't need 3D.
 * Adding multi-pass filters later is a matter of allocating one ping-pong RT.
 *
 * Filters are not commercial Instagram-style beauty — they're geometric,
 * informational, glitchy, drawn-feeling. Each surfaces a different aspect of
 * the video signal so artists can compose them with the organism layer.
 */
import { senseBus } from '../senses/SenseBus'

export type WebcamFilterKind =
  | 'none'
  | 'edges'
  | 'ascii'
  | 'halftone'
  | 'posterize'
  | 'kaleidoscope'
  | 'echo'
  | 'liquify'
  | 'chromatic'
  | 'infrared'

export interface WebcamFilterConfig {
  kind: WebcamFilterKind
  /** 0..1 — how much the filter is mixed with the raw video. 1 = pure filter. */
  intensity: number
  /** filter-specific scalar, semantics vary per kind (see each shader's uPar0 use). */
  param0?: number
  /** secondary scalar — see each filter. */
  param1?: number
  /** Tint color, applied in some filters (hex string). */
  color?: string
  /** Audio reactivity 0..1 — how much the audio FFT modulates filter params. */
  audioReact?: number
  /** Pose reactivity 0..1 — bind wrist positions to the filter's spatial params. */
  poseReact?: number
}

export const FILTER_DEFAULTS: Record<WebcamFilterKind, WebcamFilterConfig> = {
  none:         { kind: 'none',         intensity: 1.0 },
  edges:        { kind: 'edges',        intensity: 1.0, param0: 0.15, color: '#00ffa3', audioReact: 0.5 },
  ascii:        { kind: 'ascii',        intensity: 1.0, param0: 8,    color: '#7cffd4', audioReact: 0.6 },
  halftone:     { kind: 'halftone',     intensity: 1.0, param0: 0.012, color: '#ff5aa0', audioReact: 0.4 },
  posterize:    { kind: 'posterize',    intensity: 1.0, param0: 5,    audioReact: 0.3 },
  kaleidoscope: { kind: 'kaleidoscope', intensity: 1.0, param0: 6,    poseReact: 1.0 },
  echo:         { kind: 'echo',         intensity: 1.0, param0: 0.94, audioReact: 0.5 },
  liquify:      { kind: 'liquify',      intensity: 1.0, param0: 0.04, audioReact: 1.0 },
  chromatic:    { kind: 'chromatic',    intensity: 1.0, param0: 0.015, audioReact: 1.0 },
  infrared:     { kind: 'infrared',     intensity: 1.0, param0: 1.0,  audioReact: 0.3 },
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;     // flip Y so video texture is upright
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/** Each fragment is a self-contained shader receiving the common uniform header
 *  defined below. Keep them short — readability matters more than perf here. */
const FRAG_HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVideo;
uniform sampler2D uPrev;     // previous frame (for temporal filters)
uniform vec2 uResolution;
uniform float uTime;
uniform float uIntensity;
uniform float uPar0;
uniform float uPar1;
uniform vec3 uColor;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform vec2 uPose1;         // left wrist (0..1) — for pose-reactive filters
uniform vec2 uPose2;         // right wrist
uniform float uPoseValid;    // 0 or 1

vec3 sampleVideo(vec2 uv) {
  return texture(uVideo, vec2(1.0 - uv.x, uv.y)).rgb;  // mirror horizontally
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`

// ---------- FILTER LIBRARY ----------

const FRAG_PASSTHROUGH = FRAG_HEADER + `
void main() { outColor = vec4(sampleVideo(vUv), 1.0); }`

// EDGES — Sobel magnitude colored with palette + audio-reactive thickness.
const FRAG_EDGES = FRAG_HEADER + `
void main() {
  vec2 px = 1.0 / uResolution;
  float thresh = uPar0 * (1.0 - uBass * 0.7);
  float tl = luma(sampleVideo(vUv + px * vec2(-1.0, -1.0)));
  float t  = luma(sampleVideo(vUv + px * vec2( 0.0, -1.0)));
  float tr = luma(sampleVideo(vUv + px * vec2( 1.0, -1.0)));
  float l  = luma(sampleVideo(vUv + px * vec2(-1.0,  0.0)));
  float r  = luma(sampleVideo(vUv + px * vec2( 1.0,  0.0)));
  float bl = luma(sampleVideo(vUv + px * vec2(-1.0,  1.0)));
  float b  = luma(sampleVideo(vUv + px * vec2( 0.0,  1.0)));
  float br = luma(sampleVideo(vUv + px * vec2( 1.0,  1.0)));
  float gx = (tr + 2.0*r + br) - (tl + 2.0*l + bl);
  float gy = (bl + 2.0*b + br) - (tl + 2.0*t + tr);
  float mag = sqrt(gx*gx + gy*gy);
  float edge = smoothstep(thresh, thresh + 0.05, mag);
  vec3 base = sampleVideo(vUv);
  vec3 edgeCol = uColor * edge;
  vec3 mixed = mix(base * (1.0 - edge * 0.7), edgeCol, edge);
  outColor = vec4(mix(base, mixed, uIntensity), 1.0);
}`

// ASCII — quantize the screen into character cells, pick a glyph by luminance.
// Glyphs are drawn analytically (no atlas needed) using nested if/else luma bins.
// Audio bass scales the character size; high adds jitter.
const FRAG_ASCII = FRAG_HEADER + `
// Tiny 5x7 character lookups via parametric scoring per bin.
float glyphAt(vec2 cell, int bin) {
  // cell is 0..1 within the character box.
  vec2 c = cell * 5.0;
  vec2 idx = floor(c);
  // Index 0..24 in a 5x5 grid
  if (bin == 0) return 0.0;  // space
  if (bin == 1) return (idx.x == 2.0 && idx.y == 4.0) ? 1.0 : 0.0;  // dot
  if (bin == 2) return (idx.y == 2.0) ? 1.0 : 0.0;                  // dash
  if (bin == 3) return ((idx.x == 2.0) || (idx.y == 2.0)) ? 1.0 : 0.0; // plus
  if (bin == 4) return (abs(idx.x - idx.y) < 0.5 || abs(idx.x + idx.y - 4.0) < 0.5) ? 1.0 : 0.0;  // X
  if (bin == 5) return (idx.x == 0.0 || idx.x == 4.0 || idx.y == 0.0 || idx.y == 4.0) ? 1.0 : 0.0;  // O
  if (bin == 6) return 1.0;  // solid
  return 1.0;
}
void main() {
  float cellSize = max(2.0, uPar0 * (1.0 + uBass * 1.5));
  vec2 cell = floor(vUv * uResolution / cellSize) * cellSize / uResolution;
  vec2 inCell = fract(vUv * uResolution / cellSize);
  // Jitter cell by audio high for glitch
  vec2 j = vec2(sin(uTime * 5.0 + cell.y * 100.0), cos(uTime * 4.7 + cell.x * 100.0)) * uHigh * 0.01;
  vec3 col = sampleVideo(cell + cellSize / uResolution * 0.5 + j);
  float L = luma(col);
  int bin = int(clamp(floor(L * 7.0), 0.0, 6.0));
  float g = glyphAt(inCell, bin);
  vec3 tint = mix(uColor, col, 0.5);
  vec3 fxCol = tint * g;
  outColor = vec4(mix(col, fxCol, uIntensity), 1.0);
}`

// HALFTONE — circular dots whose radius encodes luminance, rotated grid.
const FRAG_HALFTONE = FRAG_HEADER + `
void main() {
  float dotSize = max(0.003, uPar0 * (1.0 - uMid * 0.4));
  float angle = uTime * 0.05;
  mat2 R = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  vec2 rUv = R * (vUv - 0.5) + 0.5;
  vec2 grid = mod(rUv, dotSize) / dotSize - 0.5;
  vec3 col = sampleVideo(vUv);
  float L = luma(col);
  float radius = (1.0 - L) * 0.5 + uBass * 0.15;
  float d = length(grid);
  float dotMask = smoothstep(radius, radius - 0.05, d);
  vec3 dotCol = mix(vec3(0.0), uColor, dotMask);
  outColor = vec4(mix(col, dotCol, uIntensity), 1.0);
}`

// POSTERIZE — color quantization, woodblock-print look.
const FRAG_POSTERIZE = FRAG_HEADER + `
void main() {
  float n = max(2.0, uPar0 * (1.0 + uHigh * 1.5));
  vec3 col = sampleVideo(vUv);
  vec3 q = floor(col * n + 0.5) / n;
  // Boost saturation for a stronger graphic feel
  float L = luma(q);
  q = mix(vec3(L), q, 1.3);
  outColor = vec4(mix(sampleVideo(vUv), q, uIntensity), 1.0);
}`

// KALEIDOSCOPE — N-fold mirror symmetry; the center follows the average of
// pose wrists when pose tracking is available, otherwise the screen center.
const FRAG_KALEIDOSCOPE = FRAG_HEADER + `
void main() {
  float segments = max(2.0, floor(uPar0));
  vec2 center = uPoseValid > 0.5 ? (uPose1 + uPose2) * 0.5 : vec2(0.5);
  vec2 d = vUv - center;
  float r = length(d);
  float a = atan(d.y, d.x);
  float seg = 6.2831853 / segments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 uv2 = center + vec2(cos(a), sin(a)) * r;
  uv2 = clamp(uv2, vec2(0.001), vec2(0.999));
  vec3 col = sampleVideo(uv2);
  outColor = vec4(mix(sampleVideo(vUv), col, uIntensity), 1.0);
}`

// ECHO — temporal feedback. Blends current frame with the previous output to
// create motion trails. uPar0 ∈ 0..1 controls the persistence.
const FRAG_ECHO = FRAG_HEADER + `
void main() {
  vec3 cur = sampleVideo(vUv);
  vec3 prev = texture(uPrev, vUv).rgb;
  float k = clamp(uPar0 + uBass * 0.05, 0.0, 0.99);
  vec3 trail = max(cur, prev * k);   // brighter-of accumulator, not just blend
  outColor = vec4(mix(cur, trail, uIntensity), 1.0);
}`

// LIQUIFY — Perlin-ish noise warp; the warp strength rides the bass.
const FRAG_LIQUIFY = FRAG_HEADER + `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
void main() {
  float amp = uPar0 * (1.0 + uBass * 3.0);
  vec2 q = vec2(noise(vUv * 4.0 + uTime * 0.3), noise(vUv * 4.0 - uTime * 0.4));
  vec2 warp = (q - 0.5) * amp;
  vec3 col = sampleVideo(vUv + warp);
  outColor = vec4(mix(sampleVideo(vUv), col, uIntensity), 1.0);
}`

// CHROMATIC — RGB channel split, scaling with bass.
const FRAG_CHROMATIC = FRAG_HEADER + `
void main() {
  vec2 dir = vUv - 0.5;
  float amp = uPar0 * (1.0 + uBass * 5.0);
  float r = sampleVideo(vUv + dir * amp).r;
  float g = sampleVideo(vUv).g;
  float b = sampleVideo(vUv - dir * amp).b;
  outColor = vec4(mix(sampleVideo(vUv), vec3(r, g, b), uIntensity), 1.0);
}`

// INFRARED — false-color thermography (luminance → palette).
const FRAG_INFRARED = FRAG_HEADER + `
vec3 thermalPalette(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 cold = vec3(0.02, 0.05, 0.25);
  vec3 cool = vec3(0.0, 0.4, 0.9);
  vec3 mid  = vec3(0.9, 0.4, 0.7);
  vec3 hot  = vec3(1.0, 0.85, 0.2);
  vec3 white = vec3(1.0);
  if (t < 0.25) return mix(cold, cool, t * 4.0);
  if (t < 0.50) return mix(cool, mid,  (t - 0.25) * 4.0);
  if (t < 0.75) return mix(mid,  hot,  (t - 0.50) * 4.0);
  return mix(hot, white, (t - 0.75) * 4.0);
}
void main() {
  vec3 col = sampleVideo(vUv);
  float t = luma(col) * uPar0 + uMid * 0.1;
  vec3 thermal = thermalPalette(t);
  outColor = vec4(mix(col, thermal, uIntensity), 1.0);
}`

const SHADERS: Record<WebcamFilterKind, string> = {
  none:         FRAG_PASSTHROUGH,
  edges:        FRAG_EDGES,
  ascii:        FRAG_ASCII,
  halftone:     FRAG_HALFTONE,
  posterize:    FRAG_POSTERIZE,
  kaleidoscope: FRAG_KALEIDOSCOPE,
  echo:         FRAG_ECHO,
  liquify:      FRAG_LIQUIFY,
  chromatic:    FRAG_CHROMATIC,
  infrared:     FRAG_INFRARED,
}

// ---------- RUNTIME ----------

function hexToRgb(hex: string | undefined): [number, number, number] {
  if (!hex) return [1, 1, 1]
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [1, 1, 1]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

export class WebcamFilterPass {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private kind: WebcamFilterKind = 'none'
  private videoTexture: WebGLTexture
  private prevTexture: WebGLTexture        // previous-frame snapshot for ECHO
  private vao: WebGLVertexArrayObject
  private uniforms = new Map<string, WebGLUniformLocation | null>()
  private rafId = 0
  private startTime = performance.now()
  private cfg: WebcamFilterConfig = { kind: 'none', intensity: 1 }
  private video: HTMLVideoElement | null = null
  /** Last source dimensions — used to throttle texSubImage updates. */
  private lastVideoTime = -1

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
    if (!gl) throw new Error('WebGL2 unavailable')
    this.gl = gl

    // Full-screen triangle pair
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(0)
    this.vao = vao

    // Allocate video & previous textures
    const mk = () => {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      return t
    }
    this.videoTexture = mk()
    this.prevTexture = mk()

    this.setKind('none')
  }

  setVideo(v: HTMLVideoElement | null) {
    this.video = v
  }

  setConfig(c: WebcamFilterConfig) {
    if (c.kind !== this.kind) this.setKind(c.kind)
    this.cfg = c
  }

  private setKind(k: WebcamFilterKind) {
    const gl = this.gl
    if (this.program) gl.deleteProgram(this.program)
    const vs = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(vs, VERT)
    gl.compileShader(vs)
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('vert error', gl.getShaderInfoLog(vs))
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(fs, SHADERS[k])
    gl.compileShader(fs)
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error(`frag error in '${k}'`, gl.getShaderInfoLog(fs))
    }
    const p = gl.createProgram()!
    gl.attachShader(p, vs)
    gl.attachShader(p, fs)
    gl.bindAttribLocation(p, 0, 'aPos')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('link error', gl.getProgramInfoLog(p))
    }
    gl.deleteShader(vs); gl.deleteShader(fs)
    this.program = p
    this.uniforms.clear()
    const u = (name: string) => this.uniforms.set(name, gl.getUniformLocation(p, name))
    ;[
      'uVideo', 'uPrev', 'uResolution', 'uTime', 'uIntensity',
      'uPar0', 'uPar1', 'uColor', 'uBass', 'uMid', 'uHigh',
      'uPose1', 'uPose2', 'uPoseValid',
    ].forEach(u)
    this.kind = k
  }

  start() {
    if (this.rafId) return
    const loop = () => {
      this.rafId = requestAnimationFrame(loop)
      this.draw()
    }
    loop()
  }

  stop() {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0 }
  }

  private fitCanvas() {
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(2, Math.floor(r.width * dpr))
    const h = Math.max(2, Math.floor(r.height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  private draw() {
    const gl = this.gl
    const v = this.video
    if (!v || v.readyState < 2 || !this.program) return
    this.fitCanvas()
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    // Upload current frame — skip if the video hasn't advanced
    if (v.currentTime !== this.lastVideoTime) {
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v)
      this.lastVideoTime = v.currentTime
    }

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    // Bind video to unit 0
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture)
    gl.uniform1i(this.uniforms.get('uVideo') ?? null, 0)

    // Bind previous frame to unit 1 (for echo)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.prevTexture)
    gl.uniform1i(this.uniforms.get('uPrev') ?? null, 1)

    gl.uniform2f(this.uniforms.get('uResolution') ?? null, this.canvas.width, this.canvas.height)
    gl.uniform1f(this.uniforms.get('uTime') ?? null, (performance.now() - this.startTime) * 0.001)
    gl.uniform1f(this.uniforms.get('uIntensity') ?? null, this.cfg.intensity)
    gl.uniform1f(this.uniforms.get('uPar0') ?? null, this.cfg.param0 ?? 0)
    gl.uniform1f(this.uniforms.get('uPar1') ?? null, this.cfg.param1 ?? 0)
    const [cr, cg, cb] = hexToRgb(this.cfg.color)
    gl.uniform3f(this.uniforms.get('uColor') ?? null, cr, cg, cb)

    // Live sense feed — multiplied by reactivity so the user can dial it out
    const ar = this.cfg.audioReact ?? 0
    gl.uniform1f(this.uniforms.get('uBass') ?? null, (senseBus.audio.bass ?? 0) * ar)
    gl.uniform1f(this.uniforms.get('uMid') ?? null, (senseBus.audio.mid ?? 0) * ar)
    gl.uniform1f(this.uniforms.get('uHigh') ?? null, (senseBus.audio.high ?? 0) * ar)
    const pr = this.cfg.poseReact ?? 0
    const pose = senseBus.pose
    const valid = pose.detected && pr > 0 ? 1 : 0
    const lw = pose.landmarks[15], rw = pose.landmarks[16]
    gl.uniform2f(this.uniforms.get('uPose1') ?? null, lw ? lw.x : 0.4, lw ? lw.y : 0.5)
    gl.uniform2f(this.uniforms.get('uPose2') ?? null, rw ? rw.x : 0.6, rw ? rw.y : 0.5)
    gl.uniform1f(this.uniforms.get('uPoseValid') ?? null, valid)

    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Snapshot the output into the previous-frame texture for the next ECHO pass.
    // copyTexImage2D is GPU-side and free relative to texImage2D from CPU.
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.prevTexture)
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, this.canvas.width, this.canvas.height, 0)
  }

  dispose() {
    this.stop()
    const gl = this.gl
    if (this.program) gl.deleteProgram(this.program)
    gl.deleteTexture(this.videoTexture)
    gl.deleteTexture(this.prevTexture)
    gl.deleteVertexArray(this.vao)
  }
}
