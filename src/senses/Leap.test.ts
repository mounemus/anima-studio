import { describe, it, expect } from 'vitest'
import frames from './__fixtures__/leap-orion.json'
import { convertFrame, LEAP_DEFAULTS, pollHands, handClock } from './Leap'

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
    const up = convertFrame(hand('right', [0, 300, 0], [[0, 300, 0], [0, 300, 0], [0, 300, 0], [0, 300, 0], [0, 300, 0]]), S).landmarks[0]
    expect(up[0].y).toBeLessThan(0.5)
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
