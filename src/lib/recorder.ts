/** WebM video recording from canvas, with optional audio track. */
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let startedAt = 0

export function isRecording() { return !!recorder && recorder.state === 'recording' }

/** Milliseconds since the current recording started (0 if not recording). */
export function recordingElapsed() { return recorder ? Date.now() - startedAt : 0 }

export interface RecordOptions {
  fps?: number
  /** Live audio stream (e.g. soundEngine.getRecordingAudioStream()) to mux in. */
  audio?: MediaStream | null
}

export function startRecording(canvas: HTMLCanvasElement, opts: RecordOptions = {}) {
  if (recorder) return
  const fps = opts.fps ?? 60
  const videoStream = canvas.captureStream(fps)
  // Combine the canvas video track with the audio track (if any) into one stream.
  const combined = new MediaStream()
  videoStream.getVideoTracks().forEach((t) => combined.addTrack(t))
  if (opts.audio) opts.audio.getAudioTracks().forEach((t) => combined.addTrack(t))

  chunks = []
  // Prefer VP9 + Opus; fall back gracefully so older browsers still record.
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
  ]
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
  recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
  startedAt = Date.now()
  recorder.start(1000)
}

export function stopRecording(filename = `anima-${Date.now()}.webm`) {
  return new Promise<void>((resolve) => {
    if (!recorder) return resolve()
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
      recorder = null
      chunks = []
      startedAt = 0
      resolve()
    }
    recorder.stop()
  })
}

/** Capture the current canvas as a PNG. Returns the pixel dimensions captured
 *  so the UI can report the resolution (already 2× on hi-DPI displays). */
export function screenshot(canvas: HTMLCanvasElement, filename = `anima-${Date.now()}.png`): { w: number; h: number } {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'image/png')
  return { w: canvas.width, h: canvas.height }
}

export function enterFullscreen(el: HTMLElement) {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* ignore */ })
  }
}
