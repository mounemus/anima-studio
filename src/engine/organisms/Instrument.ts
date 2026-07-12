/**
 * Instrument — "Harpe de lumière" : un instrument organique 3D joué aux mains.
 *
 * K cordes lumineuses verticales, chacune = une note d'une gamme. Les bouts de
 * doigts (landmarks MediaPipe 4/8/12/16/20) traversent l'écran → chaque
 * traversée d'une corde la PINCE : la corde vibre (onde sinus amortie) et joue
 * sa note via le polysynth interne, + émet une note OSC (/anima/note) pour
 * piloter Ableton / un vrai mixeur pro via le pont.
 *
 * Rendu : nuage de points lumineux (M points par corde) déplacés horizontalement
 * par l'onde de vibration ; luminosité ∝ énergie de la corde.
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { soundEngine } from '../SoundEngine'
import { oscEngine } from '../OscEngine'

export interface InstrumentParams {
  strings: number       // 5..24 cordes / notes
  root: number          // note MIDI la plus grave (48 = C3)
  scale: string         // 'penta-minor' | 'penta-major' | 'major' | 'minor' | 'dorian' | 'chromatic'
  waveSpeed: number     // vitesse de l'onde de vibration
  decay: number         // amortissement de la vibration (0.85..0.995)
  size: number          // taille des points
  velScale: number      // sensibilité de vélocité au geste
  osc: number           // 0|1 — émettre les notes en OSC (/anima/note)
}

export const INSTRUMENT_SCALES: Record<string, number[]> = {
  'penta-minor': [0, 3, 5, 7, 10],
  'penta-major': [0, 2, 4, 7, 9],
  'major': [0, 2, 4, 5, 7, 9, 11],
  'minor': [0, 2, 3, 5, 7, 8, 10],
  'dorian': [0, 2, 3, 5, 7, 9, 10],
  'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
}

const M = 40                         // points par corde
const FINGERS = [4, 8, 12, 16, 20]   // bouts de doigts (pouce → auriculaire)
const MAX_STRINGS = 24

const VERT = `
  precision highp float;
  attribute float aBright;
  attribute vec3 aColor;
  uniform float uPointPx;
  varying float vB;
  varying vec3 vC;
  void main() {
    vB = aBright; vC = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPointPx * (0.55 + aBright * 0.9);
  }
`
const FRAG = `
  precision highp float;
  varying float vB;
  varying vec3 vC;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    float a = smoothstep(0.25, 0.0, d2) * (0.3 + vB * 0.7);
    gl_FragColor = vec4(vC * (0.6 + vB * 1.1), a);
  }
`

export class InstrumentOrganism {
  mesh: THREE.Points
  count = 0
  renderer: THREE.WebGLRenderer | null = null
  obstacles: any

  private params: InstrumentParams
  private aspect = 1
  private t = 0
  private mat: THREE.ShaderMaterial
  private geo: THREE.BufferGeometry
  private pos: Float32Array
  private col: Float32Array
  private bright: Float32Array
  private baseX: Float32Array
  private phase: Float32Array
  private notes: Int16Array
  private energy: Float32Array          // per-string vibration energy 0..1
  private prevFingerX: Float32Array     // last-frame world x per finger (NaN = unseen)
  private lastPluck: Float32Array       // per-string last pluck time (s)
  private nStrings = 0
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private _sz = new THREE.Vector2()

  constructor(params: InstrumentParams, visual: VisualParams) {
    this.params = params
    this.pos = new Float32Array(MAX_STRINGS * M * 3)
    this.col = new Float32Array(MAX_STRINGS * M * 3)
    this.bright = new Float32Array(MAX_STRINGS * M)
    this.baseX = new Float32Array(MAX_STRINGS)
    this.phase = new Float32Array(MAX_STRINGS)
    this.notes = new Int16Array(MAX_STRINGS)
    this.energy = new Float32Array(MAX_STRINGS)
    this.prevFingerX = new Float32Array(FINGERS.length).fill(NaN)
    this.lastPluck = new Float32Array(MAX_STRINGS)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3))
    this.geo.setAttribute('aBright', new THREE.BufferAttribute(this.bright, 1))
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      uniforms: { uPointPx: { value: 6 } },
    })
    this.mesh = new THREE.Points(this.geo, this.mat)
    this.mesh.frustumCulled = false
    for (let p = 0; p < MAX_STRINGS; p++) this.phase[p] = Math.random() * Math.PI * 2
    this.rebuild(visual)
  }

  private rebuild(visual: VisualParams) {
    const p = this.params
    this.nStrings = Math.max(2, Math.min(MAX_STRINGS, p.strings | 0))
    const intervals = INSTRUMENT_SCALES[p.scale] ?? INSTRUMENT_SCALES['penta-minor']
    this.c1.set(visual.palette.primary); this.c2.set(visual.palette.secondary); this.c3.set(visual.palette.glow)
    const spanX = this.aspect * 0.82
    const tmp = new THREE.Color()
    for (let i = 0; i < this.nStrings; i++) {
      const f = this.nStrings > 1 ? i / (this.nStrings - 1) : 0.5
      this.baseX[i] = -spanX + 2 * spanX * f
      this.notes[i] = p.root + 12 * Math.floor(i / intervals.length) + intervals[i % intervals.length]
      // colour ramp primary → secondary → glow along the harp
      if (f < 0.5) tmp.copy(this.c1).lerp(this.c2, f * 2)
      else tmp.copy(this.c2).lerp(this.c3, (f - 0.5) * 2)
      for (let j = 0; j < M; j++) {
        const idx = i * M + j
        this.col[idx * 3] = tmp.r; this.col[idx * 3 + 1] = tmp.g; this.col[idx * 3 + 2] = tmp.b
      }
    }
    this.count = this.nStrings * M
    this.geo.setDrawRange(0, this.count)
    this.geo.attributes.aColor.needsUpdate = true
  }

  setAspect(a: number) { this.aspect = a; this.rebuildBaseX() }
  private rebuildBaseX() {
    const spanX = this.aspect * 0.82
    for (let i = 0; i < this.nStrings; i++) {
      const f = this.nStrings > 1 ? i / (this.nStrings - 1) : 0.5
      this.baseX[i] = -spanX + 2 * spanX * f
    }
  }

  updateParams(p: InstrumentParams) {
    const changed = p.strings !== this.params.strings || p.scale !== this.params.scale || p.root !== this.params.root
    this.params = p
    if (changed) {
      // reuse current palette from material colours: just recompute layout
      this.rebuildLayout()
    }
  }
  private rebuildLayout() {
    const p = this.params
    this.nStrings = Math.max(2, Math.min(MAX_STRINGS, p.strings | 0))
    const intervals = INSTRUMENT_SCALES[p.scale] ?? INSTRUMENT_SCALES['penta-minor']
    for (let i = 0; i < this.nStrings; i++) {
      this.notes[i] = p.root + 12 * Math.floor(i / intervals.length) + intervals[i % intervals.length]
    }
    this.rebuildBaseX()
    this.count = this.nStrings * M
    this.geo.setDrawRange(0, this.count)
  }

  applyVisual(visual: VisualParams) { this.rebuild(visual) }

  update(dt: number) {
    const p = this.params
    this.t += dt
    const hand = senseBus.hands
    const now = this.t
    const halfH = 0.92

    // --- Pluck detection : each fingertip crossing a string's x plucks it ---
    if (hand.detected) {
      for (let fi = 0; fi < FINGERS.length; fi++) {
        const lm = hand.landmarks[FINGERS[fi]]
        if (!lm) continue
        const fx = (lm.x - 0.5) * 2 * this.aspect      // landmarks already X-mirrored in Hands.ts
        const prev = this.prevFingerX[fi]
        if (Number.isFinite(prev)) {
          for (let i = 0; i < this.nStrings; i++) {
            const bx = this.baseX[i]
            // sign change of (fingerX - stringX) = the finger swept across the string
            if ((prev - bx) * (fx - bx) < 0 && now - this.lastPluck[i] > 0.08) {
              const vel = Math.max(0.2, Math.min(1, Math.abs(fx - prev) * p.velScale))
              this.pluck(i, vel)
              this.lastPluck[i] = now
            }
          }
        }
        this.prevFingerX[fi] = fx
      }
    } else {
      this.prevFingerX.fill(NaN)
    }

    // --- Update geometry : vibrating strings ---
    const waveK = 8.0, sp = p.waveSpeed
    const decay = Math.pow(Math.max(0.5, Math.min(0.999, p.decay)), dt * 60)
    for (let i = 0; i < this.nStrings; i++) {
      this.energy[i] *= decay
      const e = this.energy[i]
      const amp = 0.06 * e
      const bx = this.baseX[i], ph = this.phase[i]
      const b = 0.12 + e * 0.88
      for (let j = 0; j < M; j++) {
        const fy = -halfH + (2 * halfH) * (j / (M - 1))
        const x = bx + Math.sin(fy * waveK + this.t * sp + ph) * amp
        const idx = i * M + j
        this.pos[idx * 3] = x; this.pos[idx * 3 + 1] = fy; this.pos[idx * 3 + 2] = 0
        this.bright[idx] = b
      }
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.aBright.needsUpdate = true

    // point size in px
    let pxPerWorld = 300
    if (this.renderer) { this.renderer.getSize(this._sz); pxPerWorld = (this._sz.y * this.renderer.getPixelRatio()) / 2 }
    this.mat.uniforms.uPointPx.value = Math.max(2, Math.min(80, p.size * pxPerWorld))
  }

  private pluck(i: number, vel: number) {
    this.energy[i] = 1
    const note = this.notes[i]
    const v = vel * this.params.velScale > 0 ? vel : 0.7
    try { soundEngine.pluckNote(note, v, 110) } catch { /* audio not ready */ }
    if (this.params.osc) { try { oscEngine.send('/anima/note', [note, v]) } catch { /* noop */ } }
  }

  dispose() { this.geo.dispose(); this.mat.dispose() }
}
