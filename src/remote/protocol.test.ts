import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parse, parseHello, padRect, padToView, moveCursor } from './protocol'
import { addressKinds } from './link'
import { pairUrl, codeFromSearch } from './Qr'

describe('liaison : adresses annoncées par un appareil', () => {
  const line = (addr: string, typ: string) => `a=candidate:1 1 udp 2113937151 ${addr} 54321 typ ${typ} generation 0`
  it('distingue l\'adresse locale en clair, l\'adresse cachée derrière un nom, et l\'adresse publique', () => {
    const sdp = ['v=0', line('192.168.2.44', 'host'), line('192.168.2.44', 'host tcptype passive'), line('3f1c9a52-7b1e-4c0d-9d8e-2f0a6b7c8d9e.local', 'host'), line('203.0.113.7', 'srflx raddr 0.0.0.0 rport 0'), line('198.51.100.9', 'relay raddr 0.0.0.0 rport 0'), 'a=ice-ufrag:abcd'].join('\r\n')
    expect(addressKinds(sdp)).toEqual({ ip: 2, name: 1, pub: 1, relay: 1, local: ['192.168.2.44'] })
    expect(addressKinds('v=0\r\n')).toEqual({ ip: 0, name: 0, pub: 0, relay: 0, local: [] })
  })
  it('QR code : l\'adresse porte le code, et la page ne le relit que s\'il a six chiffres', () => {
    const url = pairUrl('https://exemple.test', '048213')
    expect(url).toBe('https://exemple.test/remote?code=048213')
    expect(codeFromSearch(new URL(url).search)).toBe('048213')
    for (const bad of ['', '?code=12345', '?code=1234567', '?code=12ab56', '?autre=123456']) expect(codeFromSearch(bad)).toBe('')
  })
})

describe('télécommande : messages reçus par le PC', () => {
  it('pointeur : remis dans le cadre, pression bornée, sans stylet = −1', () => {
    expect(parse({ t: 'ptr', x: 0.25, y: 0.5, d: true, p: 0.8 })).toEqual({ t: 'ptr', x: 0.25, y: 0.5, d: true, p: 0.8, c: false })
    expect(parse(JSON.stringify({ t: 'ptr', x: 7, y: -3, d: 1, p: 9 }))).toEqual({ t: 'ptr', x: 1, y: 0, d: false, p: 1, c: false })   // `d: 1` n'est pas `true`
    expect(parse({ t: 'ptr', x: 0.1, y: 0.1, d: false, c: true })).toEqual({ t: 'ptr', x: 0.1, y: 0.1, d: false, p: -1, c: true })
  })
  it('refuse ce qui n\'est pas un message : texte quelconque, nombres absents ou infinis, type inconnu', () => {
    for (const bad of [null, 42, 'bonjour', '{"t":"ptr"}', { t: 'ptr', x: NaN, y: 0 }, { t: 'ptr', x: '0.5', y: 0.5 }, { t: 'tap', x: Infinity, y: 0 }, { t: 'eval', code: 'alert(1)' }, 'x'.repeat(500)]) expect(parse(bad)).toBeNull()
  })
  it('manier l\'espace : valeurs absentes = ne rien faire, valeurs folles = bornées', () => {
    expect(parse({ t: 'nav' })).toEqual({ t: 'nav', dx: 0, dy: 0, s: 1, r: 0, yaw: 0, pitch: 0, cx: 0.5, cy: 0.5, end: false })
    const wild = parse({ t: 'nav', dx: 99, s: 1000, r: -50, yaw: 1e9, end: true })!
    expect(wild).toMatchObject({ dx: 1, s: 2, r: -1, yaw: 1, end: true })
  })
  it('commandes : seulement celles de la liste, avec des données du bon type', () => {
    expect(parse({ t: 'cmd', name: 'undo' })).toEqual({ t: 'cmd', name: 'undo' })
    expect(parse({ t: 'cmd', name: 'plane', data: 'top' })).toEqual({ t: 'cmd', name: 'plane', data: 'top' })
    expect(parse({ t: 'cmd', name: 'zoom', data: 50 })).toEqual({ t: 'cmd', name: 'zoom', data: 2 })
    expect(parse({ t: 'cmd', name: 'orbit', data: [0.2, -9] })).toEqual({ t: 'cmd', name: 'orbit', data: [0.2, -1.6] })
    for (const bad of [{ t: 'cmd', name: 'clearAll' }, { t: 'cmd', name: 'load', data: {} }, { t: 'cmd', name: 'tool', data: '__proto__' }, { t: 'cmd', name: 'tool', data: 7 }, { t: 'cmd', name: 'orbit', data: 'x' }, { t: 'cmd', name: 'zoom' }]) expect(parse(bad)).toBeNull()
  })
  it('gyroscope : une pose complète ou rien ; « coupé » passe toujours', () => {
    expect(parse({ t: 'gyro', on: true, h: 1.2, tilt: 0.4 })).toEqual({ t: 'gyro', on: true, h: 1.2, tilt: 0.4 })
    expect(parse({ t: 'gyro', on: true, h: 1.2 })).toBeNull()
    expect(parse({ t: 'gyro', on: false })).toEqual({ t: 'gyro', on: false, h: 0, tilt: 0 })
  })
  it('annonce du PC lue par la télécommande', () => {
    const h = parseHello(JSON.stringify({ t: 'hello', aspect: 1.6, tool: 'stroke', tools: [{ id: 'stroke', icon: '✏️', label: 'Trait' }, { id: 5 }, null] }))!
    expect(h.aspect).toBe(1.6); expect(h.tools).toEqual([{ id: 'stroke', icon: '✏️', label: 'Trait' }])
    expect(parseHello({ t: 'hello' })).toBeNull(); expect(parseHello('pas du json')).toBeNull()
  })
})

