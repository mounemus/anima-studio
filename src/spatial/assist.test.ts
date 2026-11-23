import { describe, it, expect } from 'vitest'
import { recognize, dehook, fitPlane, resample, pathLen, snapEnds, handScale, depthFromScale, deadzone, dist3 } from './assist'
import type { P3 } from './build'

// bruit reproductible : une main qui tremble de `amp` dans les trois directions
const rng = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1 }
const shaky = (pts: P3[], amp: number, seed = 7, depth = 1): P3[] => { const r = rng(seed); return pts.map((q) => [q[0] + r() * amp, q[1] + r() * amp, q[2] + r() * amp * depth]) }
const lineTo = (a: P3, b: P3, n: number): P3[] => Array.from({ length: n }, (_, i) => a.map((v, k) => v + (b[k] - v) * i / (n - 1)) as P3)
const arcOf = (c: P3, r: number, from: number, to: number, n: number): P3[] => Array.from({ length: n }, (_, i) => { const a = (from + (to - from) * i / (n - 1)) * Math.PI / 180; return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]] as P3 })
const poly = (corners: P3[], per: number): P3[] => corners.slice(1).flatMap((q, i) => lineTo(corners[i], q, per).slice(i ? 1 : 0))

describe('assistant : reconnaître ce que le trait veut être', () => {
  it('une droite tremblée devient une droite, posée sur l\'axe quand elle en est proche', () => {
    const g = recognize(shaky(lineTo([0, 0, 0], [1, 0.04, 0.02], 40), 0.012))
    expect(g.kind).toBe('line'); expect(g.pts).toHaveLength(2)
    expect(g.pts[0][1]).toBeCloseTo(g.pts[1][1], 9); expect(g.pts[0][2]).toBeCloseTo(g.pts[1][2], 9)      // 2,6° de l'axe x : horizontale exacte
    expect(dist3(g.pts[0], g.pts[1])).toBeGreaterThan(0.95)
    const oblique = recognize(shaky(lineTo([0, 0, 0], [0.7, 0.6, 0], 40), 0.01))
    expect(oblique.kind).toBe('line'); expect(oblique.pts[1][1] - oblique.pts[0][1]).toBeGreaterThan(0.5)    // une vraie oblique le reste
  })

  it('un cercle tremblé, un peu dépassé, avec du bruit en profondeur, devient un cercle plat et fermé', () => {
    const g = recognize(shaky(arcOf([0.2, 0.1, 0], 0.5, 20, 395, 90), 0.018, 3, 1.5))
    expect(g.kind).toBe('circle'); expect(g.closed).toBe(true)
    const pl = fitPlane(g.pts), radii = g.pts.map((q) => dist3(q, [0.2, 0.1, q[2]]))
    expect(pl.s[2]).toBeLessThan(1e-9)                                           // parfaitement plat
    expect(Math.abs(pl.n[2])).toBeCloseTo(1, 9)                                  // et pile sur le plan de face
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.03); expect(radii[0]).toBeGreaterThan(0.47); expect(radii[0]).toBeLessThan(0.53)
    expect(dist3(g.pts[0], g.pts[g.pts.length - 1])).toBeLessThan(1e-9)
  })

  it('un arc reste un arc, de la bonne ouverture', () => {
    const g = recognize(shaky(arcOf([0, 0, 0], 0.6, 10, 140, 50), 0.008))
    expect(g.kind).toBe('arc'); expect(g.closed).toBe(false)
    for (const q of g.pts) expect(Math.abs(Math.hypot(q[0], q[1]) - 0.6)).toBeLessThan(0.03)
    expect(dist3(g.pts[0], [0.6 * Math.cos(10 * Math.PI / 180), 0.6 * Math.sin(10 * Math.PI / 180), 0])).toBeLessThan(0.05)
  })

  it('triangle et rectangle : des côtés droits, des coins nets, la boucle refermée', () => {
    const tri = recognize(shaky(poly([[0, 0, 0], [1, 0, 0], [0.5, 0.8, 0], [0.02, 0.03, 0]], 25), 0.01))
    expect(tri.kind).toBe('poly'); expect(tri.closed).toBe(true); expect(tri.corners).toHaveLength(4)
    const rect = recognize(shaky(poly([[0, 0, 0], [1, 0, 0], [1, 0.6, 0], [0, 0.6, 0], [0, 0.02, 0]], 20), 0.008))
    expect(rect.kind).toBe('poly'); expect(rect.corners).toHaveLength(5)
    for (const [got, want] of [[rect.corners![1], [1, 0, 0]], [rect.corners![2], [1, 0.6, 0]], [rect.corners![3], [0, 0.6, 0]]] as [P3, P3][]) expect(dist3(got, want)).toBeLessThan(0.05)
    // les points rendus restent sur les côtés (le tube ne coupe pas les coins) et passent par chaque sommet
    for (const q of rect.pts) expect(Math.min(...rect.corners!.slice(1).map((c, i) => { const a = rect.corners![i], d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as P3, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2))); return dist3(q, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]) }))).toBeLessThan(1e-9)
    for (const c of rect.corners!) expect(rect.pts.some((q) => dist3(q, c) < 1e-9)).toBe(true)
    const open = recognize(shaky(poly([[0, 0, 0], [0, 0.8, 0], [0.7, 0.8, 0]], 25), 0.008))               // un « L » ouvert
    expect(open.kind).toBe('poly'); expect(open.closed).toBe(false); expect(open.corners).toHaveLength(3)
  })

  it('ce qui n\'est pas une forme simple reste le geste d\'origine, seulement adouci', () => {
    const wave = Array.from({ length: 80 }, (_, i): P3 => [i / 80, 0.2 * Math.sin(i / 80 * 4 * Math.PI), 0])
    const spiral = Array.from({ length: 120 }, (_, i): P3 => { const a = i / 120 * 4 * Math.PI, r = 0.1 + 0.4 * i / 120; return [r * Math.cos(a), r * Math.sin(a), 0] })
    const helix = Array.from({ length: 120 }, (_, i): P3 => { const a = i / 120 * 4 * Math.PI; return [0.4 * Math.cos(a), 0.4 * Math.sin(a), i / 120] })
    for (const curve of [wave, spiral, helix]) {
      const g = recognize(shaky(curve, 0.004)); expect(g.kind).toBe('free')
      expect(g.pts.length).toBe(curve.length)
      g.pts.forEach((q, i) => expect(dist3(q, curve[i])).toBeLessThan(0.06))                               // on ne s'éloigne pas du geste
    }
    expect(recognize(shaky(helix, 0.004)).pts.some((q) => q[2] > 0.5)).toBe(true)                          // la vraie 3D n'est pas aplatie
    // des vagues de toutes les hauteurs, aux deux niveaux : jamais prises pour un arc ou une droite
    for (const amp of [0.08, 0.12, 0.167, 0.3]) for (const periods of [1, 1.5, 2, 3]) for (const level of [1, 2] as const) {
      const w = Array.from({ length: 70 }, (_, i): P3 => [i / 70, amp * Math.sin(i / 70 * periods * 2 * Math.PI), 0])
      expect(recognize(shaky(w, 0.006, 3 + periods), level).kind, `vague ${amp} × ${periods}, niveau ${level}`).toBe('free')
    }
  })

  it('une courbe presque plate est remise à plat : le tremblement en profondeur disparaît', () => {
    const wave = Array.from({ length: 80 }, (_, i): P3 => [i / 80, 0.2 * Math.sin(i / 80 * 4 * Math.PI), 0])
    const g = recognize(shaky(wave, 0.006, 11, 2))
    expect(g.kind).toBe('free'); expect(fitPlane(g.pts).s[2]).toBeLessThan(1e-9)
  })

  it('le niveau fort redresse ce que le niveau léger laisse', () => {
    const rough = Array.from({ length: 50 }, (_, i): P3 => [i / 49, 0.3 * i / 49 + 0.065 * Math.sin(Math.PI * i / 49), 0])   // une droite bombée de 6 % : trop pour le niveau léger
    expect(recognize(rough, 1).kind).toBe('free'); expect(recognize(rough, 2).kind).toBe('line')
  })
})

