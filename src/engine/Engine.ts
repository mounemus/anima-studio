import * as THREE from 'three'
import type { Scene as ArtScene, VisualParams, MappingShape, OrganismKind } from '../types/scene'
import type { OrganismLike } from './organisms'
import { MappingPass } from './MappingPass'
import { senseBus, readSense, sanitizeSenses } from '../senses/SenseBus'
import { getSilhouetteMask } from '../senses/Silhouette'
import { loadTexture } from '../lib/textureLoader'
import type { Obstacle } from '../types/scene'
import { resetCounters, obstacleCounters } from './Obstacles'
import { oscEngine } from './OscEngine'
import { setGPUSilhouette } from './GPUObstacles'
import { soundEngine } from './SoundEngine'
import { setFlow } from './Flow'
import { setTrackers, stopColorTracking } from './ColorTracker'
import { resolveShapeTexture, pruneShapeTextures, setUseMaskedBody, disposeAllContentSources, getWebcamTexture } from './ContentSources'
import { startMaskedWebcam, stopMaskedWebcam } from './MaskedWebcam'
import { createOrganism, ORGANISM_DEFAULTS } from './OrganismFactory'
import { tick as timelineTick, loadTimeline } from './Timeline'
import { tick as melodyTick, loadMelody } from './MelodyEngine'
import { applyModifiers, getColorCycleShift, rotateHueHex, setZonePolygons, type Modifier } from './Modifiers'

export class Engine {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera()
  private organism: OrganismLike | null = null
  private feedbackRT: THREE.WebGLRenderTarget
  private feedbackRT2: THREE.WebGLRenderTarget
  private feedbackQuadScene = new THREE.Scene()
  private feedbackQuadMat: THREE.ShaderMaterial
  /** Mutable mask texture re-uploaded each frame from getSilhouetteMask(). */
  private organismMaskTex!: THREE.DataTexture
  /** Last mask buffer size, used to decide between texImage vs texSubImage. */
  private organismMaskW = 1
  private organismMaskH = 1
  /** Reusable scratch buffers for the Boids/Cells modifier adapter — reallocated
   *  only when the agent count grows, instead of every frame (GC churn). */
  private modPos: Float32Array | null = null
  private modVel: Float32Array | null = null
  private mapping = new MappingPass()
  private mainRT: THREE.WebGLRenderTarget
  private currentScene: ArtScene | null = null
  private lastT = performance.now()
  private rafId = 0
  private container: HTMLElement
  private resizeObserver: ResizeObserver | null = null
  private width = 1; private height = 1
  private bg = new THREE.Color(0x06070d)
  private bgAlpha = 1
  private stats = { fps: 0, frame: 0, fpsAcc: 0, fpsT: performance.now() }
  private currentTextureUrl: string | null = null
  private evolutionT = 0
  private baseValues: Record<string, number> = {}
  /** Per-zone independent organism instances. */
  private zoneOrganisms = new Map<string, {
    kind: OrganismKind
    organism: OrganismLike
    rt: THREE.WebGLRenderTarget
    scene: THREE.Scene
  }>()

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,                  // allow transparent canvas for AR/mirror mode
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,  // for screenshot
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(this.bg, 1)
    container.appendChild(this.renderer.domElement)
    const canvas = this.renderer.domElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'

    this.camera.left = -1; this.camera.right = 1
    this.camera.top = 1; this.camera.bottom = -1
    this.camera.near = -1; this.camera.far = 1
    this.camera.updateProjectionMatrix()

