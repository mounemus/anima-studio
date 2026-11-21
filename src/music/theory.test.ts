import { describe, it, expect } from 'vitest'
import { SCALES, snap, stringMidi, frets, frettedMidi, cross, nearest, drumVoice, bellMidi, karplus, noteName, midiToHz, hzToMidi, REF_LEN } from './theory'

const PENTA = SCALES.penta.steps, MAJOR = SCALES.major.steps

describe('lutherie : gammes et accordage', () => {
  it('nomme les notes à la française', () => {
    expect(noteName(60)).toBe('Do4'); expect(noteName(69)).toBe('La4'); expect(noteName(46)).toBe('Si♭2')
    expect(midiToHz(69)).toBeCloseTo(440); expect(hzToMidi(220)).toBeCloseTo(57)
  })

  it('accorde sur la note de la gamme la plus proche, dans toutes les octaves', () => {
    expect(snap(61, 0, MAJOR)).toBe(60)        // Do♯ → Do (ou Ré : à égale distance, le premier trouvé)
    expect(snap(66.4, 0, MAJOR)).toBe(67)      // entre Fa♯ et Sol → Sol
    expect(snap(35.8, 0, MAJOR)).toBe(36)
    expect(snap(63.4, 9, PENTA)).toBe(64)      // La mineur pentatonique (La Do Ré Mi Sol) : un peu au-dessus de Mi♭ → Mi
    for (let m = 30; m < 90; m += 0.37) expect(PENTA).toContain(((snap(m, 2, PENTA) - 2) % 12 + 12) % 12)
  })

  it('corde deux fois plus courte = une octave plus haut', () => {
    const open = stringMidi(REF_LEN, 0, MAJOR)
    expect(noteName(open)).toBe('Do3')
    expect(stringMidi(REF_LEN / 2, 0, MAJOR)).toBe(open + 12)
    expect(stringMidi(REF_LEN * 2, 0, MAJOR)).toBe(open - 12)
    expect(stringMidi(REF_LEN, 0, MAJOR, -1)).toBe(open - 12)   // voix de basse
    expect(stringMidi(0.2, 0, MAJOR)).toBeGreaterThan(stringMidi(0.4, 0, MAJOR))
  })

  it('frettes : aux notes de la gamme, l\'octave au milieu de la corde', () => {
    const open = 48, list = frets(open, 0, MAJOR)
    expect(list.map((f) => f.midi - open).slice(0, 7)).toEqual([2, 4, 5, 7, 9, 11, 12])
    expect(list.find((f) => f.midi === open + 12)!.t).toBeCloseTo(0.5, 6)
    expect(list.find((f) => f.midi === open + 7)!.t).toBeCloseTo(1 - 2 ** (-7 / 12), 6)   // la quinte, au tiers
    for (let i = 1; i < list.length; i++) expect(list[i].t).toBeGreaterThan(list[i - 1].t)
  })

  it('bloquer la corde donne la note de la frette la plus proche', () => {
    const open = 48, list = frets(open, 0, MAJOR)
    expect(frettedMidi(open, list, 0.5)).toBe(60)
    expect(frettedMidi(open, list, 0.01)).toBe(open)     // tout près du sillet : corde à vide
    expect(frettedMidi(open, list, 0.34)).toBe(55)       // près du tiers : la quinte
  })
})

describe('lutherie : géométrie du jeu', () => {
  it('un doigt qui traverse une corde la pince, à l\'endroit du croisement', () => {
    expect(cross([0.5, -1], [0.5, 1], [0, 0], [2, 0])).toBeCloseTo(0.25)
    expect(cross([0.5, 0.1], [0.5, 1], [0, 0], [2, 0])).toBeNull()      // s'arrête avant la corde
    expect(cross([3, -1], [3, 1], [0, 0], [2, 0])).toBeNull()           // passe à côté
    expect(cross([0, 1], [2, 1], [0, 0], [2, 0])).toBeNull()            // parallèle
  })
  it('distance d\'un point à une corde', () => {
    const n = nearest([1, 0.3], [0, 0], [2, 0])
    expect(n.d).toBeCloseTo(0.3); expect(n.t).toBeCloseTo(0.5)
    expect(nearest([-1, 0], [0, 0], [2, 0]).t).toBe(0)
  })
  it('tambours et clochettes : la taille et la hauteur décident de la voix', () => {
    expect(drumVoice(0.15).kind).toBe('kick'); expect(drumVoice(0.07).kind).toBe('tom'); expect(drumVoice(0.03).kind).toBe('hat')
    expect(drumVoice(0.15).hz).toBeLessThan(drumVoice(0.07).hz)
    expect(bellMidi(0.1, 0, PENTA)).toBeGreaterThan(bellMidi(0.9, 0, PENTA))
  })
})

describe('lutherie : son de corde pincée', () => {
  const SR = 44100
  /** Période dominante par autocorrélation, en échantillons. */
  const periodOf = (x: Float32Array, guess: number) => {
    let best = 0, bestLag = 0
    for (let lag = Math.floor(guess * 0.8); lag <= Math.ceil(guess * 1.25); lag++) {
      let s = 0
      for (let i = 2000; i < 12000; i++) s += x[i] * x[i + lag]
      if (s > best) { best = s; bestLag = lag }
    }
    return bestLag
  }
  const rms = (x: Float32Array, a: number, b: number) => Math.sqrt(x.slice(a, b).reduce((e, v) => e + v * v, 0) / (b - a))

  it('sonne à la bonne hauteur, du grave à l\'aigu', () => {
    for (const hz of [82.4, 130.8, 220, 440, 659.3]) {
      const x = karplus(SR, hz, 1, { bright: 0.7, pick: 0.25, sustain: 2 })
      const cents = 1200 * Math.log2((SR / periodOf(x, SR / hz)) / hz)
      expect(Math.abs(cents)).toBeLessThan(25)       // la période se mesure à l'échantillon près
    }
  })
  it('s\'éteint peu à peu, plus vite si la tenue est courte, sans saturer ni claquer à la fin', () => {
    const long = karplus(SR, 220, 2, { bright: 0.7, pick: 0.25, sustain: 3 }), short = karplus(SR, 220, 2, { bright: 0.7, pick: 0.25, sustain: 0.6 })
    expect(rms(long, 0, 4410)).toBeGreaterThan(rms(long, 60000, 64410) * 2)
    expect(rms(short, 40000, 44410)).toBeLessThan(rms(long, 40000, 44410) * 0.3)
    expect(Math.max(...long.map(Math.abs))).toBeLessThanOrEqual(0.9001)
    expect(Math.abs(long[long.length - 1])).toBeLessThan(0.01)
    expect(long.every(Number.isFinite)).toBe(true)
  })
  it('une attaque brillante contient plus d\'aigus qu\'une attaque douce', () => {
    const hf = (x: Float32Array) => { let e = 0; for (let i = 1; i < 4410; i++) e += (x[i] - x[i - 1]) ** 2; return e }
    expect(hf(karplus(SR, 220, 0.5, { bright: 0.9, pick: 0.25, sustain: 2 }))).toBeGreaterThan(hf(karplus(SR, 220, 0.5, { bright: 0.2, pick: 0.25, sustain: 2 })) * 2)
  })
})
