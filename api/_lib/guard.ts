/**
 * Security guard for AI endpoints.
 *
 * Default policy: only an authenticated admin may call paid AI endpoints (Claude / FAL / OpenAI).
 * On top of that, a per-IP token bucket via Upstash KV protects against runaway loops or stolen cookies.
 *
 * Usage:
 *   const gate = await guard(req, { bucket: 'claude', perMin: 20 })
 *   if (gate instanceof Response) return gate
 *   // continue, gate is the AdminSession
 */
import { requireAdmin, jsonResponse, type AdminSession } from './auth'
import { kv, kvConfigured } from './kv'

interface GuardOpts {
  /** Bucket name used as part of the rate-limit key. */
  bucket: string
  /** Max requests per minute per identity. */
  perMin: number
  /** If true, skip admin requirement and only rate-limit by IP+Origin (for endpoints that need to be public eventually). Default false. */
  publicAllowed?: boolean
}

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function originAllowed(req: Request): boolean {
  // Vercel default: same-origin only. We additionally require that requests
  // carry an Origin header matching the host, to defeat naïve cross-site CSRF
  // even if the cookie's SameSite policy were ever relaxed.
  const origin = req.headers.get('origin')
  if (!origin) {
    // GET / HEAD won't have Origin; we only call guard on POST so missing
    // Origin is a strong CSRF indicator → reject.
    return false
  }
  try {
    const u = new URL(origin)
    const host = req.headers.get('host') ?? ''
    return u.host === host
  } catch {
    return false
  }
}

/**
 * Returns the AdminSession when allowed, or a Response (4xx/5xx) when denied.
 * Always rate-limits, even when admin is authenticated.
 */
export async function guard(req: Request, opts: GuardOpts): Promise<AdminSession | Response> {
  // 1) Origin check (CSRF)
  if (!originAllowed(req)) {
    return jsonResponse({ error: 'origin not allowed' }, { status: 403 })
  }

  // 2) Authentication
  let session: AdminSession | null = null
  if (!opts.publicAllowed) {
    const a = await requireAdmin(req)
    if (a instanceof Response) return a
    session = a
  }

  // 3) Rate-limit per identity (admin sub if logged in, else IP)
  if (kvConfigured()) {
    const id = session?.sub ?? clientIp(req)
    const key = `anima:rl:${opts.bucket}:${id}`
    try {
      const r = await kv().incr(key)
      if (r === 1) {
        // first hit in this window — set 60s TTL
        await kv().expire(key, 60)
      }
      if (r > opts.perMin) {
        return jsonResponse(
          { error: `Trop de requêtes — limite ${opts.perMin}/min atteinte. Réessaie dans une minute.` },
          { status: 429, headers: { 'retry-after': '60' } },
        )
      }
    } catch {
      // KV unavailable: don't hard-block AI usage on infra glitch; log and proceed.
      console.warn('[guard] rate-limit KV failure, allowing through')
    }
  }

  return session ?? ({ sub: 'public', email: 'public' } as AdminSession)
}

/** Generic body-size guard for JSON endpoints. Returns null when OK, Response when too big. */
export async function readJsonCapped<T>(req: Request, maxBytes: number): Promise<T | Response> {
  const lenHdr = req.headers.get('content-length')
  if (lenHdr && Number(lenHdr) > maxBytes) {
    return jsonResponse({ error: `payload trop gros (max ${Math.round(maxBytes / 1024)} kB)` }, { status: 413 })
  }
  let text: string
  try { text = await req.text() } catch { return jsonResponse({ error: 'read failure' }, { status: 400 }) }
  if (text.length > maxBytes) {
    return jsonResponse({ error: `payload trop gros (max ${Math.round(maxBytes / 1024)} kB)` }, { status: 413 })
  }
  try { return JSON.parse(text) as T } catch { return jsonResponse({ error: 'bad json' }, { status: 400 }) }
}
