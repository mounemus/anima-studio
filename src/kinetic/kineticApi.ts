/**
 * Pure helpers of /api/kinetic (the server side of the « Sculptures cinétiques » atelier's AI).
 * They live under src/ so the vitest suite covers them ; the endpoint itself is api/kinetic.ts.
 * Everything here handles untrusted input : the request body comes from the browser, the reply from a model.
 */

export interface Turn { role: 'user' | 'assistant'; content: string }

export const LIMITS = { system: 16000, turns: 7, turn: 8000, schema: 12000 }

/**
 * Validates the conversation sent by the atelier : 1 to LIMITS.turns turns, plain strings, starting and
 * ending with the user and alternating. Returns null when the shape is wrong (the endpoint answers 400).
 */
export function cleanTurns(input: unknown): Turn[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.turns || input.length % 2 === 0) return null
  const out: Turn[] = []
  for (let i = 0; i < input.length; i++) {
    const t = input[i] as { role?: unknown; content?: unknown } | null
    const role = i % 2 === 0 ? 'user' : 'assistant'
    if (!t || t.role !== role || typeof t.content !== 'string' || !t.content.trim()) return null
    out.push({ role, content: t.content.slice(0, LIMITS.turn) })
  }
  return out
}

/** The JSON schema of the expected answer : an object, small enough to be a parameter sheet. */
export function cleanSchema(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const s = input as Record<string, unknown>
  if (s.type !== 'object' || JSON.stringify(s).length > LIMITS.schema) return null
  return s
}

/**
 * The model's answer as a JSON object, re-serialised. Accepts a bare object, or one wrapped in prose or a
 * code fence (what a model does when it is only told to answer in JSON). Returns null when there is none.
 */
export function extractJson(text: string): string | null {
  const tryParse = (s: string) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : null } catch { return null } }
  const direct = tryParse(text.trim())
  if (direct) return direct
  const m = text.match(/\{[\s\S]*\}/)
  return m ? tryParse(m[0]) : null
}
