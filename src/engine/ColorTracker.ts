/**
 * ColorTracker — finds the weighted centroid of pixels matching a target HSV color,
 * with SPATIAL COHERENCE: once locked, search is restricted to a window around the
 * previous position. This prevents the tracker from jumping to skin tones or
 * similar-colored objects elsewhere in the frame.
 */

interface TrackerState {
  x: number          // 0..1 normalized canvas coord
  y: number
  vx: number         // normalized units per ms
  vy: number
  confidence: number // 0..1, fades when no match
  lastSeen: number   // ms timestamp
}

export const trackerStates = new Map<string, TrackerState>()

const SAMPLE_W = 160
const SAMPLE_H = 120
const MIN_MATCH = 25     // min matching pixels to update position
const RESYNC_FRAMES = 30 // after this many bad frames, reset to global search

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let video: HTMLVideoElement | null = null
let timer = 0
let running = false

interface ConfigEntry { id: string; h: number; s: number; v: number; tolerance: number }
const configs: ConfigEntry[] = []
const lostCount = new Map<string, number>()  // consecutive misses per tracker

export function setTrackers(list: ConfigEntry[]) {
  configs.length = 0
  for (const c of list) configs.push(c)
  for (const id of Array.from(trackerStates.keys())) {
    if (!list.some((c) => c.id === id)) { trackerStates.delete(id); lostCount.delete(id) }
  }
  // Reset lost count when a config's color changes (id stays same but values change)
  // Caller is expected to clear state explicitly if needed; we just keep last seen.
}

/** Force the tracker to forget its locked position (used when the user re-picks). */
export function resetTracker(id: string) {
  trackerStates.delete(id)
  lostCount.delete(id)
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

/** Distance between two HSV colors, accounting for hue circularity and low-sat unreliability. */
function colorDist(h1: number, s1: number, v1: number, h2: number, s2: number, v2: number): number {
  // Reject very dark or very bright/desaturated noise
  if (v1 < 0.08) return 99
  if (v1 > 0.96 && s1 < 0.08) return 99       // washed out white/highlight
  let dh = Math.abs(h1 - h2)
  if (dh > 0.5) dh = 1 - dh
  // Hue weight grows with both saturations (if either is low, hue is meaningless)
  const hueRelevance = Math.min(s1, s2)
  const ds = Math.abs(s1 - s2)
  const dv = Math.abs(v1 - v2)
  return dh * 2.5 * (0.4 + hueRelevance * 0.6) + ds * 0.7 + dv * 0.5
}

function loop() {
  if (!running || !video || !ctx || !canvas) return
  if (video.readyState >= 2 && configs.length > 0) {
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H)
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data
    const now = performance.now()
    for (const c of configs) {
      const prev = trackerStates.get(c.id)
      // Search window: small if locked, full frame otherwise
      let minX = 0, maxX = SAMPLE_W, minY = 0, maxY = SAMPLE_H
      // Predict next position from velocity (extrapolate ~120ms ahead)
      let predX = prev?.x ?? 0.5
      let predY = prev?.y ?? 0.5
      if (prev && prev.confidence > 0.25) {
        const dtPred = 120  // ms ahead prediction
        predX = Math.max(0.02, Math.min(0.98, prev.x + (prev.vx || 0) * dtPred))
        predY = Math.max(0.02, Math.min(0.98, prev.y + (prev.vy || 0) * dtPred))
        // Bigger window so fast movements stay inside it
        const winSize = SAMPLE_W * (0.28 + (1 - prev.confidence) * 0.18)
        const cxp = predX * SAMPLE_W
        const cyp = predY * SAMPLE_H
        // Expand more in the direction of movement
        const expandX = Math.abs(prev.vx) * 1000 * SAMPLE_W * 0.05
        const expandY = Math.abs(prev.vy) * 1000 * SAMPLE_H * 0.05
        minX = Math.max(0, Math.floor(cxp - winSize - expandX))
        maxX = Math.min(SAMPLE_W, Math.ceil(cxp + winSize + expandX))
        minY = Math.max(0, Math.floor(cyp - winSize - expandY))
        maxY = Math.min(SAMPLE_H, Math.ceil(cyp + winSize + expandY))
      }
      let sx = 0, sy = 0, n = 0
      for (let py = minY; py < maxY; py += 2) {
        for (let px = minX; px < maxX; px += 2) {
          const i = (py * SAMPLE_W + px) * 4
          const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2])
          const d = colorDist(hsv.h, hsv.s, hsv.v, c.h, c.s, c.v)
          if (d < c.tolerance) { sx += px; sy += py; n++ }
        }
      }
      const nextPrev: TrackerState = prev ?? { x: 0.5, y: 0.5, vx: 0, vy: 0, confidence: 0, lastSeen: 0 }
      if (n >= MIN_MATCH) {
        const cx = 1 - (sx / n) / SAMPLE_W   // mirror X
        const cy = (sy / n) / SAMPLE_H
        const windowArea = Math.max(1, ((maxX - minX) / 2) * ((maxY - minY) / 2))
        const density = Math.min(1, n / (windowArea * 0.18))
        const newConf = Math.min(1, density * 1.5)
        // Compute velocity (delta-based) BEFORE smoothing pos
        const dt = nextPrev.lastSeen > 0 ? Math.max(20, now - nextPrev.lastSeen) : 100
        const newVx = (cx - nextPrev.x) / dt
        const newVy = (cy - nextPrev.y) / dt
        // Faster position update: 0.5 weight on new pos (was 0.4)
        nextPrev.x = nextPrev.confidence > 0.3 ? nextPrev.x * 0.5 + cx * 0.5 : cx
        nextPrev.y = nextPrev.confidence > 0.3 ? nextPrev.y * 0.5 + cy * 0.5 : cy
        // Smooth velocity (it tends to be noisy)
        nextPrev.vx = nextPrev.vx * 0.6 + newVx * 0.4
        nextPrev.vy = nextPrev.vy * 0.6 + newVy * 0.4
        nextPrev.confidence = Math.max(nextPrev.confidence * 0.5, newConf)
        nextPrev.lastSeen = now
        lostCount.set(c.id, 0)
      } else {
        // Lost frame — decay confidence, decay velocity, keep predicting
        nextPrev.confidence *= 0.92
        nextPrev.vx *= 0.85
        nextPrev.vy *= 0.85
        const lost = (lostCount.get(c.id) ?? 0) + 1
        lostCount.set(c.id, lost)
        if (lost > RESYNC_FRAMES) { nextPrev.confidence = 0; nextPrev.vx = 0; nextPrev.vy = 0 }
      }
      trackerStates.set(c.id, nextPrev)
    }
  }
  timer = window.setTimeout(loop, 75)  // ~13 Hz
}

/** Sample a pixel color from a video element at normalized stage coords (0..1, top-left origin). */
export function pickColorAt(videoEl: HTMLVideoElement | null, nx: number, ny: number): { h: number; s: number; v: number } | null {
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
  const px = Math.max(0, Math.min(SAMPLE_W - 1, Math.floor((1 - nx) * SAMPLE_W)))
  const py = Math.max(0, Math.min(SAMPLE_H - 1, Math.floor(ny * SAMPLE_H)))
  let sr = 0, sg = 0, sb = 0, n = 0
  const half = 3
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
