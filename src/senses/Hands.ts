import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { senseBus } from './SenseBus'

let landmarker: HandLandmarker | null = null
let video: HTMLVideoElement | null = null
let rafId = 0
let running = false
let lastVideoTime = -1
/** When the last frame produced a positive detection (perf.now ms). Used to
 *  reset `senseBus.hands.detected` after a short timeout, so transient drops
 *  don't keep the flag stuck true for a stale frame. */
let lastDetectionTime = 0
const STALE_TIMEOUT_MS = 300

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

async function ensureLandmarker() {
  if (landmarker) return landmarker
  const files = await FilesetResolver.forVisionTasks(WASM_BASE)
  landmarker = await HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  return landmarker
}

export async function startHands(videoEl: HTMLVideoElement) {
  if (running) return
  video = videoEl
  running = true
  await ensureLandmarker()
  // Wait for the MediaStream to start producing frames before kicking off the
  // RAF loop. Without this, the first few loop() iterations call detectForVideo
  // on a video whose currentTime is still 0 (no frames produced), which spams
  // MediaPipe with no-op work and adds ~50ms of startup lag.
  if (videoEl.readyState < 2) {
    await new Promise<void>((resolve) => {
      const onReady = () => { videoEl.removeEventListener('loadeddata', onReady); resolve() }
      videoEl.addEventListener('loadeddata', onReady)
      // Safety timeout so we never block forever
      setTimeout(() => { videoEl.removeEventListener('loadeddata', onReady); resolve() }, 1500)
    })
  }
  loop()
}

export function stopHands() {
  running = false
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  senseBus.hands.detected = false
  // Free MediaPipe resources (WASM module + GPU textures) — otherwise toggling
  // the camera off/on across many sessions slowly grows wasm memory until OOM.
  if (landmarker) {
    try { landmarker.close() } catch { /* ignore */ }
    landmarker = null
  }
  video = null
  lastVideoTime = -1
  lastDetectionTime = 0
}

function loop() {
  // Re-check `running` BEFORE scheduling the next RAF — a `stopHands()` called
  // mid-frame would otherwise be racy (one extra iteration could fire after
  // landmarker was nulled out, throwing a TypeError).
  if (!running || !video || !landmarker) return
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime
    const res = landmarker.detectForVideo(video, performance.now())
    if (res.landmarks && res.landmarks.length > 0) {
      const lm = res.landmarks[0]
      const indexTip = lm[8]
      const thumbTip = lm[4]
      const palm = lm[9]
      const pinchDist = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y, (indexTip.z ?? 0) - (thumbTip.z ?? 0))
      const pinch = Math.max(0, Math.min(1, 1 - pinchDist * 5))
      const tips = [lm[8], lm[12], lm[16], lm[20]]
      const opn = tips.reduce((s, t) => s + Math.hypot(t.x - palm.x, t.y - palm.y), 0) / tips.length
      const openness = Math.max(0, Math.min(1, opn * 3))
      // MediaPipe x is mirrored once here (webcam is mirrored visually); the rest
      // of the pipeline (Obstacles.toWorldX, ColorTracker.pickColorAt, MaskedWebcam)
      // must NOT apply another `1 - x` flip — they read these values as-is.
      senseBus.hands.detected = true
      senseBus.hands.indexTip.x = 1 - indexTip.x
      senseBus.hands.indexTip.y = indexTip.y
      senseBus.hands.indexTip.z = indexTip.z ?? 0
      senseBus.hands.palm.x = 1 - palm.x
      senseBus.hands.palm.y = palm.y
      senseBus.hands.palm.z = palm.z ?? 0
      senseBus.hands.pinch = pinch
      senseBus.hands.openness = openness
      // Mirror + copy all 21 landmarks into the pre-allocated buffer so the
      // overlay can draw the full hand skeleton. Same mirrored-x convention
      // as indexTip/palm — downstream readers must NOT apply another flip.
      const dst = senseBus.hands.landmarks
      for (let i = 0; i < 21; i++) {
        const src = lm[i]
        if (!src) continue
        dst[i].x = 1 - src.x
        dst[i].y = src.y
        dst[i].z = src.z ?? 0
      }
      lastDetectionTime = performance.now()
    } else {
      senseBus.hands.detected = false
    }
  }
  // Stale guard: if we haven't had a positive detection in the last 300ms,
  // force `detected = false` even if the last frame happened to set true.
  // This avoids ghosts where the hand left the frame mid-update.
  if (senseBus.hands.detected && performance.now() - lastDetectionTime > STALE_TIMEOUT_MS) {
    senseBus.hands.detected = false
  }
  if (running) rafId = requestAnimationFrame(loop)
}

export async function createCameraStream(videoEl: HTMLVideoElement) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  })
  videoEl.srcObject = stream
  videoEl.muted = true
  videoEl.playsInline = true
  await videoEl.play()
  return stream
}
