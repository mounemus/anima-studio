/** Live webcam → img2img loop. Captures frames periodically, sends to /api/fal/img2img, fires callback with the resulting image URL. */

export interface LiveImg2ImgOptions {
  video: HTMLVideoElement
  prompt: string
  strength?: number
  intervalMs?: number      // min delay between requests, default 1500
  onResult: (url: string) => void
  onError?: (err: string) => void
  onStatus?: (status: 'idle' | 'capturing' | 'pending' | 'error') => void
}

let captureCanvas: HTMLCanvasElement | null = null
let captureCtx: CanvasRenderingContext2D | null = null

function getCaptureCanvas() {
  if (!captureCanvas) {
    captureCanvas = document.createElement('canvas')
    captureCanvas.width = 512
    captureCanvas.height = 512
    captureCtx = captureCanvas.getContext('2d')
  }
  return { canvas: captureCanvas, ctx: captureCtx! }
}

function captureFrame(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || !video.videoWidth) return null
  const { canvas, ctx } = getCaptureCanvas()
  // square crop center
  const vw = video.videoWidth, vh = video.videoHeight
  const s = Math.min(vw, vh)
  const sx = (vw - s) / 2, sy = (vh - s) / 2
  // mirror horizontally (webcam UX)
  ctx.save()
  ctx.scale(-1, 1)
  ctx.drawImage(video, sx, sy, s, s, -canvas.width, 0, canvas.width, canvas.height)
  ctx.restore()
  return canvas.toDataURL('image/jpeg', 0.7)
}

export class LiveImg2Img {
  private opts: LiveImg2ImgOptions
  private running = false
  private timer: number | null = null

  constructor(opts: LiveImg2ImgOptions) {
    this.opts = { intervalMs: 1500, strength: 0.6, ...opts }
  }

  setPrompt(p: string) { this.opts.prompt = p }
  setStrength(s: number) { this.opts.strength = s }

  start() {
    if (this.running) return
    this.running = true
    this.opts.onStatus?.('capturing')
    this.tick()
  }

  stop() {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.opts.onStatus?.('idle')
  }

  private async tick() {
    if (!this.running) return
    const t0 = performance.now()
    const frame = captureFrame(this.opts.video)
    if (!frame) {
      this.timer = window.setTimeout(() => this.tick(), 200)
      return
    }
    this.opts.onStatus?.('pending')
    try {
      const r = await fetch('/api/fal/img2img', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: this.opts.prompt,
          image: frame,
          strength: this.opts.strength,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      if (this.running && d.url) {
        this.opts.onResult(d.url)
        this.opts.onStatus?.('capturing')
      }
    } catch (e: any) {
      this.opts.onError?.(e?.message ?? 'erreur')
      this.opts.onStatus?.('error')
    }
    if (this.running) {
      const elapsed = performance.now() - t0
      const wait = Math.max(50, (this.opts.intervalMs ?? 1500) - elapsed)
      this.timer = window.setTimeout(() => this.tick(), wait)
    }
  }
}
