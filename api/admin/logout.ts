import { clearCookieHeader, jsonResponse, readCookie, verifySession, revokeSession } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  // Best-effort revocation: read the cookie's jti and erase its KV entry so the
  // token becomes immediately invalid (defends against cookie theft within the
  // 7-day cookie lifetime).
  const tok = readCookie(req)
  if (tok) {
    const sess = await verifySession(tok)
    if (sess?.jti) await revokeSession(sess.jti)
  }
  return jsonResponse({ ok: true }, {
    status: 200,
    headers: { 'set-cookie': clearCookieHeader() },
  })
}
