import { useState, useRef, useEffect } from 'react'
import { Send, Sparkles, Mic, Volume2, VolumeX, Square } from 'lucide-react'
import { useSceneStore } from '../store/sceneStore'
import type { Scene } from '../types/scene'
import { startRecording, stopRecording, transcribeViaWhisper, recognizeLive, hasBrowserSTT, speak, stopSpeaking } from '../lib/voiceIO'

interface Message {
  role: 'user' | 'assistant'
  text: string
  action?: string
}

const SUGGESTIONS = [
  'Rends la scène plus apaisante',
  'Plus vif, plus rapide',
  'Palette océan profond',
  'Palette aurore boréale',
  'Augmente la pulsation des basses',
  'Crée une scène méduses',
]

export function AIChat({ open }: { open: boolean }) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const updateOrganism = useSceneStore((s) => s.updateOrganism)
  const patchValues = useSceneStore((s) => s.patchOrganismValues)
  const updateVisual = useSceneStore((s) => s.updateVisual)
  const updatePalette = useSceneStore((s) => s.updatePalette)
  const add = useSceneStore((s) => s.add)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [speakOn, setSpeakOn] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  if (!open) return null

  const send = async (msg?: string) => {
    const text = (msg ?? input).trim()
    if (!text || loading || !current) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text }])
    setLoading(true)
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, scene: current }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erreur API')
      let action = ''
      if (data.actions?.organismValues) {
        patchValues(data.actions.organismValues)
        action = `🧬 Paramètres mis à jour`
      }
      if (data.actions?.organism) {
        updateOrganism(data.actions.organism)
        action = `🧬 Organisme changé en ${data.actions.organism.kind}`
      }
      if (data.actions?.palette) {
        updatePalette(data.actions.palette)
        action = `🎨 Palette modifiée`
      }
      if (data.actions?.visual) {
        updateVisual(data.actions.visual)
        action = `✨ Rendu ajusté`
      }
      if (data.actions?.newScene) {
        const s: Scene = data.actions.newScene
        s.id = `scene-${Date.now().toString(36)}`
        s.createdAt = Date.now()
        s.updatedAt = Date.now()
        await add(s)
        action = `🌱 Nouvelle scène créée: ${s.name}`
      }
      const reply: string = data.reply ?? ''
      setMessages((m) => [...m, { role: 'assistant', text: reply, action }])
      if (speakOn && reply) {
        speak(reply).catch((e) => console.warn('TTS failed', e))
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', text: `❌ ${e?.message ?? e}` }])
    } finally {
      setLoading(false)
    }
  }

  // Voice input strategy: prefer browser SpeechRecognition (free, instant),
  // fall back to MediaRecorder + Whisper if browser API missing.
  const useBrowserSTT = hasBrowserSTT()

  const beginRec = async () => {
    try {
      if (useBrowserSTT) {
        setRecording(true)
        const t = await recognizeLive('fr-FR')
        setRecording(false)
        if (t) send(t)
      } else {
        await startRecording()
        setRecording(true)
      }
    } catch (e: any) {
      setRecording(false)
      setMessages((m) => [...m, { role: 'assistant', text: `❌ Micro: ${e?.message ?? e}` }])
    }
  }
  const endRec = async () => {
    if (!recording) return
    if (useBrowserSTT) return  // recognition auto-ends on silence
    setRecording(false)
    setTranscribing(true)
    try {
      const blob = await stopRecording()
      if (!blob || blob.size < 200) { setTranscribing(false); return }
      const text = await transcribeViaWhisper(blob, 'fr')
      setTranscribing(false)
      if (text) send(text)
    } catch (e: any) {
      setTranscribing(false)
      setMessages((m) => [...m, { role: 'assistant', text: `❌ Whisper: ${e?.message ?? e}` }])
    }
  }

  const toggleSpeak = () => {
    const next = !speakOn
    setSpeakOn(next)
    if (!next) stopSpeaking()
  }

  return (
    <div className="ai-chat" style={{ position: 'absolute', right: 12, top: 12, bottom: 12, width: 340, background: 'rgba(7,8,13,0.92)', backdropFilter: 'blur(12px)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', zIndex: 20 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={14} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 13, flex: 1 }}>Compagnon IA</strong>
        <button
          onClick={toggleSpeak}
          className={speakOn ? 'primary' : 'ghost icon'}
          title={speakOn ? 'Voix activée (OpenAI TTS)' : 'Voix désactivée'}
          style={{ padding: speakOn ? '4px 8px' : 4, fontSize: 11 }}
        >
          {speakOn ? <Volume2 size={12} /> : <VolumeX size={12} />}
          {speakOn ? 'Voix' : ''}
        </button>
      </div>
      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <p style={{ marginBottom: 12 }}>Tape ou maintiens 🎙️ pour parler. Tu peux demander de modifier la scène, créer une ambiance, ajuster les couleurs...</p>
            <div>
              {SUGGESTIONS.map((s) => (
                <kbd key={s} onClick={() => send(s)}>{s}</kbd>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            {m.text}
            {m.action && <div className="action">{m.action}</div>}
          </div>
        ))}
        {(loading || transcribing) && (
          <div className="ai-msg assistant">
            <em style={{ color: 'var(--text-mute)' }}>{transcribing ? 'Transcription...' : '...'}</em>
          </div>
        )}
      </div>
      <div className="ai-input">
        <button
          className={recording ? 'danger' : 'ghost icon'}
          onPointerDown={beginRec}
          onPointerUp={endRec}
          onPointerLeave={endRec}
          title={useBrowserSTT ? 'Cliquer puis parler (FR)' : 'Maintenir pour parler (Whisper FR)'}
          style={{ flexShrink: 0 }}
          disabled={loading || transcribing}
        >
          {recording ? <Square size={14} /> : <Mic size={14} />}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={recording ? '🔴 Écoute en cours...' : 'Tape ou maintiens 🎙️ pour parler'}
          disabled={loading || recording || transcribing}
        />
        <button className="primary" onClick={() => send()} disabled={loading || recording || !input.trim()}>
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
