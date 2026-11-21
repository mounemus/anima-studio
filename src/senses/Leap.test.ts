import { describe, it, expect, vi } from 'vitest'
import frames from './__fixtures__/leap-orion.json'
import { convertFrame, LEAP_DEFAULTS, pollHands, handClock, calibrate, project, priorCal, resetFit, fitState, isPinching, type LeapCal, type V3 } from './Leap'

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
        expect(hs(r.landmarks[i])).toBeGreaterThan(0.02)
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
        if (h.pinchStrength >= 0.95 && h.grabStrength < 0.5) expect(r.leap![i].pinch).toBeGreaterThan(0.75)   // au-dessus du seuil de fermeture
        if (h.pinchStrength <= 0.05 && h.grabStrength < 0.5) expect(r.leap![i].pinch).toBeLessThan(0.3)          // sous le seuil d'ouverture
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

// Calage sur la webcam. Conditions réalistes : main ouverte presque plane (le cas le plus dur
// pour retrouver une caméra), les deux capteurs ne placent pas un jalon exactement au même
// endroit, la détection de la webcam est bruitée, et une partie des mesures est fausse.
describe('Leap : calage sur la webcam', () => {
  const A = 16 / 9
  let seed = 3
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
  const gauss = () => (rnd() + rnd() + rnd() + rnd()) * 1.7
  // main ouverte, paume vers la caméra, doigts vers le haut (mm, repère de la main)
  const SHAPE = [[0, -80, 10], [-35, -55, 0], [-60, -30, -5], [-78, -8, -8], [-90, 12, -10], [-28, 5, 0], [-32, 45, -3], [-34, 72, -5], [-35, 95, -6], [-5, 10, 0], [-5, 55, -3], [-5, 85, -5], [-5, 110, -6], [16, 5, 0], [18, 48, -3], [19, 76, -5], [20, 98, -6], [36, -5, 0], [42, 30, -3], [45, 52, -5], [47, 70, -6]]
  const handAt = (c: number[]): V3[] => {
    const a = rnd() * 0.25, b = rnd() * 0.25, g = rnd() * 0.5
    return SHAPE.map(([x, y, z]) => {
      const x1 = x * Math.cos(g) - y * Math.sin(g), y1 = x * Math.sin(g) + y * Math.cos(g)
      const y2 = y1 * Math.cos(a) - z * Math.sin(a), z2 = y1 * Math.sin(a) + z * Math.cos(a)
      return { x: c[0] + x1 * Math.cos(b) + z2 * Math.sin(b), y: c[1] + y2, z: c[2] - x1 * Math.sin(b) + z2 * Math.cos(b) }
    })
  }
  const BIAS = SHAPE.map(() => [gauss() * 6, gauss() * 6, gauss() * 6])
  const CAMS: [string, LeapCal][] = [
    ['portable : au-dessus du capteur, penchée vers le bas', { cx: 20, cy: 330, cz: -260, f: 0.72, pitch: 0.2, yaw: 0.05 }],
    ['écran externe : haute et loin', { cx: -80, cy: 520, cz: -520, f: 0.62, pitch: 0.35, yaw: -0.1 }],
    ['webcam basse à grand angle', { cx: 60, cy: 120, cz: -180, f: 0.55, pitch: -0.15, yaw: 0.12 }],
  ]
  const PROBES = [[-200, 200, 100], [0, 300, 200], [200, 400, 300], [150, 220, 60], [-120, 420, 260]]
  const prior = priorCal(LEAP_DEFAULTS)
  const walk = (i: number) => [Math.sin(i * 0.7) * 200, 300 + Math.cos(i * 0.4) * 110, 190 + Math.sin(i * 0.23) * 120]
  const lab = (T: LeapCal) => ({
    seen: (pts: V3[]) => pts.map((q, i) => { const m = project({ x: q.x + BIAS[i][0], y: q.y + BIAS[i][1], z: q.z + BIAS[i][2] }, T, A); return { x: m.x + gauss() * 0.01, y: m.y + gauss() * 0.01 * A } }),
    errAt: (cal: LeapCal, c: number[]) => { const pts = handAt(c); return pts.reduce((e, q) => { const a = project(q, cal, A), b = project(q, T, A); return e + Math.hypot(a.x - b.x, (a.y - b.y) / A) }, 0) / pts.length },
  })

  for (const [name, T] of CAMS) {
    const { seen, errAt } = lab(T)

    it(`${name} : la caméra par défaut est loin de la vraie`, () => {
      expect(Math.max(...PROBES.map((c) => errAt(prior, c)))).toBeGreaterThan(0.2)
    })

    it(`${name} : une seule mesure pose la main du Leap sur l'image, sans rien casser ailleurs`, () => {
      resetFit()
      const c = [120, 310, 200], pts = handAt(c)
      const cal = calibrate([{ pts, full: true }], [seen(pts)], prior, prior, A, 0)!
      expect(errAt(cal, c)).toBeLessThan(0.025)
      expect(Math.max(...PROBES.map((q) => errAt(cal, q)))).toBeLessThan(0.2)
    })

    it(`${name} : main qui se promène, 30 % de fausses mesures : juste partout`, () => {
      resetFit()
      let cal = prior, worst = 0
      for (let i = 0; i < 60; i++) {
        const c = walk(i), pts = handAt(c), kind = rnd()
        // fausses mesures : l'autre main (pose miroir, de l'autre côté), ou une détection au hasard
        const cam = kind > 0.35 ? seen(pts.map((q) => ({ x: -q.x, y: q.y + 40, z: q.z }))) : kind > 0.2 ? pts.map(() => ({ x: 0.5 + rnd() * 0.3, y: 0.5 + rnd() * 0.3 })) : seen(pts)
        cal = calibrate([{ pts, full: true }], [cam], cal, prior, A, i * 200) ?? cal
        if (i >= 15) worst = Math.max(worst, ...PROBES.map((q) => errAt(cal, q)))
      }
      expect(Math.max(...PROBES.map((q) => errAt(cal, q)))).toBeLessThan(0.015)
      expect(worst).toBeLessThan(0.05)                       // jamais de dérapage en cours de route
      expect(cal.f).toBeGreaterThan(0.4); expect(cal.cz).toBeLessThan(-60)   // toujours une vraie caméra, devant l'utilisateur
    })
  }

  const [, T] = CAMS[0], { seen, errAt } = lab(T)

  it('main immobile : calée sur place dès la première seconde, stable ensuite', () => {
    resetFit()
    const c = [-80, 280, 160], pts = handAt(c)
    let cal = prior
    for (let i = 0; i < 40; i++) { cal = calibrate([{ pts, full: true }], [seen(pts)], cal, prior, A, i * 200) ?? cal; if (i >= 4) expect(errAt(cal, c)).toBeLessThan(0.02) }
    expect(fitState().n).toBe(1)                             // une seule zone visitée
  })

  it('sans articulations (pont) : poignet et bouts des doigts suffisent', () => {
    resetFit()
    let cal = prior
    for (let i = 0; i < 40; i++) { const pts = handAt(walk(i)); cal = calibrate([{ pts, full: false }], [seen(pts)], cal, prior, A, i * 200) ?? cal }
    expect(Math.max(...PROBES.map((q) => errAt(cal, q)))).toBeLessThan(0.02)
  })

  it('deux mains à la fois : appariées par leur côté', () => {
    resetFit()
    let cal = prior
    for (let i = 0; i < 30; i++) {
      const l = handAt([-170 + Math.sin(i) * 40, 280 + Math.cos(i * 0.5) * 80, 180 + Math.sin(i * 0.3) * 90]), r = handAt([170 + Math.cos(i) * 40, 320, 200 + Math.cos(i * 0.3) * 90])
      cal = calibrate([{ pts: l, full: true }, { pts: r, full: true }], [seen(l), seen(r)], cal, prior, A, i * 200) ?? cal
    }
    expect(Math.max(...PROBES.map((q) => errAt(cal, q)))).toBeLessThan(0.02)
  })

  it('écarte l\'autre main, les mains en nombre différent, et une mesure loin d\'un calage acquis', () => {
    resetFit()
    const pts = handAt([100, 300, 200])
    expect(calibrate([{ pts, full: true }], [seen(pts.map((q) => ({ x: -q.x, y: q.y, z: q.z })))], prior, prior, A, 0)).toBeNull()   // main miroir
    expect(calibrate([{ pts, full: true }], [], prior, prior, A, 0)).toBeNull()
    expect(calibrate([{ pts, full: true }], [seen(pts), seen(pts)], prior, prior, A, 0)).toBeNull()
    let cal = prior
    for (let i = 0; i < 20; i++) { const h = handAt(walk(i)); cal = calibrate([{ pts: h, full: true }], [seen(h)], cal, prior, A, i * 200) ?? cal }
    expect(calibrate([{ pts, full: true }], [seen(pts).map((m) => ({ x: m.x + 0.3, y: m.y - 0.25 }))], cal, prior, A, 5000)).toBeNull()
  })

  it('capteur ou écran déplacé : oublie l\'ancien calage et se refait', () => {
    resetFit()
    let cal = prior
    for (let i = 0; i < 20; i++) { const h = handAt(walk(i)); cal = calibrate([{ pts: h, full: true }], [seen(h)], cal, prior, A, i * 200) ?? cal }
    const moved = lab({ ...T, cx: T.cx + 260, cy: T.cy - 150 })
    for (let i = 0; i < 70; i++) { const h = handAt(walk(i)); cal = calibrate([{ pts: h, full: true }], [moved.seen(h)], cal, prior, A, 4000 + i * 200) ?? cal }
    expect(Math.max(...PROBES.map((q) => moved.errAt(cal, q)))).toBeLessThan(0.02)
  })
})

