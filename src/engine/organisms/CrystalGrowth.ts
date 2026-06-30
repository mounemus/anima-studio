/**
 * CrystalGrowth — croissance par accrétion sur une grille 3D.
 *
 * Modèle simple inspiré de diffusion-limited aggregation (DLA) mais 3D :
 *   - Commence avec quelques nucléi (cubes centraux)
 *   - À chaque tick, ajoute K nouveaux cubes sur des positions adjacentes
 *     aux cubes déjà existants (pousse comme un cristal)
 *   - Quand le nombre dépasse maxCubes, recycle les plus vieux (FIFO)
 *
 * Métamorphose :
 *   - growthRate (ticks/sec) modulé par audio bass — bass kick = cristallisation rapide
 *   - L'audio high déclenche occasionnellement un "nouveau nucléus" (point de cristallisation)
 *   - La main x/y position le prochain nucléus
 *
 * Rendu : InstancedMesh + PerspectiveCamera privée (comme MengerSponge).
 * Navigable : drag souris orbit, wheel zoom.
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface CrystalGrowthParams {
  maxCubes: number          // 200..4000
  growthRate: number        // 1..30 cubes per second
  cubeSize: number          // 0.6..1.05 fraction of cell
  gridResolution: number    // 16..64 cells per side
  autoOrbitSpeed: number    // 0..3
  fov: number               // 30..90
  ambient: number           // 0..1
  emissive: number          // 0..0.5
}

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`
const COPY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform float uHueShift;
  vec3 hueShift(vec3 col, float h) {
    float U = cos(h * 6.2831853); float W = sin(h * 6.2831853);
    return vec3(
      (.299 + .701 * U + .168 * W) * col.r + (.587 - .587 * U + .330 * W) * col.g + (.114 - .114 * U - .497 * W) * col.b,
      (.299 - .299 * U - .328 * W) * col.r + (.587 + .413 * U + .035 * W) * col.g + (.114 - .114 * U + .292 * W) * col.b,
      (.299 - .300 * U + 1.250 * W) * col.r + (.587 - .588 * U - 1.050 * W) * col.g + (.114 + .886 * U - .203 * W) * col.b
    );
  }
  void main() {
    vec4 c = texture2D(uTex, vUv);
    gl_FragColor = vec4(hueShift(c.rgb, uHueShift), c.a);
  }
`

interface Cell { x: number; y: number; z: number; bornAt: number }

export class CrystalGrowthOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  renderer: THREE.WebGLRenderer | null = null
  private params: CrystalGrowthParams
  private innerScene: THREE.Scene
  private innerCamera: THREE.PerspectiveCamera
  private rt: THREE.WebGLRenderTarget
  private cubeMesh: THREE.InstancedMesh | null = null
  private cubeMat: THREE.MeshPhongMaterial
  private displayMat: THREE.ShaderMaterial
  private cells: Cell[] = []
  private cellSet = new Set<string>()   // 'x,y,z' membership lookup
  private growthAccumulator = 0
  private orbit = 0
  private dummy = new THREE.Object3D()
  private grid = 32
  // Mouse
  private mouseYaw = 0
  private mousePitch = 0
  private mouseDistanceBias = 0
  private lastHighKick = 0

  constructor(params: CrystalGrowthParams, visual: VisualParams) {
    this.params = params
    this.grid = Math.max(16, Math.min(64, Math.round(params.gridResolution)))
    this.innerScene = new THREE.Scene()
    this.innerScene.background = new THREE.Color(visual.palette.bg)
    this.innerCamera = new THREE.PerspectiveCamera(params.fov, 1, 0.01, 100)
    this.innerCamera.position.set(0, 0, 3)
    const amb = new THREE.AmbientLight(0xffffff, params.ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(2, 3, 4)
    this.innerScene.add(amb, dir)
    this.cubeMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(visual.palette.primary),
      emissive: new THREE.Color(visual.palette.glow).multiplyScalar(params.emissive),
      shininess: 60,
      transparent: true, opacity: 0.95,
    })
    this.rt = new THREE.WebGLRenderTarget(1024, 1024, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    })
    this.displayMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COPY_FRAG,
      transparent: true, depthWrite: false,
      uniforms: { uTex: { value: this.rt.texture }, uHueShift: { value: 0 } },
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.displayMat)
    this.seed()
    this.rebuildInstancedMesh()
  }

  private cellKey(x: number, y: number, z: number) { return `${x},${y},${z}` }

  private seed() {
    // 3 starting nuclei near center
    const c = Math.floor(this.grid / 2)
    this.cells = []
    this.cellSet.clear()
    const add = (x: number, y: number, z: number) => {
      this.cells.push({ x, y, z, bornAt: performance.now() })
      this.cellSet.add(this.cellKey(x, y, z))
    }
    add(c, c, c)
    add(c + 1, c, c)
    add(c, c + 1, c)
  }

  private rebuildInstancedMesh() {
    if (this.cubeMesh) {
      this.innerScene.remove(this.cubeMesh)
      this.cubeMesh.geometry.dispose()
    }
    const cellSize = (1 / this.grid) * this.params.cubeSize
    const geo = new THREE.BoxGeometry(cellSize, cellSize, cellSize)
    this.cubeMesh = new THREE.InstancedMesh(geo, this.cubeMat, this.params.maxCubes)
    this.cubeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.innerScene.add(this.cubeMesh)
  }

  /** Try to add `n` new adjacent cells. Returns the number actually added. */
  private growBy(n: number, prefCenter?: { x: number; y: number; z: number }) {
    let added = 0
    for (let i = 0; i < n * 3 && added < n; i++) {
      // Pick a random existing cell (biased toward `prefCenter` if given)
      let pick: Cell
      if (prefCenter && Math.random() < 0.4) {
        // Try to find a cell near the preferred center
        let bestD = Infinity; let bestIdx = 0
        for (let k = 0; k < Math.min(this.cells.length, 32); k++) {
          const idx = Math.floor(Math.random() * this.cells.length)
          const c = this.cells[idx]
          const d = (c.x - prefCenter.x) ** 2 + (c.y - prefCenter.y) ** 2 + (c.z - prefCenter.z) ** 2
          if (d < bestD) { bestD = d; bestIdx = idx }
        }
        pick = this.cells[bestIdx]
      } else {
        pick = this.cells[Math.floor(Math.random() * this.cells.length)]
      }
      // Pick a random face-adjacent neighbor
      const dir = Math.floor(Math.random() * 6)
      const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0
      const dy = dir === 2 ? 1 : dir === 3 ? -1 : 0
      const dz = dir === 4 ? 1 : dir === 5 ? -1 : 0
      const nx = pick.x + dx, ny = pick.y + dy, nz = pick.z + dz
      if (nx < 0 || nx >= this.grid || ny < 0 || ny >= this.grid || nz < 0 || nz >= this.grid) continue
      const key = this.cellKey(nx, ny, nz)
      if (this.cellSet.has(key)) continue
      this.cells.push({ x: nx, y: ny, z: nz, bornAt: performance.now() })
      this.cellSet.add(key)
      added++
    }
    // FIFO: cull oldest when over the cap
    while (this.cells.length > this.params.maxCubes) {
      const old = this.cells.shift()!
      this.cellSet.delete(this.cellKey(old.x, old.y, old.z))
    }
    this.count = this.cells.length
  }

  /** Add a brand new nucleus at a random grid cell (audio high kicks). */
  private newNucleus(near?: { x: number; y: number; z: number }) {
    const tries = near ? 12 : 1
    for (let i = 0; i < tries; i++) {
      const x = near
        ? Math.max(0, Math.min(this.grid - 1, Math.round(near.x + (Math.random() - 0.5) * 4)))
        : Math.floor(Math.random() * this.grid)
      const y = near
        ? Math.max(0, Math.min(this.grid - 1, Math.round(near.y + (Math.random() - 0.5) * 4)))
        : Math.floor(Math.random() * this.grid)
      const z = near
        ? Math.max(0, Math.min(this.grid - 1, Math.round(near.z + (Math.random() - 0.5) * 4)))
        : Math.floor(Math.random() * this.grid)
      const key = this.cellKey(x, y, z)
      if (this.cellSet.has(key)) continue
      this.cells.push({ x, y, z, bornAt: performance.now() })
      this.cellSet.add(key)
      this.count = this.cells.length
      return
    }
  }

  setAspect(a: number) {
    this.innerCamera.aspect = a
    this.innerCamera.updateProjectionMatrix()
  }

  updateParams(p: CrystalGrowthParams) {
    const gridChanged = Math.round(p.gridResolution) !== this.grid
    const sizeChanged = p.cubeSize !== this.params.cubeSize
    const maxChanged = p.maxCubes !== this.params.maxCubes
    this.params = p
    this.innerCamera.fov = p.fov
    this.innerCamera.updateProjectionMatrix()
    if (gridChanged) {
      this.grid = Math.max(16, Math.min(64, Math.round(p.gridResolution)))
      this.seed()
    }
    if (gridChanged || sizeChanged || maxChanged) this.rebuildInstancedMesh()
  }

  applyVisual(visual: VisualParams) {
    if (this.innerScene.background instanceof THREE.Color) this.innerScene.background.set(visual.palette.bg)
    this.cubeMat.color.set(visual.palette.primary)
    this.cubeMat.emissive.set(visual.palette.glow).multiplyScalar(this.params.emissive)
  }

  update(dt: number) {
    if (!this.renderer) return
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    // Growth
    const rate = p.growthRate * (1 + (a.bass ?? 0) * 3)
    this.growthAccumulator += dt * rate
    if (this.growthAccumulator >= 1) {
      const n = Math.floor(this.growthAccumulator)
      this.growthAccumulator -= n
      const handCenter = h.detected
        ? { x: Math.round(h.indexTip.x * this.grid), y: Math.round((1 - h.indexTip.y) * this.grid), z: Math.round(this.grid / 2) }
        : undefined
      this.growBy(n, handCenter)
    }
    // Occasional nucleus on high-frequency kick (rising edge)
    const high = a.high ?? 0
    if (high > 0.45 && this.lastHighKick < 0.25) {
      const handCenter = h.detected
        ? { x: Math.round(h.indexTip.x * this.grid), y: Math.round((1 - h.indexTip.y) * this.grid), z: Math.round(this.grid / 2) }
        : undefined
      this.newNucleus(handCenter)
    }
    this.lastHighKick = high
    // Rebuild instance matrices
    if (this.cubeMesh) {
      for (let i = 0; i < this.cells.length; i++) {
        const c = this.cells[i]
        this.dummy.position.set(
          (c.x + 0.5) / this.grid * 2 - 1,
          (c.y + 0.5) / this.grid * 2 - 1,
          (c.z + 0.5) / this.grid * 2 - 1,
        )
        this.dummy.updateMatrix()
        this.cubeMesh.setMatrixAt(i, this.dummy.matrix)
      }
      this.cubeMesh.count = this.cells.length
      this.cubeMesh.instanceMatrix.needsUpdate = true
    }
    // Camera orbit + mouse
    this.orbit += dt * p.autoOrbitSpeed
    const yaw = this.orbit + this.mouseYaw
    const pitch = Math.sin(this.orbit * 0.4) * 0.25 + this.mousePitch
    const distance = Math.max(1.5, 3.2 - (h.detected ? h.pinch * 1.5 : 0) + this.mouseDistanceBias)
    this.innerCamera.position.set(Math.cos(yaw) * distance, Math.sin(pitch) * distance, Math.sin(yaw) * distance)
    this.innerCamera.lookAt(0, 0, 0)
    // Render
    this.renderer.setRenderTarget(this.rt)
    this.renderer.render(this.innerScene, this.innerCamera)
    this.renderer.setRenderTarget(null)
    this.displayMat.uniforms.uHueShift.value = (performance.now() * 0.0001 + (a.high ?? 0) * 0.3) % 1
  }

  mouseInteract(ev: { kind: string; dxNorm?: number; dyNorm?: number; wheelDelta?: number }) {
    if (ev.kind === 'drag') {
      this.mouseYaw += (ev.dxNorm ?? 0) * Math.PI
      this.mousePitch = Math.max(-1.3, Math.min(1.3, this.mousePitch + (ev.dyNorm ?? 0) * 1.5))
    } else if (ev.kind === 'wheel') {
      this.mouseDistanceBias = Math.max(-2, Math.min(5, this.mouseDistanceBias + (ev.wheelDelta ?? 0) * 0.002))
    }
  }

  dispose() {
    if (this.cubeMesh) {
      this.cubeMesh.geometry.dispose()
      this.innerScene.remove(this.cubeMesh)
    }
    this.cubeMat.dispose()
    this.rt.dispose()
    this.mesh.geometry.dispose()
    this.displayMat.dispose()
  }
}
