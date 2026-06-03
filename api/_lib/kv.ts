import { Redis } from '@upstash/redis'

let _client: Redis | null = null

function env(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name]
}

export function kv(): Redis {
  if (_client) return _client
  const url = env('KV_REST_API_URL') ?? env('UPSTASH_REDIS_REST_URL')
  const token = env('KV_REST_API_TOKEN') ?? env('UPSTASH_REDIS_REST_TOKEN')
  if (!url || !token) {
    throw new Error('Vercel KV not configured: set KV_REST_API_URL and KV_REST_API_TOKEN')
  }
  _client = new Redis({ url, token })
  return _client
}

export function kvConfigured(): boolean {
  const url = env('KV_REST_API_URL') ?? env('UPSTASH_REDIS_REST_URL')
  const token = env('KV_REST_API_TOKEN') ?? env('UPSTASH_REDIS_REST_TOKEN')
  return !!(url && token)
}

// Key namespace
export const K = {
  admin: 'anima:admin',                    // hash: id, email, password_hash, created_at, last_login_at
  setting: (key: string) => `anima:setting:${key}`,  // hash: value, hint, updated_at, updated_by
  settingsIndex: 'anima:settings:index',   // set of setting keys
}
