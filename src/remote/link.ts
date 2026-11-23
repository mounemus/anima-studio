/**
 * Liaison entre la tablette (ou le téléphone) et le PC : un canal WebRTC, ouvert après un échange de départ par
 * `/api/pair` sous un code à six chiffres. Les deux appareils se parlent en direct quand le réseau le permet, sinon
 * à travers un relais si le serveur en distribue un (voir `api/pair.ts`). Le contenu est chiffré de bout en bout.
 */

export type LinkState = 'waiting' | 'on' | 'off'
export interface Link { send(m: object): void; close(): void }
interface Handlers { onState(s: LinkState, note?: string): void; onMsg(raw: string): void }

const STUN: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function signal(body: object): Promise<any> {
  const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(r.status === 401 ? "Session fermée sur cet appareil : connecte-toi d'abord à DigiArt." : j.error ?? `Appairage indisponible (${r.status}).`)
  return j
}

/** Les serveurs de liaison distribués par le serveur, et s'il y a un relais parmi eux. */
async function network(): Promise<{ config: RTCConfiguration; relay: boolean }> {
  const j = await signal({ op: 'ice' })
  return Array.isArray(j.iceServers) && j.iceServers.length ? { config: { iceServers: j.iceServers }, relay: j.relay === true } : { config: STUN, relay: false }
}

/** L'offre part d'un bloc, une fois les adresses réseau trouvées (au plus 4 s : un serveur injoignable ne bloque pas). */
const gathered = (pc: RTCPeerConnection) => new Promise<void>((res) => {
  if (pc.iceGatheringState === 'complete') return res()
  const t = setTimeout(res, 4000)
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res() } })
})

/** Les adresses qu'une description annonce : locales en clair (avec leur liste, sans doublon), locales cachées
 *  derrière un nom « .local », publiques, et relais. */
export function addressKinds(sdp: string) {
  const k = { ip: 0, name: 0, pub: 0, relay: 0, local: [] as string[] }
  for (const l of sdp.split(/\r?\n/)) {
    if (!l.startsWith('a=candidate')) continue
    const p = l.split(' ')
    if (p[7] === 'relay') k.relay++
    else if (p[7] !== 'host') k.pub++
    else if (p[4].endsWith('.local')) k.name++
    else { k.ip++; if (!k.local.includes(p[4])) k.local.push(p[4]) }
  }
  return k
}

/** Sans accès à la caméra ou au micro, Chrome cache l'adresse locale de l'appareil derrière un nom « .local » que
 *  l'autre appareil ne sait pas toujours retrouver. L'accès accordé, elle est donnée en clair.
 *  Le micro n'est pas écouté : il est relâché aussitôt. */
async function revealLocalAddress(): Promise<boolean> {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); return true }
  catch { return false }
}

interface Tally { sent: number; got: number; heard: number }
/** Essais de liaison partis, revenus et reçus jusqu'ici (le navigateur efface ces compteurs au moment de l'échec). */
async function tally(pc: RTCPeerConnection, t: Tally) {
  let sent = 0, got = 0, heard = 0
  try { (await pc.getStats()).forEach((s: any) => { if (s.type === 'candidate-pair') { sent += s.requestsSent ?? 0; got += s.responsesReceived ?? 0; heard += s.requestsReceived ?? 0 } }) } catch { return }
  t.sent = Math.max(t.sent, sent); t.got = Math.max(t.got, got); t.heard = Math.max(t.heard, heard)
}

/** Pourquoi la liaison a échoué, en une ligne à recopier : adresses annoncées de chaque côté, essais partis et revenus,
 *  état de l'autorisation « appareils du réseau local » du navigateur. */
function diagnose(pc: RTCPeerConnection, { sent, got, heard }: Tally, lan: string): string {
  const f = (sdp?: string) => { const k = addressKinds(sdp ?? ''); return `ip${k.ip}${k.local.length ? ` (${k.local.slice(0, 4).join(', ')})` : ''} nom${k.name} pub${k.pub} relais${k.relay}` }
  return `[ici ${f(pc.localDescription?.sdp)} · en face ${f(pc.remoteDescription?.sdp)} · ${sent} envois, ${got} réponses, ${heard} reçus · réseau local : ${lan}]`
}

