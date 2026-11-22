/**
 * Lutherie d'air : la partie qui se calcule sans écran ni haut-parleur.
 *
 * Une corde dessinée se comporte comme une vraie : sa hauteur vient de sa longueur (deux fois
 * plus courte = une octave plus haut), accordée sur la note de la gamme la plus proche. Les
 * frettes sont aux endroits exacts où, en bloquant la corde, on obtient les notes suivantes de
 * la gamme. Le son de corde pincée est calculé par l'algorithme de Karplus-Strong.
 */

export type P2 = [number, number]

export const SCALES: Record<string, { label: string; steps: number[] }> = {
  penta: { label: 'Pentatonique mineure (toujours juste)', steps: [0, 3, 5, 7, 10] },
  pentaMaj: { label: 'Pentatonique majeure', steps: [0, 2, 4, 7, 9] },
  major: { label: 'Majeure', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Mineure', steps: [0, 2, 3, 5, 7, 8, 10] },
  hira: { label: 'Japonaise (hirajōshi)', steps: [0, 2, 3, 7, 8] },
  hijaz: { label: 'Orientale (hijaz)', steps: [0, 1, 4, 5, 7, 8, 10] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chroma: { label: 'Chromatique (toutes les notes)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
}
export const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si']
export const noteName = (midi: number) => `${NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`
export const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440)

/** Note de la gamme (tonique `root`, 0..11) la plus proche de la hauteur `midi`. */
export function snap(midi: number, root: number, steps: number[]): number {
  const base = Math.floor((midi - root) / 12)
  let best = 0, gap = Infinity
  for (let o = base - 1; o <= base + 1; o++) for (const st of steps) {
    const n = root + o * 12 + st, g = Math.abs(n - midi)
    if (g < gap) { gap = g; best = n }
  }
  return best
}

/** Longueur (en largeurs d'écran) d'une corde qui sonne la tonique de référence, Do3. */
export const REF_LEN = 0.5
const REF_MIDI = 48

/** Note d'une corde à vide selon sa longueur : fréquence inversement proportionnelle à la longueur. */
export function stringMidi(len: number, root: number, steps: number[], octave = 0): number {
  const l = Math.max(0.03, Math.min(2, len))
  return snap(REF_MIDI + 12 * Math.log2(REF_LEN / l) + octave * 12, root, steps)
}

export interface Fret { t: number; midi: number }
/** Frettes d'une corde : pour chaque note de la gamme au-dessus de la note à vide, l'endroit (0 = sillet,
 *  1 = chevalet) où bloquer la corde pour l'obtenir. Une octave est au milieu, comme sur une guitare. */
export function frets(open: number, root: number, steps: number[], semitones = 19): Fret[] {
  const out: Fret[] = []
  for (let m = open + 1; m <= open + semitones; m++) if (snap(m, root, steps) === m) out.push({ t: 1 - 2 ** (-(m - open) / 12), midi: m })
  return out
}
/** Note obtenue en bloquant la corde à `t` : la frette la plus proche (ou la note à vide tout près du sillet). */
export function frettedMidi(open: number, list: Fret[], t: number): number {
  let best = open, gap = Math.abs(t)
  for (const f of list) { const g = Math.abs(f.t - t); if (g < gap) { gap = g; best = f.midi } }
  return best
}

/** Croisement de deux segments : position (0..1) le long de `c → d`, ou `null` s'ils ne se croisent pas. */
export function cross(a: P2, b: P2, c: P2, d: P2): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return null
  const u = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, t = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den
  return u >= 0 && u <= 1 && t >= 0 && t <= 1 ? t : null
}
/** Distance d'un point à un segment, et position (0..1) du point le plus proche sur ce segment. */
export function nearest(p: P2, a: P2, b: P2): { d: number; t: number } {
  const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2))
  return { d: Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t), t }
}

