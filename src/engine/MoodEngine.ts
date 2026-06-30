/**
 * Mood Engine — the AI compagnon observes the scene continuously and proposes
 * subtle automatic evolutions every N seconds.
 *
 * Architecture:
 *   1. Sampler (every frame): records lightweight signals — audio FFT bands,
 *      hand activity, pose energy, FPS, scene density. Aggregated into a
 *      rolling 30-second buffer.
 *   2. Reflect (every 30s when active): summarizes the buffer into a small
 *      JSON snapshot, ships it to /api/claude with a special "mood mode"
 *      system prompt, receives back a `mood` patch (small param deltas) and
 *      a one-line poetic justification displayed as a toast.
 *   3. Apply: the patch goes through the same validator as AIChat actions
 *      (no untrusted writes), then is dispatched via the store.
 *
 * Toggleable from the TopBar. Never starts without explicit user opt-in.
 */
import { senseBus } from '../senses/SenseBus'
import { validateActions } from '../lib/aiActions'
import { useSceneStore } from '../store/sceneStore'

interface Sample {
  t: number              // ms since start
  bass: number; mid: number; high: number; level: number
  handActive: boolean
  poseEnergy: number    // 0..1 — variance of wrist positions
  fps: number
  density: number       // organism count
}

const BUFFER_MAX = 240          // ~30s at 8 Hz sampling
const SAMPLE_INTERVAL_MS = 125
const REFLECT_INTERVAL_MS = 30_000

let buffer: Sample[] = []
let samplerId: number | null = null
let reflectId: number | null = null
let lastReflectAt = 0
let active = false
let onMoodCallback: ((reply: string) => void) | null = null
let lastWristPos: { x: number; y: number } | null = null
let energyAccum = 0

function sample() {
  const a = (senseBus as any).audio ?? { bass: 0, mid: 0, high: 0, level: 0 }
  const h = senseBus.hands
  let poseEnergy = 0
  if (h.detected) {
    const curr = { x: h.indexTip.x, y: h.indexTip.y }
    if (lastWristPos) {
      const d = Math.hypot(curr.x - lastWristPos.x, curr.y - lastWristPos.y)
      energyAccum = energyAccum * 0.9 + d * 0.1
      poseEnergy = Math.min(1, energyAccum * 10)
    }
    lastWristPos = curr
  }
  const sc = useSceneStore.getState().current()
  const density = (sc?.organism.values as any)?.count ?? 0
  // FPS proxy — read from a global the engine writes (set in Engine.getStats)
  const fps = (window as any).__animaFps ?? 60
  buffer.push({
    t: performance.now(),
    bass: a.bass ?? 0, mid: a.mid ?? 0, high: a.high ?? 0, level: a.level ?? 0,
    handActive: h.detected, poseEnergy, fps, density,
  })
  if (buffer.length > BUFFER_MAX) buffer.shift()
}

/** Aggregate buffer into a compact JSON snapshot for the AI. */
function summarize() {
  if (buffer.length < 8) return null
  const avg = (k: keyof Sample) => buffer.reduce((s, x) => s + (x[k] as number), 0) / buffer.length
  const max = (k: keyof Sample) => buffer.reduce((m, x) => Math.max(m, x[k] as number), -Infinity)
  const min = (k: keyof Sample) => buffer.reduce((m, x) => Math.min(m, x[k] as number), Infinity)
  const handFrac = buffer.filter((x) => x.handActive).length / buffer.length
  return {
    audio: { bass_avg: round(avg('bass')), mid_avg: round(avg('mid')), high_avg: round(avg('high')), level_avg: round(avg('level')) },
    motion: { hand_present_frac: round(handFrac), pose_energy_avg: round(avg('poseEnergy')), pose_energy_peak: round(max('poseEnergy')) },
    perf: { fps_avg: Math.round(avg('fps')), fps_min: Math.round(min('fps')) },
    scene: { density: Math.round(avg('density')) },
    window_sec: Math.round((buffer[buffer.length - 1].t - buffer[0].t) / 1000),
  }
}

function round(n: number) { return Math.round(n * 100) / 100 }

