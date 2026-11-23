/**
 * Liaison directe entre la tablette (ou le téléphone) et le PC : un canal WebRTC, ouvert après un échange de
 * départ par `/api/pair` sous un code à six chiffres. Une fois le canal ouvert, plus rien ne passe par le serveur.
 */

export type LinkState = 'waiting' | 'on' | 'off'
export interface Link { send(m: object): void; close(): void }
interface Handlers { onState(s: LinkState, note?: string): void; onMsg(raw: string): void }

// ponytail: un seul serveur STUN public, pas de relais TURN. Deux appareils sur le même Wi-Fi se trouvent par
// leurs adresses locales ; entre deux réseaux différents (4G, pare-feu d'entreprise) non. Ajouter un TURN si le
// besoin se présente.
const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function signal(body: object): Promise<any> {
  const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(r.status === 401 ? "Session fermée sur cet appareil : connecte-toi d'abord à DigiArt." : j.error ?? `Appairage indisponible (${r.status}).`)
  return j
}

/** L'offre part d'un bloc, une fois les adresses réseau trouvées (au plus 3 s : un STUN injoignable ne bloque pas). */
const gathered = (pc: RTCPeerConnection) => new Promise<void>((res) => {
  if (pc.iceGatheringState === 'complete') return res()
  const t = setTimeout(res, 3000)
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res() } })
})

/** Les adresses qu'une description annonce : locales en clair, locales cachées derrière un nom « .local », publiques. */
export function addressKinds(sdp: string) {
  const k = { ip: 0, name: 0, pub: 0 }
  for (const l of sdp.split(/\r?\n/)) {
    if (!l.startsWith('a=candidate')) continue
    const p = l.split(' ')
    if (p[7] !== 'host') k.pub++; else if (p[4].endsWith('.local')) k.name++; else k.ip++
  }
  return k
}

/** Sans accès à la caméra ou au micro, Chrome cache l'adresse locale de l'appareil derrière un nom « .local » que
 *  l'autre appareil ne sait pas toujours retrouver. Or bien des routeurs ne laissent pas deux appareils du même Wi-Fi
 *  se joindre par leur adresse publique, et le pare-feu d'un PC ne laisse entrer que les réponses à ce qu'il a
 *  envoyé : il faut qu'un des deux connaisse l'adresse locale de l'autre. L'accès accordé, elle est donnée en clair.
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

/** Pourquoi la liaison a échoué, en une ligne à recopier : adresses annoncées de chaque côté, essais partis et revenus. */
function diagnose(pc: RTCPeerConnection, { sent, got, heard }: Tally): string {
  const f = (sdp?: string) => { const k = addressKinds(sdp ?? ''); return `ip${k.ip} nom${k.name} pub${k.pub}` }
  return `[ici ${f(pc.localDescription?.sdp)} · en face ${f(pc.remoteDescription?.sdp)} · ${sent} envois, ${got} réponses, ${heard} reçus]`
}

function wire(pc: RTCPeerConnection, h: Handlers) {
  let ch: RTCDataChannel | null = null, dead = false
  const seen: Tally = { sent: 0, got: 0, heard: 0 }
  const watch = setInterval(() => { if (pc.connectionState === 'connected') clearInterval(watch); else void tally(pc, seen) }, 1500)
  const close = (note?: string) => { if (dead) return; dead = true; clearInterval(watch); try { ch?.close() } catch { /* déjà fermé */ } try { pc.close() } catch { /* déjà fermé */ } h.onState('off', note) }
  const attach = (c: RTCDataChannel) => {
    ch = c
    c.onopen = () => { if (!dead) h.onState('on') }
    c.onclose = () => close('Liaison coupée.')
    c.onmessage = (e) => { if (typeof e.data === 'string') h.onMsg(e.data) }
  }
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') close(`Les deux appareils ne se trouvent pas sur le réseau (même Wi-Fi ?). ${diagnose(pc, seen)}`)
  })
  const link: Link = { send: (m) => { if (ch?.readyState === 'open') ch.send(JSON.stringify(m)) }, close: () => close() }
  return { link, attach, close, isDead: () => dead }
}

/** Côté PC : obtient un code, puis attend la tablette (5 min au plus). */
export async function hostLink(h: Handlers & { onCode(code: string): void }): Promise<Link> {
  const pc = new RTCPeerConnection(ICE), w = wire(pc, h)
  try {
    w.attach(pc.createDataChannel('digiart'))
    await pc.setLocalDescription(await pc.createOffer()); await gathered(pc)
    const { code } = await signal({ op: 'offer', sdp: pc.localDescription!.sdp })
    if (w.isDead()) return w.link
    h.onCode(code); h.onState('waiting')
    void (async () => {
      const t0 = Date.now()
      while (!w.isDead() && Date.now() - t0 < 290_000) {
        await sleep(1500); if (w.isDead()) return
        try { const { answer } = await signal({ op: 'wait', code }); if (answer) { await pc.setRemoteDescription({ type: 'answer', sdp: answer }); return } }
        catch { /* coupure passagère : on réessaie au tour suivant */ }
      }
      w.close('Code expiré : redemande-en un.')
    })()
  } catch (e: any) { w.close(e?.message ?? String(e)) }
  return w.link
}

/** Côté tablette : rejoint le PC avec le code affiché sur son écran. */
export async function joinLink(code: string, h: Handlers): Promise<Link> {
  h.onState('waiting')
  let w: ReturnType<typeof wire> | null = null
  try {
    const { offer } = await signal({ op: 'take', code })
    const answerTo = async () => {
      const pc = new RTCPeerConnection(ICE)
      await pc.setRemoteDescription({ type: 'offer', sdp: offer }); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc)
      return pc
    }
    let pc = await answerTo()
    // adresse locale cachée : on demande au navigateur de la donner, puis on refait la réponse avec elle
    const k = addressKinds(pc.localDescription!.sdp)
    if (k.ip === 0 && k.name > 0 && await revealLocalAddress()) { pc.close(); pc = await answerTo() }
    const live = pc; w = wire(live, h); live.ondatachannel = (e) => w!.attach(e.channel)
    await signal({ op: 'answer', code, sdp: live.localDescription!.sdp })
    setTimeout(() => { if (live.connectionState !== 'connected' && live.connectionState !== 'failed') w!.close("Le PC ne répond pas : les deux appareils sont-ils sur le même Wi-Fi ?") }, 25_000)
    return w.link
  } catch (e: any) {
    const note = e?.message ?? String(e)
    if (w) w.close(note); else h.onState('off', note)
    return w?.link ?? { send() { /* pas de liaison */ }, close() { /* pas de liaison */ } }
  }
}