describe('télécommande : de la surface tactile à l\'écran du PC', () => {
  it('le cadre garde les proportions du PC, centré dans la surface', () => {
    expect(padRect(400, 800, 2)).toEqual({ x: 0, y: 300, w: 400, h: 200 })       // téléphone debout, PC large : bandes en haut et en bas
    expect(padRect(1000, 500, 1)).toEqual({ x: 250, y: 0, w: 500, h: 500 })      // tablette couchée, fenêtre carrée : bandes sur les côtés
  })
  it('coins et centre du cadre = coins et centre de l\'écran ; hors du cadre = collé au bord', () => {
    const r = padRect(400, 800, 2)
    expect(padToView(0, 300, r)).toEqual({ x: 0, y: 0 }); expect(padToView(400, 500, r)).toEqual({ x: 1, y: 1 }); expect(padToView(200, 400, r)).toEqual({ x: 0.5, y: 0.5 })
    expect(padToView(200, 10, r)).toEqual({ x: 0.5, y: 0 })
  })
  it('un cercle tracé sur la tablette reste un cercle sur le PC', () => {
    const r = padRect(400, 800, 2), W = 1600, H = 800   // écran du PC, mêmes proportions que le cadre
    const a = padToView(200, 400, r), bx = padToView(260, 400, r), by = padToView(200, 460, r)
    expect((bx.x - a.x) * W).toBeCloseTo((by.y - a.y) * H)                       // 60 px de côté = la même distance à l'écran, en large comme en haut
  })
  it('souris : le curseur avance de la même distance à l\'écran dans les deux sens, et s\'arrête aux bords', () => {
    const aspect = 2, W = 1600, H = 800, c = moveCursor({ x: 0.5, y: 0.5 }, 40, 40, 400, aspect)
    expect((c.x - 0.5) * W).toBeCloseTo((c.y - 0.5) * H); expect(c.x).toBeCloseTo(0.65)
    expect(moveCursor({ x: 0.98, y: 0.02 }, 500, -500, 400, aspect)).toEqual({ x: 1, y: 0 })
  })
})

// ───────── la fonction serveur d'appairage, avec un stockage en mémoire ─────────
const store = new Map<string, string>()
vi.mock('../../api/_lib/kv', () => ({
  kvConfigured: () => true,
  kv: () => ({
    set: async (k: string, v: string, o?: { nx?: boolean }) => { if (o?.nx && store.has(k)) return null; store.set(k, v); return 'OK' },
    getdel: async (k: string) => { const v = store.get(k) ?? null; store.delete(k); return v },
  }),
}))
vi.mock('../../api/_lib/guard', async (orig) => ({ ...(await orig<typeof import('../../api/_lib/guard')>()), guard: async () => ({ sub: 'admin', email: 'a@b.c' }) }))

