/**
 * OscEngine — OSC-over-WebSocket client for the app.
 *
 * A browser can't speak UDP, so this connects to a local WS↔UDP bridge (see
 * bridge/osc-bridge.js) which relays to/from Resolume, TouchDesigner, etc.
 *
 *   Anima (browser) ──WebSocket(binary OSC)──> bridge ──UDP/OSC──> Resolume/TD
 *
 * IN  : incoming OSC messages → senseBus.osc.values[address] (bindable as
 *       source `osc:/address`, like MIDI CC). Discovered addresses are tracked
 *       for the bindings UI.
 * OUT : tickOut() streams audio levels + agent count + obstacle hit counters at
 *       ~30 Hz to /anima/* addresses.
 */
import { decodePacket, encodeMessage, firstNumber, type OscArg } from './osc'
import { senseBus } from '../senses/SenseBus'
import { getItem, setItem } from '../lib/storage'

export type OscStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface OscConfig {
  url: string
  enabledIn: boolean
  enabledOut: boolean
}

const CONFIG_KEY = 'osc-config'
const DEFAULT_CONFIG: OscConfig = { url: 'ws://localhost:8080', enabledIn: true, enabledOut: false }

class OscEngine {
  config: OscConfig = { ...DEFAULT_CONFIG }
  status: OscStatus = 'disconnected'
  /** Latest value per incoming address (also mirrored into senseBus.osc). */
  values: Record<string, number> = {}
  /** All addresses seen this session — for the bindings source picker. */
  addresses: string[] = []

  private ws: WebSocket | null = null
  private lastOut = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private manualClose = false
  /** Only auto-connect on boot for users who've used OSC before (else every
   *  fresh user would loop on a failed ws://localhost:8080 with no bridge). */
  private hasSavedConfig = false

  constructor() {
    const saved = getItem<OscConfig>(CONFIG_KEY)
    if (saved && typeof saved.url === 'string') { this.config = { ...DEFAULT_CONFIG, ...saved }; this.hasSavedConfig = true }
    // Ensure senseBus has the osc slot (defensive — SenseBus declares it too)
    if (!(senseBus as any).osc) (senseBus as any).osc = { connected: false, values: this.values }
    else (senseBus as any).osc.values = this.values
  }

  private persist() { setItem(CONFIG_KEY, this.config) }
  private emit() { try { window.dispatchEvent(new Event('anima:osc-state')) } catch { /* noop */ } }

  setConfig(patch: Partial<OscConfig>) {
    this.config = { ...this.config, ...patch }
    this.persist()
    this.emit()
  }

  connect(url?: string) {
    if (url) this.config.url = url
    this.persist()
    this.manualClose = false
    this.openSocket()
  }

  private openSocket() {
    this.closeSocket()
    let ws: WebSocket
    try { ws = new WebSocket(this.config.url) } catch { this.status = 'error'; this.emit(); return }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.status = 'connecting'; this.emit()
    ws.onopen = () => { this.status = 'connected'; (senseBus as any).osc.connected = true; this.emit() }
    ws.onmessage = (ev) => {
      if (!this.config.enabledIn) return
      if (!(ev.data instanceof ArrayBuffer)) return
      let msgs
      try { msgs = decodePacket(ev.data) } catch { return }
      for (const m of msgs) {
        const v = firstNumber(m)
        this.values[m.address] = v
        if (!this.addresses.includes(m.address)) {
          this.addresses.push(m.address)
          if (this.addresses.length > 200) this.addresses.shift()
          this.emit()
        }
      }
    }
    ws.onerror = () => { this.status = 'error'; this.emit() }
    ws.onclose = () => {
      this.status = 'disconnected'; (senseBus as any).osc.connected = false; this.emit()
      // auto-reconnect unless the user disconnected on purpose
      if (!this.manualClose) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => this.openSocket(), 2500)
      }
    }
  }

  private closeSocket() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) { try { this.ws.onclose = null; this.ws.close() } catch { /* noop */ }; this.ws = null }
  }

  disconnect() {
    this.manualClose = true
    this.closeSocket()
    this.status = 'disconnected'; (senseBus as any).osc.connected = false
    this.emit()
  }

  send(address: string, args: OscArg[] = []) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(encodeMessage(address, args)) } catch { /* noop */ }
    }
  }

  /** Stream app state OUT at ~30 Hz. Called every frame from the Engine loop. */
  tickOut(now: number, audio: { level: number; bass: number; mid: number; high: number }, agents: number, obstacles?: Map<string, number>) {
    if (!this.config.enabledOut || this.status !== 'connected') return
    if (now - this.lastOut < 33) return
    this.lastOut = now
    this.send('/anima/audio/level', [audio.level ?? 0])
    this.send('/anima/audio/bass', [audio.bass ?? 0])
    this.send('/anima/audio/mid', [audio.mid ?? 0])
    this.send('/anima/audio/high', [audio.high ?? 0])
    this.send('/anima/agents', [agents])
    if (obstacles) for (const [id, n] of obstacles) this.send('/anima/obstacle/' + id.replace(/[^a-zA-Z0-9_-]/g, ''), [n])
  }

  /** Auto-connect on boot only if the user has used OSC before (persisted config)
   *  and left IN or OUT enabled. Fresh users get nothing until they click Connect. */
  autostart() {
    if (this.hasSavedConfig && (this.config.enabledIn || this.config.enabledOut)) this.connect()
  }
}

export const oscEngine = new OscEngine()