describe('assistant : finition du trait', () => {
  it('retire le crochet laissé par les doigts qui s\'écartent, et rien d\'autre', () => {
    const body = lineTo([0, 0, 0], [1, 0, 0], 60), hook = lineTo([1, 0, 0], [0.97, -0.06, 0], 6).slice(1)
    const cleaned = dehook([...body, ...hook], 0.01)
    expect(cleaned[cleaned.length - 1][1]).toBeGreaterThan(-0.012); expect(cleaned[cleaned.length - 1][0]).toBeGreaterThan(0.97)
    const both = dehook([...lineTo([0.04, 0.05, 0], [0, 0, 0], 6), ...body.slice(1), ...hook], 0.01)
    expect(both[0][1]).toBeLessThan(0.012)                                                                   // crochet de début aussi
    const corner = poly([[0, 0, 0], [1, 0, 0], [1, 0.8, 0]], 40)                                            // un vrai angle, loin du bout : gardé
    expect(dehook(corner, 0.01)).toHaveLength(corner.length)
    expect(dehook(body, 0.01)).toHaveLength(body.length)
  })
  it('rééchantillonne à pas réguliers et accroche les bouts aux traits voisins', () => {
    const r = resample([[0, 0, 0], [0.1, 0, 0], [1, 0, 0]], 11)
    expect(r).toHaveLength(11); expect(r[5][0]).toBeCloseTo(0.5, 9); expect(pathLen(r)).toBeCloseTo(1, 9)
    const s = snapEnds([[0.01, 0.01, 0], [0.5, 0.5, 0], [1, 1, 0]], [[0, 0, 0], [3, 3, 3]], 0.03)
    expect(s.snapped).toBe(1); expect(s.pts[0]).toEqual([0, 0, 0]); expect(s.pts[2]).toEqual([1, 1, 0])
  })
})

