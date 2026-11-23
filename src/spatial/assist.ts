/**
 * Esquisse spatiale : l'assistant de tracé.
 *
 * Une main dans l'air tremble, s'enfonce et ressort, et finit chaque trait par un crochet quand les doigts
 * s'écartent. L'assistant regarde le trait pendant qu'on le dessine et propose ce qu'on voulait sans doute faire :
 * une droite, un arc, un cercle, un polygone, ou sinon la même courbe, nettoyée et remise à plat.
 *
 * Tout se calcule sur place, en moins d'une milliseconde (ajustements géométriques : plan moyen, cercle des
 * moindres carrés, sommets), donc à chaque image et sans réseau. Ce n'est pas un modèle de langage.
 */
import { simplify, relax, type P3 } from './build'

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: P3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: P3): P3 => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [1, 0, 0] }
const AXES: P3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const DEG = Math.PI / 180

export const dist3 = (a: P3, b: P3) => len(sub(a, b))
export const pathLen = (pts: P3[]) => pts.reduce((s, q, i) => (i ? s + dist3(q, pts[i - 1]) : 0), 0)

/** Rééchantillonne le trait en `n` points régulièrement espacés le long du chemin. */
export function resample(pts: P3[], n: number): P3[] {
  const total = pathLen(pts)
  if (pts.length < 2 || total < 1e-12) return pts.slice()
  const out: P3[] = [pts[0]], step = total / (n - 1)
  let acc = 0, want = step
  for (let i = 1; i < pts.length && out.length < n - 1; i++) {
    const seg = dist3(pts[i], pts[i - 1])
    while (seg > 1e-12 && acc + seg >= want && out.length < n - 1) { out.push(add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), (want - acc) / seg))); want += step }
    acc += seg
  }
  out.push(pts[pts.length - 1])
  return out
}

export interface Plane { c: P3; u: P3; v: P3; n: P3; s: [number, number, number] }
/** Plan moyen du trait (analyse en composantes principales) : centre, grand axe `u`, petit axe `v`, normale `n`,
 *  et l'étalement le long de chacun (`s`). Un trait bien plat a `s[2]` proche de zéro. */
export function fitPlane(pts: P3[]): Plane {
  const c = mul(pts.reduce((a, q) => add(a, q), [0, 0, 0] as P3), 1 / pts.length)
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const q of pts) { const d = sub(q, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j] / pts.length }
  // valeurs propres d'une matrice symétrique 3×3 par rotations de Jacobi
  const e = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 24; sweep++) for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(m[p][q]) < 1e-15) continue
    const th = 0.5 * Math.atan2(2 * m[p][q], m[q][q] - m[p][p]), cs = Math.cos(th), sn = Math.sin(th)
    for (let i = 0; i < 3; i++) { const a = m[i][p], b = m[i][q]; m[i][p] = cs * a - sn * b; m[i][q] = sn * a + cs * b }
    for (let i = 0; i < 3; i++) { const a = m[p][i], b = m[q][i]; m[p][i] = cs * a - sn * b; m[q][i] = sn * a + cs * b }
    for (let i = 0; i < 3; i++) { const a = e[i][p], b = e[i][q]; e[i][p] = cs * a - sn * b; e[i][q] = sn * a + cs * b }
  }
  const order = [0, 1, 2].sort((a, b) => m[b][b] - m[a][a]), col = (j: number): P3 => [e[0][j], e[1][j], e[2][j]]
  const u = unit(col(order[0])), n = unit(cross(u, col(order[1]))), v = cross(n, u)
  return { c, u, v, n, s: [0, 1, 2].map((i) => Math.sqrt(Math.max(0, m[order[i]][order[i]]))) as [number, number, number] }
}

/** Si la normale du plan est presque un axe (à `tolDeg` près), on la pose exactement dessus : le cercle dessiné
 *  « à peu près de face » tombe pile sur le plan de face. */
