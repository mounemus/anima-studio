/** Voice I/O — hold-to-talk Whisper + OpenAI TTS playback */

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let stream: MediaStream | null = null

export async function startRecording(): Promise<void> {
  if (recorder) return
  stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  chunks = []
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  recorder = new MediaRecorder(stream, { mimeType: mime })
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
  recorder.start()
}

export function stopRecording(): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (!recorder) return resolve(null)
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' })
      stream?.getTracks().forEach((t) => t.stop())
      recorder = null
      stream = null
      chunks = []
      resolve(blob)
    }
    recorder.stop()
  })
}

export async function transcribe(blob: Blob, language = 'fr'): Promise<string> {
  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('language', language)
  const r = await fetch('/api/openai/whisper', { method: 'POST', body: form })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'whisper failed')
  return d.text ?? ''
}

let currentAudio: HTMLAudioElement | null = null

export async function speak(text: string, voice: string = 'nova', speed = 1): Promise<void> {
  stopSpeaking()
  const r = await fetch('/api/openai/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, speed }),
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error(d.error || `tts ${r.status}`)
  }
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  currentAudio = new Audio(url)
  currentAudio.onended = () => { URL.revokeObjectURL(url); currentAudio = null }
  await currentAudio.play()
}

export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
}