async function reflect() {
  const snap = summarize()
  if (!snap) {
    if (onMoodCallback) onMoodCallback('⏳ Pas encore assez de données — patiente quelques secondes')
    return
  }
  const sc = useSceneStore.getState().current()
  if (!sc) return
  let res: Response
  try {
    res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Mode MOOD: tu observes l'œuvre en live. Voici un résumé des 30 dernières secondes:\n${JSON.stringify(snap)}\n\nPropose UNE petite évolution subtile (un seul "actions" minimal — 1-3 paramètres maximum, deltas modérés, pas de newScene, pas de mappingShapes). Si le tempo monte, accélère légèrement. Si l'énergie chute, ralentis et adoucis. Justifie en UNE phrase poétique courte (≤ 15 mots).`,
        scene: sc,
      }),
    })
  } catch (e: any) {
    // Network unreachable (offline, CORS, etc.)
    console.warn('[MoodEngine] reflect network error', e)
    if (onMoodCallback) onMoodCallback('⚠ Mood Engine : réseau indisponible')
    return
  }
  // Read body once as text — robust against non-JSON 404/500 HTML pages (dev env
  // is the main offender: Vite doesn't serve /api routes, you get an HTML 404).
  let bodyText = ''
  try { bodyText = await res.text() } catch { /* empty body */ }
  if (!res.ok) {
    let msg = `erreur API (HTTP ${res.status})`
    if (res.status === 401) msg = '⚠ Mood Engine : authentification requise (admin)'
    else if (res.status === 429) msg = '⚠ Mood Engine : limite de débit — patiente une minute'
    else if (res.status === 404) msg = '⚠ Mood Engine : endpoint /api/claude introuvable (mode dev local ?)'
    console.warn('[MoodEngine]', msg, bodyText.slice(0, 200))
    if (onMoodCallback) onMoodCallback(msg)
    return
  }
  let data: any
  try { data = JSON.parse(bodyText) } catch {
    console.warn('[MoodEngine] reply not valid JSON:', bodyText.slice(0, 200))
    if (onMoodCallback) onMoodCallback('⚠ Mood Engine : réponse mal formée')
    return
  }
  const actions = validateActions(data.actions)
  // STRICT MOOD MODE: only allow small per-frame deltas — never let the AI swap
  // the entire organism kind, blow up the mapping shapes, or push a new melody
  // mid-show. validateActions accepts those for the AIChat path; here we drop them.
  const store = useSceneStore.getState()
  let applied = 0
  if (actions.organismValues) { store.patchOrganismValues(actions.organismValues); applied++ }
  if (actions.palette) { store.updatePalette(actions.palette); applied++ }
  if (actions.visual) { store.updateVisual(actions.visual); applied++ }
  if (actions.flow) { store.updateFlow(actions.flow as any); applied++ }
  // Log when the AI returned data we deliberately ignore — helps debugging silent ignores
  const dropped: string[] = []
  if (actions.organism) dropped.push('organism (full swap)')
  if (actions.mappingShapes) dropped.push('mappingShapes')
  if (actions.melody) dropped.push('melody')
  if (actions.newScene) dropped.push('newScene')
  if (dropped.length) console.info('[MoodEngine] dropped non-mood actions:', dropped.join(', '))
  const reply: string = data.reply ?? ''
  if (onMoodCallback) {
    if (applied > 0) onMoodCallback('✨ ' + reply)
    else onMoodCallback(reply || 'ℹ️ Mood Engine : pas d\'évolution proposée cette fois')
  }
}

export function startMood(onMood: (reply: string) => void) {
  if (active) return
  active = true
  onMoodCallback = onMood
  buffer = []
  lastWristPos = null
  energyAccum = 0
  lastReflectAt = performance.now()
  samplerId = window.setInterval(sample, SAMPLE_INTERVAL_MS)
  reflectId = window.setInterval(() => {
    // Skip if too recent (e.g. manual trigger ran just before)
    if (performance.now() - lastReflectAt < REFLECT_INTERVAL_MS - 1000) return
    lastReflectAt = performance.now()
    reflect()
  }, REFLECT_INTERVAL_MS)
}

export function stopMood() {
  active = false
  if (samplerId) { clearInterval(samplerId); samplerId = null }
  if (reflectId) { clearInterval(reflectId); reflectId = null }
  onMoodCallback = null
}

export function isMoodActive() { return active }

/** Manual trigger — useful for "reflect now" button. */
export async function triggerMoodReflect() {
  if (!active) return
  lastReflectAt = performance.now()
  await reflect()
}
