/**
 * Timeline engine — keyframe-based parameter automation.
 *
 * Design goals:
 * - Decouple from React: a singleton ticked from the engine RAF loop.
 *   The store updates UI; the engine reads timeline state every frame and
 *   patches the scene's organism values / flow / visual on the fly.
 * - JSON-serializable: every track lives inside `scene.timeline` so it
 *   travels with the scene through save/load/export.
 * - Easing: linear, easeInOut, spring (mass-spring-damper).
 *
 * A Track binds a *path* in the scene (e.g. 'organism.values.speed') to a
 * sequence of (time, value) keyframes. The Timeline can be played/paused/
 * scrubbed; when active, each tick interpolates the current value per track
 * and dispatches a patch through a callback the engine provides.
 */
import type { Scene } from '../types/scene'

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring' | 'step'

export interface Keyframe {
  /** Time in seconds from timeline start. */
  t: number
  /** Numeric value, OR a hex color string '#rrggbb'. */
  v: number | string
  /** Per-keyframe easing; falls back to track default. */
  easing?: Easing
}

export interface Track {
  id: string
  /** Dot-notation path: 'organism.values.speed' | 'visual.feedback' | 'flow.angle' | 'visual.palette.primary' (color). */
  path: string
  /** Display label for the UI. */
  label: string
  /** Color of the track row in the UI (any CSS color). */
  color: string
  /** Default easing applied between keyframes that don't override. */
  easing: Easing
  /** Sorted by time. */
  keyframes: Keyframe[]
}

export interface TimelineState {
  /** Total length in seconds. */
  duration: number
  /** Looping when playback reaches the end. */
  loop: boolean
  /** Tracks (order = display order in UI). */
  tracks: Track[]
}

export const defaultTimeline = (): TimelineState => ({
  duration: 60,
  loop: true,
  tracks: [],
})

// ---------------- Easing functions ----------------

function ease(e: Easing, t: number): number {
  switch (e) {
    case 'linear': return t
    case 'easeIn': return t * t
    case 'easeOut': return 1 - (1 - t) * (1 - t)
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    case 'spring': {
      // Damped sine. Overshoots ~10% then settles. Pleasing for slow organic moves.
      const c4 = (2 * Math.PI) / 3
      return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
    }
    case 'step': return t < 1 ? 0 : 1
  }
}

// ---------------- Color interpolation ----------------

function hexToRgb(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h)
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
}

// ---------------- Sampler ----------------

/** Sample a track at time `t` in seconds. Returns undefined if no keyframes. */
export function sampleTrack(track: Track, time: number): number | string | undefined {
  const ks = track.keyframes
  if (ks.length === 0) return undefined
  if (ks.length === 1) return ks[0].v
  // Clamp to the boundaries
  if (time <= ks[0].t) return ks[0].v
  if (time >= ks[ks.length - 1].t) return ks[ks.length - 1].v
  // Binary search the bracketing pair
  let lo = 0, hi = ks.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ks[mid].t <= time) lo = mid; else hi = mid
  }
  const a = ks[lo], b = ks[hi]
  const span = b.t - a.t
  const u = span <= 0 ? 0 : (time - a.t) / span
  const e = ease(b.easing ?? track.easing, u)
  if (typeof a.v === 'string' || typeof b.v === 'string') {
    return lerpColor(String(a.v), String(b.v), e)
  }
  return (a.v as number) + ((b.v as number) - (a.v as number)) * e
}

// ---------------- Playback runtime ----------------

type Patch = { path: string; value: number | string }

export interface TimelineRuntime {
  state: TimelineState
  /** True when playback is running. */
  playing: boolean
  /** Current playhead time in seconds. */
  time: number
  /** Wall-clock at which `time` was last anchored (for delta calculation). */
  anchor: number
}

export const runtime: TimelineRuntime = {
  state: defaultTimeline(),
  playing: false,
  time: 0,
  anchor: 0,
}

export function loadTimeline(t: TimelineState | undefined) {
  runtime.state = t ? { ...t, tracks: [...t.tracks] } : defaultTimeline()
  runtime.time = 0
  runtime.playing = false
}

export function play() {
  if (runtime.playing) return
  runtime.playing = true
  runtime.anchor = performance.now()
}

export function pause() {
  if (!runtime.playing) return
  // Bake the elapsed time into runtime.time so resume picks up correctly
  const now = performance.now()
  runtime.time += (now - runtime.anchor) / 1000
  runtime.playing = false
}

export function stop() {
  runtime.playing = false
  runtime.time = 0
}

