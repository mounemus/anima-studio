/**
 * Appairage d'une tablette ou d'un téléphone avec l'application ouverte sur le PC.
 *
 * Les deux appareils se parlent ensuite en direct (WebRTC) ; cette fonction ne sert qu'à l'échange de départ,
 * sous un code à six chiffres qui expire. Le PC dépose son offre et reçoit le code ; la tablette la retire avec
 * le code (une seule fois) et dépose sa réponse ; le PC la récupère. Rien d'autre ne passe par le serveur.
 *
 *   POST { op: 'offer',  sdp }        → { code }
 *   POST { op: 'take',   code }       → { offer }            (404 : code inconnu, expiré ou déjà pris)
 *   POST { op: 'answer', code, sdp }  → { ok: true }
 *   POST { op: 'wait',   code }       → { answer | null }
 */
import { guard, readJsonCapped } from './_lib/guard'
import { jsonResponse } from './_lib/auth'
import { kv, kvConfigured } from './_lib/kv'

export const config = { runtime: 'edge' }

const TTL = 300, MAX_SDP = 8000
const offerKey = (code: string) => `anima:pair:${code}:o`, answerKey = (code: string) => `anima:pair:${code}:a`
const okSdp = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_SDP && s.startsWith('v=0')
const okCode = (c: unknown): c is string => typeof c === 'string' && /^\d{6}$/.test(c)
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST seulement' }, { status: 405 })
  // session ouverte sur les deux appareils ; le PC interroge toutes les 1,5 s en attendant la tablette
  const gate = await guard(req, { bucket: 'pair', perMin: 90 })
  if (gate instanceof Response) return gate
  if (!kvConfigured()) return jsonResponse({ error: 'Stockage non configuré : appairage indisponible.' }, { status: 503 })
  const body = await readJsonCapped<{ op?: unknown; code?: unknown; sdp?: unknown }>(req, 12_000)
  if (body instanceof Response) return body
  const { op, code, sdp } = body ?? {}

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
