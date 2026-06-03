/**
 * Psychedelic — tunnel/galaxie swirling 3D-feel.
 *
 * Port direct de l'équation p5.js classique :
 *   a=(x,y, d=mag(k=x/8-25,e=y/8-25)**2/99) => [
 *     (q=x/3 + k*.5/cos(y*5)*sin(d*d-t)) * sin(c=d/2-t/8) + e*sin(d+k-t) + 200,
 *     (q + y/8 + d*9) * cos(c) + 200
 *   ]
 *
 * Réimplémenté en vertex shader GLSL — N×N points dont chacun calcule sa propre
 * position projetée à partir de son index (x,y) et d'un temps animé. Le résultat
 * donne l'illusion d'une projection 3D (l'équation contient sin/cos d'angles
 * dépendant du rayon, créant la perspective). Le simple résultat 2D ressemble à
 * une galaxie qui tourne en perspective.
 *
 * Interactif :
 * - Main (indexTip) : décale le centre + accélère le temps quand on serre (pinch)
 * - Audio (bass)    : pulse l'échelle radiale
 * - Audio (high)    : module la fréquence interne (effet "vibration")
 *
 * Compat modifiers : expose `positions` (Float32Array stride 3), `count`, et
 * un `velocities=null` (le système est entièrement procédural, non basé sur
 * une simulation à pas de temps — les modifiers vortex/gravity peuvent le pousser
 * en mutant positions).
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface PsychedelicParams {
  count: number           // total = grid×grid (clampé à MAX_GRID²)
  speed: number           // 0.1..3 — vitesse de rotation du temps
  freq: number            // 1..10 — fréquence interne (la `*5` originale)
  scale: number           // 0.5..2 — échelle de sortie
  trail: number           // 0.7..0.999 — utilisé par feedback global
  size: number            // 0.5..6 — taille des points
}

const MAX_GRID = 80   // 80×80 = 6400 points max

export class PsychedelicOrganism {
  mesh: THREE.Points
  /** Exposed for the Modifier system (in NDC ~[-1,1]) */
  positions: Float32Array
  /** Procedural organism — no velocity simulation. */
  velocities: Float32Array | null = null
  count: number
  obstacles: any
  private aspect = 1
  private params: PsychedelicParams
  private mat: THREE.PointsMaterial
  private t = 0
  private grid: number = MAX_GRID
  // Hoisted colors to avoid per-frame allocations during applyVisual hue cycling
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()

  constructor(params: PsychedelicParams, visual: VisualParams) {
    this.params = params
    this.grid = Math.max(8, Math.min(MAX_GRID, Math.floor(Math.sqrt(params.count))))
    this.count = this.grid * this.grid
    const geo = new THREE.BufferGeometry()
    this.positions = new Float32Array(MAX_GRID * MAX_GRID * 3)
    const colors = new Float32Array(MAX_GRID * MAX_GRID * 3)
    // Seed positions on a grid (will be overwritten by update())
    for (let j = 0; j < MAX_GRID; j++) {
      for (let i = 0; i < MAX_GRID; i++) {
        const idx = (j * MAX_GRID + i) * 3
        this.positions[idx] = (i / MAX_GRID - 0.5) * 2
        this.positions[idx + 1] = (j / MAX_GRID - 0.5) * 2
        this.positions[idx + 2] = 0
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setDrawRange(0, this.count)
    this.mat = new THREE.PointsMaterial({
      size: params.size * 0.012,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.mesh = new THREE.Points(geo, this.mat)
    this.applyVisual(visual)
  }

  setAspect(a: number) { this.aspect = a }

  updateParams(p: PsychedelicParams) {
    this.params = p
    const newGrid = Math.max(8, Math.min(MAX_GRID, Math.floor(Math.sqrt(p.count))))
    if (newGrid !== this.grid) {
      this.grid = newGrid
      this.count = this.grid * this.grid
      this.mesh.geometry.setDrawRange(0, this.count)
    }
    this.mat.size = p.size * (0.012 + senseBus.audio.bass * 0.02)
  }

  applyVisual(visual: VisualParams) {
    const colors = this.mesh.geometry.attributes.color.array as Float32Array
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    this.c3.set(visual.palette.glow)
    const tmp = this.tmp
    const N = MAX_GRID
    // 3-color HSL-ish radial gradient based on point's grid distance from center
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const dx = i - N / 2, dy = j - N / 2
        const d = Math.sqrt(dx * dx + dy * dy) / (N / 2)  // 0 center → 1 edge
        const t = Math.min(1, d)
        if (t < 0.5) tmp.copy(this.c1).lerp(this.c2, t * 2)
        else tmp.copy(this.c2).lerp(this.c3, (t - 0.5) * 2)
        const idx = (j * N + i) * 3
        colors[idx] = tmp.r; colors[idx + 1] = tmp.g; colors[idx + 2] = tmp.b
      }
    }
    ;(this.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
    this.mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  update(dt: number) {
    const p = this.params
    const h = senseBus.hands
    const audio = senseBus.audio
    // Pinch accelerates time. Audio bass adds radial pump. high adds inner vibration.
    const tSpeed = p.speed * (1 + (h.detected ? h.pinch * 1.8 : 0)) * (Math.PI / 60)
    this.t += dt * tSpeed * 6     // ~p5 default = PI/60 per frame at 60fps → 60dt scale
    const t = this.t

    // Center offset by hand (or stay at origin)
    const cxOffset = h.detected ? (h.indexTip.x - 0.5) * 0.6 * this.aspect : 0
    const cyOffset = h.detected ? -(h.indexTip.y - 0.5) * 0.6 : 0

    // Audio modulations
    const radialPump = 1 + (audio.bass ?? 0) * 0.4
    const freq = p.freq * (1 + (audio.high ?? 0) * 0.6)
    const scale = p.scale * radialPump * 0.011   // map p5 200-range to NDC ~[-1,1]

    const N = this.grid
    const positions = this.positions
    // Iterate grid (same loop bounds as the original p5 code's x=99..299, y=99..299)
    // but mapped to our N×N grid so the visual is identical regardless of resolution
    const STEP = 200 / N
    let idxOut = 0
    for (let jj = 0; jj < N; jj++) {
      const y = 99 + jj * STEP
      for (let ii = 0; ii < N; ii++) {
        const x = 99 + ii * STEP
        const k = x / 8 - 25
        const e = y / 8 - 25
        const d = (k * k + e * e) / 99
        // The original uses cos(y*5); we use cos(y*freq) for audio-driven distortion.
        // Guard against the /cos blow-up by clamping the denominator away from 0.
        const cosArg = y * freq * 0.2
        const cosY = Math.cos(cosArg)
        const cosSafe = Math.abs(cosY) < 0.05 ? 0.05 * Math.sign(cosY || 1) : cosY
        const q = x / 3 + k * 0.5 / cosSafe * Math.sin(d * d - t)
        const c = d / 2 - t / 8
        const px = q * Math.sin(c) + e * Math.sin(d + k - t) + 200
        const py = (q + y / 8 + d * 9) * Math.cos(c) + 200
        // Center on origin then scale to NDC + apply hand offset
        positions[idxOut * 3]     = (px - 200) * scale + cxOffset
        positions[idxOut * 3 + 1] = (py - 200) * scale + cyOffset
        positions[idxOut * 3 + 2] = 0
        idxOut++
      }
    }
    ;(this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mat.dispose()
  }
}
