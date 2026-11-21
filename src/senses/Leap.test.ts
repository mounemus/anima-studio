import { describe, it, expect, vi } from 'vitest'
import frames from './__fixtures__/leap-orion.json'
import { convertFrame, LEAP_DEFAULTS, pollHands, handClock, calibrate, project, priorCal, resetFit, type LeapCal, type V3 } from './Leap'

// Vraies trames d'un Leap Motion LM-010 (Orion 4.1.0), 1 sur 30 d'une séance de 20 s.
const S = LEAP_DEFAULTS
const hs = (lm: { x: number; y: number }[]) => Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y)

const hand = (type: 'left' | 'right', palm: number[], tips: number[][], extra: object = {}) => {
  const id = type === 'left' ? 1 : 2
  return {
    hands: [{ id, type, palmPosition: palm, palmNormal: [0, -1, 0], direction: [0, 0, -1], pinchStrength: 0, grabStrength: 0, ...extra }],
    pointables: tips.map((t, i) => ({ id: id * 10 + i, handId: id, type: i, extended: true, tipPosition: t, length: 50 })),
  }
}
const open = (x: number, z: number) => hand('right', [x, 200, z], [[x - 70, 200, z - 20], [x - 25, 200, z - 95], [x, 200, z - 105], [x + 20, 200, z - 95], [x + 40, 200, z - 75]])

describe('Leap → jalons MediaPipe', () => {
  it('convertit chaque main réelle en 21 jalons finis et un geste', () => {
    let hands = 0
    for (const f of frames as any[]) {
      const r = convertFrame(f, S)
      expect(r.landmarks.length).toBe(f.hands.length)
      for (let i = 0; i < r.landmarks.length; i++) {
        hands++
        expect(r.landmarks[i]).toHaveLength(21)
        for (const p of r.landmarks[i]) expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
        // taille apparente poignet → jointure du majeur : celle d'une main devant une webcam
        expect(hs(r.landmarks[i])).toBeGreaterThan(0.04)
        expect(hs(r.landmarks[i])).toBeLessThan(0.6)
        expect(typeof r.gestures[i][0].categoryName).toBe('string')
      }
    }
    expect(hands).toBeGreaterThan(40)
  })

  it('reconnaît le poing et la pince sur les trames réelles', () => {
    for (const f of frames as any[]) {
      const r = convertFrame(f, S)
      f.hands.forEach((h: any, i: number) => {
        if (h.grabStrength >= 0.95) expect(r.gestures[i][0].categoryName).toBe('Closed_Fist')
        if (h.pinchStrength >= 0.95) expect(r.leap![i].pinch).toBeGreaterThanOrEqual(0.95)
      })
    }
  })

  it('image non miroir : la droite de l\'utilisateur est à gauche, le haut en haut', () => {
    const r = convertFrame(open(120, 0), S).landmarks[0], l = convertFrame(open(-120, 0), S).landmarks[0]
    expect(r[9].x).toBeLessThan(0.5); expect(l[9].x).toBeGreaterThan(0.5)
    const at = (y: number) => convertFrame(hand('right', [0, y, 0], [[0, y, 0], [0, y, 0], [0, y, 0], [0, y, 0], [0, y, 0]]), S).landmarks[0][0].y
    expect(at(450)).toBeLessThan(0.5); expect(at(450)).toBeLessThan(at(250))
  })

  it('main plus proche de l\'écran = plus grande, comme devant une webcam', () => {
    const near = hs(convertFrame(open(0, -120), S).landmarks[0]), far = hs(convertFrame(open(0, 120), S).landmarks[0])
    expect(near).toBeGreaterThan(far * 1.5)
  })

  it('classe paume ouverte, index levé et pince', () => {
    expect(convertFrame(open(0, 0), S).gestures[0][0].categoryName).toBe('Open_Palm')
    const point = open(0, 0); point.pointables.forEach((p, i) => { p.extended = i === 1 })
    expect(convertFrame(point, S).gestures[0][0].categoryName).toBe('Pointing_Up')
    const pinch = open(0, 0); pinch.pointables[0].tipPosition = [...pinch.pointables[1].tipPosition]
    const c = convertFrame(pinch, S)
    expect(c.leap![0].pinch).toBe(1)
    expect(c.gestures[0][0].categoryName).not.toBe('Open_Palm')
    // la pince lue sur les jalons, comme le font les ateliers (distance pouce-index / taille de main)
    const lm = c.landmarks[0]
    expect(Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / hs(lm)).toBeLessThan(0.2)
  })

  it('capteur fixé à l\'écran : la distance au capteur devient la profondeur', () => {
    const scr = { ...S, placement: 'screen' as const }
    // repère capteur : y = distance à l'écran (250 mm = centre), z vers le bas
    const c = convertFrame(hand('right', [0, 250, -80], [[0, 250, -80], [0, 250, -80], [0, 250, -80], [0, 250, -80], [0, 250, -80]]), scr).leap![0]
    expect(c.palmMm.y).toBeCloseTo(280); expect(c.palmMm.z).toBeCloseTo(0)
  })

  it('pollHands : sans Leap, lit le modèle caméra une fois par image vidéo', () => {
    let calls = 0
    const model = { recognizeForVideo: () => { calls++; return { landmarks: [], gestures: [] } } }
    const video = { readyState: 4, currentTime: 1 } as HTMLVideoElement, clock = handClock()
    expect(pollHands(video, model, clock)).not.toBeNull()
    expect(pollHands(video, model, clock)).toBeNull()      // même image : rien de neuf
    ;(video as any).currentTime = 2
    expect(pollHands(video, model, clock)).not.toBeNull()
    expect(calls).toBe(2)
    expect(pollHands(video, null, clock)).toBeNull()       // modèle pas encore chargé
  })
})

