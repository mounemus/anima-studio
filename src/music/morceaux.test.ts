// Les morceaux tout faits (public/morceaux, écrits par scripts/morceaux.mjs) : chaque corde doit sonner la note
// prévue avec le vrai accordage, et un manège simulé doit les jouer dans l'ordre et au bon moment.
import { describe, it, expect } from 'vitest'
import { SCALES, stringMidi, sweep, inTri, sweepPoint, type P2 } from './theory'
import { TIMBRES, type Timbre } from './synth'

const all = import.meta.glob('../../public/morceaux/*.json', { eager: true, import: 'default' }) as Record<string, any>
const byName = Object.fromEntries(Object.entries(all).map(([path, data]) => [path.split('/').pop()!, data]))
const files = Object.keys(byName).filter((f) => f !== 'index.json')
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1])

describe('lutherie : balayage du manège', () => {
  const c: P2 = [0, 0], p: P2 = [1, 0], q: P2 = [0.9, 0.3]
  it('attrape une corde fine que le rayon a sautée entre deux images', () => {
    expect(sweep(c, p, q, [0.5, 0.05], [0.55, 0.1])).not.toBeNull()      // entièrement dans le secteur
    expect(sweep(c, p, q, [0.5, -0.1], [0.5, 0.05])).toBeCloseTo(2 / 3)   // traverse l'ancien rayon
    expect(sweep(c, p, q, [0.5, 0.4], [0.6, 0.5])).toBeNull()            // pas encore atteinte
    expect(sweep(c, p, p, [0.5, 0.05], [0.55, 0.1])).toBeNull()          // rayon immobile : pas de secteur
  })
  it('même chose pour le centre d\'un tambour', () => {
    expect(inTri([0.5, 0.05], c, p, q)).toBe(true)
    expect(sweepPoint(c, p, q, [0.5, 0.05], 0.018)).toBe(true)
    expect(sweepPoint(c, p, q, [0.5, 0.4], 0.018)).toBe(false)
  })
})

describe('lutherie : morceaux tout faits', () => {
  it('la liste et les fichiers se correspondent', () => {
    const index = byName['index.json'] as { id: string; title: string }[]
    expect(index.map((m) => m.id + '.json').sort()).toEqual([...files].sort())
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  for (const name of files) {
    it(`${name} : notes justes, jouées dans l'ordre et en mesure`, () => {
      const f = byName[name]
      const { scale, root, bpm, turn } = f.settings
      expect(SCALES[scale]).toBeTruthy(); expect(bpm).toBeGreaterThanOrEqual(40); expect(bpm).toBeLessThanOrEqual(180)
      const steps = SCALES[scale].steps
      const wheel = f.things.find((t: any) => t.kind === 'wheel'), strings = f.things.filter((t: any) => t.kind === 'string')
      expect(strings.length).toBeGreaterThan(10)
      for (const s of strings) {
        expect(stringMidi(dist(s.a, s.b), root, steps, TIMBRES[s.timbre as Timbre].octave), `${s.id} (${s.midi})`).toBe(s.midi)
        for (const q of [s.a, s.b]) { expect(q[0]).toBeGreaterThan(0.3); expect(q[0]).toBeLessThan(0.9); expect(q[1]).toBeGreaterThan(0); expect(q[1]).toBeLessThan(0.53) }   // tient à droite du panneau, sur un écran 16:9
      }
      // deux tours de manège à 30 images par seconde, avec la même règle que l'atelier (une note quand le secteur balayé
      // atteint la corde) ; le premier tour met le manège en route, on écoute le second
      const r = dist(wheel.a, wheel.b), phase = Math.atan2(wheel.b[1] - wheel.a[1], wheel.b[0] - wheel.a[0]), step = bpm / 60 / 30
      const spot = (b: number): P2 => { const g = phase + b / turn * Math.PI * 2; return [wheel.a[0] + Math.cos(g) * r, wheel.a[1] + Math.sin(g) * r] }
      const touching = new Set<string>(), played = new Map<string, number>()
      for (let beat = step / 2; beat < 2 * turn; beat += step) {
        const from = spot(beat - step), tip = spot(beat)
        for (const s of strings) {
          const on = sweep(wheel.a, from, tip, s.a, s.b) !== null
          if (on && !touching.has(s.id)) { touching.add(s.id); if (beat >= turn) { expect(played.has(s.id), `${s.id} jouée deux fois`).toBe(false); played.set(s.id, beat - turn) } }
          else if (!on) touching.delete(s.id)
        }
      }
      for (const s of strings) {
        const at = played.get(s.id)
        expect(at, `${s.id} jamais jouée`).toBeDefined()
        expect(at! - s.beat, `${s.id} à ${at}, attendue à ${s.beat}`).toBeGreaterThan(-1e-3)
        expect(at! - s.beat).toBeLessThan(step + 1e-3)                                  // au plus une image de retard
      }
    })
  }
})