function snapPlane(pl: Plane, tolDeg: number): Plane {
  const ax = AXES.map((a) => Math.abs(dot(a, pl.n))), best = ax.indexOf(Math.max(...ax))
  if (ax[best] < Math.cos(tolDeg * DEG) || ax[best] > 1 - 1e-9) return pl
  const n = mul(AXES[best], Math.sign(dot(AXES[best], pl.n)) || 1), u = unit(sub(pl.u, mul(n, dot(pl.u, n))))
  return { ...pl, n, u, v: cross(n, u) }
}

/** Retire le crochet de début ou de fin : un tout petit bout de trait après un virage sec, laissé par les doigts
 *  qui se referment ou s'écartent. `width` est l'épaisseur du trait. */
export function dehook(pts: P3[], width: number): P3[] {
  const total = pathLen(pts)
  if (pts.length < 6 || total < width * 6) return pts
  const limit = Math.min(total * 0.15, Math.max(width * 8, total * 0.08))   // un crochet ne dépasse pas cette longueur
  const cutEnd = (p: P3[]): number => {
    let acc = 0, best = -1, sharpest = Math.cos(65 * DEG)
    for (let j = p.length - 2; j > 2; j--) {
      acc += dist3(p[j + 1], p[j]); if (acc > limit) break
      // direction du trait avant le point (sur une distance comparable au crochet), et direction vers la fin
      let b = j; let back = 0; while (b > 0 && back < Math.max(acc * 2, width * 3)) { back += dist3(p[b], p[b - 1]); b-- }
      const turn = dot(unit(sub(p[j], p[b])), unit(sub(p[p.length - 1], p[j])))
      if (turn < sharpest) { sharpest = turn; best = j }
    }
    return best
  }
  let out = pts
  const e = cutEnd(out); if (e > 0) out = out.slice(0, e + 1)
  const rev = out.slice().reverse(), s = cutEnd(rev); if (s > 0) out = rev.slice(0, s + 1).reverse()
  return out
}

export type Shape = 'line' | 'arc' | 'circle' | 'poly' | 'free'
export interface Guess { kind: Shape; pts: P3[]; closed: boolean; label: string; corners?: P3[] }   // corners : les sommets d'un polygone
export const SHAPE_LABELS: Record<Shape, string> = { line: 'droite', arc: 'arc de cercle', circle: 'cercle', poly: 'polygone', free: 'courbe libre' }
/** Tolérances par niveau d'aide : 1 = seulement les formes nettes, 2 = on redresse plus volontiers. */
const TOL = { 1: { line: 0.035, circle: 0.05, poly: 0.03, cut: 0.06, axis: 7, flat: 0.06 }, 2: { line: 0.065, circle: 0.09, poly: 0.05, cut: 0.06, axis: 14, flat: 0.12 } }   // cut : un coin reste un coin aux deux niveaux

/** Le tube est une courbe lissée entre ses points : pour que les côtés d'un polygone restent droits et ses coins
 *  nets, chaque côté reçoit des points serrés, dont deux tout près de chaque sommet. */
function straightSides(corners: P3[]): P3[] {
  const out: P3[] = [corners[0]]
  for (let i = 1; i < corners.length; i++) for (const t of [0.03, 0.12, 0.25, 0.4, 0.5, 0.6, 0.75, 0.88, 0.97, 1]) out.push(add(corners[i - 1], mul(sub(corners[i], corners[i - 1]), t)))
  return out
}

/** Cercle des moindres carrés (Kåsa) sur des points 2D : centre, rayon, écart moyen des points au cercle. */
function fitCircle(xy: [number, number][]) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0
  for (const [x, y] of xy) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z }
  const n = xy.length, A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], B = [sxz, syz, sz]
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const d = det(A); if (Math.abs(d) < 1e-18) return null
  const col = (j: number) => A.map((row, i) => row.map((val, k) => (k === j ? B[i] : val)))
  const a = det(col(0)) / d / 2, b = det(col(1)) / d / 2, c = det(col(2)) / d, r = Math.sqrt(Math.max(0, c + a * a + b * b))
  if (!(r > 1e-9)) return null
  const rms = Math.sqrt(xy.reduce((e, [x, y]) => e + (Math.hypot(x - a, y - b) - r) ** 2, 0) / n)
  return { a, b, r, rms }
}