function wire(pc: RTCPeerConnection, h: Handlers, relay: boolean) {
  let ch: RTCDataChannel | null = null, dead = false, lan = '?'
  const seen: Tally = { sent: 0, got: 0, heard: 0 }
  const watch = setInterval(() => { if (pc.connectionState === 'connected') clearInterval(watch); else void tally(pc, seen) }, 1500)
  navigator.permissions?.query({ name: 'local-network' as PermissionName }).then((s) => { lan = s.state }, () => { /* navigateur sans cette autorisation */ })
  const close = (note?: string) => { if (dead) return; dead = true; clearInterval(watch); try { ch?.close() } catch { /* déjà fermé */ } try { pc.close() } catch { /* déjà fermé */ } h.onState('off', note) }
  const attach = (c: RTCDataChannel) => {
    ch = c
    c.onopen = () => { if (!dead) h.onState('on') }
    c.onclose = () => close('Liaison coupée.')
    c.onmessage = (e) => { if (typeof e.data === 'string') h.onMsg(e.data) }
  }
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState !== 'failed') return
    const why = relay ? 'La liaison ne passe ni en direct ni par le relais.' : "Les deux appareils ne se joignent pas en direct sur ce réseau, et aucun relais n'est configuré."
    close(`${why} ${diagnose(pc, seen, lan)}`)
  })
  const link: Link = { send: (m) => { if (ch?.readyState === 'open') ch.send(JSON.stringify(m)) }, close: () => close() }
  return { link, attach, close, isDead: () => dead }
}

const NONE: Link = { send() { /* pas de liaison */ }, close() { /* pas de liaison */ } }

/** Côté PC : obtient un code, puis attend la tablette (5 min au plus). */
export async function hostLink(h: Handlers & { onCode(code: string): void }): Promise<Link> {
  let w: ReturnType<typeof wire> | null = null
  try {
    const net = await network(), pc = new RTCPeerConnection(net.config)
    w = wire(pc, h, net.relay)
    w.attach(pc.createDataChannel('digiart'))
    await pc.setLocalDescription(await pc.createOffer()); await gathered(pc)
    const { code } = await signal({ op: 'offer', sdp: pc.localDescription!.sdp })
    if (w.isDead()) return w.link
    h.onCode(code); h.onState('waiting')
    const live = w
    void (async () => {
      const t0 = Date.now()
      while (!live.isDead() && Date.now() - t0 < 290_000) {
        await sleep(1500); if (live.isDead()) return
        try { const { answer } = await signal({ op: 'wait', code }); if (answer) { await pc.setRemoteDescription({ type: 'answer', sdp: answer }); return } }
        catch { /* coupure passagère : on réessaie au tour suivant */ }
      }
      live.close('Code expiré : redemande-en un.')
    })()
    return w.link
  } catch (e: any) {
    const note = e?.message ?? String(e)
    if (w) w.close(note); else h.onState('off', note)
    return w?.link ?? NONE
  }
}

/** Côté tablette : rejoint le PC avec le code affiché sur son écran. */
export async function joinLink(code: string, h: Handlers): Promise<Link> {
  h.onState('waiting')
  let w: ReturnType<typeof wire> | null = null
  try {
    const net = await network()
    const { offer } = await signal({ op: 'take', code })
    const answerTo = async () => {
      const pc = new RTCPeerConnection(net.config)
      await pc.setRemoteDescription({ type: 'offer', sdp: offer }); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc)
      return pc
    }
    let pc = await answerTo()
    // sans relais, adresse locale cachée : on demande au navigateur de la donner, puis on refait la réponse avec elle
    const k = addressKinds(pc.localDescription!.sdp)
    if (!net.relay && k.ip === 0 && k.name > 0 && await revealLocalAddress()) { pc.close(); pc = await answerTo() }
    const live = pc, lw = w = wire(live, h, net.relay); live.ondatachannel = (e) => lw.attach(e.channel)
    await signal({ op: 'answer', code, sdp: live.localDescription!.sdp })
    setTimeout(() => { if (live.connectionState !== 'connected' && live.connectionState !== 'failed') lw.close('Le PC ne répond pas : son code est-il toujours affiché ?') }, 30_000)
    return w.link
  } catch (e: any) {
    const note = e?.message ?? String(e)
    if (w) w.close(note); else h.onState('off', note)
    return w?.link ?? NONE
  }
}
