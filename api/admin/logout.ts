import { clearCookieHeader, jsonResponse } from '../_lib/auth'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request): Promise<Response> {
  return jsonResponse({ ok: true }, {
    status: 200,
    headers: { 'set-cookie': clearCookieHeader() },
  })
}
