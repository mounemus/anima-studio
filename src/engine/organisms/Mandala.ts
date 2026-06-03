/**
 * Mandala — géométrie sacrée multi-couches.
 *
 * Compose 3 couches superposées de symétrie radiale, plus un maillage optionnel
 * de connecteurs (LineSegments) qui relie les sommets d'une couche à l'autre
 * selon un skip-pattern (effet "étoile inscrite" / sacred geometry).
 *
 * Couches :
 *  - inner  : petits points proches du centre (rayon 0 → innerRing)
 *  - middle : points à mi-distance (innerRing → midRing)
 *  - outer  : points sur le grand cercle (midRing → outerRadius)
 *
 * Connecteurs : pour chaque sommet `i` du polygone outer (`arms` sommets), trace
 * une ligne vers le sommet `(i + skip) % arms`. Avec `skip=2` on a un pentagramme
 * pour arms=5, avec `skip=3` une étoile à 6 branches pour arms=6, etc. Plusieurs
 * `skipLayers` superposés produisent les patterns denses de l'image de référence.
 *
 * Interactif :
 *  - Main x       : OVERRIDE le nombre de bras (3..16) en live (kaléidoscope)
 *  - Main y       : décale centre verticalement
 *  - Pinch        : ouvre le centre
 *  - Audio bass   : pulsation radiale globale
 *  - Audio mid    : vitesse de rotation
 *  - Audio high   : module l'opacité des connecteurs (clignote en rythme)
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface MandalaParams {
  arms: number              // 3..24
  pointsPerArm: number      // 16..128
  outerRadius: number       // 0.2..1.2
  innerRadius: number       // 0..0.5
  waves: number             // 0..8
  freq: number              // 0.1..3
  rotation: number          // -2..2 rad/sec
  thickness: number         // 0.001..0.03 (taille des points)
  layers: number            // 1..3 — nombre de couches superposées
  connectors: number        // 0..6 — nombre de skip-patterns pour les lignes (0 = pas de lignes)
  connectorOpacity: number  // 0..1 — opacité de base des lignes
}

const MAX_POINTS = 6144
const MAX_LINES = 1024     // segments = 2 vertices each

export class MandalaOrganism {
  mesh: THREE.Group           // Group containing Points + LineSegments
  positions: Float32Array
  velocities: Float32Array | null = null
  count: number = 0
  obstacles: any
  private aspect = 1
  private params: MandalaParams
  private points: THREE.Points
  private lines: THREE.LineSegments
  private pointMat: THREE.PointsMaterial
  private lineMat: THREE.LineBasicMaterial
  private linePositions: Float32Array
  private lineColors: Float32Array
  private t = 0
  private rotation = 0
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private c3 = new THREE.Color()
  private tmp = new THREE.Color()
  private effectiveArms = 6
  private effectivePoints = 64
  private effectiveLayers = 1

  constructor(params: MandalaParams, visual: VisualParams) {
    this.params = params
    // Points geometry
    this.positions = new Float32Array(MAX_POINTS * 3)
    const pointColors = new Float32Array(MAX_POINTS * 3)
    const pointGeo = new THREE.BufferGeometry()
    pointGeo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    pointGeo.setAttribute('color', new THREE.BufferAttribute(pointColors, 3))
    this.pointMat = new THREE.PointsMaterial({
      size: params.thickness * 200,            // ⬆ doubled for visibility
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(pointGeo, this.pointMat)
    // Lines geometry
    this.linePositions = new Float32Array(MAX_LINES * 2 * 3)
    this.lineColors = new Float32Array(MAX_LINES * 2 * 3)
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3))
    lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3))
    this.lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: params.connectorOpacity ?? 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: 1,
    })
    this.lines = new THREE.LineSegments(lineGeo, this.lineMat)
    this.mesh = new THREE.Group()
    this.mesh.add(this.lines)
    this.mesh.add(this.points)
    this.recomputeCounts()
    this.applyVisual(visual)
  }

  private recomputeCounts() {
    const h = senseBus.hands
    const handArmsOverride = h.detected ? 3 + Math.round(h.indexTip.x * 13) : null
    this.effectiveArms = Math.max(3, Math.min(24, handArmsOverride ?? Math.round(this.params.arms)))
    this.effectiveLayers = Math.max(1, Math.min(3, Math.round(this.params.layers ?? 1)))
    // Per-layer points cap so total stays under MAX_POINTS
    const perLayerCap = Math.floor(MAX_POINTS / (this.effectiveArms * this.effectiveLayers))
    this.effectivePoints = Math.min(perLayerCap, Math.max(4, Math.round(this.params.pointsPerArm)))
    this.count = this.effectiveArms * this.effectivePoints * this.effectiveLayers
  }

  setAspect(a: number) { this.aspect = a; void this.aspect }

  updateParams(p: MandalaParams) {
    this.params = p
    this.pointMat.size = p.thickness * 200
    this.lineMat.opacity = p.connectorOpacity ?? 0.4
    this.recomputeCounts()
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
    this.recomputeCounts()
    const p = this.params
    const h = senseBus.hands
    const audio = senseBus.audio
    const arms = this.effectiveArms
    const pts = this.effectivePoints
    const layers = this.effectiveLayers
    const inner = Math.min(0.7, p.innerRadius + (h.detected ? h.pinch * 0.3 : 0))
    const outer = Math.max(inner + 0.05, p.outerRadius)
    const bassPump = 1 + (audio.bass ?? 0) * 0.3
    this.rotation += dt * p.rotation * (1 + (audio.mid ?? 0) * 2)
    this.t += dt * p.freq * (1 + (audio.mid ?? 0))
    const cy = h.detected ? -(h.indexTip.y - 0.5) * 0.5 : 0

    const positions = this.positions
    const colors = this.points.geometry.attributes.color.array as Float32Array
    const tmp = this.tmp

    // Vertex grid: layers × arms — used by connectors. Stored in NDC.
    // Layer 0 = inner (small), Layer 1 = middle, Layer 2 = outer
    const layerVerts: { x: number; y: number }[][] = []

    let idx = 0
    for (let L = 0; L < layers; L++) {
      const layerFrac = layers === 1 ? 1 : L / (layers - 1)         // 0..1
      const layerInner = inner + (outer - inner) * layerFrac * 0.6
      const layerOuter = inner + (outer - inner) * (0.4 + layerFrac * 0.6)
      const layerRotOffset = L * (Math.PI / arms) * (L % 2 === 0 ? 1 : -1)  // alternating tilt
      const verts: { x: number; y: number }[] = []
      for (let a = 0; a < arms; a++) {
        const baseAngle = (a / arms) * Math.PI * 2 + this.rotation + layerRotOffset
        // Record the outer-most vertex of each arm for connector use
        let armOuterX = 0, armOuterY = 0
        for (let r = 0; r < pts; r++) {
          const radial = layerInner + (r / (pts - 1)) * (layerOuter - layerInner)
          const breath = 1 + Math.sin(this.t + r * 0.3 + L * 0.7) * 0.08
          const angleWiggle = Math.sin(this.t * 1.7 + r * p.waves * 0.4 + L * 1.1) * (0.05 / (1 + r * 0.05))
          const rad = radial * breath * bassPump
          const angle = baseAngle + angleWiggle
          const px = Math.cos(angle) * rad
          const py = Math.sin(angle) * rad + cy
          positions[idx * 3]     = px
          positions[idx * 3 + 1] = py
          positions[idx * 3 + 2] = 0
          // Color: gradient + layer hue offset
          const t = r / (pts - 1)
          if (t < 0.5) tmp.copy(this.c1).lerp(this.c2, t * 2)
          else tmp.copy(this.c2).lerp(this.c3, (t - 0.5) * 2)
          const layerHue = 1 + L * 0.15
          const armHue = 1 + Math.sin(this.t * 0.5 + a * 0.7) * 0.15
          colors[idx * 3]     = tmp.r * armHue * layerHue
          colors[idx * 3 + 1] = tmp.g * armHue * layerHue
          colors[idx * 3 + 2] = tmp.b * armHue * layerHue
          if (r === pts - 1) { armOuterX = px; armOuterY = py }
          idx++
        }
        verts.push({ x: armOuterX, y: armOuterY })
      }
      layerVerts.push(verts)
    }
    this.points.geometry.setDrawRange(0, this.count)
    ;(this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true

    // Build connectors (LineSegments) from the OUTER layer vertices
    const nConn = Math.min(6, Math.max(0, Math.round(p.connectors ?? 0)))
    if (nConn > 0 && layerVerts.length > 0) {
      const outerLayer = layerVerts[layerVerts.length - 1]
      let lineIdx = 0
      // For each skip pattern 1..nConn, draw line from vertex i to (i+skip) % arms
      for (let skip = 1; skip <= nConn; skip++) {
        // Avoid degenerate (skip == arms) → same vertex
        if (skip >= arms) break
        // Color shift for each skip level
        const skipT = skip / Math.max(1, nConn)
        if (skipT < 0.5) tmp.copy(this.c1).lerp(this.c2, skipT * 2)
        else tmp.copy(this.c2).lerp(this.c3, (skipT - 0.5) * 2)
        for (let i = 0; i < arms; i++) {
          if (lineIdx >= MAX_LINES) break
          const a = outerLayer[i]
          const b = outerLayer[(i + skip) % arms]
          const off = lineIdx * 6
          this.linePositions[off]     = a.x
          this.linePositions[off + 1] = a.y
          this.linePositions[off + 2] = 0
          this.linePositions[off + 3] = b.x
          this.linePositions[off + 4] = b.y
          this.linePositions[off + 5] = 0
          for (let k = 0; k < 2; k++) {
            this.lineColors[off + k * 3]     = tmp.r
            this.lineColors[off + k * 3 + 1] = tmp.g
            this.lineColors[off + k * 3 + 2] = tmp.b
          }
          lineIdx++
        }
      }
      this.lines.geometry.setDrawRange(0, lineIdx * 2)
      ;(this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
      ;(this.lines.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
      // Audio high modulates connector opacity → flickers in rhythm
      this.lineMat.opacity = (p.connectorOpacity ?? 0.4) * (0.6 + (audio.high ?? 0) * 0.8)
      this.lines.visible = true
    } else {
      this.lines.visible = false
    }
  }

  dispose() {
    this.points.geometry.dispose()
    this.pointMat.dispose()
    this.lines.geometry.dispose()
    this.lineMat.dispose()
  }
}