export function seek(t: number) {
  runtime.time = Math.max(0, Math.min(runtime.state.duration, t))
  runtime.anchor = performance.now()
}

/** Compute the current playhead time without mutating anchors. */
export function currentTime(): number {
  if (!runtime.playing) return runtime.time
  const now = performance.now()
  let t = runtime.time + (now - runtime.anchor) / 1000
  const d = runtime.state.duration
  if (t > d) {
    if (runtime.state.loop) t = t % d
    else { t = d; runtime.playing = false }
  }
  return t
}

/** Sample all tracks at the current time. Returns the list of patches to apply. */
export function tick(): Patch[] {
  if (runtime.state.tracks.length === 0) return []
  const t = currentTime()
  const out: Patch[] = []
  for (const tr of runtime.state.tracks) {
    const v = sampleTrack(tr, t)
    if (v !== undefined) out.push({ path: tr.path, value: v })
  }
  return out
}

/** Apply a patch list onto a scene (returns a NEW scene object — caller should
 *  diff and only persist what changed). */
export function applyPatches(scene: Scene, patches: Patch[]): Scene {
  if (patches.length === 0) return scene
  // We mutate a shallow clone in-place because patching deep paths is annoying
  // otherwise. The caller (engine) reads parameters directly without going
  // through the React store, so the in-memory mutation is fine for visual
  // effect. We don't persist these tick-time patches back to localStorage.
  const next: any = { ...scene }
  for (const p of patches) {
    setPath(next, p.path, p.value)
  }
  return next
}

function setPath(obj: any, path: string, value: any) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (cur[k] === undefined || cur[k] === null) cur[k] = {}
    else cur[k] = { ...cur[k] }
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

// ---------------- Track management helpers (used by UI) ----------------

export function newTrack(path: string, label: string, color = '#00ffa3', easing: Easing = 'easeInOut'): Track {
  return { id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, path, label, color, easing, keyframes: [] }
}

export function addKey(track: Track, k: Keyframe): Track {
  const keyframes = [...track.keyframes.filter((x) => Math.abs(x.t - k.t) > 1e-4), k]
    .sort((a, b) => a.t - b.t)
  return { ...track, keyframes }
}

export function removeKey(track: Track, idx: number): Track {
  return { ...track, keyframes: track.keyframes.filter((_, i) => i !== idx) }
}

export function moveKey(track: Track, idx: number, t: number, v?: number | string): Track {
  const keyframes = track.keyframes.map((k, i) => i === idx ? { ...k, t, v: v ?? k.v } : k)
    .sort((a, b) => a.t - b.t)
  return { ...track, keyframes }
}

/** Suggested targets — used by the UI to populate the "add track" dropdown. */
export const TRACK_TARGETS: { path: string; label: string; type: 'number' | 'color'; defaultMin?: number; defaultMax?: number }[] = [
  { path: 'organism.values.speed', label: 'Vitesse', type: 'number', defaultMin: 0.1, defaultMax: 3 },
  { path: 'organism.values.count', label: 'Densité (count)', type: 'number', defaultMin: 50, defaultMax: 5000 },
  { path: 'organism.values.trail', label: 'Traînée', type: 'number', defaultMin: 0.5, defaultMax: 0.99 },
  { path: 'organism.values.size', label: 'Taille', type: 'number', defaultMin: 0.001, defaultMax: 0.05 },
  { path: 'visual.feedback', label: 'Feedback (rémanence)', type: 'number', defaultMin: 0.7, defaultMax: 0.99 },
  { path: 'visual.bloom', label: 'Bloom', type: 'number', defaultMin: 0, defaultMax: 2 },
  { path: 'visual.textureIntensity', label: 'Intensité texture', type: 'number', defaultMin: 0, defaultMax: 1 },
  { path: 'visual.palette.bg', label: 'Couleur fond', type: 'color' },
  { path: 'visual.palette.primary', label: 'Couleur principale', type: 'color' },
  { path: 'visual.palette.secondary', label: 'Couleur secondaire', type: 'color' },
  { path: 'visual.palette.glow', label: 'Couleur halo', type: 'color' },
  { path: 'flow.angle', label: 'Flux — angle', type: 'number', defaultMin: -3.14, defaultMax: 3.14 },
  { path: 'flow.strength', label: 'Flux — force', type: 'number', defaultMin: 0, defaultMax: 3 },
  { path: 'flow.turbulence', label: 'Flux — turbulence', type: 'number', defaultMin: 0, defaultMax: 2 },
]
