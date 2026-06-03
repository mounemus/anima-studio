/** WebM video recording from canvas */
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []

export function isRecording() { return !!recorder && recorder.state === 'recording' }

export function startRecording(canvas: HTMLCanvasElement, fps = 60) {
  if (recorder) return
  const stream = canvas.captureStream(fps)
  chunks = []
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
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
      resolve()
    }
    recorder.stop()
  })
}

export function screenshot(canvas: HTMLCanvasElement, filename = `anima-${Date.now()}.png`) {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'image/png')
}

export function enterFullscreen(el: HTMLElement) {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* ignore */ })
  }
}
