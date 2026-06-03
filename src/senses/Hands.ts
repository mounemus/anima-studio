import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { senseBus } from './SenseBus'

let landmarker: HandLandmarker | null = null
let video: HTMLVideoElement | null = null
let rafId = 0
let running = false
let lastVideoTime = -1

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
  loop()
}

export function stopHands() {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  senseBus.hands.detected = false
}

function loop() {
  if (!running || !video || !landmarker) return
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime
    const res = landmarker.detectForVideo(video, performance.now())
    if (res.landmarks && res.landmarks.length > 0) {
      const lm = res.landmarks[0]
      // landmarks: 0 wrist, 4 thumb tip, 5 index base, 8 index tip, 12 mid tip, 16 ring tip, 20 pinky tip, 9 mid base
      const indexTip = lm[8]
      const thumbTip = lm[4]
      const palm = lm[9]
      const pinchDist = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y, (indexTip.z ?? 0) - (thumbTip.z ?? 0))
      const pinch = Math.max(0, Math.min(1, 1 - pinchDist * 5))
      // openness ~ avg distance of finger tips to palm
      const tips = [lm[8], lm[12], lm[16], lm[20]]
      const opn = tips.reduce((s, t) => s + Math.hypot(t.x - palm.x, t.y - palm.y), 0) / tips.length
      const openness = Math.max(0, Math.min(1, opn * 3))
      // mirror x (webcam is mirrored visually)
      senseBus.hands.detected = true
      senseBus.hands.indexTip.x = 1 - indexTip.x
      senseBus.hands.indexTip.y = indexTip.y
      senseBus.hands.indexTip.z = indexTip.z ?? 0
      senseBus.hands.palm.x = 1 - palm.x
      senseBus.hands.palm.y = palm.y
      senseBus.hands.palm.z = palm.z ?? 0
      senseBus.hands.pinch = pinch
      senseBus.hands.openness = openness
    } else {
      senseBus.hands.detected = false
    }
  }
  rafId = requestAnimationFrame(loop)
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
