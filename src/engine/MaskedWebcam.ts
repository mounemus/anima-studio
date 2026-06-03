/**
 * Composites the webcam video with the SelfieSegmenter silhouette mask into a single
 * canvas, then exposes it as a THREE.CanvasTexture. Used when arMaskBody is enabled:
 * the resulting texture is the webcam clipped to the body — environment becomes
 * transparent so downstream zones only show the person.
 *
 * Single shared instance (sufficient for all webcam-content zones).
 */
import * as THREE from 'three'
import { getSilhouetteMask } from '../senses/Silhouette'

const CANVAS_W = 512
const CANVAS_H = 384

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let texture: THREE.CanvasTexture | null = null
let rafId = 0
let running = false
let maskCanvas: HTMLCanvasElement | null = null
let maskCtx: CanvasRenderingContext2D | null = null
// Hoisted: reused every frame to avoid allocating 196 608 bytes per loop()
// (createImageData allocates a fresh Uint8ClampedArray each call → big GC pressure).
let maskImg: ImageData | null = null
let lastMaskSize = { w: 0, h: 0 }

function ensure() {
  if (canvas) return
  canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  ctx = canvas.getContext('2d', { willReadFrequently: false })
  texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter

  maskCanvas = document.createElement('canvas')
  maskCanvas.width = CANVAS_W
  maskCanvas.height = CANVAS_H
  maskCtx = maskCanvas.getContext('2d')!
}

export function startMaskedWebcam() {
  if (running) return
  ensure()
  running = true
  loop()
}

export function stopMaskedWebcam() {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
}

export function getMaskedWebcamTexture(): THREE.CanvasTexture | null {
  if (!texture) ensure()
  return texture
}

function loop() {
  if (!running || !ctx || !canvas || !maskCanvas || !maskCtx || !texture) return
  const video = document.querySelector('video.mirror-bg') as HTMLVideoElement | null
    ?? document.querySelector('video') as HTMLVideoElement | null
  const mask = getSilhouetteMask()

  if (video && video.readyState >= 2 && video.videoWidth > 0) {
    // 1) Draw the webcam frame (already mirrored at display time — here we draw raw)
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.drawImage(video, 0, 0, CANVAS_W, CANVAS_H)

    if (mask) {
      // 2) Build a mask image (white where person, transparent where background).
      // Reuse the ImageData buffer across frames when the mask size hasn't changed
      // (typical case — MediaPipe SelfieSegmenter emits a fixed 256×144 mask).
      if (!maskImg || lastMaskSize.w !== mask.w || lastMaskSize.h !== mask.h) {
        maskImg = maskCtx.createImageData(mask.w, mask.h)
        lastMaskSize = { w: mask.w, h: mask.h }
        // Pre-fill RGB to white — only alpha changes per frame
        const d = maskImg.data
        for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255 }
      }
      const data = maskImg.data
      for (let i = 0; i < mask.data.length; i++) {
        data[i * 4 + 3] = mask.data[i] > 127 ? 255 : 0
      }
      maskCtx.putImageData(maskImg, 0, 0)

      // 3) Use destination-in: keep webcam pixels where mask alpha > 0
      ctx.globalCompositeOperation = 'destination-in'
      // Smooth the mask a bit with a small blur via the canvas filter API
      ctx.filter = 'blur(2px)'
      ctx.drawImage(maskCanvas, 0, 0, CANVAS_W, CANVAS_H)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
    }

    texture.needsUpdate = true
  }

  rafId = requestAnimationFrame(loop)
}
