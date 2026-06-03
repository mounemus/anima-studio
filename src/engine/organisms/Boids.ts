import * as THREE from 'three'
import type { BoidsParams, VisualParams, Obstacle } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'
import { solveObstacles } from '../Obstacles'
import { getSilhouetteMask } from '../../senses/Silhouette'
import { sampleFlow } from '../Flow'

const MAX_COUNT = 5000

export class BoidsOrganism {
  mesh: THREE.InstancedMesh
  private px: Float32Array
  private py: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private dummy = new THREE.Object3D()
  private color = new THREE.Color()
  private aspect = 1
  private count: number
  private params: BoidsParams
  obstacles: Obstacle[] | undefined

  constructor(params: BoidsParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(params.count, MAX_COUNT)
    const geo = new THREE.CircleGeometry(0.01, 8)
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(visual.palette.primary),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      alphaTest: 0.01,
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_COUNT)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = this.count
    // per-instance color
    const colors = new Float32Array(MAX_COUNT * 3)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)

    this.px = new Float32Array(MAX_COUNT)
    this.py = new Float32Array(MAX_COUNT)
    this.vx = new Float32Array(MAX_COUNT)
    this.vy = new Float32Array(MAX_COUNT)
    for (let i = 0; i < MAX_COUNT; i++) {
      this.px[i] = (Math.random() - 0.5) * 2
      this.py[i] = (Math.random() - 0.5) * 2
      this.vx[i] = (Math.random() - 0.5) * 0.2
      this.vy[i] = (Math.random() - 0.5) * 0.2
    }
    this.applyVisual(visual)
  }

  setAspect(a: number) { this.aspect = a }

  updateParams(p: BoidsParams) {
    this.params = p
    this.count = Math.min(p.count, MAX_COUNT)
    this.mesh.count = this.count
  }

  applyVisual(visual: VisualParams) {
    const mat = this.mesh.material as THREE.MeshBasicMaterial
    mat.color.set(visual.palette.primary)
    mat.blending = visual.blendMode === 'add' ? THREE.AdditiveBlending
      : visual.blendMode === 'screen' ? THREE.AdditiveBlending
      : THREE.NormalBlending
    const colors = (this.mesh.instanceColor!.array as Float32Array)
    const c1 = new THREE.Color(visual.palette.primary)
    const c2 = new THREE.Color(visual.palette.secondary)
    for (let i = 0; i < MAX_COUNT; i++) {
      const t = i / MAX_COUNT
      this.color.copy(c1).lerp(c2, t)
      colors[i * 3] = this.color.r
      colors[i * 3 + 1] = this.color.g
      colors[i * 3 + 2] = this.color.b
    }
    this.mesh.instanceColor!.needsUpdate = true
  }

  setTexture(tex: THREE.Texture | null) {
    const mat = this.mesh.material as THREE.MeshBasicMaterial
    mat.map = tex
    if (tex) mat.color.setRGB(1, 1, 1)  // let texture colors show through instanceColor mult
    mat.needsUpdate = true
  }

  update(dt: number) {
    const p = this.params
    const n = this.count
    const aspect = this.aspect
    const vision = p.vision * 0.1
    const vision2 = vision * vision
    const speedScale = p.speed * (0.4 + senseBus.audio.high * 0.6)
    const sepW = p.separation
    const cohW = p.cohesion
    const alnW = p.alignment

    // sense: attract toward hand index tip when detected
    const hand = senseBus.hands
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const handForce = hand.detected ? (0.7 + senseBus.hands.pinch * 1.5) : 0

    // sample-based neighbor approximation for perf: each boid uses 12 random peers
    const samples = 12
    const px = this.px, py = this.py, vx = this.vx, vy = this.vy

    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0  // separation
      let cx = 0, cy = 0  // cohesion target
      let ax = 0, ay = 0  // alignment
      let nC = 0, nA = 0

      for (let s = 0; s < samples; s++) {
        const j = (i + 1 + ((Math.random() * (n - 1)) | 0)) % n
        const dx = px[j] - px[i]
        const dy = py[j] - py[i]
        const d2 = dx * dx + dy * dy
        if (d2 < vision2 && d2 > 0) {
          // cohesion (toward avg neighbor pos)
          cx += px[j]; cy += py[j]; nC++
          // alignment (avg neighbor vel)
          ax += vx[j]; ay += vy[j]; nA++
          // separation (push away if too close)
          if (d2 < vision2 * 0.25) {
            const inv = 1 / Math.max(1e-4, Math.sqrt(d2))
            sx -= dx * inv
            sy -= dy * inv
          }
        }
      }
      if (nC > 0) { cx = cx / nC - px[i]; cy = cy / nC - py[i] }
      if (nA > 0) { ax = ax / nA - vx[i]; ay = ay / nA - vy[i] }

      let fx = sx * sepW + cx * cohW * 1.2 + ax * alnW * 0.8
      let fy = sy * sepW + cy * cohW * 1.2 + ay * alnW * 0.8

      // hand attraction
      if (handForce > 0) {
        const dx = handX - px[i], dy = handY - py[i]
        const d = Math.max(0.05, Math.sqrt(dx * dx + dy * dy))
        fx += (dx / d) * handForce * 0.8
        fy += (dy / d) * handForce * 0.8
      }

      // flow field
      const flow = sampleFlow(px[i], py[i], performance.now() * 0.001)
      fx += flow.fx
      fy += flow.fy

      // obstacles
      if (this.obstacles && this.obstacles.length) {
        const o = solveObstacles(px[i], py[i], aspect, this.obstacles, getSilhouetteMask())
        fx += o.fx
        fy += o.fy
        if (o.kill) {
          px[i] = (Math.random() - 0.5) * 2 * aspect
          py[i] = (Math.random() - 0.5) * 2
          vx[i] = 0; vy[i] = 0
          continue
        }
      }

      // integrate
      vx[i] += fx * dt * 2.0
      vy[i] += fy * dt * 2.0
      // limit speed
      const sp = Math.hypot(vx[i], vy[i])
      const maxSp = 1.2 * speedScale
      if (sp > maxSp) { vx[i] = (vx[i] / sp) * maxSp; vy[i] = (vy[i] / sp) * maxSp }
      // move
      px[i] += vx[i] * dt * speedScale
      py[i] += vy[i] * dt * speedScale
      // wrap
      const ax2 = aspect
      if (px[i] > ax2) px[i] = -ax2
      else if (px[i] < -ax2) px[i] = ax2
      if (py[i] > 1) py[i] = -1
      else if (py[i] < -1) py[i] = 1
    }

    // write matrices — bumped base scale 2x for visibility
    const size = p.size * (1.2 + senseBus.audio.bass * 2.5)
    for (let i = 0; i < n; i++) {
      this.dummy.position.set(px[i], py[i], 0)
      this.dummy.scale.set(size, size, 1)
      this.dummy.rotation.z = Math.atan2(vy[i], vx[i])
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