describe('appairage : échange de départ par le serveur', () => {
  beforeEach(() => store.clear())
  const call = async (body: unknown, method = 'POST') => {
    const { default: handler } = await import('../../api/pair')
    const res = await handler(new Request('https://x.test/api/pair', { method, ...(method === 'POST' ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }))
    return { status: res.status, json: await res.json() as any }
  }
  const sdp = (tag: string) => `v=0\r\no=- ${tag} 2 IN IP4 127.0.0.1\r\n`

  it('le PC dépose son offre, la tablette la retire avec le code et répond, le PC récupère la réponse', async () => {
    const { json: { code } } = await call({ op: 'offer', sdp: sdp('pc') })
    expect(code).toMatch(/^\d{6}$/)
    expect((await call({ op: 'wait', code })).json.answer).toBeNull()             // la tablette n'a pas encore répondu
    expect((await call({ op: 'take', code })).json.offer).toBe(sdp('pc'))
    expect((await call({ op: 'answer', code, sdp: sdp('tablette') })).json.ok).toBe(true)
    expect((await call({ op: 'wait', code })).json.answer).toBe(sdp('tablette'))
    expect((await call({ op: 'wait', code })).json.answer).toBeNull()             // la réponse ne sert qu'une fois
  })
  it('un code ne sert qu\'une fois : un second appareil ne peut pas prendre la place', async () => {
    const { json: { code } } = await call({ op: 'offer', sdp: sdp('pc') })
    expect((await call({ op: 'take', code })).status).toBe(200)
    expect((await call({ op: 'take', code })).status).toBe(404)
  })
  it('refuse un code mal formé ou inconnu, une offre qui n\'en est pas une, une offre énorme, une autre méthode', async () => {
    expect((await call({ op: 'take', code: '12ab56' })).status).toBe(400)
    expect((await call({ op: 'take', code: '000000' })).status).toBe(404)
    expect((await call({ op: 'offer', sdp: '<script>' })).status).toBe(400)
    expect((await call({ op: 'offer', sdp: 'v=0' + 'a'.repeat(21_000) })).status).toBe(400)
    expect((await call({ op: 'offer', sdp: 'v=0' + 'a'.repeat(30_000) })).status).toBe(413)
    expect((await call({ op: 'answer', code: '123456', sdp: 42 })).status).toBe(400)
    expect((await call({ op: 'danse', code: '123456' })).status).toBe(400)
    expect((await call(null, 'GET')).status).toBe(405)
  })

  describe('serveurs de liaison', () => {
    const P = (globalThis as any).process
    const cloudflare = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] }
    const withKeys = async (fetchImpl: any, run: () => Promise<void>) => {
      P.env.TURN_KEY_ID = 'id'; P.env.TURN_KEY_API_TOKEN = 'jeton'
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
      try { await run() } finally { delete P.env.TURN_KEY_ID; delete P.env.TURN_KEY_API_TOKEN; spy.mockRestore() }
      return spy
    }
    it('sans relais configuré : le serveur public de découverte, et `relay` faux', async () => {
      const { json } = await call({ op: 'ice' })
      expect(json.relay).toBe(false); expect(json.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }])
    })
    it('relais configuré : identifiants à durée limitée demandés avec la clé, port 53 retiré, la clé ne sort pas', async () => {
      let asked: any = null
      await withKeys(async (url: string, init: any) => { asked = { url, auth: init.headers.authorization, body: JSON.parse(init.body) }; return new Response(JSON.stringify(cloudflare), { status: 201 }) }, async () => {
        const { json } = await call({ op: 'ice' })
        expect(json.relay).toBe(true)
        expect(json.iceServers[1]).toEqual({ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' })
        expect(JSON.stringify(json)).not.toContain('jeton')
      })
      expect(asked.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/id/credentials/generate-ice-servers')
      expect(asked.auth).toBe('Bearer jeton'); expect(asked.body.ttl).toBeGreaterThan(3600)
    })
    it('relais en panne ou clé refusée : on retombe sur la liaison directe, sans erreur pour l\'utilisateur', async () => {
      for (const impl of [async () => new Response('non', { status: 401 }), async () => { throw new Error('réseau') }, async () => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), { status: 201 })]) {
        await withKeys(impl, async () => { const { status, json } = await call({ op: 'ice' }); expect(status).toBe(200); expect(json.relay).toBe(false); expect(json.iceServers[0].urls[0]).toContain('stun:') })
      }
    })
  })
})
