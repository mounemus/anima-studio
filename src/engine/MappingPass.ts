import * as THREE from 'three'
import type { MappingConfig, MappingShape, TestPattern } from '../types/scene'
import { smoothPolygon, centroid, rotateAround } from '../lib/curve'

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`

const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uC0, uC1, uC2, uC3;     // TL TR BR BL in 0..1 (canvas coords)
  uniform vec4 uSourceRect;            // x, y, w, h on source texture
  uniform vec4 uBlend;                 // left, right, top, bottom
  uniform float uGamma;
  uniform int uPattern;                // 0=none 1=grid 2=white 3=black 4=colorbars 5=crosshair 6=gradient
  uniform vec3 uTint;                  // overall tint multiplier
  uniform float uTransparent;          // 0 = opaque (normal), 1 = content-based alpha (AR mirror)
  uniform float uOpacity;              // per-shape opacity 0..1

  // Newton iteration WITHOUT clamping (else outside-quad detection is dead code).
  vec2 invQuadMap(vec2 p) {
    vec2 uv = vec2(0.5);
    for (int i = 0; i < 14; i++) {
      vec2 m1 = mix(uC0, uC1, uv.x);
      vec2 m2 = mix(uC3, uC2, uv.x);
      vec2 cur = mix(m1, m2, uv.y);
      vec2 d = p - cur;
      vec2 dU = mix(uC1 - uC0, uC2 - uC3, uv.y);
      vec2 dV = m2 - m1;
      float det = dU.x * dV.y - dU.y * dV.x;
      if (abs(det) < 1e-6) return vec2(-99.0);  // singular → return outside-sentinel
      uv += vec2(d.x * dV.y - d.y * dV.x, d.y * dU.x - d.x * dU.y) / det;
      // bail early if iteration is diverging far outside
      if (uv.x < -0.5 || uv.x > 1.5 || uv.y < -0.5 || uv.y > 1.5) return uv;
    }
    return uv;
  }

  // Fast point-in-quad test using signed edge cross products.
  bool insideQuad(vec2 p) {
    float c0 = (uC1.x - uC0.x) * (p.y - uC0.y) - (uC1.y - uC0.y) * (p.x - uC0.x);
    float c1 = (uC2.x - uC1.x) * (p.y - uC1.y) - (uC2.y - uC1.y) * (p.x - uC1.x);
    float c2 = (uC3.x - uC2.x) * (p.y - uC2.y) - (uC3.y - uC2.y) * (p.x - uC2.x);
    float c3 = (uC0.x - uC3.x) * (p.y - uC3.y) - (uC0.y - uC3.y) * (p.x - uC3.x);
    float mn = min(min(c0, c1), min(c2, c3));
    float mx = max(max(c0, c1), max(c2, c3));
    return mn >= -1e-4 || mx <= 1e-4;   // tolerate either winding
  }

  vec3 patternColor(vec2 uv) {
    if (uPattern == 1) {
      // grid: 10x10 cells + center cross
      vec2 g = abs(fract(uv * 10.0) - 0.5);
      float line = step(0.48, max(g.x, g.y));
      vec2 c = abs(uv - 0.5);
      float cross = step(0.498, 1.0 - max(c.x, c.y) * 2.0);
      return mix(vec3(0.05), vec3(0.0, 1.0, 0.6), max(line, cross));
    }
    if (uPattern == 2) return vec3(1.0);
    if (uPattern == 3) return vec3(0.0);
    if (uPattern == 4) {
      // SMPTE-ish color bars (7 vertical stripes)
      float i = floor(uv.x * 7.0);
      vec3 bars[7];
      bars[0] = vec3(0.75); bars[1] = vec3(0.75, 0.75, 0.0);
      bars[2] = vec3(0.0, 0.75, 0.75); bars[3] = vec3(0.0, 0.75, 0.0);
      bars[4] = vec3(0.75, 0.0, 0.75); bars[5] = vec3(0.75, 0.0, 0.0);
      bars[6] = vec3(0.0, 0.0, 0.75);
      int idx = int(i);
      vec3 col = bars[0];
      if (idx == 1) col = bars[1]; else if (idx == 2) col = bars[2];
      else if (idx == 3) col = bars[3]; else if (idx == 4) col = bars[4];
      else if (idx == 5) col = bars[5]; else if (idx == 6) col = bars[6];
      return col;
    }
    if (uPattern == 5) {
      vec2 d = abs(uv - 0.5);
      float dist = length(d - vec2(0.0));
      float ring1 = smoothstep(0.005, 0.0, abs(dist - 0.1));
      float ring2 = smoothstep(0.005, 0.0, abs(dist - 0.25));
      float ring3 = smoothstep(0.005, 0.0, abs(dist - 0.4));
      float cross = step(0.498, 1.0 - max(d.x, d.y) * 2.0);
      return vec3(0.0, 1.0, 0.6) * max(max(ring1, ring2), max(ring3, cross));
    }
    if (uPattern == 6) {
      return vec3(uv.x, uv.y, 0.5);
    }
    return vec3(0.0);
  }

  void main() {
    // Cheap reject first: skip pixels outside the quad polygon
    if (!insideQuad(vUv)) {
      gl_FragColor = vec4(0.0);
      return;
    }
    vec2 uv = invQuadMap(vUv);
    // Hard bounds (catches Newton divergence + NaN)
    if (!(uv.x >= -0.02) || !(uv.y >= -0.02) || !(uv.x <= 1.02) || !(uv.y <= 1.02)) {
      gl_FragColor = vec4(0.0);
      return;
    }
    uv = clamp(uv, 0.0, 1.0);
    vec3 col;
    if (uPattern > 0) {
      col = patternColor(uv);
    } else {
      // sample sub-rect of source
      vec2 srcUv = vec2(
        uSourceRect.x + uv.x * uSourceRect.z,
        1.0 - (uSourceRect.y + uv.y * uSourceRect.w)
      );
      col = texture2D(uTex, srcUv).rgb;
    }
    col *= uTint;
    // edge blend
    float bl = 1.0;
    if (uBlend.x > 0.0) bl *= pow(smoothstep(0.0, uBlend.x, uv.x), uGamma);
    if (uBlend.y > 0.0) bl *= pow(smoothstep(0.0, uBlend.y, 1.0 - uv.x), uGamma);
    if (uBlend.z > 0.0) bl *= pow(smoothstep(0.0, uBlend.z, uv.y), uGamma);
    if (uBlend.w > 0.0) bl *= pow(smoothstep(0.0, uBlend.w, 1.0 - uv.y), uGamma);
    vec3 outCol = col * bl;
    float a = mix(1.0, max(max(outCol.r, outCol.g), outCol.b), uTransparent);
    gl_FragColor = vec4(outCol * uOpacity, a * uOpacity);
  }
`

