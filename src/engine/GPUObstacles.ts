/**
 * GPUObstacles — obstacle forces for the GPU organisms (Murmuration/Boids/
 * Particles/Cells GPU), replicating the CPU solveObstacles() semantics inside
 * the sim shader.
 *
 * The CPU per-agent solver can't run in a fragment shader, so we pack the scene
 * obstacles into uniform arrays each frame and evaluate the same avoid / attract
 * / bounce / kill forces in GLSL:
 *   - circle / hand / pose-joint / tracker  → circles (position + radius)
 *   - polygon                                → one polygon slot (ray-cast inside
 *                                              + nearest-edge normal)
 *   - map "walls"                            → containment inside the bounding box
 *                                              of the enabled mapping zones
 *
 * Not yet ported: the 'silhouette' mask obstacle (needs the mask texture bound in
 * the sim shader) — left as a follow-up; those scenes can use gpu:0 (CPU) meanwhile.
 *
 * Coordinate convention matches Obstacles.ts: canvas 0..1 (top-left) → world
 * (x∈[-aspect,aspect], y∈[-1,1]); radius nr → nr*2*max(1,aspect).
 */
import * as THREE from 'three'
import type { Obstacle } from '../types/scene'
import { senseBus } from '../senses/SenseBus'
import { trackerStates } from './ColorTracker'

export const MAX_OBS_CIRCLES = 16
export const MAX_OBS_POLY = 24

const INTERACTION_CODE: Record<string, number> = { avoid: 0, attract: 1, bounce: 2, kill: 3 }

