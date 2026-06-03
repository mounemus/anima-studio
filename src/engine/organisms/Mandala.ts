/**
 * Mandala — symétrie radiale géométrique interactive.
 *
 * Génère N bras × M points par bras, chaque point en coord polaires modulées
 * par sin(t * freq + r * waves). Les bras tournent ensemble ; le motif est
 * symétrique par rotation d'angle 2π/N.
 *
 * Interactif :
 * - Main x-position : nombre de bras (arms) 3..16 (kaléidoscope)
 * - Main y-position : décale le centre vertical
 * - Pinch           : rayon intérieur (vide central)
 * - Audio bass      : pulsation radiale (les bras respirent)
 * - Audio mid       : vitesse de rotation
 *
 * Compat modifiers : positions exposées en NDC.
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface MandalaParams {
  arms: number            // 3..24
  pointsPerArm: number    // 16..128
  outerRadius: number     // 0.2..1.0
  innerRadius: number     // 0.0..0.5
  waves: number           // 0..6 — ondulations radiales le long du bras
  freq: number            // 0.1..3 — vitesse de l'ondulation
  rotation: number        // -2..2 rad/sec — rotation globale
  thickness: number       // 0.001..0.02 — taille des points
}

const MAX_POINTS = 4096

export class MandalaOrganism {
  mesh!: THREE.Points
  positions: Float32Array
  velocities: Float32Array | null = null
  count: number = 0
  obstacles: any
  private aspect = 1
  private params: MandalaParams
  private mat: THREE.PointsMaterial
  private t = 0
  private rotation = 0
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()
  private effectiveArms = 6
  private effectivePoints = 64

  constructor(params: MandalaParams, visual: VisualParams) {
    this.params = params
    this.recomputeCounts()
    const geo = new THREE.BufferGeometry()
    this.positions = new Float32Array(MAX_POINTS * 3)
    const colors = new Float32Array(MAX_POINTS * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setDrawRange(0, this.count)
    this.mat = new THREE.PointsMaterial({
      size: params.thickness * 100,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.mesh = new THREE.Points(geo, this.mat)
    this.applyVisual(visual)
  }

  private recomputeCounts() {
    const h = senseBus.hands
    // If hand is present, OVERRIDE arms count by x position (3..16) for live performance
    const handArmsOverride = h.detected ? 3 + Math.round(h.indexTip.x * 13) : null
    this.effectiveArms = Math.max(3, Math.min(24, handArmsOverride ?? Math.round(this.params.arms)))
    this.effectivePoints = Math.min(Math.floor(MAX_POINTS / this.effectiveArms), Math.max(4, Math.round(this.params.pointsPerArm)))
    this.count = this.effectiveArms * this.effectivePoints
    if (this.mesh) this.mesh.geometry.setDrawRange(0, this.count)
  }

  setAspect(a: number) { this.aspect = a; void this.aspect }

  updateParams(p: MandalaParams) {
    this.params = p
    this.recomputeCounts()
    this.mat.size = p.thickness * 100
  }

  applyVisual(visual: VisualParams) {
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    this.c3.set(visual.palette.glow)
    // Color buffer rebuilt each update() because counts change with hand
    this.mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  update(dt: number) {
    this.recomputeCounts()
    const p = this.params
    const h = senseBus.hands
    const audio = senseBus.audio
    const arms = this.effectiveArms
    const pts = this.effectivePoints
    // Pinch widens inner hole
    const inner = Math.min(0.7, p.innerRadius + (h.detected ? h.pinch * 0.3 : 0))
    const outer = Math.max(inner + 0.05, p.outerRadius)
    // Audio bass = radial breathing
    const bassPump = 1 + (audio.bass ?? 0) * 0.3
    // Audio mid = rotation speed
    this.rotation += dt * p.rotation * (1 + (audio.mid ?? 0) * 2)
    this.t += dt * p.freq * (1 + (audio.mid ?? 0))
    // Hand y offset
    const cy = h.detected ? -(h.indexTip.y - 0.5) * 0.5 : 0

    const positions = this.positions
    const colors = this.mesh.geometry.attributes.color.array as Float32Array
    const tmp = this.tmp
    let idx = 0
    for (let a = 0; a < arms; a++) {
      const baseAngle = (a / arms) * Math.PI * 2 + this.rotation
      for (let r = 0; r < pts; r++) {
        const radial = inner + (r / (pts - 1)) * (outer - inner)
        // Modulation: radial breathing + angular shimmer
        const breath = 1 + Math.sin(this.t + r * 0.3) * 0.08
        const angleWiggle = Math.sin(this.t * 1.7 + r * p.waves * 0.4) * (0.05 / (1 + r * 0.05))
        const rad = radial * breath * bassPump
        const angle = baseAngle + angleWiggle
        positions[idx * 3]     = Math.cos(angle) * rad
        positions[idx * 3 + 1] = Math.sin(angle) * rad + cy
        positions[idx * 3 + 2] = 0
        // Color: lerp c1→c2→c3 along radius, with hue shift by time per arm
        const t = r / (pts - 1)
        if (t < 0.5) tmp.copy(this.c1).lerp(this.c2, t * 2)
        else tmp.copy(this.c2).lerp(this.c3, (t - 0.5) * 2)
        // Slight per-arm offset for shimmer
        const armHue = 1 + Math.sin(this.t * 0.5 + a * 0.7) * 0.15
        colors[idx * 3]     = tmp.r * armHue
        colors[idx * 3 + 1] = tmp.g * armHue
        colors[idx * 3 + 2] = tmp.b * armHue
        idx++
      }
    }
    ;(this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