/** Le point x est-il dans le triangle c-p-q ? (triangle plat : non) */
export function inTri(x: P2, c: P2, p: P2, q: P2): boolean {
  if (Math.abs((p[0] - c[0]) * (q[1] - c[1]) - (p[1] - c[1]) * (q[0] - c[0])) < 1e-12) return false
  const s = (a: P2, b: P2) => (b[0] - a[0]) * (x[1] - a[1]) - (b[1] - a[1]) * (x[0] - a[0])
  const d1 = s(c, p), d2 = s(p, q), d3 = s(q, c)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}
/** Secteur balayé par le rayon d'un manège entre deux images (triangle centre c, ancien bout p, nouveau bout q) :
 *  position (0..1) le long de la corde a→b où il la touche, ou `null`. Tester le rayon seul laisserait un manège
 *  rapide sauter par-dessus une corde fine sans la jouer. */
export function sweep(c: P2, p: P2, q: P2, a: P2, b: P2): number | null {
  return cross(c, q, a, b) ?? cross(c, p, a, b) ?? cross(p, q, a, b) ?? (inTri(a, c, p, q) ? 0.5 : null)
}
/** Même balayage pour un tambour ou une clochette : son centre x est-il à moins de r du rayon, ou dans le secteur ? */
export function sweepPoint(c: P2, p: P2, q: P2, x: P2, r: number): boolean {
  return nearest(x, c, q).d < r || nearest(x, c, p).d < r || inTri(x, c, p, q)
}

/** Tambour : son rayon (en largeurs d'écran) décide de sa voix. Grand = grosse caisse, petit = charleston. */
export function drumVoice(radius: number): { kind: 'kick' | 'tom' | 'hat'; hz: number } {
  const hz = Math.max(45, Math.min(520, 9 / Math.max(0.01, radius)))
  return { kind: radius > 0.1 ? 'kick' : radius > 0.055 ? 'tom' : 'hat', hz }
}
/** Clochette : plus elle est posée haut, plus elle est aiguë (deux octaves du bas au haut de l'écran). */
export function bellMidi(y01: number, root: number, steps: number[]): number {
  return snap(60 + (1 - Math.max(0, Math.min(1, y01))) * 24, root, steps)
}

export interface PluckTone { bright: number; pick: number; sustain: number }
/** Corde pincée (Karplus-Strong) : un souffle de bruit tourne dans une ligne à retard de la longueur d'une
 *  période, adouci et affaibli à chaque tour. `bright` = attaque plus ou moins brillante, `pick` = endroit du
 *  pincement le long de la corde, `sustain` = secondes pour s'éteindre. */
export function karplus(sampleRate: number, hz: number, seconds: number, tone: PluckTone, seed = 1): Float32Array {
  const period = sampleRate / hz, N = Math.max(2, Math.round(period - 0.5)), s = Math.max(0.08, Math.min(0.92, period - N))
  const out = new Float32Array(Math.max(N + 2, Math.floor(sampleRate * seconds)))
  let rnd = seed * 9301 + 49297
  const noise = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 1073741823.5 - 1 }
  // excitation : bruit adouci, puis creusé là où l'on pince (un pincement au milieu ôte les harmoniques paires)
  const ex = new Float32Array(N)
  let lp = 0
  for (let i = 0; i < N; i++) { lp += tone.bright * (noise() - lp); ex[i] = lp }
  const k = Math.max(1, Math.round(Math.max(0.05, Math.min(0.5, tone.pick)) * N))
  for (let i = 0; i < N; i++) out[i] = ex[i] - ex[(i - k + N) % N]
  const loss = 10 ** (-3 / (hz * tone.sustain))             // −60 dB au bout de `sustain` secondes
  for (let i = N + 1; i < out.length; i++) out[i] = loss * ((1 - s) * out[i - N] + s * out[i - N - 1])
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  const fade = Math.min(out.length, Math.floor(sampleRate * 0.03)), gain = peak > 0 ? 0.9 / peak : 0
  for (let i = 0; i < out.length; i++) out[i] *= gain * Math.min(1, (out.length - i) / fade)
  return out
}