/** Ce que le trait veut être. `level` : 1 (léger) ou 2 (fort). Les points rendus sont dans le même repère que `pts`. */
export function recognize(pts: P3[], level: 1 | 2 = 1): Guess {
  const tol = TOL[level], total = pathLen(pts), free = (p: P3[], closed = false): Guess => ({ kind: 'free', pts: p, closed, label: SHAPE_LABELS.free })
  if (pts.length < 4 || total < 1e-9) return free(pts)
  const R = resample(pts, 64), first = R[0], last = R[R.length - 1], chord = dist3(first, last)
  const pl = snapPlane(fitPlane(R), tol.axis + 3)

  // 1. droite : tout le trait reste près de son grand axe, sans aller-retour
  const along = (q: P3) => dot(sub(q, pl.c), pl.u), off = (q: P3) => len(sub(sub(q, pl.c), mul(pl.u, along(q))))
  if (chord > total * 0.87 && Math.max(...R.map(off)) <= tol.line * chord) {
    let dir = unit(sub(add(pl.c, mul(pl.u, along(last))), add(pl.c, mul(pl.u, along(first)))))
    const ax = AXES.map((a) => Math.abs(dot(a, dir))), m = ax.indexOf(Math.max(...ax))
    if (ax[m] > Math.cos(tol.axis * DEG)) dir = mul(AXES[m], Math.sign(dot(AXES[m], dir)) || 1)   // presque un axe : pile sur l'axe
    const mid = mul(add(first, last), 0.5), half = chord / 2
    return { kind: 'line', pts: [sub(mid, mul(dir, half)), add(mid, mul(dir, half))], closed: false, label: SHAPE_LABELS.line }
  }

  const planar = pl.s[2] <= tol.flat * Math.max(pl.s[0], 1e-12)
  const xy = R.map((q): [number, number] => [dot(sub(q, pl.c), pl.u), dot(sub(q, pl.c), pl.v)])
  const lift = (x: number, y: number): P3 => add(pl.c, add(mul(pl.u, x), mul(pl.v, y)))
  const closedGap = chord <= total * 0.14
  const size = Math.hypot(...[0, 1].map((i) => Math.max(...xy.map((q) => q[i])) - Math.min(...xy.map((q) => q[i]))))   // diagonale du trait dans son plan

  if (planar) {
    // 2. cercle ou arc : distance au centre constante, et on tourne toujours dans le même sens
    // l'écart au cercle se juge à l'échelle du trait : un très grand cercle « colle » à n'importe quelle courbe presque droite
    const c = fitCircle(xy), unitLen = c ? Math.min(c.r, size / 2) : 1
    if (c && c.rms <= tol.circle * unitLen) {
      const ang = xy.map(([x, y]) => Math.atan2(y - c.b, x - c.a))
      let sweep = 0, same = 0
      const steps = ang.slice(1).map((a, i) => { let d = a - ang[i]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d })
      for (const d of steps) sweep += d
      for (const d of steps) if (d * sweep > 0) same++
      const turns = Math.abs(sweep), sagitta = c.r * (1 - Math.cos(Math.min(turns, Math.PI) / 2))
      if (same >= steps.length * 0.9) {
        if (turns >= 300 * DEG && turns <= 440 * DEG && chord <= c.r * 0.9) {
          const ptsC: P3[] = []; for (let i = 0; i <= 72; i++) { const a = ang[0] + Math.sign(sweep) * 2 * Math.PI * i / 72; ptsC.push(lift(c.a + c.r * Math.cos(a), c.b + c.r * Math.sin(a))) }
          return { kind: 'circle', pts: ptsC, closed: true, label: SHAPE_LABELS.circle }
        }
        if (turns >= 35 * DEG && turns < 300 * DEG && c.rms <= tol.circle * 0.7 * unitLen && sagitta >= 0.07 * chord && c.rms <= 0.2 * sagitta) {   // la courbure doit dépasser nettement le tremblement
          const n = Math.max(8, Math.ceil(turns / (5 * DEG))), ptsA: P3[] = []
          for (let i = 0; i <= n; i++) { const a = ang[0] + sweep * i / n; ptsA.push(lift(c.a + c.r * Math.cos(a), c.b + c.r * Math.sin(a))) }
          return { kind: 'arc', pts: ptsA, closed: false, label: SHAPE_LABELS.arc }
        }
      }
    }
    // 3. polygone : quelques côtés droits séparés par de vrais angles. Les sommets ne sont pas des points du trait
    //    (la main arrondit les coins) : chaque côté est une droite ajustée, les sommets sont leurs croisements.
    const flatR = xy.map(([x, y]) => lift(x, y))
    const idx = simplify(flatR, tol.poly * size * 1.6), sides = idx.length - 1
    if (sides >= 2 && sides <= 6 && (closedGap ? sides >= 3 : true)) {
      const lines = idx.slice(1).map((end, sd) => {   // droite des moindres carrés sur le cœur du côté (sans ses bouts arrondis)
        const from = idx[sd], cutN = Math.floor((end - from) * 0.18), seg = xy.slice(from + cutN, end - cutN + 1), q = seg.length >= 3 ? seg : xy.slice(from, end + 1)
        const mx = q.reduce((a, v) => a + v[0], 0) / q.length, my = q.reduce((a, v) => a + v[1], 0) / q.length
        let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of q) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my) }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); let dx = Math.cos(th), dy = Math.sin(th)
        if (dx * (xy[end][0] - xy[from][0]) + dy * (xy[end][1] - xy[from][1]) < 0) { dx = -dx; dy = -dy }   // dans le sens du tracé
        const dev = Math.max(...q.map(([x, y]) => Math.abs((x - mx) * dy - (y - my) * dx))), length = Math.hypot(xy[end][0] - xy[from][0], xy[end][1] - xy[from][1])
        return { mx, my, dx, dy, dev, length }
      })
      const meet = (a: typeof lines[0], b: typeof lines[0]): [number, number] | null => { const den = a.dx * b.dy - a.dy * b.dx; if (Math.abs(den) < Math.sin(15 * DEG)) return null; const t = ((b.mx - a.mx) * b.dy - (b.my - a.my) * b.dx) / den; return [a.mx + a.dx * t, a.my + a.dy * t] }
      const onto = (l: typeof lines[0], q: [number, number]): [number, number] => { const t = (q[0] - l.mx) * l.dx + (q[1] - l.my) * l.dy; return [l.mx + l.dx * t, l.my + l.dy * t] }
      const c2: ([number, number] | null)[] = [closedGap ? meet(lines[sides - 1], lines[0]) ?? onto(lines[0], xy[0]) : onto(lines[0], xy[0])]
      for (let v = 1; v < sides; v++) c2.push(meet(lines[v - 1], lines[v]))
      c2.push(closedGap ? c2[0] : onto(lines[sides - 1], xy[xy.length - 1]))
      // des côtés droits à l'échelle de leur propre longueur (une vague douce a des « côtés » bombés), de vrais angles,
      // et des sommets qui restent là où la main a tourné
      const ok = lines.every((l) => l.dev <= Math.max(1.33 * tol.poly * l.length, 0.4 * tol.poly * size) && l.length >= size * 0.12)
        && c2.every((q, v) => q !== null && Math.hypot(q[0] - xy[idx[Math.min(v, sides)]][0], q[1] - xy[idx[Math.min(v, sides)]][1]) <= 0.12 * size)
        && lines.slice(1).every((l, v) => l.dx * lines[v].dx + l.dy * lines[v].dy < Math.cos(28 * DEG))
        // un coin net : le trait passe tout près du sommet. Une crête de vague, elle, coupe largement le « coin ».
        && c2.every((q, v) => { if (!q || (v === 0 || v === sides) && !closedGap) return true; const near = Math.min(...xy.map((r) => Math.hypot(r[0] - q[0], r[1] - q[1]))); return near <= tol.cut * Math.min(lines[(v + sides - 1) % sides].length, lines[v % sides].length) })
      if (ok) { const corners = (c2 as [number, number][]).map(([x, y]) => lift(x, y)); return { kind: 'poly', pts: straightSides(corners), corners, closed: closedGap, label: SHAPE_LABELS.poly } }
    }
  }

  // 4. courbe libre : on garde le geste, on gomme le tremblement, on remet à plat ce qui est presque plat,
  //    et on referme la boucle si le trait revient à son point de départ
  let out = pts.length > 3 ? relax(pts, level) : pts.slice()
  if (planar) out = out.map((q) => sub(q, mul(pl.n, dot(sub(q, pl.c), pl.n))))
  const closed = chord <= total * 0.07 && out.length > 4
  if (closed) out = [...out.slice(0, -1), out[0]]
  return free(out, closed)
}

