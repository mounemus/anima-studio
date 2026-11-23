/**
 * Télécommande : la tablette ou le téléphone devient un périphérique de l'Esquisse spatiale ouverte sur le PC.
 * Trois usages, au choix : tablette de dessin (le cadre est l'écran du PC), souris (pavé tactile), commande (boutons).
 * La liaison est directe entre les deux appareils, après un code à six chiffres affiché sur le PC.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { joinLink, type Link as Wire, type LinkState } from './link'
import { parseHello, padRect, padToView, moveCursor, type Hello, type Msg } from './protocol'
import { devicePose, twoFinger } from '../spatial/tablet'

type Mode = 'tablet' | 'mouse' | 'pad'
type Hold = '' | 'draw' | 'orbit'
type Pt = { x: number; y: number }
const MODES: { id: Mode; icon: string; label: string }[] = [
  { id: 'tablet', icon: '✍️', label: 'Tablette de dessin' },
  { id: 'mouse', icon: '🖱️', label: 'Souris' },
  { id: 'pad', icon: '🎛️', label: 'Commande' },
]
const PLANES: [string, string][] = [['front', 'Face'], ['top', 'Dessus'], ['side', 'Côté'], ['iso', '3/4']]
const STEP = Math.PI / 12

export function RemotePage() {
  const [state, setState] = useState<LinkState>('off')
  const [note, setNote] = useState('')
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<Mode>('tablet')
  const [hello, setHello] = useState<Hello | null>(null)
  const [gyro, setGyro] = useState(false)
  const [fingerDraws, setFingerDraws] = useState(true)   // un doigt dessine ; dès qu'un stylet est vu, un doigt tourne la vue
  const [hold, setHold] = useState<Hold>('')
  const [box, setBox] = useState({ w: 0, h: 0 })
  const wire = useRef<Wire | null>(null), surface = useRef<HTMLDivElement>(null)
  const g = useRef({
    touches: new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>(),
    two: null as null | { a: Pt; b: Pt; spread: number; twist: number; zooming: boolean; turning: boolean },
    drawing: false, orbit: false, multi: false, penDown: false, cur: { x: 0.5, y: 0.5 }, hold: '' as Hold,
  }).current
  const aspect = hello?.aspect ?? 16 / 9

  const send = (m: Msg) => wire.current?.send(m)
  const ptr = (v: Pt, d: boolean, p = -1, c = false) => send({ t: 'ptr', x: v.x, y: v.y, d, p, c })
  const nav = (o: Partial<Extract<Msg, { t: 'nav' }>>) => send({ t: 'nav', dx: 0, dy: 0, s: 1, r: 0, yaw: 0, pitch: 0, cx: 0.5, cy: 0.5, end: false, ...o })
  const cmd = (name: string, data?: unknown) => send({ t: 'cmd', name, data } as Msg)

  const join = async () => {
    if (code.length !== 6 || state === 'waiting') return
    setNote(''); setHello(null)
    wire.current = await joinLink(code, {
      onState: (s, n) => { setState(s); if (s === 'off') { setGyro(false); setNote(n ?? '') } },
      onMsg: (raw) => { const h = parseHello(raw); if (h) setHello(h) },
    })
  }
  useEffect(() => () => wire.current?.close(), [])
  // l'écran ne se met pas en veille pendant qu'on pilote le PC
  useEffect(() => {
    if (state !== 'on') return
    let lock: any
    ;(navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l }).catch(() => { /* refusé : tant pis */ })
    return () => { lock?.release?.().catch(() => { /* déjà relâché */ }) }
  }, [state])
  useEffect(() => {
    const el = surface.current; if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el)
    return () => ro.disconnect()
  }, [state, mode])

  /** Le gyroscope ne se lit qu'après un geste, et sur iPhone et iPad après accord. */
  const toggleGyro = async () => {
    if (gyro) { setGyro(false); return }
    const D = (window as any).DeviceOrientationEvent
    if (!D) { setNote("Cet appareil n'a pas de gyroscope lisible par le navigateur."); return }
    try { if (typeof D.requestPermission === 'function' && (await D.requestPermission()) !== 'granted') { setNote('Accès au gyroscope refusé : autorise « Mouvement et orientation » pour ce site.'); return } }
    catch { setNote("Le navigateur n'a pas voulu ouvrir l'accès au gyroscope."); return }
    setNote(''); setGyro(true)
  }
  useEffect(() => {
    if (!gyro) return
    const on = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return
      const p = devicePose(e.alpha, e.beta, e.gamma, screen.orientation?.angle ?? 0)
      send({ t: 'gyro', on: true, h: p.heading, tilt: p.tilt })
    }
    window.addEventListener('deviceorientation', on)
    return () => { window.removeEventListener('deviceorientation', on); send({ t: 'gyro', on: false, h: 0, tilt: 0 }) }
  }, [gyro])

  const switchMode = (m: Mode) => {
    if (g.drawing || g.hold === 'draw') ptr(g.cur, false, -1, true)
    g.touches.clear(); g.two = null; g.drawing = g.orbit = g.multi = false; g.hold = ''; setHold(''); setMode(m)
  }

  // ───────── surface tactile ─────────
  /** Où le pointeur se trouve dans la vue du PC, et la largeur (en pixels d'ici) qui vaut une largeur de vue. */
  const where = (x: number, y: number) => {
    const b = surface.current!.getBoundingClientRect(), r = padRect(b.width, b.height, aspect)
    return { ...padToView(x - b.left, y - b.top, r), w: mode === 'mouse' ? b.width : r.w }
  }
  const asFinger = (e: React.PointerEvent) => e.pointerType === 'touch' || mode === 'mouse'   // en mode souris, tout pointeur glisse comme un doigt
  const onDown = (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointeur déjà relâché */ }
    if (asFinger(e)) {
      if (g.penDown) return                                   // la paume posée pendant qu'on dessine au stylet ne compte pas
      g.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() })
      if (g.touches.size === 1) {
        g.multi = false
        if (mode === 'tablet') { if (fingerDraws) { g.drawing = true; ptr(where(e.clientX, e.clientY), true) } else g.orbit = true }
      } else if (g.touches.size === 2) {
        // un deuxième doigt : ce n'était pas un trait, c'est un geste sur l'espace
        if (g.drawing) { g.drawing = false; ptr(where(e.clientX, e.clientY), false, -1, true) }
        g.orbit = false; g.multi = true
        const [a, b] = [...g.touches.values()]
        g.two = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, spread: 1, twist: 0, zooming: false, turning: false }
      }
      return
    }
    const pen = e.pointerType === 'pen'
    if (pen) { g.penDown = true; g.touches.clear(); g.two = null; if (fingerDraws) setFingerDraws(false) }   // le stylet dessine, les doigts manient l'espace
    g.drawing = true; ptr(where(e.clientX, e.clientY), true, pen ? e.pressure || 0.5 : -1)
  }
  const onMove = (e: React.PointerEvent) => {
    if (asFinger(e)) {
      const t = g.touches.get(e.pointerId); if (!t) return
      const dx = e.clientX - t.x, dy = e.clientY - t.y; t.x = e.clientX; t.y = e.clientY
      const v = where(e.clientX, e.clientY)
      if (g.touches.size === 1 && !g.multi) {
        if (mode === 'mouse') {
          if (g.hold === 'orbit') nav({ yaw: dx * 0.006, pitch: dy * 0.006 })
          else { g.cur = moveCursor(g.cur, dx, dy, v.w, aspect); ptr(g.cur, g.hold === 'draw') }
        } else if (g.drawing) ptr(v, true)
        else if (g.orbit) nav({ yaw: dx * 0.006, pitch: dy * 0.006 })
      } else if (g.touches.size === 2 && g.two) {
        const [a, b] = [...g.touches.values()], k = twoFinger(g.two.a, g.two.b, a, b)
        // zoom et rotation ne s'engagent qu'après un vrai écart : déplacer la vue ne la fait ni zoomer ni pivoter
        g.two.spread *= k.scale; g.two.twist += k.twist
        if (!g.two.zooming && Math.abs(g.two.spread - 1) > 0.06) g.two.zooming = true
        if (!g.two.turning && Math.abs(g.two.twist) > 0.14) g.two.turning = true
        const c = mode === 'mouse' ? g.cur : where(k.cx, k.cy)
        nav({ dx: k.dx / v.w, dy: k.dy / v.w, s: g.two.zooming ? k.scale : 1, r: g.two.turning ? k.twist : 0, cx: c.x, cy: c.y })
        g.two.a = { x: a.x, y: a.y }; g.two.b = { x: b.x, y: b.y }
      }
      return
    }
    // stylet ou souris : posé, il trace ; en survol, il montre le curseur sur le PC
    ptr(where(e.clientX, e.clientY), g.drawing, g.drawing && e.pointerType === 'pen' ? e.pressure || 0.5 : -1)
  }
  const onUp = (e: React.PointerEvent) => {
    if (asFinger(e)) {
      const t = g.touches.get(e.pointerId); if (!t) return
      g.touches.delete(e.pointerId)
      // toucher bref et immobile d'un seul doigt : choisir l'objet dessous
      const tap = e.type === 'pointerup' && !g.multi && performance.now() - t.t0 < 280 && Math.hypot(t.x - t.x0, t.y - t.y0) < 12
      const v = mode === 'mouse' ? g.cur : where(e.clientX, e.clientY)
      if (g.drawing) { g.drawing = false; ptr(v, false, -1, tap) }
      if (g.orbit) { g.orbit = false; if (!tap) nav({ end: true }) }
      if (g.two && g.touches.size < 2) { g.two = null; nav({ end: true }) }
      if (tap) send({ t: 'tap', x: v.x, y: v.y })
      return
    }
    if (e.pointerType === 'pen') g.penDown = false
    if (g.drawing) { g.drawing = false; ptr(where(e.clientX, e.clientY), false) }
  }
  /** Mode souris : maintenir « Tracer » ou « Tourner » d'un pouce, glisser de l'autre main. */
  const press = (h: Hold) => (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointeur déjà relâché */ }
    g.hold = h; setHold(h); if (h === 'draw') ptr(g.cur, true)
  }
  const release = () => {
    if (g.hold === 'draw') ptr(g.cur, false); else if (g.hold === 'orbit') nav({ end: true })
    g.hold = ''; setHold('')
  }

  // ───────── écran d'appairage ─────────
  if (state !== 'on') return (
    <div style={page}>
      <form onSubmit={(e) => { e.preventDefault(); void join() }} style={{ margin: 'auto', width: 'min(420px, calc(100vw - 32px))', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <strong style={{ color: '#00f0ff', textTransform: 'uppercase', letterSpacing: 1, fontSize: 16 }}>📲 Télécommande</strong>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#bbb' }}>
          Cet appareil devient la <b>tablette de dessin</b>, la <b>souris</b> ou la <b>commande</b> de l'Esquisse spatiale ouverte sur ton PC.<br />
          Sur le PC : ouvre l'Esquisse spatiale, clique <b>📲 Télécommande</b>, puis tape ici le code à six chiffres qui s'affiche.
        </p>
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label="Code à six chiffres affiché sur le PC" placeholder="000000"
          style={{ fontSize: 34, letterSpacing: 8, textAlign: 'center', padding: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontVariantNumeric: 'tabular-nums' }} />
        <button type="submit" disabled={code.length !== 6 || state === 'waiting'} style={{ ...btn, padding: 14, fontSize: 16, background: '#00f0ff', color: '#04121a', opacity: code.length === 6 && state !== 'waiting' ? 1 : 0.45 }}>
          {state === 'waiting' ? 'Liaison en cours…' : 'Relier au PC'}
        </button>
        <div role="status" style={{ minHeight: 20, fontSize: 13, color: '#ff8a8a', lineHeight: 1.4 }}>{note}</div>
        <Link to="/" style={{ color: '#aaa', fontSize: 13, textDecoration: 'none' }}>← Studio</Link>
      </form>
    </div>
  )

  // ───────── télécommande ─────────
  const rect = padRect(box.w, box.h, aspect)
  return (
    <div style={page} onContextMenu={(e) => e.preventDefault()}>
      <div style={{ display: 'flex', gap: 6, padding: 8, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
        <div role="tablist" aria-label="Usage de cet appareil" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {MODES.map((m) => <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => switchMode(m.id)} style={{ ...btn, ...(mode === m.id ? on : null) }}>{m.icon} {m.label}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        <button onClick={() => void toggleGyro()} aria-pressed={gyro} title="La vue du PC suit l'inclinaison de cet appareil : à plat = dessus, debout = face" style={{ ...btn, ...(gyro ? warm : null) }}>📱 Gyro</button>
        <button onClick={() => wire.current?.close()} style={btn}>Quitter</button>
      </div>
      {note && <div role="status" style={{ padding: '4px 10px', fontSize: 12, color: '#ffd200' }}>{note}</div>}

      {mode !== 'pad' && <>
        <div ref={surface} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label={mode === 'tablet' ? "Surface de dessin : le cadre est l'écran du PC" : 'Pavé tactile'}
          style={{ flex: 1, position: 'relative', touchAction: 'none', minHeight: 0, background: mode === 'mouse' ? 'rgba(255,255,255,0.04)' : 'transparent' }}>
          {mode === 'tablet' && <div style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxSizing: 'border-box', border: '1px solid rgba(0,240,255,0.6)', borderRadius: 6, background: 'rgba(0,240,255,0.05)', pointerEvents: 'none' }} />}
          <div style={{ position: 'absolute', left: 10, right: 10, bottom: 8, fontSize: 11, lineHeight: 1.4, color: '#8d8d99', pointerEvents: 'none', textAlign: 'center' }}>
            {mode === 'tablet'
              ? <>Le cadre est l'écran du PC. Le stylet dessine (appuyer épaissit le trait). Deux doigts : déplacer, zoomer, pivoter. Toucher bref : choisir un objet.</>
              : <>Glisse un doigt : le curseur bouge sur le PC. Toucher bref : choisir l'objet sous le curseur. Deux doigts : déplacer, zoomer, pivoter.</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: 8 }}>
          {mode === 'tablet'
            ? <button onClick={() => setFingerDraws((v) => !v)} aria-pressed={!fingerDraws} style={{ ...btn, flex: 1 }}>{fingerDraws ? '☝️ Un doigt dessine' : '☝️ Un doigt tourne la vue'}</button>
            : <>
              <button onPointerDown={press('draw')} onPointerUp={release} onPointerCancel={release} aria-pressed={hold === 'draw'} style={{ ...btn, ...big, ...(hold === 'draw' ? on : null) }}>✏️ Maintenir pour tracer</button>
              <button onPointerDown={press('orbit')} onPointerUp={release} onPointerCancel={release} aria-pressed={hold === 'orbit'} style={{ ...btn, ...big, ...(hold === 'orbit' ? warm : null) }}>🔄 Maintenir pour tourner</button>
            </>}
        </div>
      </>}

      {mode === 'pad' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Group label="Outil">
            {(hello?.tools ?? []).map((t) => <button key={t.id} onClick={() => cmd('tool', t.id)} aria-pressed={hello?.tool === t.id} style={{ ...btn, ...key, ...(hello?.tool === t.id ? on : null) }}><span style={{ fontSize: 22 }}>{t.icon}</span>{t.label}</button>)}
          </Group>
          <Group label="Corriger">
            <button onClick={() => cmd('undo')} style={{ ...btn, ...key }}><span style={{ fontSize: 22 }}>↶</span>Annuler</button>
            <button onClick={() => cmd('redo')} style={{ ...btn, ...key }}><span style={{ fontSize: 22 }}>↷</span>Refaire</button>
            <button onClick={() => cmd('delete')} style={{ ...btn, ...key, color: '#ff8a8a' }}><span style={{ fontSize: 22 }}>🗑</span>Objet choisi</button>
          </Group>
          <Group label="Plan de dessin">
            {PLANES.map(([id, label]) => <button key={id} onClick={() => cmd('plane', id)} style={{ ...btn, ...key }}>{label}</button>)}
          </Group>
          <Group label="Vue">
            <button onClick={() => cmd('zoom', 0.8)} aria-label="Dézoomer" style={{ ...btn, ...key }}><span style={{ fontSize: 22 }}>−</span>Zoom</button>
            <button onClick={() => cmd('zoom', 1.25)} aria-label="Zoomer" style={{ ...btn, ...key }}><span style={{ fontSize: 22 }}>+</span>Zoom</button>
            <button onClick={() => cmd('fit')} style={{ ...btn, ...key }}><span style={{ fontSize: 22 }}>⤢</span>Tout voir</button>
            <button onClick={() => cmd('recenter')} style={{ ...btn, ...key }}><span style={{ fontSize: 22 }}>⊙</span>Recentrer</button>
            <button onClick={() => cmd('orbit', [-STEP, 0])} aria-label="Tourner à gauche" style={{ ...btn, ...key, fontSize: 22 }}>←</button>
            <button onClick={() => cmd('orbit', [0, -STEP])} aria-label="Basculer vers le haut" style={{ ...btn, ...key, fontSize: 22 }}>↑</button>
            <button onClick={() => cmd('orbit', [0, STEP])} aria-label="Basculer vers le bas" style={{ ...btn, ...key, fontSize: 22 }}>↓</button>
            <button onClick={() => cmd('orbit', [STEP, 0])} aria-label="Tourner à droite" style={{ ...btn, ...key, fontSize: 22 }}>→</button>
          </Group>
        </div>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div style={{ color: '#00f0ff', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>{children}</div>
    </div>
  )
}

const page: React.CSSProperties = { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#07080d', color: '#fff', fontFamily: 'system-ui', userSelect: 'none', WebkitUserSelect: 'none', overscrollBehavior: 'none', touchAction: 'manipulation' }
const btn: React.CSSProperties = { minHeight: 44, padding: '8px 12px', borderRadius: 10, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 600, fontSize: 13 }
const on: React.CSSProperties = { borderColor: '#00f0ff', background: 'rgba(0,240,255,0.22)' }
const warm: React.CSSProperties = { borderColor: '#ffd200', color: '#ffd200' }
const big: React.CSSProperties = { flex: 1, minHeight: 64, fontSize: 14, touchAction: 'none' }
const key: React.CSSProperties = { minHeight: 64, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 12 }
