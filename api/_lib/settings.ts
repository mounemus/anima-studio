import { kv, kvConfigured, K } from './kv'
import { decryptString, encryptString, hint } from './crypto'

export const KNOWN_KEYS = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...', help: 'Compagnon IA — modifie tes scènes par prompt.' },
  { key: 'FAL_KEY', label: 'fal.ai (SDXL Turbo, Flux)', placeholder: 'fal-...', help: 'Génération d\'images / textures live (~1s).' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-proj-...', help: 'Alternative IA / TTS / Whisper.' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'sk_...', help: 'Voix de synthèse pour installations parlantes.' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', placeholder: 'r8_...', help: 'Modèles open-source (vidéo, 3D, audio).' },
  { key: 'STABILITY_API_KEY', label: 'Stability AI', placeholder: 'sk-...', help: 'Stable Diffusion 3, ControlNet officiel.' },
] as const

export type SettingKey = typeof KNOWN_KEYS[number]['key']

interface StoredSetting {
  value: string  // encrypted
  hint: string
  updated_at: string
  updated_by?: string
}

export async function getSetting(key: string): Promise<string | null> {
  // Prefer KV, fallback to raw env var (so legacy ANTHROPIC_API_KEY env still works)
  if (kvConfigured()) {
    try {
      const row = await kv().get<StoredSetting>(K.setting(key))
      if (row?.value) {
        try { return await decryptString(row.value) } catch { /* corrupt */ }
      }
    } catch { /* KV error */ }
  }
  return (globalThis as any).process?.env?.[key] ?? null
}

export async function listSettings(): Promise<{ key: string; hint: string; configured: boolean }[]> {
  const env = (globalThis as any).process?.env ?? {}
  const out: { key: string; hint: string; configured: boolean }[] = []
  let rows: Record<string, StoredSetting | null> = {}
  if (kvConfigured()) {
    try {
      const keys = KNOWN_KEYS.map((k) => K.setting(k.key))
      const values = await kv().mget<(StoredSetting | null)[]>(...keys)
      KNOWN_KEYS.forEach((k, i) => { rows[k.key] = values[i] })
    } catch { /* ignore */ }
  }
  for (const k of KNOWN_KEYS) {
    const row = rows[k.key]
    const hasKv = !!row?.value
    const hasEnv = !!env[k.key]
    out.push({
      key: k.key,
      hint: row?.hint ?? (hasEnv ? '(env)' : ''),
      configured: hasKv || hasEnv,
    })
  }
  return out
}

export async function setSetting(key: string, value: string, updatedBy?: string) {
  if (!kvConfigured()) throw new Error('Vercel KV non configurée — impossible de sauvegarder.')
  const trimmed = value.trim()
  const enc = await encryptString(trimmed)
  const stored: StoredSetting = {
    value: enc,
    hint: hint(trimmed),
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  }
  await kv().set(K.setting(key), stored)
  await kv().sadd(K.settingsIndex, key)
}

export async function deleteSetting(key: string) {
  if (!kvConfigured()) throw new Error('Vercel KV non configurée.')
  await kv().del(K.setting(key))
  await kv().srem(K.settingsIndex, key)
}
