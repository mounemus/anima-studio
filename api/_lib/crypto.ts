/** AES-256-GCM encryption using WebCrypto (works in Vercel edge runtime). */

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Stable HKDF salt — distinct from the encrypted payload and never secret.
// Changing this value invalidates all already-encrypted ciphertexts; treat as forever.
const HKDF_SALT = enc.encode('anima-studio:v1:encrypt-key-derivation')
const HKDF_INFO = enc.encode('aes-gcm-256:settings')

let _cachedKey: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey
  const raw = (globalThis as any).process?.env?.ENCRYPT_KEY
  if (!raw || raw.length < 32) {
    throw new Error('ENCRYPT_KEY env var missing or too short (need 32+ chars)')
  }
  // HKDF-SHA256: proper key-derivation with stretching and domain-separated info.
  // Replaces the bare SHA-256(input) we had before — bare-hash had no salt, no info,
  // and was vulnerable to length-extension / rainbow attacks on weak ENCRYPT_KEY.
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(raw), 'HKDF', false, ['deriveKey'])
  _cachedKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT as BufferSource, info: HKDF_INFO as BufferSource },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return _cachedKey
}

export async function encryptString(plain: string): Promise<string> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain))
  return `${b64(iv)}.${b64(ct)}`
}

/**
 * Legacy key derivation (bare SHA-256 of ENCRYPT_KEY) — kept for backward-compat
 * with ciphertexts encrypted before the HKDF migration. decryptString() falls
 * back to this if HKDF decryption fails, then the caller (settings.ts) should
 * re-encrypt-and-store to migrate forward.
 */
async function getLegacyKey(): Promise<CryptoKey> {
  const raw = (globalThis as any).process?.env?.ENCRYPT_KEY
  if (!raw) throw new Error('ENCRYPT_KEY missing')
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(raw))
  return crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, false, ['decrypt'])
}

export async function decryptString(payload: string): Promise<string> {
  const [ivS, ctS] = payload.split('.')
  if (!ivS || !ctS) throw new Error('Bad cipher payload')
  const iv = unb64(ivS)
  const ct = unb64(ctS)
  // Try the modern HKDF key first
  try {
    const key = await getKey()
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return dec.decode(pt)
  } catch {
    // Fall back to the legacy SHA-256 key for ciphertexts created before
    // the HKDF migration. settings.getSetting() will detect a 'legacy' hit
    // and silently re-encrypt with the new key.
    const legacy = await getLegacyKey()
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, legacy, ct)
    return dec.decode(pt)
  }
}

export function hint(s: string): string {
  if (!s) return ''
  if (s.length <= 6) return '••••'
  return `••••${s.slice(-4)}`
}
