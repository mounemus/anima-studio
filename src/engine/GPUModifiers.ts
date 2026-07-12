/**
 * GPU behaviour-modifier injection — the GPU counterpart of [[Modifiers.ts]].
 *
 * The CPU `applyModifiers()` mutates position/velocity arrays after the organism
 * update. GPU organisms have no CPU arrays (state lives in ping-pong textures), so
 * force-field modifiers were silent on them. This module injects the same force
 * fields directly into the GPU sim fragment shader, exactly like [[GPUObstacles.ts]]
 * injects OBSTACLE_GLSL.
 *
 * Ported modifiers: vortex, gravityWell, magneticBands (as additive forces) and
 * pulseGate (as a per-frame velocity multiplier `uPulseVelScale`). colorCycle is
 * palette-only and already handled in the Engine; zoneWalls stays CPU-only (it
 * overlaps the per-zone obstacle feature).
 */
import * as THREE from 'three'
import { senseBus } from '../senses/SenseBus'
import type { Modifier } from './Modifiers'

export const MAX_GPU_MODS = 8

/** GLSL declaring the modifier uniforms + `modifierForce(pos)`. Inject once per
 *  sim shader (after OBSTACLE_GLSL). The caller must also apply `vel *= uPulseVelScale`. */
export const MODIFIER_GLSL = `
  uniform int   uModCount;
  uniform float uModType[${MAX_GPU_MODS}];   // 1=vortex 2=gravityWell 3=magneticBands
  uniform vec2  uModCenter[${MAX_GPU_MODS}];
  uniform vec4  uModParam[${MAX_GPU_MODS}];  // packed per-type params
  uniform float uPulseVelScale;              // pulseGate: velocity multiplier this frame

  vec2 modifierForce(vec2 pos) {
    vec2 f = vec2(0.0);
    for (int i = 0; i < ${MAX_GPU_MODS}; i++) {
      if (i >= uModCount) break;
      float ty = uModType[i];
      if (ty < 0.5) continue;
      vec4 pr = uModParam[i];
      vec2 ctr = uModCenter[i];
      if (ty < 1.5) {
        // vortex — tangential swirl + radial pull.  pr = (omega, radius, pull, -)
        vec2 d = pos - ctr;
        float r = length(d);
        float radius = max(1e-3, pr.y);
        if (r < radius) {
          float fall = 1.0 - r / radius;
          vec2 tang = vec2(-d.y, d.x);
          float tl = max(1e-4, length(tang));
          f += (tang / tl) * pr.x * fall * 2.0;
          float dl = max(1e-3, r);
          f -= (d / dl) * pr.z * fall;
        }
      } else if (ty < 2.5) {
        // gravityWell — radial attraction.  pr = (strength, radius, -, -)
        vec2 d = ctr - pos;
        float r = length(d);
        float radius = max(1e-3, pr.y);
        if (r < radius && r > 1e-3) {
          float fall = 1.0 - r / radius;
          f += (d / r) * pr.x * fall;
        }
      } else if (ty < 3.5) {
        // magneticBands — restoring force toward nearest horizontal band centre.
        // pr = (bands, strength, -, -)
        float bands = max(1.0, pr.x);
        float stepH = 2.0 / bands;
        float bandIdx = floor((pos.y + 1.0) / stepH);
        float targetY = bandIdx * stepH + stepH * 0.5 - 1.0;
        f.y += (targetY - pos.y) * pr.y;
      }
    }
    return f;
  }
`

/** Uniform block for a sim material. Spread into the ShaderMaterial uniforms. */
export function makeModifierUniforms(): Record<string, THREE.IUniform> {
  return {
    uModCount: { value: 0 },
    uModType: { value: new Float32Array(MAX_GPU_MODS) },
    uModCenter: { value: Array.from({ length: MAX_GPU_MODS }, () => new THREE.Vector2()) },
    uModParam: { value: Array.from({ length: MAX_GPU_MODS }, () => new THREE.Vector4()) },
    uPulseVelScale: { value: 1 },
  }
}

/** Pack the active modifier list into the sim uniforms. Call each frame in the
 *  GPU organism's update(), like packObstacles(). `time` is seconds (organism.t). */
export function packModifiers(
  uniforms: Record<string, THREE.IUniform>,
  modifiers: Modifier[] | undefined,
  aspect: number,
  time: number,
): void {
  const types = uniforms.uModType.value as Float32Array
  const centers = uniforms.uModCenter.value as THREE.Vector2[]
  const params = uniforms.uModParam.value as THREE.Vector4[]
  const hand = senseBus.hands
  let n = 0
  let pulse = 1
  if (modifiers) {
    for (const m of modifiers) {
      if (!m.enabled) continue
      if (m.kind === 'vortex') {
        if (n >= MAX_GPU_MODS) break
        let cx: number, cy: number
        if (m.center === 'hand') {
          if (!hand.detected) continue
          cx = (hand.indexTip.x - 0.5) * 2 * aspect
          cy = -(hand.indexTip.y - 0.5) * 2
        } else {
          cx = (m.center.x - 0.5) * 2 * aspect
          cy = -(m.center.y - 0.5) * 2
        }
        types[n] = 1
        centers[n].set(cx, cy)
        params[n].set(m.omega, Math.max(1e-3, m.radius), m.pull, 0)
        n++
      } else if (m.kind === 'gravityWell') {
        for (const w of m.wells ?? []) {
          if (n >= MAX_GPU_MODS) break
          types[n] = 2
          centers[n].set((w.x - 0.5) * 2 * aspect, -(w.y - 0.5) * 2)
          params[n].set(w.strength, Math.max(1e-3, w.radius), 0, 0)
          n++
        }
      } else if (m.kind === 'magneticBands') {
        if (n >= MAX_GPU_MODS) break
        types[n] = 3
        centers[n].set(0, 0)
        params[n].set(Math.max(1, m.bands), m.strength, 0, 0)
        n++
      } else if (m.kind === 'pulseGate') {
        const width = Math.max(1e-3, m.width)
        const phase = (time * m.bpm) % 1
        let beat = Math.exp(-Math.pow((phase - 0) / width, 2)) + Math.exp(-Math.pow((phase - 1) / width, 2))
        if (!Number.isFinite(beat)) beat = 0
        pulse *= 1 + (m.intensity - 1) * beat
      }
      // colorCycle → palette hue-shift in Engine ; zoneWalls → CPU-only.
    }
  }
  for (let i = n; i < MAX_GPU_MODS; i++) types[i] = 0
  uniforms.uModCount.value = n
  uniforms.uPulseVelScale.value = pulse
}

/** Shared point-sprite fragment snippet: sample an optional texture at gl_PointCoord.
 *  Declares `uTex`/`uUseTex`; multiplies the base color and modulates alpha by the
 *  texture's luminance/alpha. Organisms call texSpriteColor(baseColor, baseAlpha). */
export const SPRITE_TEX_GLSL = `
  uniform sampler2D uTex;
  uniform float uUseTex;
  vec4 texSprite(vec3 baseColor, float baseAlpha) {
    if (uUseTex < 0.5) return vec4(baseColor, baseAlpha);
    vec4 t = texture2D(uTex, gl_PointCoord);
    float a = baseAlpha * t.a * (0.2 + 0.8 * max(max(t.r, t.g), t.b));
    return vec4(baseColor * t.rgb * 1.6, a);
  }
`

/** Uniforms for the sprite-texture snippet. Spread into a render material. */
export function makeSpriteTexUniforms(): Record<string, THREE.IUniform> {
  return { uTex: { value: null }, uUseTex: { value: 0 } }
}
