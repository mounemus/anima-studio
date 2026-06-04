/**
 * ReactionDiffusion — système Gray-Scott simulé sur GPU.
 *
 * Modèle chimique : deux substances U et V diffusent et réagissent selon :
 *   dU/dt = du * ∇²U  -  U*V*V  +  F * (1 - U)
 *   dV/dt = dv * ∇²V  +  U*V*V  -  (F + k) * V
 *
 * Selon (F, k), on obtient des motifs très différents :
 *   - F=0.054, k=0.062 → spots (taches)
 *   - F=0.029, k=0.057 → coral
 *   - F=0.025, k=0.060 → mitosis (spirales)
 *   - F=0.030, k=0.062 → fingerprint
 *   - F=0.062, k=0.061 → U-skate (worms)
 *
 * Architecture rendering :
 *   - 2 WebGLRenderTargets RG_A / RG_B (RGFloat), ping-pong
 *   - simShader : lit RT precedent, écrit le step suivant
 *   - displayShader : lit RT_current et le colore via la palette
 *
 * Interactif :
 *   - Main x,y : splat (injection de V) — la main « peint » des graines vivantes
 *   - Pinch    : taille du splat
 *   - Audio bass : module F (feed)
 *   - Audio high : module k (kill)
 *   - Bouton reset = re-seed pattern initial
 */