/** Fresh uniform set to spread into a sim ShaderMaterial's uniforms. */
export function makeObstacleUniforms(): Record<string, THREE.IUniform> {
  return {
    uObsCircle: { value: Array.from({ length: MAX_OBS_CIRCLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uObsCircleFx: { value: Array.from({ length: MAX_OBS_CIRCLES }, () => new THREE.Vector2(0, 0)) },
    uObsCircleCount: { value: 0 },
    uObsPoly: { value: Array.from({ length: MAX_OBS_POLY }, () => new THREE.Vector2(0, 0)) },
    uObsPolyCount: { value: 0 },
    uObsPolyFx: { value: new THREE.Vector4(0, 0, 0.05, 0) },  // (interaction, strength, margin, _)
    uMapWalls: { value: 0 },
    uMapBounds: { value: new THREE.Vector4(-1, -1, 1, 1) },     // (minX, minY, maxX, maxY) world
    uObsAspect: { value: 1 },
    // Silhouette (SelfieSegmenter body mask)
    uSilMask: { value: null },
    uSilOn: { value: 0 },
    uSilFx: { value: new THREE.Vector3(0, 1, 0) },  // (interactionCode, strength, invert)
    uSilTexel: { value: 1 / 128 },
    uSilMargin: { value: 0.04 },
  }
}

/** Module-level silhouette state, set once per frame by the Engine and consumed
 *  by every organism's packObstacles() call (avoids threading it through each). */
let silState: { tex: THREE.Texture | null; interaction: string; strength: number; invert: boolean; texel: number; marginUv: number } | null = null
export function setGPUSilhouette(s: typeof silState) { silState = s }

/** GLSL to prepend to a sim fragment shader. Provides obstacleForce(). */
export const OBSTACLE_GLSL = `
  uniform vec4 uObsCircle[${MAX_OBS_CIRCLES}];    // (cx, cy, r, margin) world
  uniform vec2 uObsCircleFx[${MAX_OBS_CIRCLES}];  // (interactionCode, strength)
  uniform int uObsCircleCount;
  uniform vec2 uObsPoly[${MAX_OBS_POLY}];
  uniform int uObsPolyCount;
  uniform vec4 uObsPolyFx;                         // (interactionCode, strength, margin, _)
  uniform float uMapWalls;
  uniform vec4 uMapBounds;
  uniform float uObsAspect;
  uniform sampler2D uSilMask;
  uniform float uSilOn;
  uniform vec3 uSilFx;      // (interactionCode, strength, invert)
  uniform float uSilTexel;
  uniform float uSilMargin; // avoidance band radius (uv) around the body

  void applyInter(float interaction, vec2 n, float k, bool inside, inout vec2 f, inout float kill) {
    if (interaction < 0.5)      { f += n * k * 3.0; }                 // avoid
    else if (interaction < 1.5) { f -= n * k * 2.0; }                 // attract
    else if (interaction < 2.5) { if (inside) f += n * k * 12.0; }    // bounce
    else                        { if (inside) kill = 1.0; }           // kill
  }

  vec2 obstacleForce(vec2 p, out float kill) {
    kill = 0.0;
    vec2 f = vec2(0.0);
    // --- circles (circle / hand / pose / tracker) ---
    for (int i = 0; i < ${MAX_OBS_CIRCLES}; i++) {
      if (i >= uObsCircleCount) break;
      vec4 g = uObsCircle[i];
      float r = g.z, m = max(1e-4, g.w);
      vec2 d = p - g.xy;
      float dist = length(d);
      float total = r + m;
      if (dist < total) {
        bool inside = dist < r;
        float t = inside ? 1.0 : 1.0 - (dist - r) / m;
        vec2 n = dist > 1e-4 ? d / dist : vec2(0.0, 1.0);
        applyInter(uObsCircleFx[i].x, n, uObsCircleFx[i].y * t, inside, f, kill);
      }
    }
    // --- one polygon (ray-cast inside + nearest-edge normal) ---
    if (uObsPolyCount >= 3) {
      // seed prev = last vertex
      vec2 prev = uObsPoly[0];
      for (int k = 0; k < ${MAX_OBS_POLY}; k++) { if (k >= uObsPolyCount) break; prev = uObsPoly[k]; }
      bool inside = false;
      float minDist = 1e9; vec2 nrm = vec2(0.0, 1.0);
      for (int i = 0; i < ${MAX_OBS_POLY}; i++) {
        if (i >= uObsPolyCount) break;
        vec2 cur = uObsPoly[i];
        if (((cur.y > p.y) != (prev.y > p.y)) &&
            (p.x < (prev.x - cur.x) * (p.y - cur.y) / (prev.y - cur.y) + cur.x)) inside = !inside;
        // distance to edge segment (prev -> cur)
        vec2 e = cur - prev;
        float len2 = max(1e-6, dot(e, e));
        float tt = clamp(dot(p - prev, e) / len2, 0.0, 1.0);
        vec2 cp = prev + tt * e;
        float dd = length(p - cp);
        if (dd < minDist) { minDist = dd; nrm = dd > 1e-4 ? (p - cp) / dd : vec2(0.0, 1.0); }
        prev = cur;
      }
      float m = max(1e-4, uObsPolyFx.z);
      if (inside || minDist < m) {
        float t = inside ? 1.0 : 1.0 - minDist / m;
        applyInter(uObsPolyFx.x, nrm, uObsPolyFx.y * t, inside, f, kill);
      }
    }
    // --- silhouette (body mask) : same world→mask uv + Sobel-normal convention
    //     as the CPU solver (Obstacles.ts), so GPU behaviour matches CPU. ---
    if (uSilOn > 0.5) {
      // world → mask uv : nx = x/aspect*0.5+0.5 ; ny = 0.5 - y*0.5  (mask stored top-down, X already mirrored)
      vec2 suv = vec2(p.x / uObsAspect * 0.5 + 0.5, 0.5 - p.y * 0.5);
      if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
        float inv = uSilFx.z;
        float mr = uSilMargin;                                   // avoidance-band radius
        float c = texture2D(uSilMask, suv).r;
        float l = texture2D(uSilMask, suv + vec2(-mr, 0.0)).r;
        float r = texture2D(uSilMask, suv + vec2( mr, 0.0)).r;
        float u = texture2D(uSilMask, suv + vec2(0.0, -mr)).r;
        float d = texture2D(uSilMask, suv + vec2(0.0,  mr)).r;
        if (inv > 0.5) { c=1.0-c; l=1.0-l; r=1.0-r; u=1.0-u; d=1.0-d; }
        // Dilated influence : the body PLUS a margin band. Agents feel the push
        // BEFORE touching (ramped by proximity) → they veer cleanly around the
        // silhouette instead of penetrating then popping out (fuzzy edge before).
        float infl = max(c, max(max(l, r), max(u, d)));
        if (infl > 0.02) {
          // Outward normal from the wide-kernel gradient. World y up, mask y down → (gx, -gy).
          vec2 n = vec2(l - r, -(u - d));
          float len = length(n);
          if (len < 1e-3) n = vec2(0.0, 1.0); else n /= len;      // deep inside → push up (rare with the band)
          // avoid/attract ramp across the band ; bounce/kill still gate on truly-inside (c>0.5)
          applyInter(uSilFx.x, n, uSilFx.y * infl, c > 0.5, f, kill);
        }
      }
    }
    // --- map walls : keep agents inside the enabled-zone bounding box ---
    if (uMapWalls > 0.5) {
      float push = 8.0;
      if (p.x < uMapBounds.x) f.x += (uMapBounds.x - p.x) * push;
      if (p.x > uMapBounds.z) f.x -= (p.x - uMapBounds.z) * push;
      if (p.y < uMapBounds.y) f.y += (uMapBounds.y - p.y) * push;
      if (p.y > uMapBounds.w) f.y -= (p.y - uMapBounds.w) * push;
    }
    return f;
  }
`

const toWX = (nx: number, a: number) => (nx - 0.5) * 2 * a
const toWY = (ny: number) => -(ny - 0.5) * 2
const toWR = (nr: number, a: number) => nr * 2 * Math.max(1, a)

/**
 * Fill a sim material's obstacle uniforms from the scene obstacles + optional
 * map-zone bounds. Call once per frame before rendering the sim pass.
 */
export function packObstacles(
  uniforms: Record<string, THREE.IUniform>,
  obstacles: Obstacle[] | undefined,
  aspect: number,
  mapBounds: [number, number, number, number] | null,
) {
  const circles = uniforms.uObsCircle.value as THREE.Vector4[]
  const circleFx = uniforms.uObsCircleFx.value as THREE.Vector2[]
  const poly = uniforms.uObsPoly.value as THREE.Vector2[]
  let nc = 0
  let npoly = 0
  const pushCircle = (cx: number, cy: number, r: number, m: number, inter: string, strength: number) => {
    if (nc >= MAX_OBS_CIRCLES) return
    circles[nc].set(cx, cy, r, m)
    circleFx[nc].set(INTERACTION_CODE[inter] ?? 0, strength)
    nc++
  }
  for (const o of obstacles ?? []) {
    if (!o.enabled) continue
    const m = toWR(o.margin, aspect)
    if (o.kind === 'circle' && o.circle) {
      pushCircle(toWX(o.circle.cx, aspect), toWY(o.circle.cy), toWR(o.circle.r, aspect), m, o.interaction, o.strength)
    } else if (o.kind === 'hand' && o.hand && senseBus.hands.detected) {
      const s = o.hand.source === 'index' ? senseBus.hands.indexTip : senseBus.hands.palm
      pushCircle(toWX(s.x, aspect), toWY(s.y), toWR(o.hand.radius, aspect), m, o.interaction, o.strength)
    } else if (o.kind === 'tracker' && o.tracker) {
      const st = trackerStates.get(o.id)
      if (st && st.confidence >= 0.1) pushCircle(toWX(st.x, aspect), toWY(st.y), toWR(o.tracker.radius, aspect), m, o.interaction, o.strength * st.confidence)
    } else if (o.kind === 'pose' && o.pose && senseBus.pose.detected) {
      for (const ji of o.pose.joints) {
        const j = senseBus.pose.landmarks[ji]
        if (j && j.vis >= 0.3) pushCircle(toWX(j.x, aspect), toWY(j.y), toWR(o.pose.radius, aspect), m, o.interaction, o.strength)
      }
    } else if (o.kind === 'polygon' && o.polygon && npoly === 0) {
      // one polygon slot (the common case)
      const pts = o.polygon.points.slice(0, MAX_OBS_POLY)
      for (let i = 0; i < pts.length; i++) poly[i].set(toWX(pts[i].x, aspect), toWY(pts[i].y))
      ;(uniforms.uObsPolyFx.value as THREE.Vector4).set(INTERACTION_CODE[o.interaction] ?? 0, o.strength, m, 0)
      uniforms.uObsPolyCount.value = pts.length
      npoly = pts.length
    }
    // 'silhouette' not ported to GPU yet.
  }
  uniforms.uObsCircleCount.value = nc
  if (npoly === 0) uniforms.uObsPolyCount.value = 0
  uniforms.uObsAspect.value = aspect
  if (mapBounds) {
    uniforms.uMapWalls.value = 1
    ;(uniforms.uMapBounds.value as THREE.Vector4).set(mapBounds[0], mapBounds[1], mapBounds[2], mapBounds[3])
  } else {
    uniforms.uMapWalls.value = 0
  }
  // Silhouette (module-level, set by the Engine each frame)
  if (silState && silState.tex) {
    uniforms.uSilOn.value = 1
    uniforms.uSilMask.value = silState.tex
    uniforms.uSilTexel.value = silState.texel
    uniforms.uSilMargin.value = silState.marginUv
    ;(uniforms.uSilFx.value as THREE.Vector3).set(INTERACTION_CODE[silState.interaction] ?? 0, silState.strength, silState.invert ? 1 : 0)
  } else {
    uniforms.uSilOn.value = 0
  }
}