/** Accroche les deux bouts d'un trait ouvert aux points voisins (bouts des autres traits), à moins de `tol`. */
export function snapEnds(pts: P3[], anchors: P3[], tol: number): { pts: P3[]; snapped: number } {
  if (pts.length < 2 || !anchors.length) return { pts, snapped: 0 }
  const out = pts.slice(); let snapped = 0
  for (const i of [0, out.length - 1]) {
    let best: P3 | null = null, bd = tol
    for (const a of anchors) { const d = dist3(a, out[i]); if (d < bd) { bd = d; best = a } }
    if (best) { out[i] = best; snapped++ }
  }
  return { pts: out, snapped }
}

// ───────── profondeur de la main vue par la caméra ─────────

/** Taille apparente de la main, en unités d'image par mètre : rapport entre l'étalement des 21 jalons dans l'image
 *  et celui des mêmes jalons en 3D (mètres). Contrairement à la longueur poignet → majeur, il ne change pas quand
 *  la main s'incline : une main penchée paraît plus courte dans l'image, mais ses jalons 3D aussi. `aspect` =
 *  largeur / hauteur de l'image de la caméra. */
export function handScale(lm: { x: number; y: number }[], world: { x: number; y: number }[], aspect: number): number {
  const n = Math.min(lm.length, world.length); if (n < 5) return 0
  let ix = 0, iy = 0, wx = 0, wy = 0
  for (let i = 0; i < n; i++) { ix += lm[i].x * aspect; iy += lm[i].y; wx += world[i].x; wy += world[i].y }
  ix /= n; iy /= n; wx /= n; wy /= n
  let si = 0, sw = 0
  for (let i = 0; i < n; i++) { si += (lm[i].x * aspect - ix) ** 2 + (lm[i].y - iy) ** 2; sw += (world[i].x - wx) ** 2 + (world[i].y - wy) ** 2 }
  return sw > 1e-12 ? Math.sqrt(si / sw) : 0
}
/** Écart de profondeur, de −1 (main reculée) à 1 (main avancée vers l'écran), à partir de la taille apparente et de
 *  celle mesurée quand la main est entrée dans le champ. Une main 1,6 fois plus grosse = 1. */
export const depthFromScale = (scale: number, ref: number) => (scale > 0 && ref > 0 ? Math.max(-1, Math.min(1, Math.log(scale / ref) / Math.log(1.6))) : 0)
/** Zone morte : près du plan de dessin, la profondeur reste exactement à zéro ; au-delà elle repart de zéro sans saut. */
export const deadzone = (v: number, dead: number) => Math.sign(v) * Math.max(0, Math.abs(v) - dead)
