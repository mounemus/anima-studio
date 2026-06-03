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

async function getKey(): Promise<CryptoKey> {
  const raw = (globalThis as any).process?.env?.ENCRYPT_KEY
  if (!raw || raw.length < 32) {
    throw new Error('ENCRYPT_KEY env var missing or too short (need 32+ chars)')
  }
  // hash to a fixed-length 256-bit key
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(raw))
  return crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptString(plain: string): Promise<string> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain))
  return `${b64(iv)}.${b64(ct)}`
}

export async function decryptString(payload: string): Promise<string> {
  const [ivS, ctS] = payload.split('.')
  if (!ivS || !ctS) throw new Error('Bad cipher payload')
  const key = await getKey()
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivS) }, key, unb64(ctS))
  return dec.decode(pt)
}

export function hint(s: string): string {
  if (!s) return ''
  if (s.length <= 6) return '••••'
  return `••••${s.slice(-4)}`
}
