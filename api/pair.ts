/**
 * Appairage d'une tablette ou d'un téléphone avec l'application ouverte sur le PC.
 *
 * Les deux appareils se parlent ensuite en direct (WebRTC) ; cette fonction ne sert qu'à l'échange de départ,
 * sous un code à six chiffres qui expire. Le PC dépose son offre et reçoit le code ; la tablette la retire avec
 * le code (une seule fois) et dépose sa réponse ; le PC la récupère. Rien d'autre ne passe par le serveur.
 *
 *   POST { op: 'ice' }                → { iceServers, relay }   (serveurs de liaison ; `relay` : un relais est configuré)
 *   POST { op: 'offer',  sdp }        → { code }
 *   POST { op: 'take',   code }       → { offer }            (404 : code inconnu, expiré ou déjà pris)
 *   POST { op: 'answer', code, sdp }  → { ok: true }
 *   POST { op: 'wait',   code }       → { answer | null }
 */
import { guard, readJsonCapped } from './_lib/guard'
import { jsonResponse } from './_lib/auth'
import { kv, kvConfigured } from './_lib/kv'

export const config = { runtime: 'edge' }

const TTL = 300, MAX_SDP = 20_000   // avec un relais, la description annonce bien plus d'adresses
const offerKey = (code: string) => `anima:pair:${code}:o`, answerKey = (code: string) => `anima:pair:${code}:a`
const okSdp = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_SDP && s.startsWith('v=0')
const okCode = (c: unknown): c is string => typeof c === 'string' && /^\d{6}$/.test(c)

/** Serveurs de liaison. Sans relais, deux appareils ne se joignent que si le réseau les laisse se parler en direct ;
 *  avec un relais TURN (Cloudflare Realtime, variables TURN_KEY_ID et TURN_KEY_API_TOKEN), ils passent par lui quand
 *  le direct échoue. Les identifiants du relais sont à durée limitée et fabriqués ici : la clé ne quitte pas le serveur. */
const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }]
const env = (name: string): string | undefined => (globalThis as any).process?.env?.[name]
async function iceServers(): Promise<{ iceServers: { urls: string[]; username?: string; credential?: string }[]; relay: boolean }> {
  const id = env('TURN_KEY_ID'), token = env('TURN_KEY_API_TOKEN')
  if (!id || !token) return { iceServers: STUN, relay: false }
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 43200 }),
    })
    if (!r.ok) throw new Error(String(r.status))
    const list = ((await r.json() as any).iceServers ?? [])
      .map((s: any) => ({ ...s, urls: ([] as string[]).concat(s.urls ?? []).filter((u) => !/:53(\?|$)/.test(u)) }))   // le port 53 est bloqué par les navigateurs
      .filter((s: any) => s.urls.length)
    if (!list.some((s: any) => s.credential)) throw new Error('pas de relais dans la réponse')
    return { iceServers: list, relay: true }
  } catch (e) { console.warn('[pair] relais indisponible', e); return { iceServers: STUN, relay: false } }
}
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST seulement' }, { status: 405 })
  // session ouverte sur les deux appareils ; le PC interroge toutes les 1,5 s en attendant la tablette
  const gate = await guard(req, { bucket: 'pair', perMin: 90 })
  if (gate instanceof Response) return gate
  if (!kvConfigured()) return jsonResponse({ error: 'Stockage non configuré : appairage indisponible.' }, { status: 503 })
  const body = await readJsonCapped<{ op?: unknown; code?: unknown; sdp?: unknown }>(req, 24_000)
  if (body instanceof Response) return body
  const { op, code, sdp } = body ?? {}

  if (op === 'ice') return jsonResponse(await iceServers())
  if (op === 'offer') {
    if (!okSdp(sdp)) return jsonResponse({ error: 'offre invalide' }, { status: 400 })
    for (let i = 0; i < 5; i++) {   // un code déjà en attente n'est jamais réattribué
      const c = newCode()
      if (await kv().set(offerKey(c), sdp, { nx: true, ex: TTL })) return jsonResponse({ code: c })
    }
    return jsonResponse({ error: 'Pas de code libre, réessaie.' }, { status: 503 })
  }
  if (!okCode(code)) return jsonResponse({ error: 'Le code a six chiffres.' }, { status: 400 })
  if (op === 'take') {
    const offer = await kv().getdel<string>(offerKey(code))
    return offer ? jsonResponse({ offer }) : jsonResponse({ error: 'Code inconnu ou expiré.' }, { status: 404 })
  }
  if (op === 'answer') {
    if (!okSdp(sdp)) return jsonResponse({ error: 'réponse invalide' }, { status: 400 })
    await kv().set(answerKey(code), sdp, { ex: 60 })
    return jsonResponse({ ok: true })
  }
  if (op === 'wait') return jsonResponse({ answer: (await kv().getdel<string>(answerKey(code))) ?? null })
  return jsonResponse({ error: 'opération inconnue' }, { status: 400 })
}
