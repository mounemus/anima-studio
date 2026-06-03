/**
 * Voice I/O — tries OpenAI Whisper/TTS first, falls back to browser Web Speech APIs.
 * Browser APIs work offline, no key required (Chrome / Edge).
 */

// ============ Speech Recognition (input) ============

const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

export function hasBrowserSTT(): boolean { return !!SpeechRecognitionCtor }

/** Live browser-based recognition: starts mic, resolves with transcript when user stops speaking. */
export function recognizeLive(lang = 'fr-FR'): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!SpeechRecognitionCtor) return reject(new Error('SpeechRecognition non disponible (utilise Chrome/Edge)'))
    const r: any = new SpeechRecognitionCtor()
    r.lang = lang
    r.continuous = false
    r.interimResults = false
    r.maxAlternatives = 1
    let resolved = false
    r.onresult = (e: any) => {
      const t = e.results?.[0]?.[0]?.transcript ?? ''
      resolved = true
      resolve(t.trim())
    }
    r.onerror = (e: any) => { if (!resolved) reject(new Error(e.error || 'recognition error')) }
    r.onend = () => { if (!resolved) resolve('') }
    try { r.start() } catch (e) { reject(e) }
    // expose so we can stop
    activeRecognition = r
  })
}

let activeRecognition: any = null
export function stopLiveRecognition() {
  if (activeRecognition) { try { activeRecognition.stop() } catch {} ; activeRecognition = null }
}

// ============ MediaRecorder + Whisper (server) ============

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

export async function transcribeViaWhisper(blob: Blob, language = 'fr'): Promise<string> {
  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('language', language)
  const r = await fetch('/api/openai/whisper', { method: 'POST', body: form })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'whisper failed')
  return d.text ?? ''
}

// ============ Text-to-Speech (output) ============

let currentAudio: HTMLAudioElement | null = null
let lastTTSFailed = false   // sticky: once OpenAI denied, stop hammering

export function hasBrowserTTS(): boolean { return 'speechSynthesis' in window }

function speakBrowser(text: string, lang = 'fr-FR'): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve()
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    u.rate = 1
    u.pitch = 1
    // prefer a French voice if available
    const voices = window.speechSynthesis.getVoices()
    const fr = voices.find((v) => v.lang?.startsWith('fr')) ?? voices.find((v) => v.default)
    if (fr) u.voice = fr
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  })
}

export async function speak(text: string, voice: string = 'nova', speed = 1): Promise<void> {
  stopSpeaking()
  if (!text) return
  // Try OpenAI TTS unless we know it's blocked
  if (!lastTTSFailed) {
    try {
      const r = await fetch('/api/openai/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }),
      })
      if (r.ok) {
        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        currentAudio = new Audio(url)
        currentAudio.onended = () => { URL.revokeObjectURL(url); currentAudio = null }
        await currentAudio.play()
        return
      } else {
        // remember the failure to avoid retrying every time
        lastTTSFailed = true
        console.info('TTS OpenAI indisponible → fallback browser SpeechSynthesis')
      }
    } catch { lastTTSFailed = true }
  }
  // fallback
  await speakBrowser(text)
}

export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}