describe('assistant : profondeur de la main à la caméra', () => {
  // une main en 3D (mètres), vue par une caméra sténopé à la distance z, éventuellement inclinée
  const model = [[0, 0, 0], [0.03, -0.02, 0], [0.05, -0.05, 0], [0.06, -0.08, 0], [0.07, -0.1, 0], [0.02, -0.09, 0], [0.02, -0.13, 0], [0.02, -0.155, 0], [0.02, -0.175, 0], [0, -0.095, 0], [0, -0.14, 0], [0, -0.165, 0], [0, -0.185, 0], [-0.02, -0.09, 0], [-0.02, -0.13, 0], [-0.02, -0.15, 0], [-0.02, -0.17, 0], [-0.04, -0.08, 0], [-0.04, -0.11, 0], [-0.04, -0.125, 0], [-0.04, -0.14, 0]]
  const view = (z: number, tiltDeg: number) => {
    const t = tiltDeg * Math.PI / 180
    const cy = model.reduce((a, q) => a + q[1], 0) / model.length
    const world = model.map(([x, y, zz]) => ({ x, y: (y - cy) * Math.cos(t) - zz * Math.sin(t), z: (y - cy) * Math.sin(t) + zz * Math.cos(t) }))   // penchée autour de son milieu : la distance moyenne ne change pas
    const lm = world.map((q) => ({ x: (0.5 + 0.9 * q.x / (z + q.z)) / (16 / 9), y: 0.5 + 0.9 * q.y / (z + q.z) }))
    return { lm, world }
  }
  it('la taille mesurée ne dépend presque pas de l\'inclinaison de la main, contrairement à poignet → majeur', () => {
    const flat = view(0.6, 0), tilted = view(0.6, 50)
    const robust = handScale(tilted.lm, tilted.world, 16 / 9) / handScale(flat.lm, flat.world, 16 / 9)
    const naive = Math.hypot(tilted.lm[0].x - tilted.lm[9].x, tilted.lm[0].y - tilted.lm[9].y) / Math.hypot(flat.lm[0].x - flat.lm[9].x, flat.lm[0].y - flat.lm[9].y)
    expect(Math.abs(robust - 1)).toBeLessThan(0.05)      // la perspective sur une main penchée laisse quelques pour cent
    expect(naive).toBeLessThan(0.75)                     // l'ancienne mesure la croyait bien plus loin
  })
  it('main plus près = profondeur positive, plus loin = négative, bornée, et nulle près du plan', () => {
    const ref = handScale(view(0.5, 0).lm, view(0.5, 0).world, 16 / 9), near = view(0.35, 0), far = view(0.7, 0)
    expect(depthFromScale(handScale(near.lm, near.world, 16 / 9), ref)).toBeGreaterThan(0.6)
    expect(depthFromScale(handScale(far.lm, far.world, 16 / 9), ref)).toBeLessThan(-0.6)
    expect(depthFromScale(ref * 10, ref)).toBe(1); expect(depthFromScale(0, ref)).toBe(0)
    expect(deadzone(0.05, 0.08)).toBe(0); expect(deadzone(-0.2, 0.08)).toBeCloseTo(-0.12); expect(deadzone(0.5, 0.08)).toBeCloseTo(0.42)
  })
})
