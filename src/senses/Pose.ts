/** MediaPipe PoseLandmarker — 33 landmarks of the body, mirrored to match the webcam. */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { senseBus } from './SenseBus'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'

let landmarker: PoseLandmarker | null = null
let video: HTMLVideoElement | null = null
let rafId = 0
let running = false
let lastT = -1
let lastDetectionTime = 0
const STALE_TIMEOUT_MS = 400  // pose is slower than hands; allow a longer window

async function ensureLandmarker() {
  if (landmarker) return landmarker
  const files = await FilesetResolver.forVisionTasks(WASM_BASE)
  landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  return landmarker
}

export async function startPose(videoEl: HTMLVideoElement) {
  if (running) return
  video = videoEl
  running = true
  await ensureLandmarker()
  if (videoEl.readyState < 2) {
    await new Promise<void>((resolve) => {
      const onReady = () => { videoEl.removeEventListener('loadeddata', onReady); resolve() }
      videoEl.addEventListener('loadeddata', onReady)
      setTimeout(() => { videoEl.removeEventListener('loadeddata', onReady); resolve() }, 1500)
    })
  }
  loop()
}

export function stopPose() {
  running = false
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  senseBus.pose.detected = false
  // Dispose the MediaPipe instance — see Hands.stopHands for the same rationale.
  if (landmarker) {
    try { landmarker.close() } catch { /* ignore */ }
    landmarker = null
  }
  video = null
  lastT = -1
  lastDetectionTime = 0
}

function loop() {
  if (!running || !video || !landmarker) return
  if (video.readyState >= 2 && video.currentTime !== lastT) {
    lastT = video.currentTime
    const res = landmarker.detectForVideo(video, performance.now())
    if (res.landmarks && res.landmarks.length > 0) {
      const lm = res.landmarks[0]
      const dst = senseBus.pose.landmarks
      senseBus.pose.detected = true
      lastDetectionTime = performance.now()
      for (let i = 0; i < 33; i++) {
        const p = lm[i]
        if (!p) continue
        // MediaPipe x mirrored once here (matches the visually-flipped webcam);
        // downstream code reads as-is, no second flip.
        dst[i].x = 1 - p.x
        dst[i].y = p.y
        dst[i].z = p.z ?? 0
        dst[i].vis = (p as any).visibility ?? 1
      }
    } else {
      senseBus.pose.detected = false
    }
  }
  if (senseBus.pose.detected && performance.now() - lastDetectionTime > STALE_TIMEOUT_MS) {
    senseBus.pose.detected = false
  }
  if (running) rafId = requestAnimationFrame(loop)
}
