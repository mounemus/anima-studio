import * as THREE from 'three'
import type { CellsParams, VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

const MAX = 250

/** Cells — pulsating soft circles attracting/repelling each other. */
export class CellsOrganism {
  mesh: THREE.InstancedMesh
  private px: Float32Array
  private py: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private radius: Float32Array
  private phase: Float32Array
  private dummy = new THREE.Object3D()
  private aspect = 1
  private count: number
  private params: CellsParams
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private cTmp = new THREE.Color()

  constructor(params: CellsParams, visual: VisualParams) {
    this.params = params
    this.count = Math.min(params.count, MAX)
    const geo = new THREE.CircleGeometry(0.5, 24)
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = this.count
    const colors = new Float32Array(MAX * 3)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)

    this.px = new Float32Array(MAX)
    this.py = new Float32Array(MAX)
    this.vx = new Float32Array(MAX)
    this.vy = new Float32Array(MAX)
    this.radius = new Float32Array(MAX)
    this.phase = new Float32Array(MAX)
    for (let i = 0; i < MAX; i++) {
      this.px[i] = (Math.random() - 0.5) * 2
      this.py[i] = (Math.random() - 0.5) * 2
      this.radius[i] = 0.04 + Math.random() * 0.06
      this.phase[i] = Math.random() * Math.PI * 2
    }
    this.applyVisual(visual)
  }

  setAspect(a: number) { this.aspect = a }

  updateParams(p: CellsParams) {
    this.params = p
    this.count = Math.min(p.count, MAX)
    this.mesh.count = this.count
  }

  applyVisual(visual: VisualParams) {
    this.c1.set(visual.palette.primary)
    this.c2.set(visual.palette.secondary)
    const colors = (this.mesh.instanceColor!.array as Float32Array)
    for (let i = 0; i < MAX; i++) {
      this.cTmp.copy(this.c1).lerp(this.c2, this.phase[i] / (Math.PI * 2))
      colors[i * 3] = this.cTmp.r
      colors[i * 3 + 1] = this.cTmp.g
      colors[i * 3 + 2] = this.cTmp.b
    }
    this.mesh.instanceColor!.needsUpdate = true
    const mat = this.mesh.material as THREE.MeshBasicMaterial
    mat.blending = visual.blendMode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending
  }

  setTexture(tex: THREE.Texture | null) {
    const mat = this.mesh.material as THREE.MeshBasicMaterial
    mat.map = tex
    mat.needsUpdate = true
  }

  update(dt: number) {
    const p = this.params
    const n = this.count
    const pulse = p.pulse * (1 + senseBus.audio.bass * 2)
    const attract = p.attraction * 0.02
    const repulse = p.repulsion * 0.04
    const sizeBase = p.size
    const hand = senseBus.hands
    const handX = hand.detected ? (hand.indexTip.x - 0.5) * 2 * this.aspect : 0
    const handY = hand.detected ? -(hand.indexTip.y - 0.5) * 2 : 0
    const handForce = hand.detected ? (0.3 + senseBus.hands.pinch * 1.2) : 0

    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0
      // pairwise forces
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const dx = this.px[j] - this.px[i]
        const dy = this.py[j] - this.py[i]
        const d2 = dx * dx + dy * dy + 1e-4
        const d = Math.sqrt(d2)
        // attraction far, repulsion close
        const sumR = this.radius[i] + this.radius[j]
        if (d < sumR * 2) {
          fx -= (dx / d) * repulse / d
          fy -= (dy / d) * repulse / d
        } else if (d < 0.6) {
          fx += (dx / d) * attract
          fy += (dy / d) * attract
        }
      }
      if (handForce > 0) {
        const dx = handX - this.px[i], dy = handY - this.py[i]
        const d = Math.max(0.05, Math.hypot(dx, dy))
        fx += (dx / d) * handForce * 0.4
        fy += (dy / d) * handForce * 0.4
      }
      this.vx[i] = this.vx[i] * 0.9 + fx
      this.vy[i] = this.vy[i] * 0.9 + fy
      this.px[i] += this.vx[i] * dt
      this.py[i] += this.vy[i] * dt
      // soft bounce
      const ax = this.aspect
      if (this.px[i] > ax) { this.px[i] = ax; this.vx[i] *= -0.5 }
      if (this.px[i] < -ax) { this.px[i] = -ax; this.vx[i] *= -0.5 }
      if (this.py[i] > 1) { this.py[i] = 1; this.vy[i] *= -0.5 }
      if (this.py[i] < -1) { this.py[i] = -1; this.vy[i] *= -0.5 }
      this.phase[i] += dt * (1 + this.radius[i] * 10) * pulse * 0.5

      const r = (this.radius[i] + Math.sin(this.phase[i]) * 0.015) * sizeBase
      this.dummy.position.set(this.px[i], this.py[i], 0)
      this.dummy.scale.set(r, r, 1)
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
