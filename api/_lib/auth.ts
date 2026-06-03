import { SignJWT, jwtVerify } from 'jose'
import { kv, kvConfigured, K } from './kv'

// PBKDF2-SHA256 password hashing (edge-compatible via WebCrypto)
const PBKDF2_ITERS = 200_000
const PBKDF2_KEYLEN = 32
const SALT_LEN = 16

// JWT identifier index — when present in KV, the token is valid; absent = revoked.
const JTI_KEY = (jti: string) => `anima:jti:${jti}`
const JTI_TTL_SEC = 60 * 60 * 24 * 7    // matches cookie Max-Age

function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    PBKDF2_KEYLEN * 8,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const hash = await pbkdf2(plain, salt)
  return `pbkdf2$${PBKDF2_ITERS}$${bytesToB64(salt)}$${bytesToB64(hash)}`
}

export async function comparePassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const salt = b64ToBytes(parts[2])
  const expected = b64ToBytes(parts[3])
  const actual = await pbkdf2(plain, salt)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}

const COOKIE = 'anima_admin'
const ALG = 'HS256'

function secret(): Uint8Array {
  const s = (globalThis as any).process?.env?.JWT_SECRET
  // Raised from 16 → 32: HS256 needs ≥256 bits of entropy to resist offline
  // cracking of intercepted tokens. Generate with: openssl rand -base64 32
  if (!s || s.length < 32) throw new Error('JWT_SECRET env var missing or too short (need 32+ chars)')
  return new TextEncoder().encode(s)
}

function randomJti(): string {
  const buf = crypto.getRandomValues(new Uint8Array(16))
  return bytesToB64(buf).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' } as any)[c])
}

export interface AdminSession { sub: string; email: string; jti?: string }

export async function signSession(s: AdminSession): Promise<string> {
  const jti = randomJti()
  // Register the jti as "active" in KV. Absent jti = revoked (logged out / forced).
  // KV may be down — we still issue the token, but it won't be revocable until KV returns.
  if (kvConfigured()) {
    try { await kv().set(JTI_KEY(jti), { sub: s.sub, iat: Date.now() }, { ex: JTI_TTL_SEC }) }
    catch { /* swallow — token still issued */ }
  }
  return await new SignJWT({ email: s.email, jti })
    .setProtectedHeader({ alg: ALG })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

export async function verifySession(token: string): Promise<AdminSession | null> {
  try {
    const r = await jwtVerify(token, secret())
    const jti = r.payload.jti ? String(r.payload.jti) : undefined
    // Check revocation list in KV. If KV is configured and the jti is missing → revoked.
    // If KV is unconfigured, we trust the signature alone (graceful degradation).
    if (jti && kvConfigured()) {
      try {
        const exists = await kv().get(JTI_KEY(jti))
        if (exists === null || exists === undefined) return null
      } catch { /* KV glitch — trust signature */ }
    }
    return { sub: String(r.payload.sub), email: String(r.payload.email), jti }
  } catch {
    return null
  }
}

/** Revoke a specific JWT id (called on logout). */
export async function revokeSession(jti: string | undefined): Promise<void> {
  if (!jti || !kvConfigured()) return
  try { await kv().del(JTI_KEY(jti)) } catch { /* ignore */ }
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

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(data), { ...init, headers })
}
