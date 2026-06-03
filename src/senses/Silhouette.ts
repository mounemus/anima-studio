/**
 * MediaPipe SelfieSegmenter — produces a binary person mask from the webcam.
 * Updated at ~10 Hz to keep CPU happy; consumed by the obstacle solver.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import { createMask, type SilhouetteMask } from '../engine/Obstacles'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

const MASK_W = 192
const MASK_H = 192

let segmenter: ImageSegmenter | null = null
let video: HTMLVideoElement | null = null
let running = false
let lastT = -1
let timer = 0
let mask: SilhouetteMask | null = null

export function getSilhouetteMask(): SilhouetteMask | null {
  return mask
}

async function ensureSegmenter() {
  if (segmenter) return segmenter
  const files = await FilesetResolver.forVisionTasks(WASM_BASE)
  segmenter = await ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  })
  return segmenter
}

export async function startSilhouette(videoEl: HTMLVideoElement) {
  if (running) return
  video = videoEl
  running = true
  mask = createMask(MASK_W, MASK_H)
  await ensureSegmenter()
  loop()
}

export function stopSilhouette() {
  running = false
  clearTimeout(timer)
  if (mask) {
    mask.data.fill(0)
  }
  mask = null
}

function loop() {
  if (!running || !video || !segmenter || !mask) return
  if (video.readyState >= 2 && video.currentTime !== lastT) {
    lastT = video.currentTime
    try {
      const res = segmenter.segmentForVideo(video, performance.now())
      const cat = res.categoryMask
      if (cat) {
        // SelfieSegmenter: 0 = background, 1 = person
        const arr = cat.getAsUint8Array()
        const sw = cat.width, sh = cat.height
        // Downsample/upsample into our fixed mask (mirror X to match Hands)
        const dst = mask.data
        for (let y = 0; y < MASK_H; y++) {
          const sy = Math.floor((y / MASK_H) * sh)
          for (let x = 0; x < MASK_W; x++) {
            // mirror X
            const sx = Math.floor(((MASK_W - 1 - x) / MASK_W) * sw)
            const v = arr[sy * sw + sx]
            dst[y * MASK_W + x] = v === 0 ? 255 : 0   // model: 0=person, others=bg (SelfieSeg convention is reversed)
          }
        }
        cat.close()
      }
    } catch { /* ignore frame */ }
  }
  timer = window.setTimeout(loop, 100)  // 10 fps is plenty for obstacles
}
