import { useState, useRef, useEffect } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { useSceneStore } from '../store/sceneStore'
import type { Scene } from '../types/scene'

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
      // apply actions
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
      setMessages((m) => [...m, { role: 'assistant', text: data.reply, action }])
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', text: `❌ ${e?.message ?? e}. Vérifie que ANTHROPIC_API_KEY est défini en variables d'env Vercel.` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="ai-chat" style={{ position: 'absolute', right: 12, top: 12, bottom: 12, width: 320, background: 'rgba(7,8,13,0.92)', backdropFilter: 'blur(12px)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', zIndex: 20 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={14} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 13 }}>Compagnon IA</strong>
      </div>
      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <p style={{ marginBottom: 12 }}>Demande-moi de modifier la scène, créer une nouvelle ambiance, ajuster les couleurs...</p>
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
        {loading && <div className="ai-msg assistant"><em style={{ color: 'var(--text-mute)' }}>...</em></div>}
      </div>
      <div className="ai-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Comment modifier la scène ?"
          disabled={loading}
        />
        <button className="primary" onClick={() => send()} disabled={loading || !input.trim()}>
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
