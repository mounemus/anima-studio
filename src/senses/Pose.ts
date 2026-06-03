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
  loop()
}

export function stopPose() {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  senseBus.pose.detected = false
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
      for (let i = 0; i < 33; i++) {
        const p = lm[i]
        if (!p) continue
        // mirror X to match the visually-mirrored webcam display
        dst[i].x = 1 - p.x
        dst[i].y = p.y
        dst[i].z = p.z ?? 0
        dst[i].vis = (p as any).visibility ?? 1
      }
    } else {
      senseBus.pose.detected = false
    }
  }
  rafId = requestAnimationFrame(loop)
}
