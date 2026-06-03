/**
 * MathCurve — courbes paramétriques mathématiques.
 *
 * Choisis une FORMULE (`formula` enum) et anime ses paramètres. La formule
 * échantillonne N points sur t ∈ [0, 2π * cycles] et trace en Points + lignes
 * connectant les voisins (LineSegments).
 *
 * Formules disponibles :
 *  - 'lissajous'    : x = sin(a*t + δ), y = sin(b*t)
 *  - 'rose'         : r = cos(k * θ) — rose curve / rhodonea
 *  - 'spirograph'   : hypotrochoid — R, r, d
 *  - 'butterfly'    : x = sin(t)(e^cos(t) - 2cos(4t) - sin^5(t/12))
 *  - 'lorenz'       : projection 2D du Lorenz attractor (chaos)
 *  - 'heart'        : cardioid paramétrique
 *
 * Tous les params (a, b, k, R, r, d, δ, scale, cycles) sont éditables par
 * l'UI ET par l'IA via le chat. L'IA peut donc "formuler des maths" en
 * choisissant la formula puis en réglant les params (et créer des keyframes
 * timeline qui animent ces params).
 *
 * Interactif :
 *  - Main x/y      : décale (a, b) en live → morphe la courbe
 *  - Pinch         : zoom (scale boost)
 *  - Audio bass    : pulse de scale
 *  - Audio mid     : accélère la rotation des paramètres dans le temps
 *
 * Compat modifiers : expose `positions` (NDC, stride 3).
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export type CurveFormula = 'lissajous' | 'rose' | 'spirograph' | 'butterfly' | 'lorenz' | 'heart'

export interface MathCurveParams {
  formula: CurveFormula
  samples: number      // 100..4000 — number of points along the curve
  cycles: number       // 1..10 — how many full t periods
  a: number            // formula-specific param (e.g. Lissajous x-freq, rose petals)
  b: number            // formula-specific param (e.g. Lissajous y-freq, spirograph R)
  c: number            // formula-specific param (e.g. spirograph r)
  d: number            // formula-specific param (e.g. spirograph d, Lissajous phase)
  scale: number        // 0.1..2 — overall scale
  speed: number        // 0..3 — animation speed (params drift over time)
  thickness: number    // 0.001..0.02 — point size
  lineOpacity: number  // 0..1 — opacity of the connecting line
}

const MAX_SAMPLES = 4000

export class MathCurveOrganism {
  mesh: THREE.Group
  positions: Float32Array
  velocities: Float32Array | null = null
  count: number = 0
  obstacles: any
  private aspect = 1
  private params: MathCurveParams
  private points: THREE.Points
  private line: THREE.Line
  private pointMat: THREE.PointsMaterial
  private lineMat: THREE.LineBasicMaterial
  private t = 0
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()
  // Lorenz integration state — kept across frames for the chaos attractor
  private lz = [0.1, 0, 0]

  constructor(params: MathCurveParams, visual: VisualParams) {
    this.params = params
    this.positions = new Float32Array(MAX_SAMPLES * 3)
    const colors = new Float32Array(MAX_SAMPLES * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.pointMat = new THREE.PointsMaterial({
      size: params.thickness * 200,
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, this.pointMat)
    // Line uses the SAME geometry/buffers — Three.js draws each pair of consecutive
    // points as a connected line, no buffer duplication needed.
    this.lineMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: params.lineOpacity ?? 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    this.line = new THREE.Line(geo, this.lineMat)
    this.mesh = new THREE.Group()
    this.mesh.add(this.line)
    this.mesh.add(this.points)
    this.applyVisual(visual)
    this.recomputeCount()
  }

  private recomputeCount() {
    this.count = Math.max(50, Math.min(MAX_SAMPLES, Math.round(this.params.samples)))
    this.points.geometry.setDrawRange(0, this.count)
    this.line.geometry.setDrawRange(0, this.count)
  }

  setAspect(a: number) { this.aspect = a; void this.aspect }

  updateParams(p: MathCurveParams) {
    this.params = p
    this.pointMat.size = p.thickness * 200
    this.lineMat.opacity = p.lineOpacity ?? 0.5
    this.recomputeCount()
  }

  applyVisual(visual: VisualParams) {
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    this.c3.set(visual.palette.glow)
    const blend = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
    this.pointMat.blending = blend
    this.lineMat.blending = blend
  }

  update(dt: number) {
    const p = this.params
    const h = senseBus.hands
    const audio = senseBus.audio
    this.t += dt * p.speed * (1 + (audio.mid ?? 0))
    const scale = p.scale * (1 + (audio.bass ?? 0) * 0.3) * (h.detected ? 1 + h.pinch * 0.6 : 1)
    // Hand drift on a/b
    const aDrift = h.detected ? (h.indexTip.x - 0.5) * 1.2 : 0
    const bDrift = h.detected ? -(h.indexTip.y - 0.5) * 1.2 : 0
    const a = p.a + aDrift
    const b = p.b + bDrift
    const c = p.c
    const d = p.d
    const samples = this.count
    const cycles = Math.max(0.1, p.cycles)
    const positions = this.positions
    const colors = this.points.geometry.attributes.color.array as Float32Array
    const tmp = this.tmp

    // Lorenz state reset if formula changed away from lorenz (prevents weird seed)
    if (p.formula !== 'lorenz') this.lz = [0.1, 0, 0]

    for (let i = 0; i < samples; i++) {
      const u = i / (samples - 1)              // 0..1
      const t = u * Math.PI * 2 * cycles + this.t * 0.5
      let x = 0, y = 0
      switch (p.formula) {
        case 'lissajous': {
          x = Math.sin(a * t + d)
          y = Math.sin(b * t)
          break
        }
        case 'rose': {
          // r = cos(k * theta); k = a, modulated by b for harmonic offset
          const k = a
          const r = Math.cos(k * t + d) + b * 0.2 * Math.sin(c * t)
          x = r * Math.cos(t)
          y = r * Math.sin(t)
          break
        }
        case 'spirograph': {
          // Hypotrochoid: R = a*0.5 + 0.5, r = c*0.2 + 0.1, d = d
          const R = Math.max(0.3, a * 0.5 + 0.5)
          const rad = Math.max(0.05, c * 0.2 + 0.1)
          const off = d * 0.4 + 0.3
          x = (R - rad) * Math.cos(t) + off * Math.cos(((R - rad) / rad) * t * b)
          y = (R - rad) * Math.sin(t) - off * Math.sin(((R - rad) / rad) * t * b)
          break
        }
        case 'butterfly': {
          // Fay's butterfly curve, normalized
          const e = Math.exp(Math.cos(t * a))
          const fact = (e - 2 * Math.cos(4 * t) - Math.pow(Math.sin(t / 12), 5)) * 0.25
          x = Math.sin(t * b) * fact
          y = Math.cos(t * b) * fact
          break
        }
        case 'lorenz': {
          // Step the Lorenz attractor once per sample (not per frame) for a static trace
          const sigma = 10, rho = 28, beta = 8 / 3
          const stepDt = 0.005 * (1 + (audio.bass ?? 0) * 2) * a   // 'a' tunes integration speed
          const [lx, ly, lz] = this.lz
          const dx = sigma * (ly - lx) * stepDt
          const dy = (lx * (rho - lz) - ly) * stepDt
          const dz = (lx * ly - beta * lz) * stepDt
          this.lz[0] = lx + dx; this.lz[1] = ly + dy; this.lz[2] = lz + dz
          // Project to 2D (XZ plane)
          x = this.lz[0] / 25
          y = (this.lz[2] - 25) / 25
          break
        }
        case 'heart': {
          // Cardioid-ish: 16sin³(t), 13cos(t)-5cos(2t)-2cos(3t)-cos(4t)
          x = Math.pow(Math.sin(t), 3) * a * 0.07
          y = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * b * 0.04
          break
        }
      }
      positions[i * 3]     = x * scale
      positions[i * 3 + 1] = y * scale
      positions[i * 3 + 2] = 0
      // Color: lerp along the curve
      const t01 = u
      if (t01 < 0.5) tmp.copy(this.c1).lerp(this.c2, t01 * 2)
      else tmp.copy(this.c2).lerp(this.c3, (t01 - 0.5) * 2)
      colors[i * 3]     = tmp.r
      colors[i * 3 + 1] = tmp.g
      colors[i * 3 + 2] = tmp.b
    }
    ;(this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
    // Audio high modulates line opacity
    this.lineMat.opacity = (p.lineOpacity ?? 0.5) * (0.6 + (audio.high ?? 0) * 0.8)
  }

  dispose() {
    this.points.geometry.dispose()
    this.pointMat.dispose()
    this.lineMat.dispose()
  }
}