// Calage sur la webcam : une vraie caméra simulée (en haut de l'écran, penchée de 15° vers le
// bas, tournée de 8°) regarde les mêmes points que le Leap ; le calage doit la retrouver à
// partir des seules correspondances.
describe('Leap : calage sur la webcam', () => {
  const A = 16 / 9, C = { x: 40, y: 450, z: -450 }, F = 0.6, pitch = 15 * Math.PI / 180, yaw = 8 * Math.PI / 180
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
  /** Une main : 21 points dans un volume de la taille d'une main, autour de `c`. */
  const handAt = (c: number[]): V3[] => Array.from({ length: 21 }, () => ({ x: c[0] + rnd() * 160, y: c[1] + rnd() * 180, z: c[2] + rnd() * 70 }))
  const exact = (p: V3) => {
    const x = p.x - C.x, y = p.y - C.y, z = p.z - C.z
    const x1 = x * Math.cos(yaw) - z * Math.sin(yaw), z1 = x * Math.sin(yaw) + z * Math.cos(yaw)
    const y2 = y * Math.cos(pitch) + z1 * Math.sin(pitch), z2 = -y * Math.sin(pitch) + z1 * Math.cos(pitch)
    return { x: 0.5 - F * x1 / z2, y: 0.5 - F * A * y2 / z2 }
  }
  const seen = (pts: V3[]) => pts.map((p) => { const e = exact(p); return { x: e.x + rnd() * 0.006, y: e.y + rnd() * 0.006 } })   // bruit de détection
  const errOf = (cal: LeapCal, pts: V3[]) => pts.reduce((e, p) => { const a = project(p, cal), b = exact(p); return e + Math.hypot(a.x - b.x, a.y - b.y) }, 0) / pts.length
  const start = priorCal(LEAP_DEFAULTS, A)
  const walk = (i: number) => [Math.sin(i * 0.7) * 200, 250 + Math.cos(i * 0.4) * 130, Math.sin(i * 0.23) * 130]

  it('la caméra par défaut est loin de la vraie (sinon le test ne prouve rien)', () => {
    expect(errOf(start, handAt([100, 300, 0]))).toBeGreaterThan(0.1)
  })

  it('une seule mesure suffit à poser la main du Leap sur celle de l\'image', () => {
    resetFit()
    const pts = handAt([120, 320, 20])
    const cal = calibrate([{ pts, full: true }], [seen(pts)], start)!
    expect(cal).not.toBeNull()
    expect(errOf(cal, pts)).toBeLessThan(0.03)
  })

  it('main qui se promène : juste partout dans le volume, même là où elle n\'est pas passée', () => {
    resetFit()
    let cal = start
    for (let i = 0; i < 80; i++) { const pts = handAt(walk(i)); cal = calibrate([{ pts, full: true }], [seen(pts)], cal) ?? cal }
    for (const c of [[-220, 180, -100], [0, 300, 0], [230, 420, 140], [150, 200, 120]]) expect(errOf(cal, handAt(c))).toBeLessThan(0.01)
  })

  it('main immobile : reste calée sur place, sans dérive', () => {
    resetFit()
    const pts = handAt([-80, 260, 40])
    let cal = start
    for (let i = 0; i < 60; i++) cal = calibrate([{ pts, full: true }], [seen(pts)], cal) ?? cal
    expect(errOf(cal, pts)).toBeLessThan(0.01)
    expect(errOf(cal, handAt([60, 320, 0]))).toBeLessThan(0.1)   // ailleurs : encore approximatif, mais pas absurde
  })

  it('sans articulations (pont) : poignet et bouts des doigts suffisent', () => {
    resetFit()
    let cal = start
    for (let i = 0; i < 80; i++) { const pts = handAt(walk(i)); cal = calibrate([{ pts, full: false }], [seen(pts)], cal) ?? cal }
    expect(errOf(cal, handAt([60, 300, 30]))).toBeLessThan(0.015)
  })

  it('deux mains : appariées par leur ordre dans l\'image', () => {
    resetFit()
    let cal = start
    for (let i = 0; i < 40; i++) {
      const l = handAt([-150 + Math.sin(i) * 40, 280 + Math.cos(i * 0.5) * 80, Math.sin(i * 0.3) * 90]), r = handAt([160 + Math.cos(i) * 40, 300, Math.cos(i * 0.3) * 90])
      cal = calibrate([{ pts: l, full: true }, { pts: r, full: true }], [seen(r), seen(l)], cal) ?? cal   // ordre inversé côté caméra
    }
    expect(errOf(cal, handAt([0, 300, 0]))).toBeLessThan(0.01)
  })

  it('écarte une mesure incohérente une fois calé, et les mains en nombre différent', () => {
    resetFit()
    let cal = start
    for (let i = 0; i < 30; i++) { const pts = handAt(walk(i)); cal = calibrate([{ pts, full: true }], [seen(pts)], cal) ?? cal }
    const pts = handAt([0, 300, 0])
    expect(calibrate([{ pts, full: true }], [seen(pts).map((m) => ({ x: m.x + 0.4, y: m.y - 0.3 }))], cal)).toBeNull()
    expect(calibrate([{ pts, full: true }], [], cal)).toBeNull()
    expect(calibrate([{ pts, full: true }], [seen(pts), seen(pts)], cal)).toBeNull()
  })

  it('mal parti (la caméra voyait une autre main) : se reprend tout seul', () => {
    resetFit()
    let cal = start
    for (let i = 0; i < 10; i++) { const pts = handAt(walk(i)), other = handAt([-walk(i)[0], 500 - walk(i)[1], 60]); cal = calibrate([{ pts, full: true }], [seen(other)], cal) ?? cal }
    for (let i = 0; i < 110; i++) { const pts = handAt(walk(i)); cal = calibrate([{ pts, full: true }], [seen(pts)], cal) ?? cal }
    expect(errOf(cal, handAt([0, 300, 0]))).toBeLessThan(0.01)
  })

  it('la main convertie tombe sur l\'image une fois calée', () => {
    resetFit()
    let cal = start
    for (let i = 0; i < 80; i++) { const pts = handAt(walk(i)); cal = calibrate([{ pts, full: true }], [seen(pts)], cal) ?? cal }
    const f = (frames as any[]).find((x) => x.hands.length)
    const lm = convertFrame(f, { ...S, cal }, A).landmarks[0], palm = f.hands[0].palmPosition, tip = f.pointables.find((q: any) => q.handId === f.hands[0].id && q.type === 1).tipPosition
    const e = exact({ x: tip[0], y: tip[1], z: tip[2] })
    expect(Math.hypot(lm[8].x - e.x, lm[8].y - e.y)).toBeLessThan(0.01)   // bout de l'index
    expect(palm).toHaveLength(3)
  })
})

