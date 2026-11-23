/**
 * Liaison directe entre la tablette (ou le téléphone) et le PC : un canal WebRTC, ouvert après un échange de
 * départ par `/api/pair` sous un code à six chiffres. Une fois le canal ouvert, plus rien ne passe par le serveur.
 */

export type LinkState = 'waiting' | 'on' | 'off'
export interface Link { send(m: object): void; close(): void }
interface Handlers { onState(s: LinkState, note?: string): void; onMsg(raw: string): void }

// ponytail: un seul serveur STUN public, pas de relais TURN. Deux appareils sur le même Wi-Fi se trouvent ;
// derrière certains réseaux (4G, pare-feu d'entreprise) non. Ajouter un TURN si le besoin se présente.
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

function wire(pc: RTCPeerConnection, h: Handlers) {
  let ch: RTCDataChannel | null = null, dead = false
  const close = (note?: string) => { if (dead) return; dead = true; try { ch?.close() } catch { /* déjà fermé */ } try { pc.close() } catch { /* déjà fermé */ } h.onState('off', note) }
  const attach = (c: RTCDataChannel) => {
    ch = c
    c.onopen = () => { if (!dead) h.onState('on') }
    c.onclose = () => close('Liaison coupée.')
    c.onmessage = (e) => { if (typeof e.data === 'string') h.onMsg(e.data) }
  }
  pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close("Les deux appareils ne se trouvent plus (même Wi-Fi ?).") })
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
  const pc = new RTCPeerConnection(ICE), w = wire(pc, h)
  try {
    h.onState('waiting')
    const { offer } = await signal({ op: 'take', code })
    pc.ondatachannel = (e) => w.attach(e.channel)
    await pc.setRemoteDescription({ type: 'offer', sdp: offer }); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc)
    await signal({ op: 'answer', code, sdp: pc.localDescription!.sdp })
    setTimeout(() => { if (pc.connectionState !== 'connected') w.close("Le PC ne répond pas : les deux appareils sont-ils sur le même Wi-Fi ?") }, 20_000)
  } catch (e: any) { w.close(e?.message ?? String(e)) }
  return w.link
}