// Bout en bout : le service Leap envoie des trames, la webcam (simulée, penchée) voit la même
// main ; `pollHands` doit caler tout seul et rendre des jalons posés sur l'image.
describe('Leap : calage automatique pendant le suivi', () => {
  it('cale la projection en regardant la webcam, puis l\'enregistre', async () => {
    const { connectLeap, turnLeapOff, setLeapSettings, leapSettings } = await import('./Leap')
    const A = 16 / 9, T: LeapCal = { cx: -30, cy: 400, cz: -300, f: 0.65, pitch: 0.3, yaw: 0.06 }
    const exact = (q: number[]) => project({ x: q[0], y: q[1], z: q[2] }, T, A)
    // main ouverte dressée face à la caméra : poignet + 5 doigts × 4 articulations
    const handPts = (c: number[]) => [[c[0], c[1] - 80, c[2] + 10], ...[[-60, -20, 0.55], [-30, 95, 1], [-5, 110, 1], [20, 98, 1], [47, 70, 1]].flatMap(([dx, len, k]) => [0.05, 0.45, 0.75, 1].map((t) => [c[0] + dx * (0.5 + t / 2), c[1] + len * t * k - (k < 1 ? 30 : 0), c[2] - 6 * t]))]
    const frame = (pts: number[][], c: number[], v = 20) => ({ hands: [{ id: 1, type: 'right', palmPosition: c, palmVelocity: [v, 0, 0], palmNormal: [0, 0, -1], direction: [0, 1, 0], wrist: pts[0], pinchStrength: 0, grabStrength: 0 }],
      pointables: [0, 1, 2, 3, 4].map((i) => { const q = pts.slice(1 + i * 4, 5 + i * 4); return { id: 10 + i, handId: 1, type: i, extended: true, carpPosition: pts[0], mcpPosition: q[0], pipPosition: q[1], dipPosition: q[2], btipPosition: q[3], tipPosition: q[3] } }) })

    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let sock: any = null
    vi.stubGlobal('WebSocket', class { onopen: any; onmessage: any; onclose: any; onerror: any; constructor() { sock = this } send() {} close() {} })
    setLeapSettings({ ...LEAP_DEFAULTS, autoCal: true })
    const ready = connectLeap()
    sock.onopen?.(); sock.onmessage({ data: JSON.stringify({ version: 6 }) })
    expect(await ready).toBe(true)

    let cur: number[][] = [], calls = 0
    const video = { readyState: 4, currentTime: 0, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement
    const model = { recognizeForVideo: () => { calls++; return { landmarks: [cur.map(exact)], gestures: [] } } }
    const clock = handClock()
    let res: any = null, first = -1
    const errOf = (lm: { x: number; y: number }[]) => lm.reduce((e, m, i) => { const t = exact(cur[i]); return e + Math.hypot(m.x - t.x, m.y - t.y) }, 0) / lm.length
    const step = (c: number[], v?: number) => { now += 200; (video as any).currentTime += 0.2; cur = handPts(c); sock.onmessage({ data: JSON.stringify(frame(cur, c, v)) }); res = pollHands(video, model, clock) }

    step([0, 300, 180], 900)                                 // main rapide : la webcam est en retard, pas de mesure
    expect(calls).toBe(0)
    first = errOf(res.landmarks[0])
    expect(first).toBeGreaterThan(0.05)                      // sans calage : à côté de l'image
    for (let i = 0; i < 40; i++) step([Math.sin(i * 0.3) * 160, 300 + Math.cos(i * 0.2) * 90, 180 + Math.sin(i * 0.17) * 90])
    expect(errOf(res.landmarks[0])).toBeLessThan(0.01)       // calé : posé dessus
    expect(res.leap[0].palmMm.y).toBeGreaterThan(100)        // les millimètres du capteur restent inchangés
    const saved = JSON.parse(localStorage.getItem('digiart:leap')!)
    expect(Object.keys(saved.cal).sort()).toEqual(['cx', 'cy', 'cz', 'f', 'pitch', 'yaw'])
    expect(leapSettings().cal!.f).toBeGreaterThan(0.4)
    turnLeapOff(); setLeapSettings({ ...LEAP_DEFAULTS }); vi.unstubAllGlobals()
  })

  it('un calage enregistré par une ancienne version est ignoré', async () => {
    localStorage.setItem('digiart:leap', JSON.stringify({ span: 600, cal: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }))
    vi.resetModules()
    const fresh = await import('./Leap')
    expect(fresh.leapSettings().cal).toBeNull()
    expect(fresh.leapSettings().span).toBe(600)
    localStorage.removeItem('digiart:leap')
  })
})

// Pince à la caméra. Les valeurs viennent d'un enregistrement réel : vraies pinces (signe « OK »)
// à 33-39 mm en 3D avec l'index déplié ; poings près du visage avec l'index replié.
describe('pince : caméra et Leap', () => {
  const STRAIGHT = [[0, 0, 0], [0, 0.04, 0], [0, 0.065, 0], [0, 0.085, 0]], CURLED = [[0, 0, 0], [0, 0.04, 0], [0, 0.04, -0.025], [0, 0.02, -0.03]]
  /** Main vue de face : doigts tendus ou repliés, bout du pouce placé à `thumb` (m) du bout de l'index. */
  const camHand = (curled: boolean[], thumb: number[], gesture = 'None') => {
    const w: V3[] = [{ x: 0, y: -0.09, z: 0 }, { x: -0.03, y: -0.06, z: 0 }, { x: -0.045, y: -0.03, z: 0 }, { x: -0.05, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
    ;[-0.025, 0, 0.022, 0.042].forEach((x, f) => (curled[f] ? CURLED : STRAIGHT).forEach(([dx, dy, dz]) => w.push({ x: x + dx, y: dy, z: dz })))
    w[4] = { x: w[8].x + thumb[0], y: w[8].y + thumb[1], z: w[8].z + thumb[2] }
    return { landmarks: [w.map((q) => ({ x: 0.5 + q.x * 2, y: 0.5 - q.y * 2, z: q.z }))], worldLandmarks: [w], gestures: [[{ categoryName: gesture, score: 0.9 }]] }
  }
  const OPEN = [false, false, false, false], FIST = [true, true, true, true]

  it('vraie pince, doigts tendus (signe « OK ») : 35 mm en 3D suffisent', () => {
    expect(isPinching(camHand(OPEN, [0.01, 0, 0.033]), 0, false)).toBe(true)
  })
  it('main ouverte : pas de pince, même si la caméra classe la main « paume ouverte » avec le pouce près', () => {
    expect(isPinching(camHand(OPEN, [-0.07, -0.04, 0]), 0, false)).toBe(false)
    expect(isPinching(camHand(OPEN, [0.01, 0, 0.02], 'Open_Palm'), 0, false)).toBe(false)
  })
  it('poing (index replié, pouce posé dessus) : pas de pince', () => {
    expect(isPinching(camHand(FIST, [0.01, 0, 0.03]), 0, false)).toBe(false)
    expect(isPinching(camHand(FIST, [0.005, 0, 0.01], 'Closed_Fist'), 0, false)).toBe(false)
  })
  it('index tendu mais les trois autres doigts repliés : il faut vraiment serrer', () => {
    expect(isPinching(camHand([false, true, true, true], [0.01, 0, 0.027]), 0, false)).toBe(false)   // presque-poing
    expect(isPinching(camHand([false, true, true, true], [0.005, 0, 0.014]), 0, false)).toBe(true)   // pince « porte-plume »
  })
  it('hystérésis : une pince fermée tient jusqu\'à ce qu\'on rouvre franchement', () => {
    const loose = camHand(OPEN, [0.03, 0.02, 0.035])   // ~50 mm
    expect(isPinching(loose, 0, false)).toBe(false)
    expect(isPinching(loose, 0, true)).toBe(true)
    expect(isPinching(camHand(OPEN, [-0.07, -0.04, 0]), 0, true)).toBe(false)
  })
  it('sans jalons 3D : retombe sur l\'écart à l\'écran', () => {
    const h = camHand(OPEN, [0.01, 0, 0.033]); delete (h as any).worldLandmarks
    expect(isPinching(h, 0, false)).toBe(true)
  })
  it('Leap : distance réelle des bouts des doigts, avec hystérésis', () => {
    const leap = (pinch: number, g = 'None') => ({ ...camHand(OPEN, [-0.07, -0.04, 0], g), leap: [{ pinch } as any] })
    expect(isPinching(leap(0.9), 0, false)).toBe(true)
    expect(isPinching(leap(0.5), 0, false)).toBe(false)
    expect(isPinching(leap(0.5), 0, true)).toBe(true)
    expect(isPinching(leap(0.2), 0, true)).toBe(false)
    expect(isPinching(leap(1, 'Closed_Fist'), 0, false)).toBe(false)
  })
})