import * as THREE from 'three'
import type { Obstacle, VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { trackerStates } from '../ColorTracker'

/** Max number of obstacle-driven splats sampled by the SIM shader each frame.
 *  Each enabled obstacle (circle, hand, tracker, pose joint) emits one splat;
 *  beyond this cap the extras are dropped silently. 12 covers a typical scene. */
const MAX_SPLATS = 12

export type RDPreset = 'spots' | 'coral' | 'mitosis' | 'fingerprint' | 'worms' | 'maze' | 'pulse'

export const RD_PRESETS: Record<RDPreset, { F: number; k: number }> = {
  spots: { F: 0.054, k: 0.062 },
  coral: { F: 0.029, k: 0.057 },
  mitosis: { F: 0.025, k: 0.060 },
  fingerprint: { F: 0.030, k: 0.062 },
  worms: { F: 0.062, k: 0.061 },
  maze: { F: 0.040, k: 0.057 },
  pulse: { F: 0.025, k: 0.054 },
}

export interface ReactionDiffusionParams {
  preset: RDPreset
  F: number              // feed rate (overrides preset if explicit)
  k: number              // kill rate
  du: number             // diffusion U
  dv: number             // diffusion V
  resolution: number     // 128..1024 — RT size (square)
  stepsPerFrame: number  // 1..16 — sim iterations per render frame
  splatSize: number      // 0.01..0.2 — radius of the hand splat (0..1)
  splatStrength: number  // 0..1
  contrast: number       // 0.5..3 — display contrast
}

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`

// SIM SHADER : lit RT_prev (RG = U, V), écrit RT_next (RG = nouveau U, V)
const SIM_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrev;
  uniform vec2 uTexel;
  uniform float uF;
  uniform float uK;
  uniform float uDu;
  uniform float uDv;
  uniform vec2 uSplatPos;    // [-1,-1] = off — primary hand splat (kept for back-compat)
  uniform float uSplatRadius;
  uniform float uSplatStrength;
  // Obstacles & trackers : each entry = (x, y, radius, signedStrength)
  // Positive strength injects V (life), negative removes V (avoid/kill).
  uniform vec4 uSplats[${MAX_SPLATS}];
  uniform int uSplatCount;

  // Discrete Laplacian — 8-cell stencil with weights (Gray-Scott classique)
  vec2 laplacian(vec2 uv) {
    vec2 c = texture2D(uPrev, uv).rg;
    vec2 n = texture2D(uPrev, uv + vec2(0.0,  uTexel.y)).rg;
    vec2 s = texture2D(uPrev, uv + vec2(0.0, -uTexel.y)).rg;
    vec2 e = texture2D(uPrev, uv + vec2( uTexel.x, 0.0)).rg;
    vec2 w = texture2D(uPrev, uv + vec2(-uTexel.x, 0.0)).rg;
    vec2 ne = texture2D(uPrev, uv + uTexel).rg;
    vec2 nw = texture2D(uPrev, uv + vec2(-uTexel.x,  uTexel.y)).rg;
    vec2 se = texture2D(uPrev, uv + vec2( uTexel.x, -uTexel.y)).rg;
    vec2 sw = texture2D(uPrev, uv - uTexel).rg;
    return (n + s + e + w) * 0.2
         + (ne + nw + se + sw) * 0.05
         + c * (-1.0);
  }

  void main() {
    vec2 uvf = texture2D(uPrev, vUv).rg;
    float u = uvf.r;
    float v = uvf.g;
    vec2 lap = laplacian(vUv);
    float reaction = u * v * v;
    float du_dt = uDu * lap.r - reaction + uF * (1.0 - u);
    float dv_dt = uDv * lap.g + reaction - (uF + uK) * v;
    // Use a small dt; the sim runs multiple steps per frame for stability
    float dt = 1.0;
    u += du_dt * dt;
    v += dv_dt * dt;
    // Hand splat: inject V (alive chemical) inside the cursor radius
    if (uSplatPos.x >= 0.0) {
      float d = distance(vUv, uSplatPos);
      if (d < uSplatRadius) {
        float falloff = 1.0 - smoothstep(0.0, uSplatRadius, d);
        v = min(1.0, v + uSplatStrength * falloff);
      }
    }
    // Obstacle / tracker splats — every enabled obstacle in the scene paints
    // into the chemistry: attract = inject V, avoid/kill = remove V. Tracking
    // (color tracker) and pose joints are routed through the same array.
    for (int i = 0; i < ${MAX_SPLATS}; i++) {
      if (i >= uSplatCount) break;
      vec4 sp = uSplats[i];
      if (sp.x < 0.0) continue;
      float d = distance(vUv, sp.xy);
      if (d < sp.z) {
        float falloff = 1.0 - smoothstep(0.0, sp.z, d);
        v = v + sp.w * falloff;
        // When removing life we also re-saturate U to encourage chemistry recovery
        if (sp.w < 0.0) u = min(1.0, u - sp.w * 0.5 * falloff);
      }
    }
    u = clamp(u, 0.0, 1.0);
    v = clamp(v, 0.0, 1.0);
    gl_FragColor = vec4(u, v, 0.0, 1.0);
  }
`

// DISPLAY SHADER : visualise RT_current (RG = U, V) via la palette
const DISPLAY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSrc;
  uniform vec3 uPaletteA;
  uniform vec3 uPaletteB;
  uniform vec3 uPaletteC;
  uniform float uContrast;
  uniform float uHueShift;

  vec3 hueShift(vec3 col, float h) {
    float U = cos(h * 6.2831853);
    float W = sin(h * 6.2831853);
    return vec3(
      (.299 + .701 * U + .168 * W) * col.r + (.587 - .587 * U + .330 * W) * col.g + (.114 - .114 * U - .497 * W) * col.b,
      (.299 - .299 * U - .328 * W) * col.r + (.587 + .413 * U + .035 * W) * col.g + (.114 - .114 * U + .292 * W) * col.b,
      (.299 - .300 * U + 1.250 * W) * col.r + (.587 - .588 * U - 1.050 * W) * col.g + (.114 + .886 * U - .203 * W) * col.b
    );
  }

  void main() {
    vec2 uv = texture2D(uSrc, vUv).rg;
    // Map V (alive) onto a 3-color palette with contrast adjustment
    float t = clamp((uv.g - 0.1) * uContrast, 0.0, 1.0);
    vec3 col = t < 0.5
      ? mix(uPaletteA, uPaletteB, t * 2.0)
      : mix(uPaletteB, uPaletteC, (t - 0.5) * 2.0);
    col = hueShift(col, uHueShift);
    gl_FragColor = vec4(col, 1.0);
  }
`

export class ReactionDiffusionOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  private params: ReactionDiffusionParams
  private rtA: THREE.WebGLRenderTarget
  private rtB: THREE.WebGLRenderTarget
  private currentRT: THREE.WebGLRenderTarget   // points to whichever is current
  private simMat: THREE.ShaderMaterial
  private displayMat: THREE.ShaderMaterial
  private simScene: THREE.Scene
  private simCam: THREE.OrthographicCamera
  private fullQuad: THREE.Mesh
  private res: number
  // Engine writes its renderer here so we can run simulation passes
  renderer: THREE.WebGLRenderer | null = null
  /** Deferred seed flag: the constructor runs before the Engine attaches its
   *  renderer, so the initial pattern must be written on the first update(). */
  private _seeded = false
  private splatArr: THREE.Vector4[] = []

  constructor(params: ReactionDiffusionParams, visual: VisualParams) {
    this.params = params
    this.res = Math.max(64, Math.min(1024, params.resolution))
    // Two ping-pong RTs storing (U, V) as RG channels in floating-point
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    }
    this.rtA = new THREE.WebGLRenderTarget(this.res, this.res, rtOpts)
    this.rtB = new THREE.WebGLRenderTarget(this.res, this.res, rtOpts)
    this.currentRT = this.rtA

    // Sim setup : full-screen quad in a private scene we render into the OFFSCREEN RT
    // Pre-allocate the splat array so the uniform is always a stable Vector4[]
    const splatArr: THREE.Vector4[] = []
    for (let i = 0; i < MAX_SPLATS; i++) splatArr.push(new THREE.Vector4(-1, -1, 0, 0))
    this.splatArr = splatArr
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: this.rtA.texture },
        uTexel: { value: new THREE.Vector2(1 / this.res, 1 / this.res) },
        uF: { value: params.F },
        uK: { value: params.k },
        uDu: { value: params.du },
        uDv: { value: params.dv },
        uSplatPos: { value: new THREE.Vector2(-1, -1) },
        uSplatRadius: { value: params.splatSize },
        uSplatStrength: { value: params.splatStrength },
        uSplats: { value: splatArr },
        uSplatCount: { value: 0 },
      },
    })
    this.simScene = new THREE.Scene()
    this.simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.fullQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat)
    this.simScene.add(this.fullQuad)

    // Display mesh : the user-visible mesh that shows the simulation
    this.displayMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: DISPLAY_FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      uniforms: {
        uSrc: { value: this.rtA.texture },
        uPaletteA: { value: new THREE.Color(visual.palette.bg) },
        uPaletteB: { value: new THREE.Color(visual.palette.primary) },
        uPaletteC: { value: new THREE.Color(visual.palette.glow) },
        uContrast: { value: params.contrast },
        uHueShift: { value: 0 },
      },
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.displayMat)
    // Initial seed is deferred to the first update() — the Engine attaches
    // its renderer AFTER construction, so seeding here would no-op silently.
  }

  /** Initial pattern: small disk of V in the middle, U everywhere. */
  seed() {
    if (!this.renderer) return
    const N = this.res
    const data = new Uint16Array(N * N * 4)   // half-float = 16 bits/channel
    // For HalfFloatType, write float32 values then convert via DataTexture upload? Easier:
    // Use a temporary RGBA float texture then blit. We instead seed via a dedicated shader:
    void data
    // Simpler: render a small seed via a one-shot shader replacing the sim
    const seedMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        void main() {
          vec2 c = vUv - vec2(0.5);
          float d = length(c);
          // U everywhere; V inside a small disk + random scatter
          float u = 1.0;
          float v = d < 0.08 ? 1.0 : 0.0;
          // Add a few random hot spots
          float n = fract(sin(dot(vUv * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
          if (n > 0.997) v = 1.0;
          gl_FragColor = vec4(u, v, 0.0, 1.0);
        }
      `,
    })
    const prev = this.fullQuad.material
    this.fullQuad.material = seedMat
    this.renderer.setRenderTarget(this.rtA)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(this.rtB)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(null)
    this.fullQuad.material = prev
    seedMat.dispose()
    this.currentRT = this.rtA
    this.displayMat.uniforms.uSrc.value = this.currentRT.texture
  }

  setAspect(_a: number) { /* full-screen quad — no aspect handling needed */ }

  updateParams(p: ReactionDiffusionParams) {
    const presetChanged = p.preset !== this.params.preset
    this.params = p
    if (presetChanged && RD_PRESETS[p.preset]) {
      const r = RD_PRESETS[p.preset]
      p.F = r.F; p.k = r.k
    }
    this.simMat.uniforms.uF.value = p.F
    this.simMat.uniforms.uK.value = p.k
    this.simMat.uniforms.uDu.value = p.du
    this.simMat.uniforms.uDv.value = p.dv
    this.simMat.uniforms.uSplatRadius.value = p.splatSize
    this.simMat.uniforms.uSplatStrength.value = p.splatStrength
    this.displayMat.uniforms.uContrast.value = p.contrast
    if (p.resolution !== this.res) {
      this.res = Math.max(64, Math.min(1024, p.resolution))
      this.rtA.setSize(this.res, this.res)
      this.rtB.setSize(this.res, this.res)
      this.simMat.uniforms.uTexel.value.set(1 / this.res, 1 / this.res)
      this.seed()
    }
  }

  applyVisual(visual: VisualParams) {
    ;(this.displayMat.uniforms.uPaletteA.value as THREE.Color).set(visual.palette.bg)
    ;(this.displayMat.uniforms.uPaletteB.value as THREE.Color).set(visual.palette.primary)
    ;(this.displayMat.uniforms.uPaletteC.value as THREE.Color).set(visual.palette.glow)
  }

  update(_dt: number) {
    if (!this.renderer) return
    // Lazy seed — runs once on the first frame, after the Engine has attached its renderer.
    if (!this._seeded) { this.seed(); this._seeded = true }
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    // Audio modulation: bass bumps F (more food), high bumps k (more death)
    this.simMat.uniforms.uF.value = p.F + (a.bass ?? 0) * 0.01
    this.simMat.uniforms.uK.value = p.k + (a.high ?? 0) * 0.005
    // Hand splat: project hand position into the sim space
    if (h.detected) {
      this.simMat.uniforms.uSplatPos.value.set(h.indexTip.x, 1 - h.indexTip.y)
      this.simMat.uniforms.uSplatRadius.value = p.splatSize * (1 + h.pinch * 3)
    } else {
      this.simMat.uniforms.uSplatPos.value.set(-1, -1)
    }
    // Build obstacle / tracker / pose splats — every enabled obstacle pushes
    // chemistry into V. This is how scenes, tracking and obstacles "physically"
    // interact with the simulation (attract = inject life, avoid/kill = remove).
    this.buildObstacleSplats(p)
    // Run N simulation steps per frame, swapping rtA <-> rtB each step
    const steps = Math.max(1, Math.min(16, Math.round(p.stepsPerFrame)))
    for (let i = 0; i < steps; i++) {
      const src = this.currentRT
      const dst = src === this.rtA ? this.rtB : this.rtA
      this.simMat.uniforms.uPrev.value = src.texture
      this.renderer.setRenderTarget(dst)
      this.renderer.render(this.simScene, this.simCam)
      this.currentRT = dst
    }
    this.renderer.setRenderTarget(null)
    this.displayMat.uniforms.uSrc.value = this.currentRT.texture
    // Slow auto hue cycle
    this.displayMat.uniforms.uHueShift.value = (performance.now() * 0.00005) % 1
  }

  /** Collect every enabled obstacle into the splat uniform array.
   *  Coord convention: obstacles are normalized canvas 0..1 (top-left origin)
   *  whereas sim UV uses bottom-left origin, so y is flipped. */
  private buildObstacleSplats(p: ReactionDiffusionParams) {
    const obstacles = (this.obstacles ?? []) as Obstacle[]
    let n = 0
    const baseR = p.splatSize
    const baseS = p.splatStrength
    const arr = this.splatArr
    const push = (x: number, y: number, r: number, s: number) => {
      if (n >= MAX_SPLATS) return
      arr[n].set(x, 1 - y, Math.max(0.005, r), s)
      n++
    }
    const signFor = (kind: Obstacle['interaction'], strength: number) => {
      // attract pulls life in (+V), kill/avoid/bounce push it out (-V)
      const mag = baseS * strength
      if (kind === 'attract') return +mag
      if (kind === 'kill') return -mag
      // avoid + bounce: soft erosion, half magnitude so the field can recover
      return -mag * 0.5
    }
    for (const o of obstacles) {
      if (!o.enabled) continue
      if (o.kind === 'circle' && o.circle) {
        push(o.circle.cx, o.circle.cy, o.circle.r + o.margin * 0.5, signFor(o.interaction, o.strength))
      } else if (o.kind === 'hand' && o.hand && senseBus.hands.detected) {
        const src = o.hand.source === 'index' ? senseBus.hands.indexTip : senseBus.hands.palm
        push(src.x, src.y, o.hand.radius + o.margin * 0.5, signFor(o.interaction, o.strength))
      } else if (o.kind === 'tracker' && o.tracker) {
        const st = trackerStates.get(o.id)
        if (!st || st.confidence < 0.1) continue
        push(st.x, st.y, o.tracker.radius + o.margin * 0.5, signFor(o.interaction, o.strength * st.confidence))
      } else if (o.kind === 'pose' && o.pose && senseBus.pose.detected) {
        for (const ji of o.pose.joints) {
          if (n >= MAX_SPLATS) break
          const j = senseBus.pose.landmarks[ji]
          if (!j || j.vis < 0.3) continue
          push(j.x, j.y, o.pose.radius + o.margin * 0.5, signFor(o.interaction, o.strength * j.vis))
        }
      }
      // polygon + silhouette obstacles still apply to other organisms; for RD
      // they need a mask texture pass — left for a follow-up.
      if (n >= MAX_SPLATS) break
    }
    // Clear unused slots so the shader's early-out is well-defined.
    for (let i = n; i < MAX_SPLATS; i++) arr[i].set(-1, -1, 0, 0)
    this.simMat.uniforms.uSplatCount.value = n
    // Note: assigning .value (same reference) is enough; three.js diffs by reference.
    void baseR
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose()
    this.simMat.dispose(); this.displayMat.dispose()
    this.fullQuad.geometry.dispose()
    this.mesh.geometry.dispose()
  }
}
