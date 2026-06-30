/**
 * MengerSponge — fractale 3D classique, rendue via InstancedMesh.
 *
 * Algorithme :
 *   - Commencer avec 1 cube unité (centre 0,0,0)
 *   - À chaque itération, chaque cube est subdivisé en 27 sous-cubes 3×3×3
 *   - On supprime les 7 cubes "centre de face + centre du cube"
 *   - Il reste 20 cubes par itération → croissance 20^n
 *
 * Comptes :
 *   - n=0 : 1     cube
 *   - n=1 : 20    cubes
 *   - n=2 : 400   cubes
 *   - n=3 : 8000  cubes  (recommandé)
 *   - n=4 : 160000 cubes (lourd)
 *
 * Architecture rendering :
 *   - Scene interne dédiée + PerspectiveCamera privée
 *   - L'organisme rend cette scène dans un RT à chaque frame
 *   - mesh est un FullScreenQuad qui display le RT — intégré au pipeline principal
 *
 * Navigable :
 *   - Caméra orbite automatique (autoOrbitSpeed)
 *   - Main x : modifie la vitesse d'orbite en live
 *   - Main y : tilt vertical
 *   - Pinch  : zoom (FOV inverse)
 *   - Audio bass : pulse l'échelle globale du sponge
 *   - Audio high : décale la teinte de la palette
 *
 * Métamorphose :
 *   - depth parameter (1..4) modifie la profondeur de subdivision en live
 *   - Le rebuild est O(20^n) — re-fait seulement quand depth change
 *   - twistAmount : torsion de chaque cube le long de l'axe Y (effet liquide)
 */
import * as THREE from 'three'
import type { VisualParams } from '../../types/scene'
import { senseBus } from '../../senses/SenseBus'

export interface MengerSpongeParams {
  depth: number              // 1..4
  autoOrbitSpeed: number     // 0..3 rad/s
  fov: number                // 30..90 deg
  twistAmount: number        // 0..2 — rotation per Y-unit
  cubeSize: number           // 0.6..1.05 — fraction of nominal cell size (gaps if <1)
  ambient: number            // 0..1
  bloom: number              // 0..1 (visual hint — palette gain)
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
  uniform float uBloom;
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
    vec3 col = hueShift(c.rgb, uHueShift) * (1.0 + uBloom * 0.6);
    gl_FragColor = vec4(col, c.a);
  }
