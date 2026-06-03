import * as THREE from 'three'
import type { MappingConfig } from '../types/scene'

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`

const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uC0, uC1, uC2, uC3; // TL TR BR BL in 0..1
  uniform vec4 uBlend;  // left, right, top, bottom
  uniform float uGamma;
  uniform float uFeedback;

  // bilinear inverse mapping of quad (TL,TR,BR,BL) into unit square
  vec2 invQuadMap(vec2 p) {
    // iterative solver
    vec2 uv = vec2(0.5);
    for (int i = 0; i < 12; i++) {
      vec2 mix1 = mix(uC0, uC1, uv.x);
      vec2 mix2 = mix(uC3, uC2, uv.x);
      vec2 cur = mix(mix1, mix2, uv.y);
      vec2 d = p - cur;
      // approx jacobian
      vec2 dU = mix(uC1 - uC0, uC2 - uC3, uv.y);
      vec2 dV = mix2 - mix1;
      float det = dU.x * dV.y - dU.y * dV.x;
      if (abs(det) < 1e-6) break;
      uv += vec2(d.x * dV.y - d.y * dV.x, d.y * dU.x - d.x * dU.y) / det;
      uv = clamp(uv, 0.0, 1.0);
    }
    return uv;
  }

  void main() {
    vec2 uv = invQuadMap(vUv);
    // outside the quad -> black
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    vec3 col = texture2D(uTex, vec2(uv.x, 1.0 - uv.y)).rgb;
    // edge blend
    float bl = 1.0;
    if (uBlend.x > 0.0) bl *= pow(smoothstep(0.0, uBlend.x, uv.x), uGamma);
    if (uBlend.y > 0.0) bl *= pow(smoothstep(0.0, uBlend.y, 1.0 - uv.x), uGamma);
    if (uBlend.z > 0.0) bl *= pow(smoothstep(0.0, uBlend.z, uv.y), uGamma);
    if (uBlend.w > 0.0) bl *= pow(smoothstep(0.0, uBlend.w, 1.0 - uv.y), uGamma);
    gl_FragColor = vec4(col * bl, 1.0);
  }
`

export class MappingPass {
  scene = new THREE.Scene()
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  uniforms: Record<string, THREE.IUniform>
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial

  constructor() {
    this.uniforms = {
      uTex: { value: null },
      uC0: { value: new THREE.Vector2(0, 0) },
      uC1: { value: new THREE.Vector2(1, 0) },
      uC2: { value: new THREE.Vector2(1, 1) },
      uC3: { value: new THREE.Vector2(0, 1) },
      uBlend: { value: new THREE.Vector4(0, 0, 0, 0) },
      uGamma: { value: 2.2 },
      uFeedback: { value: 0 },
    }
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
    const geo = new THREE.PlaneGeometry(2, 2)
    this.mesh = new THREE.Mesh(geo, this.mat)
    this.scene.add(this.mesh)
  }

  apply(cfg: MappingConfig) {
    const c = cfg.corners
    ;(this.uniforms.uC0.value as THREE.Vector2).set(c[0].x, 1 - c[0].y)
    ;(this.uniforms.uC1.value as THREE.Vector2).set(c[1].x, 1 - c[1].y)
    ;(this.uniforms.uC2.value as THREE.Vector2).set(c[2].x, 1 - c[2].y)
    ;(this.uniforms.uC3.value as THREE.Vector2).set(c[3].x, 1 - c[3].y)
    const b = cfg.edgeBlend
    ;(this.uniforms.uBlend.value as THREE.Vector4).set(b.left, b.right, b.top, b.bottom)
    this.uniforms.uGamma.value = b.gamma
  }

  setSource(tex: THREE.Texture) {
    this.uniforms.uTex.value = tex
  }

  dispose() {
    this.mat.dispose()
    this.mesh.geometry.dispose()
  }
}
