import { senseBus } from './SenseBus'

let video: HTMLVideoElement | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let timer = 0
let running = false

const SAMPLE_W = 32
const SAMPLE_H = 24

export function startLight(videoEl: HTMLVideoElement) {
  if (running) return
  video = videoEl
  canvas = document.createElement('canvas')
  canvas.width = SAMPLE_W; canvas.height = SAMPLE_H
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  running = true
  loop()
}

export function stopLight() {
  running = false
  clearTimeout(timer)
  video = null; canvas = null; ctx = null
}

function loop() {
  if (!running || !video || !ctx || !canvas) return
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H)
    const img = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data
    let r = 0, g = 0, b = 0
    const px = SAMPLE_W * SAMPLE_H
    for (let i = 0; i < img.length; i += 4) {
      r += img[i]; g += img[i + 1]; b += img[i + 2]
    }
    r /= px; g /= px; b /= px
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const warmth = Math.max(0, Math.min(1, 0.5 + (r - b) / 256))
    // smooth
    senseBus.light.brightness = senseBus.light.brightness * 0.7 + brightness * 0.3
    senseBus.light.warmth = senseBus.light.warmth * 0.7 + warmth * 0.3
  }
  timer = window.setTimeout(loop, 100) // 10 Hz is plenty
}