`

/** Generate the (x, y, z) integer cell centers of a Menger sponge of depth N
 *  in a side-(3^N) grid. Returns a Float32Array of length total*3. */
function buildMengerCells(depth: number): { cells: Float32Array; side: number; count: number } {
  const N = Math.max(1, Math.min(4, Math.round(depth)))
  const side = Math.pow(3, N)
  // Recursive predicate: cell (x, y, z) is in the sponge if, at every level,
  // it's NOT in the central cross of a 3×3×3 block. A cell is central when its
  // ternary digit at that level == 1 in at least 2 of the 3 axes.
  const isInSponge = (x: number, y: number, z: number): boolean => {
    while (x > 0 || y > 0 || z > 0) {
      let middles = 0
      if (x % 3 === 1) middles++
      if (y % 3 === 1) middles++
      if (z % 3 === 1) middles++
      if (middles >= 2) return false
      x = Math.floor(x / 3); y = Math.floor(y / 3); z = Math.floor(z / 3)
    }
    return true
  }
  // First pass: count survivors so we know how big the array needs to be
  let count = 0
  for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    if (isInSponge(x, y, z)) count++
  }
  const cells = new Float32Array(count * 3)
  let idx = 0
  for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    if (isInSponge(x, y, z)) {
      cells[idx * 3]     = x
      cells[idx * 3 + 1] = y
      cells[idx * 3 + 2] = z
      idx++
    }
  }
  return { cells, side, count }
}

export class MengerSpongeOrganism {
  mesh: THREE.Mesh
  positions = new Float32Array(0)
  velocities: Float32Array | null = null
  count = 0
  obstacles: any
  renderer: THREE.WebGLRenderer | null = null
  private params: MengerSpongeParams
  private innerScene: THREE.Scene
  private innerCamera: THREE.PerspectiveCamera
  private rt: THREE.WebGLRenderTarget
  private cubeMesh: THREE.InstancedMesh | null = null
  private displayMat: THREE.ShaderMaterial
  private cubeMat: THREE.MeshPhongMaterial
  private orbit = 0
  private builtDepth = -1
  private c1 = new THREE.Color()
  private c2 = new THREE.Color()
  private _seeded = false

  constructor(params: MengerSpongeParams, visual: VisualParams) {
    this.params = params
    // Internal 3D scene
    this.innerScene = new THREE.Scene()
    this.innerScene.background = new THREE.Color(visual.palette.bg)
    this.innerCamera = new THREE.PerspectiveCamera(params.fov, 1, 0.01, 100)
    this.innerCamera.position.set(0, 0, 3)
    this.innerCamera.lookAt(0, 0, 0)
    // Lights
    const amb = new THREE.AmbientLight(0xffffff, params.ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(2, 3, 4)
    this.innerScene.add(amb, dir)
    // Cube material — uses scene palette
    this.cubeMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(visual.palette.primary),
      emissive: new THREE.Color(visual.palette.glow).multiplyScalar(0.15),
      shininess: 30,
      flatShading: false,
    })
    // Build geometry on first frame (needs renderer for the RT to be sized)
    this.rt = new THREE.WebGLRenderTarget(1024, 1024, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    })
    // Display: full-screen quad showing the RT, with hue shift hook for audio
    this.displayMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COPY_FRAG,
      transparent: true, depthWrite: false,
      uniforms: {
        uTex: { value: this.rt.texture },
        uHueShift: { value: 0 },
        uBloom: { value: params.bloom },
      },
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.displayMat)
  }

  /** (Re)build the InstancedMesh when depth or cubeSize changes. */
  private rebuild() {
    if (this.cubeMesh) {
      this.innerScene.remove(this.cubeMesh)
      this.cubeMesh.geometry.dispose()
      this.cubeMesh = null
    }
    const { cells, side, count } = buildMengerCells(this.params.depth)
    this.count = count
    // Single unit cube geometry shared across instances
    const cellSize = (1 / side) * this.params.cubeSize
    const geo = new THREE.BoxGeometry(cellSize, cellSize, cellSize)
    this.cubeMesh = new THREE.InstancedMesh(geo, this.cubeMat, count)
    this.cubeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Place each cell — centered around origin, fits in [-1, 1] cube
    const dummy = new THREE.Object3D()
    for (let i = 0; i < count; i++) {
      const x = (cells[i * 3] + 0.5) / side * 2 - 1
      const y = (cells[i * 3 + 1] + 0.5) / side * 2 - 1
      const z = (cells[i * 3 + 2] + 0.5) / side * 2 - 1
      dummy.position.set(x, y, z)
      dummy.updateMatrix()
      this.cubeMesh.setMatrixAt(i, dummy.matrix)
    }
    this.cubeMesh.instanceMatrix.needsUpdate = true
    this.innerScene.add(this.cubeMesh)
    this.builtDepth = this.params.depth
  }

  setAspect(a: number) {
    this.innerCamera.aspect = a
    this.innerCamera.updateProjectionMatrix()
  }

  updateParams(p: MengerSpongeParams) {
    const depthChanged = Math.round(p.depth) !== this.builtDepth
    const cubeSizeChanged = p.cubeSize !== this.params.cubeSize
    this.params = p
    this.innerCamera.fov = p.fov
    this.innerCamera.updateProjectionMatrix()
    if (depthChanged || cubeSizeChanged) this.rebuild()
    this.displayMat.uniforms.uBloom.value = p.bloom
  }

  applyVisual(visual: VisualParams) {
    if (this.innerScene.background instanceof THREE.Color) {
      this.innerScene.background.set(visual.palette.bg)
    }
    this.cubeMat.color.set(visual.palette.primary)
    this.cubeMat.emissive.copy(this.c1.set(visual.palette.glow)).multiplyScalar(0.15)
    this.c2.set(visual.palette.secondary)
  }

  update(dt: number) {
    if (!this.renderer) return
    if (!this._seeded) { this.rebuild(); this._seeded = true }
    const p = this.params
    const h = senseBus.hands
    const a = senseBus.audio
    // Orbit — hand x speeds up; audio high adds rotation jitter
    const orbitSpeed = p.autoOrbitSpeed * (1 + (h.detected ? (h.indexTip.x - 0.5) * 2 : 0))
    this.orbit += dt * orbitSpeed
    // Vertical tilt — hand y or default slow oscillation
    const tilt = h.detected ? (h.indexTip.y - 0.5) * 1.2 : Math.sin(this.orbit * 0.3) * 0.4
    // Camera distance — pinch zooms in
    const distance = 3 - (h.detected ? h.pinch * 1.5 : 0)
    this.innerCamera.position.set(
      Math.cos(this.orbit) * distance,
      Math.sin(tilt) * distance,
      Math.sin(this.orbit) * distance,
    )
    this.innerCamera.lookAt(0, 0, 0)
    // Bass pulses the whole sponge's scale (metamorphosis)
    if (this.cubeMesh) {
      const bassScale = 1 + (a.bass ?? 0) * 0.2
      this.cubeMesh.scale.setScalar(bassScale)
      // Twist along Y: rotate the whole mesh — cheaper than per-instance twist
      this.cubeMesh.rotation.y = this.orbit * 0.15 + p.twistAmount * Math.sin(this.orbit)
      this.cubeMesh.rotation.x = tilt * 0.3
    }
    // Render the inner 3D scene into the RT
    this.renderer.setRenderTarget(this.rt)
    this.renderer.render(this.innerScene, this.innerCamera)
    this.renderer.setRenderTarget(null)
    // Audio high shifts the palette hue continuously
    this.displayMat.uniforms.uHueShift.value =
      (performance.now() * 0.0001 + (a.high ?? 0) * 0.3) % 1
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