    this.mainRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    this.feedbackRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    this.feedbackRT2 = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })

    // Allocate a 1×1 white DataTexture as the default mask so the feedback
    // shader can always sample uMask even when SelfieSegmenter isn't running.
    const seedMaskTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    seedMaskTex.needsUpdate = true
    this.organismMaskTex = seedMaskTex
    this.feedbackQuadMat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uCurr: { value: null },
        uFade: { value: 0.92 },
        uMask: { value: this.organismMaskTex },
        uMaskValid: { value: 0 },     // 0 = mask off (full pass-through)
        uMaskMode: { value: 0 },      // 0=all, 1=body-only, 2=background-only
        uMaskFeather: { value: 0.15 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uPrev;
        uniform sampler2D uCurr;
        uniform sampler2D uMask;
        uniform float uFade;
        uniform float uMaskValid;
        uniform float uMaskMode;
        uniform float uMaskFeather;
        // Y flip only — senses/Silhouette.ts already mirrors X in the buffer
        // (line 72: "mirror X to match Hands"), so re-flipping here would put
        // the body mask on the wrong side when the person moves. Y still needs
        // a flip because three.js renders bottom-up while the mask is stored
        // top-down (image-coordinate convention).
        float maskWeight(vec2 uv) {
          if (uMaskValid < 0.5 || uMaskMode < 0.5) return 1.0;
          float body = texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r;
          float f = max(0.001, uMaskFeather);
          float edge = smoothstep(0.5 - f, 0.5 + f, body);
          return (uMaskMode < 1.5) ? edge : (1.0 - edge);
        }
        void main() {
          vec3 prev = texture2D(uPrev, vUv).rgb * uFade;
          vec3 curr = texture2D(uCurr, vUv).rgb;
          vec3 c = max(prev, curr);
          float m = maskWeight(vUv);
          // Multiply BOTH the color and the alpha. Killing alpha lets AR mode
          // show the camera through the clipped area; killing color makes
          // the same area read as black in non-AR (where bg is opaque).
          gl_FragColor = vec4(c * m, m);
        }
      `,
    })
    const fbMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.feedbackQuadMat)
    this.feedbackQuadScene.add(fbMesh)

    this.resize()
    // Reconnect OSC if the user had IN/OUT enabled last session.
    oscEngine.autostart()
    window.addEventListener('resize', this.resize)
    // Window 'resize' alone is not enough: the flex/grid container gets its real
    // dimensions AFTER the Engine constructs, with no window event to catch the
    // layout settling — so the first resize() runs at 0×0, clamps to 2×2, and the
    // drawing buffer stays stuck tiny (canvas stretched by CSS to full size but
    // rendering 2×2 px). A ResizeObserver fires on that first layout pass and on
    // any later container-only resize (panel toggles, splitter drags).
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(container)
    this.attachMouseControls(canvas)
    this.loop()
  }

  /** Pointer + wheel listeners on the canvas — forwarded to the current organism
   *  only if it implements mouseInteract (3D organisms : Menger, SuperShape3D, etc.).
   *  2D organisms ignore — their interaction is hand/audio/MIDI based. */
  private mouseDragActive = false
  private lastMouseX = 0
  private lastMouseY = 0
  private attachMouseControls(canvas: HTMLCanvasElement) {
    const onDown = (e: PointerEvent) => {
      // Only react when the click is on the canvas (not when bubbling from an overlay
      // SVG/HTML control). The Stage handler does Alt+click for tap-to-place — we
      // only take over for plain drag (no modifier keys).
      if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return
      if (!(this.organism as any)?.mouseInteract) return
      this.mouseDragActive = true
      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY
      canvas.setPointerCapture?.(e.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (e: PointerEvent) => {
      if (!this.mouseDragActive) return
      const dx = (e.clientX - this.lastMouseX) / canvas.clientWidth
      const dy = (e.clientY - this.lastMouseY) / canvas.clientHeight
      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY
      ;(this.organism as any)?.mouseInteract?.({ kind: 'drag', dxNorm: dx, dyNorm: dy })
    }
    const onUp = (e: PointerEvent) => {
      this.mouseDragActive = false
      canvas.releasePointerCapture?.(e.pointerId)
      canvas.style.cursor = ''
    }
    const onWheel = (e: WheelEvent) => {
      if (!(this.organism as any)?.mouseInteract) return
      e.preventDefault()
      ;(this.organism as any).mouseInteract({ kind: 'wheel', wheelDelta: e.deltaY })
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    // Saved for cleanup
    this._mouseCleanup = () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel as EventListener)
    }
  }
  private _mouseCleanup: (() => void) | null = null

  resize = () => {
    const r = this.container.getBoundingClientRect()
    const w = Math.max(2, Math.floor(r.width))
    const h = Math.max(2, Math.floor(r.height))
    if (w === this.width && h === this.height) return
    this.width = w; this.height = h
    this.renderer.setSize(w, h, false)
    const dpr = this.renderer.getPixelRatio()
    const rtW = Math.floor(w * dpr)
    const rtH = Math.floor(h * dpr)
    this.mainRT.setSize(rtW, rtH)
    this.feedbackRT.setSize(rtW, rtH)
    this.feedbackRT2.setSize(rtW, rtH)
    const aspect = w / h
    this.camera.left = -aspect; this.camera.right = aspect
    this.camera.updateProjectionMatrix()
    if (this.organism) this.organism.setAspect(aspect)
  }

  loadScene(s: ArtScene) {
    this.currentScene = s
    if (this.organism) {
      this.scene.remove(this.organism.mesh)
      this.organism.dispose()
      this.organism = null
    }
    const aspect = this.width / this.height
    this.organism = createOrganism(s.organism.kind, s.organism.values, s.visual)
    if (this.organism) {
      this.organism.setAspect(aspect)
      ;(this.organism as any).obstacles = s.obstacles ?? []
      // Some organisms (ReactionDiffusion, CellularAutomata) need access to the
      // engine renderer to run their own offscreen ping-pong simulation passes.
      ;(this.organism as any).renderer = this.renderer
      this.scene.add(this.organism.mesh)
    }
    // snapshot base values for evolution drift
    this.baseValues = { ...(s.organism.values as unknown as Record<string, number>) }
    this.evolutionT = 0
    // Load the scene's timeline (or default empty one) into the runtime
    loadTimeline(s.timeline as any)
    // Same for the AI-generated melody, if any
    loadMelody((s as any).melody ?? null)
    this.applyVisual(s.visual)
    this.mapping.apply(s.mapping)
    // Sync sonification voices to the scene's obstacles — without this the first
    // scene-load doesn't reach the SoundEngine and "Sonifier cet obstacle" stays
    // silent until the user touches an obstacle field.
    soundEngine.sync(s.obstacles ?? [])
    // Same for color trackers: scene-load should hand them to ColorTracker
    // immediately, otherwise tracker-obstacles only fire after the user re-saves.
    const trackerCfgs = (s.obstacles ?? [])
      .filter((o) => o.enabled && o.kind === 'tracker' && o.tracker)
      .map((o) => ({ id: o.id, h: o.tracker!.h, s: o.tracker!.s, v: o.tracker!.v, tolerance: o.tracker!.tolerance }))
    setTrackers(trackerCfgs)
    // And the flow field — the scene declares it but the Flow module needs it
    setFlow(s.flow)
    // clear feedback
    this.renderer.setRenderTarget(this.feedbackRT)
    this.renderer.clear()
    this.renderer.setRenderTarget(this.feedbackRT2)
    this.renderer.clear()
    this.renderer.setRenderTarget(null)
  }

  updateOrganismParams(p: any) {
    if (this.organism) this.organism.updateParams(p)
    this.baseValues = { ...(p as unknown as Record<string, number>) }
  }

  applyVisual(v: VisualParams) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, visual: v }
    this.bg.set(v.palette.bg)
    if (this.organism) this.organism.applyVisual(v)
    this.feedbackQuadMat.uniforms.uFade.value = v.feedback
    // texture sync
    const newUrl = v.texture?.url ?? null
    if (newUrl !== this.currentTextureUrl) {
      this.currentTextureUrl = newUrl
      if (newUrl) {
        loadTexture(newUrl).then((tex) => {
          if (this.currentTextureUrl === newUrl && this.organism?.setTexture) {
            this.organism.setTexture(tex)
          }
        }).catch((e) => console.warn('Texture load failed', e))
      } else {
        this.organism?.setTexture?.(null)
      }
    }
  }


  /** Sync the active behavior-modifier list. Without this, modifiers added or
   *  edited in the UI sit in the store but never reach the Engine until the
   *  next full scene reload — which is what made Vortex / GravityWell /
   *  ColorCycle / PulseGate / MagneticBands appear "dead" in production. */
  updateModifiers(modifiers: Modifier[]) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, modifiers }
  }

  updateObstacles(obs: Obstacle[]) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, obstacles: obs }
    if (this.organism) (this.organism as any).obstacles = obs
    soundEngine.sync(obs)
    // Sync color trackers
    const trackers = obs
      .filter((o) => o.enabled && o.kind === 'tracker' && o.tracker)
      .map((o) => ({ id: o.id, h: o.tracker!.h, s: o.tracker!.s, v: o.tracker!.v, tolerance: o.tracker!.tolerance }))
    setTrackers(trackers)
  }

  /** Live-update the per-scene sensor filters (Capteurs actifs). Without this the
   *  Engine kept the senses snapshot from loadScene, so toggling "Tracking main +
   *  corps" etc. in the UI had no effect until a full scene reload. */
  updateSenses(s: any) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, senses: s }
  }

  updateFlow(flow: import('../types/scene').FlowField | undefined) {
    if (this.currentScene) this.currentScene = { ...this.currentScene, flow }
    setFlow(flow)
  }

  updateMapping(cfg?: import('../types/scene').MappingConfig) {
    if (cfg) {
      if (this.currentScene) this.currentScene = { ...this.currentScene, mapping: cfg }
      this.mapping.apply(cfg)
    } else if (this.currentScene) {
      this.mapping.apply(this.currentScene.mapping)
    }
    // Sync per-shape content textures
    const c = cfg ?? this.currentScene?.mapping
    const shapes = c?.shapes ?? []
    // Update the masked-body flag BEFORE resolving textures so webcam zones get the right one
    setUseMaskedBody(!!c?.arMaskBody)
    if (c?.arMaskBody) startMaskedWebcam(); else stopMaskedWebcam()
    // Sync per-zone organisms BEFORE resolving textures so the zone RT exists
    this.syncZoneOrganisms(shapes)
    const ids = new Set<string>()
    for (const s of shapes) {
      ids.add(s.id)
      // If this zone has its own organism, use its RT as the source texture.
      // Otherwise fall back to the standard content (video/image/webcam/main organism).
      const zoneOrg = this.zoneOrganisms.get(s.id)
      if (zoneOrg) {
        this.mapping.setShapeTexture(s.id, zoneOrg.rt.texture)
      } else {
        const tex = resolveShapeTexture(s.id, s.content)
        this.mapping.setShapeTexture(s.id, tex)
      }
    }
    pruneShapeTextures(ids)
  }

  private syncZoneOrganisms(shapes: MappingShape[]) {
    const aspect = this.width / this.height
    const wanted = new Map<string, { kind: OrganismKind; values: any }>()
    for (const s of shapes) {
      if (s.content?.type === 'organism' && s.content.organismKind) {
        wanted.set(s.id, {
          kind: s.content.organismKind,
          values: s.content.organismValues ?? ORGANISM_DEFAULTS[s.content.organismKind],
        })
      }
    }
    // Dispose removed — IMPORTANT: clear the mapping's per-shape texture reference
    // BEFORE disposing the RT, otherwise the GPU texture is freed while MappingPass
    // still holds a stale reference and the next sample reads undefined memory.
    for (const [id, entry] of this.zoneOrganisms) {
      if (!wanted.has(id) || wanted.get(id)!.kind !== entry.kind) {
        this.mapping.setShapeTexture(id, null)
        entry.scene.remove(entry.organism.mesh)
        entry.organism.dispose()
        entry.rt.dispose()
        this.zoneOrganisms.delete(id)
      }
    }
    // Create / update
    for (const [id, params] of wanted) {
      let entry = this.zoneOrganisms.get(id)
      if (!entry) {
        const rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType })
        const sc = new THREE.Scene()
        const visual = this.currentScene?.visual ?? {
          palette: { bg: '#000000', primary: '#00ffa3', secondary: '#00d4ff', glow: '#7c3aed' },
          bloom: 0.5, feedback: 0.92, blendMode: 'add' as const, texture: null,
        }
        const org = createOrganism(params.kind, params.values, visual)
        org.setAspect(1)
        // GPU organisms (boids/particles/cells/murmuration now, + reaction-diffusion
        // / cellular-automata) run offscreen sim passes and need the renderer — the
        // main organism gets it in loadScene(), zone organisms must too or they'd
        // render black.
        ;(org as any).renderer = this.renderer
        sc.add(org.mesh)
        entry = { kind: params.kind, organism: org, rt, scene: sc }
        this.zoneOrganisms.set(id, entry)
      }
      entry.organism.updateParams(params.values)
      // Inherit scene-level obstacles for interaction within the zone organism too
      ;(entry.organism as any).obstacles = this.currentScene?.obstacles ?? []
    }
    // Touch aspect to avoid stale warning
    void aspect
  }

  loop = () => {
    this.rafId = requestAnimationFrame(this.loop)
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastT) / 1000)
    this.lastT = now

    // stats
    this.stats.frame++
    this.stats.fpsAcc++
    if (now - this.stats.fpsT > 500) {
      this.stats.fps = Math.round(this.stats.fpsAcc * 1000 / (now - this.stats.fpsT))
      this.stats.fpsAcc = 0
      this.stats.fpsT = now
    }

    if (!this.currentScene) return

    // Sanitize sensor inputs BEFORE anything reads them. Sensors glitch (NaN
    // landmarks, NaN FFT bins) and a single NaN would permanently poison an
    // organism's position buffer. One guard here protects every organism.
    sanitizeSenses()

    // SENSE MASK : the "Capteurs actifs" checkboxes used to be dead — toggled
    // a boolean in the scene but nothing consumed it, so the user couldn't
    // disable hand-tracking interactions without killing the whole webcam
    // (which AR mode needs to stay alive). Now we gate at the source : zero
    // out the senseBus fields the scene opted out of, so every organism +
    // obstacle that reads senseBus.hands / .audio / .light behaves as if the
    // sensor weren't there — without touching the actual MediaPipe pipeline.
    const ss = this.currentScene.senses ?? { hands: true, audio: true, light: true }
    if (ss.hands === false) {
      senseBus.hands.detected = false
      // also damp the pose feed so pose-joint obstacles stop pushing
      senseBus.pose.detected = false
    }
    if (ss.audio === false) {
      senseBus.audio.level = 0
      senseBus.audio.bass = 0
      senseBus.audio.mid = 0
      senseBus.audio.high = 0
    }
    if (ss.light === false) {
      // Light is read by some organisms via brightness — neutralize to mid.
      senseBus.light.brightness = 0.5
      senseBus.light.warmth = 0.5
    }

    // Reset per-frame obstacle counters; record total population for density normalization
    resetCounters()
    soundEngine.totalAgents = (this.currentScene.organism.values as any).count ?? 0

    // ORDER MATTERS : evolution drift runs FIRST (it rebuilds the whole param
    // set from baseValues), THEN timeline + sense-bindings patch on top. If this
    // were reversed, evolution would overwrite the timeline/binding patches every
    // frame and the automation would have no visible effect.

    // Evolution: organic drift of organism params via low-freq noise (in-engine, no React loop)
    if (this.currentScene.evolution.enabled && this.organism) {
      this.evolutionT += dt * this.currentScene.evolution.driftSpeed
      const amp = this.currentScene.evolution.amplitude
      const evolved: Record<string, number> = { ...this.baseValues }
      let idx = 0
      for (const k in this.baseValues) {
        const base = this.baseValues[k]
        if (typeof base !== 'number' || k === 'count' || k === 'length') continue
        const n = Math.sin(this.evolutionT * (0.7 + idx * 0.3) + idx * 1.7) * 0.7
                + Math.sin(this.evolutionT * 2.3 + idx * 0.9) * 0.3
        evolved[k] = Math.max(0, base * (1 + n * amp))
        idx++
      }
      this.organism.updateParams(evolved)
    }

    // Timeline tick: sample every track at the current playhead time and route the
    // resulting patches to the right subsystem WITHOUT going through the React store
    // (which would persist them to localStorage — we only want the visual effect).
    const tPatches = timelineTick()
    if (tPatches.length > 0) this.applyTimelinePatches(tPatches)

    // Sense bindings: read each binding's source, scale to [min,max], and route as a
    // patch (same path scheme as the timeline). Same no-persist semantics.
    const bindings = this.currentScene.senses?.bindings ?? []
    if (bindings.length > 0) {
      const patches: { path: string; value: number | string }[] = []
      for (const b of bindings) {
        let v = readSense(b.source)
        if (b.invert) v = 1 - v
        v = Math.max(0, Math.min(1, v))
        const min = b.range?.[0] ?? 0
        const max = b.range?.[1] ?? 1
        patches.push({ path: b.target, value: min + (max - min) * v })
      }
      this.applyTimelinePatches(patches)
    }

    // Publish the silhouette body mask to the GPU obstacle module (once per frame,
    // consumed by every organism's packObstacles). null when no silhouette obstacle.
    this.updateGPUSilhouette()

    if (this.organism) {
      // Feed the GPU organisms the bounding box of the enabled mapping zones so
      // they can keep agents inside the projection surface ("map walls"). null
      // when mapping is off → no confinement. CPU organisms ignore this field.
      ;(this.organism as any).obstacles = this.effectiveObstacles()
      ;(this.organism as any).mapBounds = this.computeMapBounds()
      this.organism.update(dt)
      // Layer behavior modifiers on top of the base organism update.
      // The organism owns its position/velocity Float32Arrays; we expose them via
      // duck-typed access so modifiers can mutate in place without knowing the
      // specific organism class. Modifiers no-op if the arrays aren't present.
      const mods = (this.currentScene.modifiers ?? []) as Modifier[]
      if (mods.length > 0) {
        const o = this.organism as any
        let positions: Float32Array | undefined = o.positions ?? o.heads?.array
        let velocities: Float32Array | null = o.velocities ?? null
        let count: number = o.count ?? (positions ? positions.length / 3 : 0)
        let separateAgentArrays: { px: Float32Array; py: Float32Array; vx?: Float32Array; vy?: Float32Array } | null = null
        // Boids and Cells store agents as separate px/py/vx/vy arrays, not as
        // interleaved positions[]. Pack them into stride-3/stride-2 buffers for
        // the modifier API and copy back after. Without this adapter, modifiers
        // are completely silent on those organisms — which is exactly what made
        // Vortex/GravityWell/PulseGate/MagneticBands appear dead on Boids+Cells.
        if (!positions && typeof o.px === 'object' && typeof o.py === 'object') {
          count = o.count ?? o.px.length
          // Reuse cached scratch buffers; grow only when the count increases.
          if (!this.modPos || this.modPos.length < count * 3) this.modPos = new Float32Array(count * 3)
          if (o.vx && o.vy && (!this.modVel || this.modVel.length < count * 2)) this.modVel = new Float32Array(count * 2)
          positions = this.modPos
          velocities = o.vx && o.vy ? this.modVel : null
          for (let i = 0; i < count; i++) {
            positions[i * 3] = o.px[i]
            positions[i * 3 + 1] = o.py[i]
            if (velocities) {
              velocities[i * 2] = o.vx[i]
              velocities[i * 2 + 1] = o.vy[i]
            }
          }
          separateAgentArrays = { px: o.px, py: o.py, vx: o.vx, vy: o.vy }
        }
        if (positions && count > 0) {
          // Register the active mapping zone polygons so the 'zoneWalls' modifier
          // (if enabled) can use them as confinement colliders. Cheap : just
          // points the module-global pointer; cleared automatically when the
          // shapes list is empty.
          setZonePolygons(this.currentScene.mapping?.shapes ?? [])
          applyModifiers(positions, velocities, count, dt, this.width / this.height, mods)
          if (separateAgentArrays) {
            // Copy modifier-mutated values back into the organism's storage
            const s = separateAgentArrays
            for (let i = 0; i < count; i++) {
              s.px[i] = positions[i * 3]
              s.py[i] = positions[i * 3 + 1]
              if (s.vx && s.vy && velocities) {
                s.vx[i] = velocities[i * 2]
                s.vy[i] = velocities[i * 2 + 1]
              }
            }
          }
          // Mark the GPU geometry dirty so the next draw picks up modifier-written positions
          const geom = (this.organism.mesh as any).geometry
          if (geom?.attributes?.position) geom.attributes.position.needsUpdate = true
        }
        // ColorCycle modifier — visual-only, so it's outside applyModifiers().
        // Re-issue applyVisual() with a hue-rotated palette so every organism (and
        // any shader uniform that consumes the palette) picks up the live shift.
        // The applyVisual() texture-loading path is a no-op when the URL is unchanged,
        // so this is cheap; the only real work is the per-organism color rebuild.
        const hueShift = getColorCycleShift(mods)
        if (hueShift !== 0 && this.currentScene.visual) {
          const v = this.currentScene.visual
          const shifted = {
            ...v,
            palette: {
              bg: v.palette.bg,
              primary: rotateHueHex(v.palette.primary, hueShift),
              secondary: rotateHueHex(v.palette.secondary, hueShift),
              glow: rotateHueHex(v.palette.glow, hueShift),
            },
          }
          this.organism.applyVisual(shifted)
          for (const e of this.zoneOrganisms.values()) e.organism.applyVisual(shifted)
        }
      }
    }
    // Update + render per-zone organisms FIRST so their RTs are fresh for the mapping pass.
    // Clear with TRANSPARENT (alpha=0) instead of the scene bg color — otherwise the bg color
    // is baked into the zone texture and the mapping shader can't blend cleanly in AR mode.
    const zoneClear = new THREE.Color(0x000000)
    for (const entry of this.zoneOrganisms.values()) {
      entry.organism.update(dt)
      this.renderer.setRenderTarget(entry.rt)
      this.renderer.setClearColor(zoneClear, 0)
      this.renderer.clear()
      this.renderer.render(entry.scene, this.camera)
    }
    // After organisms moved, push counters → audio
    soundEngine.tick()
    // OSC OUT — stream audio levels + agent count + obstacle hit counters (~30 Hz)
    oscEngine.tickOut(now, senseBus.audio, (this.currentScene.organism.values as any).count ?? 0, obstacleCounters)
    // AI-generated melody sequencer — fires virtual notes; the polysynth
    // tick that follows turns them into audio in the same frame.
    melodyTick()
    // Polysynth: poll MIDI notes (USB or virtual) and trigger/release voices
    soundEngine.tickMidi()

    // render main organism to mainRT
    this.renderer.setRenderTarget(this.mainRT)
    this.renderer.setClearColor(this.bg, this.bgAlpha)
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)

    // Refresh the organism-mask uniform set : push the SelfieSegmenter buffer
    // into the DataTexture if the scene asks for body/background clipping.
    // The shader treats uMaskValid=0 as full pass-through, so the cost of
    // doing nothing when applyTo='all' is just a single uniform write.
    const omCfg = this.currentScene.organismMask
    const omActive = !!omCfg && omCfg.mode !== 'all'
    const silMask = omActive ? getSilhouetteMask() : null
    if (silMask && omActive) {
      if (silMask.w !== this.organismMaskW || silMask.h !== this.organismMaskH) {
        // Re-create a sized DataTexture — re-using the GPU object would
        // require manually setting image.width/height + needsUpdate which
        // three.js handles cleanly via a fresh DataTexture for the rare
        // resize case.
        const rgba = new Uint8Array(silMask.w * silMask.h * 4)
        for (let i = 0; i < silMask.data.length; i++) {
          const v = silMask.data[i]
          rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255
        }
        const tex = new THREE.DataTexture(rgba, silMask.w, silMask.h)
        tex.needsUpdate = true
        this.organismMaskTex.dispose()
        this.organismMaskTex = tex
        this.feedbackQuadMat.uniforms.uMask.value = tex
        this.organismMaskW = silMask.w
        this.organismMaskH = silMask.h
      } else {
        // Same size — just rewrite the buffer and flag for re-upload.
        const rgba = this.organismMaskTex.image.data as Uint8Array
        for (let i = 0; i < silMask.data.length; i++) {
          const v = silMask.data[i]
          rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255
        }
        this.organismMaskTex.needsUpdate = true
      }
    }
    this.feedbackQuadMat.uniforms.uMaskValid.value = (omActive && silMask) ? 1 : 0
    this.feedbackQuadMat.uniforms.uMaskMode.value =
      !omActive ? 0 : omCfg!.mode === 'body' ? 1 : 2
    this.feedbackQuadMat.uniforms.uMaskFeather.value = omCfg?.feather ?? 0.15

    // feedback blend mainRT into feedbackRT
    this.feedbackQuadMat.uniforms.uPrev.value = this.feedbackRT.texture
    this.feedbackQuadMat.uniforms.uCurr.value = this.mainRT.texture
    this.renderer.setRenderTarget(this.feedbackRT2)
    this.renderer.render(this.feedbackQuadScene, this.camera)
    // swap
    const tmp = this.feedbackRT
    this.feedbackRT = this.feedbackRT2
    this.feedbackRT2 = tmp

    // Chroma-key (green screen) : bind the live webcam so zones with a color key
    // mask their content to the matching object, per-pixel, following it live.
    this.mapping.setChromaWebcam(
      this.currentScene.mapping?.shapes?.some((s) => s.chromaKey) ? getWebcamTexture() : null,
    )

    // final draw: mapping (always-on; identity quad if no mapping)
    this.mapping.setSource(this.feedbackRT.texture)
    this.renderer.setRenderTarget(null)
    this.renderer.setClearColor(0x000000, this.bgAlpha)
    this.renderer.clear()
    this.renderer.render(this.mapping.scene, this.mapping.camera)
  }

  private silObsTex: THREE.DataTexture | null = null
  private silObsW = 0; private silObsH = 0
  /** Upload the SelfieSegmenter body mask to a texture and hand it to the GPU
   *  obstacle module so GPU organisms (boids/particles/cells/murmuration) avoid /
   *  bounce off / are killed by the body — same behaviour the CPU solver gives. */
  private updateGPUSilhouette() {
    const obs = this.currentScene?.obstacles?.find((o) => o.enabled && o.kind === 'silhouette')
    const mask = obs ? getSilhouetteMask() : null
    if (!obs || !mask) { setGPUSilhouette(null); return }
    if (!this.silObsTex || this.silObsW !== mask.w || this.silObsH !== mask.h) {
      this.silObsTex?.dispose()
      this.silObsTex = new THREE.DataTexture(new Uint8Array(mask.w * mask.h * 4), mask.w, mask.h)
      this.silObsTex.minFilter = THREE.LinearFilter
      this.silObsTex.magFilter = THREE.LinearFilter
      this.silObsW = mask.w; this.silObsH = mask.h
    }
    const rgba = this.silObsTex.image.data as Uint8Array
    for (let i = 0; i < mask.data.length; i++) {
      const v = mask.data[i]
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255
    }
    this.silObsTex.needsUpdate = true
    // margin band (uv) from the obstacle's Marge slider → agents avoid before touching
    const marginUv = 0.012 + (obs.margin ?? 0.3) * 0.08
    setGPUSilhouette({ tex: this.silObsTex, interaction: obs.interaction, strength: obs.strength, invert: !!obs.silhouette?.invert, texel: 1 / mask.w, marginUv })
  }

  /** Scene obstacles + obstacles synthesized from any mapping zone flagged as an
   *  obstacle (its outline becomes a polygon obstacle). */
  private effectiveObstacles(): Obstacle[] {
    const base = this.currentScene?.obstacles ?? []
    const shapes = this.currentScene?.mapping?.shapes ?? []
    let extra: Obstacle[] | null = null
    for (const s of shapes) {
      if (!s.enabled || !s.obstacle) continue
      let points: { x: number; y: number }[] | undefined
      if (s.kind === 'polygon' && s.points) points = s.points
      else if (s.kind === 'mesh' && s.mesh) {
        const g = s.mesh, w = g.cols + 1
        points = [g.points[0], g.points[g.cols], g.points[(g.rows + 1) * w - 1], g.points[g.rows * w]]
      } else points = s.corners
      if (!points || points.length < 3) continue
      ;(extra ??= []).push({
        id: 'zoneobs:' + s.id, name: s.name, kind: 'polygon', enabled: true,
        interaction: s.obstacle.interaction, strength: s.obstacle.strength, margin: s.obstacle.margin,
        polygon: { points },
      })
    }
    return extra ? [...base, ...extra] : base
  }

  /** Bounding box (world coords) of the enabled mapping zones, or null when
   *  mapping is off / has no shapes. Used by GPU organisms as soft "walls". */
  private computeMapBounds(): [number, number, number, number] | null {
    const m = this.currentScene?.mapping
    if (!m?.enabled) return null
    const shapes = m.shapes ?? []
    if (shapes.length === 0) return null
    const aspect = this.width / this.height
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let any = false
    const add = (nx: number, ny: number) => {
      const wx = (nx - 0.5) * 2 * aspect, wy = -(ny - 0.5) * 2
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy
      any = true
    }
    for (const s of shapes) {
      if (!s.enabled) continue
      if (s.kind === 'polygon' && s.points) for (const p of s.points) add(p.x, p.y)
      else if (s.kind === 'mesh' && s.mesh) for (const p of s.mesh.points) add(p.x, p.y)
      else for (const c of s.corners) add(c.x, c.y)
    }
    if (!any) return null
    // A near-fullscreen zone shouldn't act as a wall (nothing to confine).
    if (minX <= -aspect * 0.98 && maxX >= aspect * 0.98 && minY <= -0.98 && maxY >= 0.98) return null
    return [minX, minY, maxX, maxY]
  }

  getStats() { return { fps: this.stats.fps, sense: { ...senseBus.hands } } }

  /** Apply timeline-driven patches to the live engine subsystems. Routes by path prefix
   *  so we don't waste cycles re-running expensive pipelines for unrelated keyframes. */
  private applyTimelinePatches(patches: { path: string; value: number | string }[]) {
    if (!this.currentScene || !this.organism) return
    let visualDirty = false
    let flowDirty = false
    const orgPatch: Record<string, number> = {}
    for (const p of patches) {
      const parts = p.path.split('.')
      if (parts[0] === 'organism' && parts[1] === 'values' && parts[2] && typeof p.value === 'number') {
        orgPatch[parts[2]] = p.value
      } else if (parts[0] === 'visual') {
        // Mutate scene.visual in place (visual is small + applyVisual rebuilds all the right state)
        const v: any = this.currentScene.visual
        if (parts[1] === 'palette' && parts[2]) {
          v.palette = { ...v.palette, [parts[2]]: p.value }
        } else if (parts[1]) {
          v[parts[1]] = p.value
        }
        visualDirty = true
      } else if (parts[0] === 'flow') {
        const f: any = this.currentScene.flow ?? { enabled: true, angle: 0, strength: 0, turbulence: 0 }
        if (parts[1]) f[parts[1]] = p.value
        this.currentScene.flow = f
        flowDirty = true
      }
    }
    if (Object.keys(orgPatch).length > 0) {
      this.organism.updateParams({ ...(this.currentScene.organism.values as any), ...orgPatch })
    }
    if (visualDirty) this.applyVisual(this.currentScene.visual)
    if (flowDirty && this.currentScene.flow) setFlow(this.currentScene.flow)
  }

  /** Switch between opaque rendering (with bg color) and transparent (for AR mirror overlay). */
  setTransparent(transparent: boolean) {
    this.bgAlpha = transparent ? 0 : 1
    this.mapping.setTransparent(transparent)
  }

  /** Expose renderer for advanced integrations (WebXR session). */
  getRenderer() { return this.renderer }

  getCanvas() { return this.renderer.domElement }

  destroy() {
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('resize', this.resize)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.organism?.dispose()
    for (const e of this.zoneOrganisms.values()) { e.organism.dispose(); e.rt.dispose() }
    this.zoneOrganisms.clear()
    this.mapping.dispose()
    this.mainRT.dispose(); this.feedbackRT.dispose(); this.feedbackRT2.dispose()
    // Dispose the feedback-pass resources : renderer.dispose() does NOT free
    // per-material compiled programs nor scene-graph geometries, so without
    // these each Stage remount / HMR cycle leaked one shader program, one VBO
    // and one mask DataTexture.
    this.feedbackQuadMat.dispose()
    const fbMesh = this.feedbackQuadScene.children[0] as THREE.Mesh | undefined
    fbMesh?.geometry?.dispose()
    this.organismMaskTex?.dispose()
    this.silObsTex?.dispose()
    // Release any module-level singletons that would otherwise leak across HMR
    stopMaskedWebcam()
    stopColorTracking()
    disposeAllContentSources()
    this._mouseCleanup?.()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