interface ShapeMesh {
  shape: MappingShape
  mesh: THREE.Mesh
  uniforms: Record<string, THREE.IUniform>
  kind: 'quad' | 'polygon'
}

const MAX_POLY_POINTS = 64

const FRAG_POLYGON = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uPoints[${MAX_POLY_POINTS}];
  uniform int uPointCount;
  uniform vec4 uBbox;                  // minX, minY, w, h  (already with Y flipped same as points)
  uniform vec4 uSourceRect;
  uniform vec4 uBlend;
  uniform float uGamma;
  uniform int uPattern;
  uniform vec3 uTint;
  uniform float uTransparent;
  uniform float uOpacity;

  // Ray-casting point-in-polygon
  bool insidePolygon(vec2 p) {
    bool inside = false;
    for (int i = 0; i < ${MAX_POLY_POINTS}; i++) {
      if (i >= uPointCount) break;
      vec2 a = uPoints[i];
      int jj = i == 0 ? uPointCount - 1 : i - 1;
      vec2 b = vec2(0.0);
      for (int k = 0; k < ${MAX_POLY_POINTS}; k++) {
        if (k == jj) { b = uPoints[k]; break; }
      }
      if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) {
        inside = !inside;
      }
    }
    return inside;
  }

  vec3 patternColor(vec2 uv) {
    if (uPattern == 1) {
      vec2 g = abs(fract(uv * 10.0) - 0.5);
      float line = step(0.48, max(g.x, g.y));
      return mix(vec3(0.05), vec3(0.0, 1.0, 0.6), line);
    }
    if (uPattern == 2) return vec3(1.0);
    if (uPattern == 3) return vec3(0.0);
    if (uPattern == 4) {
      float i = floor(uv.x * 7.0);
      return mix(vec3(0.75), vec3(0.5, 0.0, 0.8), step(0.5, fract(i / 2.0)));
    }
    if (uPattern == 5) return vec3(uv.x, uv.y, 0.5);
    if (uPattern == 6) return vec3(uv.x, uv.y, 0.5);
    return vec3(0.0);
  }

  void main() {
    if (!insidePolygon(vUv)) { gl_FragColor = vec4(0.0); return; }
    // UV: map vUv from polygon's bbox to [0,1] then to source rect
    vec2 local = (vUv - uBbox.xy) / uBbox.zw;
    local = clamp(local, 0.0, 1.0);
    vec2 srcUv = vec2(
      uSourceRect.x + local.x * uSourceRect.z,
      1.0 - (uSourceRect.y + local.y * uSourceRect.w)
    );
    vec3 col;
    if (uPattern > 0) col = patternColor(local);
    else col = texture2D(uTex, srcUv).rgb;
    col *= uTint;
    float bl = 1.0;
    if (uBlend.x > 0.0) bl *= pow(smoothstep(0.0, uBlend.x, local.x), uGamma);
    if (uBlend.y > 0.0) bl *= pow(smoothstep(0.0, uBlend.y, 1.0 - local.x), uGamma);
    if (uBlend.z > 0.0) bl *= pow(smoothstep(0.0, uBlend.z, local.y), uGamma);
    if (uBlend.w > 0.0) bl *= pow(smoothstep(0.0, uBlend.w, 1.0 - local.y), uGamma);
    vec3 outCol = col * bl;
    float a = mix(1.0, max(max(outCol.r, outCol.g), outCol.b), uTransparent);
    gl_FragColor = vec4(outCol * uOpacity, a * uOpacity);
  }
