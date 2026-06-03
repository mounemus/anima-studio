/**
 * ColorTracker — samples the webcam at ~10 Hz and finds the weighted centroid
 * of pixels matching a target HSV color (within tolerance).
 *
 * The centroid is published in `trackerStates[obstacleId]` and consumed by the
 * Obstacles solver to position 'tracker' obstacles in real time.
 */

interface TrackerState {
  x: number          // 0..1 normalized canvas coord
  y: number
  confidence: number // 0..1, fades when no match
  lastSeen: number   // ms timestamp
}

export const trackerStates = new Map<string, TrackerState>()

const SAMPLE_W = 160
const SAMPLE_H = 120

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let video: HTMLVideoElement | null = null
let timer = 0
let running = false

/** Per-tracker config registered from the obstacle list. */
interface ConfigEntry { id: string; h: number; s: number; v: number; tolerance: number }
const configs: ConfigEntry[] = []

export function setTrackers(list: ConfigEntry[]) {
  configs.length = 0
  for (const c of list) configs.push(c)
  // Drop state for removed trackers
  for (const id of Array.from(trackerStates.keys())) {
    if (!list.some((c) => c.id === id)) trackerStates.delete(id)
  }
}

export function startColorTracking(videoEl: HTMLVideoElement) {
  if (running) return
  video = videoEl
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = SAMPLE_W; canvas.height = SAMPLE_H
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  }
  running = true
  loop()
}

export function stopColorTracking() {
  running = false
  clearTimeout(timer)
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

function loop() {
  if (!running || !video || !ctx || !canvas) return
  if (video.readyState >= 2 && configs.length > 0) {
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H)
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data
    // Compute centroid per tracker
    const acc: Record<string, { sx: number; sy: number; n: number }> = {}
    for (const c of configs) acc[c.id] = { sx: 0, sy: 0, n: 0 }
    for (let py = 0; py < SAMPLE_H; py += 2) {     // sample every 2 rows for speed
      for (let px = 0; px < SAMPLE_W; px += 2) {
        const i = (py * SAMPLE_W + px) * 4
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (r + g + b < 30) continue   // skip near-black
        const hsv = rgbToHsv(r, g, b)
        for (const c of configs) {
          let dh = Math.abs(hsv.h - c.h)
          if (dh > 0.5) dh = 1 - dh  // hue wraps
          const ds = Math.abs(hsv.s - c.s) * 0.7
          const dv = Math.abs(hsv.v - c.v) * 0.5
          const dist = dh * 2 + ds + dv
          if (dist < c.tolerance) {
            const a = acc[c.id]
            a.sx += px; a.sy += py; a.n++
          }
        }
      }
    }
    const now = performance.now()
    for (const c of configs) {
      const a = acc[c.id]
      const prev = trackerStates.get(c.id) ?? { x: 0.5, y: 0.5, confidence: 0, lastSeen: 0 }
      if (a.n > 8) {
        // Mirror X to match the visually-mirrored webcam display in MirrorView
        const cx = 1 - (a.sx / a.n) / SAMPLE_W
        const cy = (a.sy / a.n) / SAMPLE_H
        const conf = Math.min(1, a.n / 80)
        // exponential smoothing
        prev.x = prev.x * 0.65 + cx * 0.35
        prev.y = prev.y * 0.65 + cy * 0.35
        prev.confidence = Math.max(prev.confidence * 0.7, conf)
        prev.lastSeen = now
      } else {
        prev.confidence *= 0.85
      }
      trackerStates.set(c.id, prev)
    }
  }
  timer = window.setTimeout(loop, 80)  // ~12 Hz
}

/** Sample a single pixel color from a video element at normalized stage coords (0..1, top-left origin).
 *  Returns the HSV components. Used by the UI color picker.
 *  Tries the visible mirror video first (most reliable), falls back to the hidden tracking video.
 */
export function pickColorAt(videoEl: HTMLVideoElement | null, nx: number, ny: number): { h: number; s: number; v: number } | null {
  // Prefer the visible mirror video — guaranteed to be pumping frames
  const candidates: HTMLVideoElement[] = []
  const mirror = document.querySelector('video.mirror-bg') as HTMLVideoElement | null
  if (mirror && mirror.readyState >= 2 && mirror.videoWidth > 0) candidates.push(mirror)
  if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) candidates.push(videoEl)
  if (candidates.length === 0) return null
  const v = candidates[0]
  const tmp = document.createElement('canvas')
  tmp.width = SAMPLE_W; tmp.height = SAMPLE_H
  const tc = tmp.getContext('2d')
  if (!tc) return null
  tc.drawImage(v, 0, 0, SAMPLE_W, SAMPLE_H)
  // The mirror video is displayed mirrored (scaleX -1), so a stage click at X=nx
  // corresponds to the source-video pixel at X=(1-nx).
  const px = Math.max(0, Math.min(SAMPLE_W - 1, Math.floor((1 - nx) * SAMPLE_W)))
  const py = Math.max(0, Math.min(SAMPLE_H - 1, Math.floor(ny * SAMPLE_H)))
  // Average a small 5×5 neighborhood for stability
  let sr = 0, sg = 0, sb = 0, n = 0
  const half = 2
  const x0 = Math.max(0, px - half)
  const y0 = Math.max(0, py - half)
  const w = Math.min(SAMPLE_W - x0, 2 * half + 1)
  const h = Math.min(SAMPLE_H - y0, 2 * half + 1)
  const img = tc.getImageData(x0, y0, w, h).data
  for (let i = 0; i < img.length; i += 4) {
    sr += img[i]; sg += img[i + 1]; sb += img[i + 2]; n++
  }
  if (n === 0) return null
  return rgbToHsv(sr / n, sg / n, sb / n)
}
