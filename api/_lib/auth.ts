import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'

const COOKIE = 'anima_admin'
const ALG = 'HS256'

function secret(): Uint8Array {
  const s = (globalThis as any).process?.env?.JWT_SECRET
  if (!s || s.length < 16) throw new Error('JWT_SECRET env var missing or too short')
  return new TextEncoder().encode(s)
}

export interface AdminSession { sub: string; email: string }

export async function signSession(s: AdminSession): Promise<string> {
  return await new SignJWT({ email: s.email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

export async function verifySession(token: string): Promise<AdminSession | null> {
  try {
    const r = await jwtVerify(token, secret())
    return { sub: String(r.payload.sub), email: String(r.payload.email) }
  } catch {
    return null
  }
}

export function cookieHeader(token: string, maxAgeSec = 60 * 60 * 24 * 7) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`
}
export function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function readCookie(req: Request): string | null {
  const h = req.headers.get('cookie') || ''
  const m = h.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

export async function requireAdmin(req: Request): Promise<AdminSession | Response> {
  const tok = readCookie(req)
  if (!tok) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  const sess = await verifySession(tok)
  if (!sess) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  return sess
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(data), { ...init, headers })
}