`

const PATTERN_INDEX: Record<TestPattern, number> = {
  none: 0, grid: 1, white: 2, black: 3, colorbars: 4, crosshair: 5, gradient: 6,
}

export class MappingPass {
  scene = new THREE.Scene()
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private shapes: ShapeMesh[] = []
  private sourceTex: THREE.Texture | null = null
  private transparent = 0
  /** Per-shape texture override. If absent, the shape uses the default sourceTex. */
  private perShapeTex = new Map<string, THREE.Texture | null>()

  constructor() {}

  private makeShape(shape: MappingShape, cfg: MappingConfig): ShapeMesh {
    const kind = shape.kind === 'polygon' ? 'polygon' : 'quad'
    let uniforms: Record<string, THREE.IUniform>
    let mat: THREE.ShaderMaterial
    if (kind === 'polygon') {
      uniforms = {
        uTex: { value: this.sourceTex },
        uPoints: { value: Array.from({ length: MAX_POLY_POINTS }, () => new THREE.Vector2(0, 0)) },
        uPointCount: { value: 0 },
        uBbox: { value: new THREE.Vector4(0, 0, 1, 1) },
        uSourceRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uBlend: { value: new THREE.Vector4(0, 0, 0, 0) },
        uGamma: { value: 2.2 },
        uPattern: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uTransparent: { value: this.transparent },
        uOpacity: { value: 1.0 },
      }
      mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG_POLYGON,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
    } else {
      uniforms = {
        uTex: { value: this.sourceTex },
        uC0: { value: new THREE.Vector2() },
        uC1: { value: new THREE.Vector2() },
        uC2: { value: new THREE.Vector2() },
        uC3: { value: new THREE.Vector2() },
        uSourceRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uBlend: { value: new THREE.Vector4(0, 0, 0, 0) },
        uGamma: { value: 2.2 },
        uPattern: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uTransparent: { value: this.transparent },
        uOpacity: { value: 1.0 },
      }
      mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
    }
    const geo = new THREE.PlaneGeometry(2, 2)
    const mesh = new THREE.Mesh(geo, mat)
    const sm: ShapeMesh = { shape, mesh, uniforms, kind }
    this.applyToShape(sm, cfg)
    return sm
  }

  private applyToShape(sm: ShapeMesh, cfg: MappingConfig) {
    if (sm.kind === 'quad') {
      const c = sm.shape.corners
      ;(sm.uniforms.uC0.value as THREE.Vector2).set(c[0].x, 1 - c[0].y)
      ;(sm.uniforms.uC1.value as THREE.Vector2).set(c[1].x, 1 - c[1].y)
      ;(sm.uniforms.uC2.value as THREE.Vector2).set(c[2].x, 1 - c[2].y)
      ;(sm.uniforms.uC3.value as THREE.Vector2).set(c[3].x, 1 - c[3].y)
    } else {
      let pts = sm.shape.points ?? []
      // Apply rotation around centroid if set
      if (sm.shape.rotation) {
        pts = rotateAround(pts, centroid(pts), sm.shape.rotation)
      }
      // Apply Catmull-Rom smoothing if requested
      if (sm.shape.smooth && sm.shape.smooth > 0) {
        pts = smoothPolygon(pts, sm.shape.smooth)
      }
      // Hard cap to shader array size
      if (pts.length > MAX_POLY_POINTS) {
        // Decimate evenly down to fit
        const step = pts.length / MAX_POLY_POINTS
        const dec: typeof pts = []
        for (let i = 0; i < MAX_POLY_POINTS; i++) dec.push(pts[Math.floor(i * step)])
        pts = dec
      }
      const arr = sm.uniforms.uPoints.value as THREE.Vector2[]
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < MAX_POLY_POINTS; i++) {
        if (i < pts.length) {
          const px = pts[i].x, py = 1 - pts[i].y    // Y flip to match clip space
          arr[i].set(px, py)
          if (px < minX) minX = px
          if (py < minY) minY = py
          if (px > maxX) maxX = px
          if (py > maxY) maxY = py
        } else {
          arr[i].set(0, 0)
        }
      }
      sm.uniforms.uPointCount.value = Math.min(pts.length, MAX_POLY_POINTS)
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1 }
      ;(sm.uniforms.uBbox.value as THREE.Vector4).set(minX, minY, Math.max(1e-4, maxX - minX), Math.max(1e-4, maxY - minY))
    }
    const sr = sm.shape.source
    ;(sm.uniforms.uSourceRect.value as THREE.Vector4).set(sr.x, sr.y, sr.w, sr.h)
    const b = cfg.edgeBlend
    ;(sm.uniforms.uBlend.value as THREE.Vector4).set(b.left, b.right, b.top, b.bottom)
    sm.uniforms.uGamma.value = b.gamma
    sm.uniforms.uPattern.value = PATTERN_INDEX[cfg.testPattern ?? 'none']
    sm.uniforms.uTransparent.value = this.transparent
    sm.uniforms.uOpacity.value = sm.shape.content?.opacity ?? 1.0
    const custom = this.perShapeTex.get(sm.shape.id)
    sm.uniforms.uTex.value = custom ?? this.sourceTex
    sm.mesh.visible = sm.shape.enabled
  }

  /** Override the source texture for a specific shape (null = use the default). */
  setShapeTexture(shapeId: string, tex: THREE.Texture | null) {
    if (tex) this.perShapeTex.set(shapeId, tex)
    else this.perShapeTex.delete(shapeId)
    // Re-apply uniforms for the matching shape
    const sm = this.shapes.find((s) => s.shape.id === shapeId)
    if (sm) sm.uniforms.uTex.value = tex ?? this.sourceTex
  }

  setTransparent(t: boolean) {
    this.transparent = t ? 1 : 0
    for (const sm of this.shapes) sm.uniforms.uTransparent.value = this.transparent
  }

  apply(cfg: MappingConfig) {
    // Build the effective shape list:
    // - If mapping disabled OR no shapes: 1 full-screen identity quad
    // - Else: each shape becomes a mesh
    const targetShapes: MappingShape[] = (() => {
      if (!cfg.enabled) {
        return [{
          id: 'identity', name: 'Identity', enabled: true,
          corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
          source: { x: 0, y: 0, w: 1, h: 1 },
        }]
      }
      if (cfg.shapes && cfg.shapes.length > 0) return cfg.shapes
      // legacy fallback to single-quad corners
      return [{
        id: 'legacy', name: 'Legacy', enabled: true,
        corners: cfg.corners,
        source: { x: 0, y: 0, w: 1, h: 1 },
      }]
    })()

    // Diff: rebuild if shape count or kind changed; otherwise update in place
    const needRebuild = this.shapes.length !== targetShapes.length ||
      this.shapes.some((sm, i) => sm.kind !== (targetShapes[i].kind === 'polygon' ? 'polygon' : 'quad'))
    if (needRebuild) {
      for (const sm of this.shapes) {
        this.scene.remove(sm.mesh)
        sm.mesh.geometry.dispose()
        ;(sm.mesh.material as THREE.Material).dispose()
      }
      this.shapes = targetShapes.map((s) => {
        const sm = this.makeShape(s, cfg)
        this.scene.add(sm.mesh)
        return sm
      })
    } else {
      this.shapes.forEach((sm, i) => {
        sm.shape = targetShapes[i]
        this.applyToShape(sm, cfg)
      })
    }
  }

  setSource(tex: THREE.Texture) {
    this.sourceTex = tex
    for (const sm of this.shapes) {
      const custom = this.perShapeTex.get(sm.shape.id)
      sm.uniforms.uTex.value = custom ?? tex
    }
  }

  dispose() {
    for (const sm of this.shapes) {
      this.scene.remove(sm.mesh)
      sm.mesh.geometry.dispose()
      ;(sm.mesh.material as THREE.Material).dispose()
    }
    this.shapes = []
  }
}
