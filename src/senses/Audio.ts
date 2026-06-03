import { senseBus } from './SenseBus'

let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let data: Uint8Array | null = null
let stream: MediaStream | null = null
let rafId = 0
let running = false

export async function startAudio() {
  if (running) return
  ctx = new AudioContext()
  stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  const src = ctx.createMediaStreamSource(stream)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.7
  src.connect(analyser)
  data = new Uint8Array(analyser.frequencyBinCount)
  running = true
  loop()
}

export function stopAudio() {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  stream?.getTracks().forEach((t) => t.stop())
  ctx?.close()
  ctx = null; analyser = null; data = null; stream = null
  senseBus.audio.level = 0
  senseBus.audio.bass = 0
  senseBus.audio.mid = 0
  senseBus.audio.high = 0
}

function loop() {
  if (!running || !analyser || !data) return
  // @ts-expect-error TS DOM lib mismatch with byte array overload
  analyser.getByteFrequencyData(data)
  // bands
  const n = data.length
  const bassEnd = Math.floor(n * 0.08)
  const midEnd = Math.floor(n * 0.35)
  let bass = 0, mid = 0, high = 0, total = 0
  for (let i = 0; i < n; i++) {
    const v = data[i] / 255
    total += v
    if (i < bassEnd) bass += v
    else if (i < midEnd) mid += v
    else high += v
  }
  senseBus.audio.bass = Math.min(1, bass / bassEnd * 1.5)
  senseBus.audio.mid = Math.min(1, mid / (midEnd - bassEnd) * 1.2)
  senseBus.audio.high = Math.min(1, high / (n - midEnd) * 1.4)
  senseBus.audio.level = Math.min(1, total / n * 1.3)
  // downsample spectrum to 64 buckets
  const out = senseBus.audio.spectrum
  const step = Math.floor(n / out.length)
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (let j = 0; j < step; j++) s += data[i * step + j] / 255
    out[i] = s / step
  }
  rafId = requestAnimationFrame(loop)
}