// Bout en bout : le service Leap envoie des trames, la webcam (simulée, penchée) voit la même
// main ; `pollHands` doit caler tout seul et rendre des jalons posés sur l'image.
describe('Leap : calage automatique pendant le suivi', () => {
  it('cale la projection en regardant la webcam, puis l\'enregistre', async () => {
    const { connectLeap, turnLeapOff, setLeapSettings, leapSettings } = await import('./Leap')
    const A = 16 / 9, C = { x: -30, y: 470, z: -420 }, F = 0.65, pitch = 18 * Math.PI / 180
    const exact = (p: number[]) => { const x = p[0] - C.x, y = p[1] - C.y, z = p[2] - C.z, y2 = y * Math.cos(pitch) + z * Math.sin(pitch), z2 = -y * Math.sin(pitch) + z * Math.cos(pitch); return { x: 0.5 - F * x / z2, y: 0.5 - F * A * y2 / z2 } }
    // main à plat, doigts vers l'écran : poignet + 5 doigts × 4 articulations
    const handPts = (c: number[]) => [[c[0], c[1], c[2] + 70], ...[-60, -25, 0, 22, 42].flatMap((dx, i) => [20, -15, -45, -70].map((dz, j) => [c[0] + dx * (0.5 + j / 6), c[1] + (i === 0 ? -10 : j * 4), c[2] + dz * (i === 0 ? 0.6 : 1)]))]
    const frame = (pts: number[][], c: number[]) => ({ hands: [{ id: 1, type: 'right', palmPosition: c, palmNormal: [0, -1, 0], direction: [0, 0, -1], wrist: pts[0], pinchStrength: 0, grabStrength: 0 }],
      pointables: [0, 1, 2, 3, 4].map((i) => { const q = pts.slice(1 + i * 4, 5 + i * 4); return { id: 10 + i, handId: 1, type: i, extended: true, carpPosition: pts[0], mcpPosition: q[0], pipPosition: q[1], dipPosition: q[2], btipPosition: q[3], tipPosition: q[3] } }) })

    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let sock: any = null
    vi.stubGlobal('WebSocket', class { onopen: any; onmessage: any; onclose: any; onerror: any; constructor() { sock = this } send() {} close() {} })
    setLeapSettings({ ...LEAP_DEFAULTS, autoCal: true })
    const ready = connectLeap()
    sock.onopen?.(); sock.onmessage({ data: JSON.stringify({ version: 6 }) })
    expect(await ready).toBe(true)

    let cur: number[][] = []
    const video = { readyState: 4, currentTime: 0, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement
    const model = { recognizeForVideo: () => ({ landmarks: [cur.map(exact)], gestures: [] }) }
    const clock = handClock()
    let res: any = null, first = -1
    const errOf = (lm: { x: number; y: number }[]) => lm.reduce((e, m, i) => { const t = exact(cur[i]); return e + Math.hypot(m.x - t.x, m.y - t.y) }, 0) / lm.length
    for (let i = 0; i < 90; i++) {
      now += 200; (video as any).currentTime += 0.2
      const c = [Math.sin(i * 0.09) * 180, 260 + Math.cos(i * 0.07) * 110, Math.sin(i * 0.05) * 110]   // ~20 mm par trame : main lente
      cur = handPts(c)
      sock.onmessage({ data: JSON.stringify(frame(cur, c)) })
      res = pollHands(video, model, clock)
      if (i === 0) first = errOf(convertFrame(frame(cur, c), LEAP_DEFAULTS, A).landmarks[0])   // la même trame, sans calage
    }
    expect(first).toBeGreaterThan(0.05)                      // sans calage : à côté de l'image
    expect(errOf(res.landmarks[0])).toBeLessThan(0.01)       // après : posé dessus
    expect(res.leap[0].palmMm.y).toBeGreaterThan(100)        // les millimètres du capteur restent inchangés
    const saved = JSON.parse(localStorage.getItem('digiart:leap')!)
    expect(saved.cal).toHaveLength(11)
    expect(leapSettings().cal).toHaveLength(11)
    turnLeapOff(); setLeapSettings({ ...LEAP_DEFAULTS }); vi.unstubAllGlobals()
  })
})
