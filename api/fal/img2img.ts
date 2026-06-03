import { getSetting } from '../_lib/settings'
import { jsonResponse } from '../_lib/auth'
import { guard, readJsonCapped } from '../_lib/guard'

export const config = { runtime: 'edge' }

// Cap data URLs at ~6 MB base64 (~4.5 MB original). Anything bigger is almost
// certainly a misuse and would needlessly spend egress + fal credits.
const MAX_IMG2IMG_BYTES = 6 * 1024 * 1024

/**
 * POST /api/fal/img2img
 * Body: { prompt: string, image: string (base64 dataURL), strength?: 0..1, size?: 'sq'|'sq_hd' }
 * Returns: { url, width, height, model }
 *
 * Uses fal-ai/fast-lightning-sdxl with image_url + strength for fast img2img (~0.7s).
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, { status: 405 })
  const gate = await guard(req, { bucket: 'fal-img2img', perMin: 6 })
  if (gate instanceof Response) return gate

  const apiKey = await getSetting('FAL_KEY')
  if (!apiKey) return jsonResponse({ error: 'Clé fal.ai non configurée.' }, { status: 500 })

  const parsed = await readJsonCapped<{ prompt?: string; image?: string; strength?: number; size?: string }>(req, MAX_IMG2IMG_BYTES)
  if (parsed instanceof Response) return parsed
  const body = parsed

  const prompt = body.prompt?.toString().slice(0, 800).trim()
  const image = body.image?.toString()
  if (!prompt) return jsonResponse({ error: 'prompt manquant' }, { status: 400 })
  if (!image || !image.startsWith('data:image/')) return jsonResponse({ error: 'image (dataURL) manquante' }, { status: 400 })
  if (image.length > MAX_IMG2IMG_BYTES) return jsonResponse({ error: 'image trop volumineuse (max 6 MB)' }, { status: 413 })
  const strength = Math.max(0.1, Math.min(0.95, body.strength ?? 0.65))

  const model = 'fal-ai/fast-lightning-sdxl'
  const size = body.size === 'sq_hd' ? { width: 1024, height: 1024 } : { width: 512, height: 512 }

  try {
    const r = await fetch(`https://fal.run/${model}/image-to-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_url: image,
        strength,
        num_inference_steps: 4,
        num_images: 1,
        image_size: size,
        enable_safety_checker: true,
      }),
    })
    if (!r.ok) {
      const txt = await r.text()
      console.error('[api/fal/img2img]', r.status, txt.slice(0, 500))
      return jsonResponse({ error: `fal.ai indisponible (${r.status})` }, { status: 502 })
    }
    const data = await r.json() as { images?: { url: string; width?: number; height?: number }[] }
    const img = data.images?.[0]
    if (!img?.url) return jsonResponse({ error: 'no image' }, { status: 502 })
    return jsonResponse({ url: img.url, width: img.width ?? size.width, height: img.height ?? size.height, model, prompt })
  } catch (e: any) {
    console.error('[api/fal/img2img]', e)
    return jsonResponse({ error: 'erreur côté fal.ai' }, { status: 500 })
  }
}
