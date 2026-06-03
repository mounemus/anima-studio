import { readCookie, verifySession, jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  const tok = readCookie(req)
  if (!tok) return jsonResponse({ authenticated: false })
  const sess = await verifySession(tok)
  if (!sess) return jsonResponse({ authenticated: false })
  return jsonResponse({ authenticated: true, email: sess.email })
}
