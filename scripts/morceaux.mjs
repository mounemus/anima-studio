// Fabrique les morceaux tout faits de la Lutherie d'air : `node scripts/morceaux.mjs` écrit public/morceaux/*.json.
//
// Un morceau est une boîte à musique : un manège au centre, et une corde par note, accrochée au bord du cercle à
// l'angle de son temps. La longueur de la corde donne sa note (comme partout dans l'atelier), et le rayon du manège
// la pince en arrivant sur son point d'accroche. Les airs sont du domaine public.
// Autour : des tambours (grosses caisses en rosace près du centre, toms à mi-rayon, charlestons en perles sur le
// cercle) et des clochettes, dont la note vient de la hauteur à l'écran : le script cherche, parmi les notes de
// l'accord demandé, celle qui tombe sur le passage du rayon au bon moment.
//
// Notation d'une voix : « Mi5 » s'écrit E5, dièse #, bémol b ; « E5:1.5 » dure un temps et demi ; « _ » est un silence.
// Tambours : « x » est un coup. Clochettes : « CEG » veut dire « une note parmi Do, Mi, Sol ».
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCALES, bellMidi, lengthFor } from '../src/music/theory.ts'   // le vrai accordage de l'atelier (Node 24 lit le TypeScript)

const OUT = fileURLToPath(new URL('../public/morceaux/', import.meta.url))
const C = [0.6, 0.265], R = 0.235, RIM = 0.96 * R      // centre, rayon du manège, cercle d'accroche (en largeurs d'écran)
const OCTAVE = { guitar: 0, harp: 1, bass: -1 }        // comme TIMBRES dans src/music/synth.ts
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const round = (v) => Math.round(v * 1e5) / 1e5
const DRUM = { kick: { radius: 0.105, at: 0.07 }, tom: { radius: 0.06, at: 0.13 }, hat: { radius: 0.014, at: R + 0.008 } }   // taille (donc voix) et distance au centre
const NEAR = 0.018         // l'atelier fait sonner tambour ou clochette quand son centre est à moins de ça du rayon
/** Le rayon touche (à NEAR près) un point situé à la distance rc du centre un peu avant d'arriver dessus : de cet angle. */
const lead = (rc) => (Math.sqrt(rc * rc - NEAR * NEAR) <= R ? Math.asin(NEAR / rc) : Math.acos((rc * rc + R * R - NEAR * NEAR) / (2 * rc * R)))
const polar = (rc, th) => [round(C[0] + rc * Math.cos(th)), round(C[1] + rc * Math.sin(th))]

function midiOf(name) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name)
  if (!m) throw new Error(`note illisible : ${name}`)
  return SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (+m[3] + 1)
}
const lengthOf = (midi, timbre) => lengthFor(midi, OCTAVE[timbre])

function build(piece) {
  const things = [{ id: `${piece.id}-roue`, kind: 'wheel', a: C, b: [C[0], round(C[1] - R)], timbre: 'guitar' }]   // rayon de départ : vers le haut
  piece.voices.forEach((voice, v) => {
    const unit = voice.unit ?? piece.unit ?? 1, tilt = (voice.tilt ?? 14) * Math.PI / 180
    let beat = 0, n = 0
    for (const token of voice.notes.trim().split(/\s+/)) {
      const [name, dur = '1'] = token.split(':')
      const th0 = -Math.PI / 2 + 2 * Math.PI * beat / piece.turn
      if (name !== '_' && voice.drum) {
        const d = DRUM[voice.drum], a = polar(d.at, th0 + lead(d.at))
        things.push({ id: `${piece.id}-${v}-${n++}`, kind: 'drum', a, b: [round(a[0] + d.radius), a[1]], timbre: 'guitar', voice: voice.drum, beat: round(beat) })
      } else if (name !== '_' && voice.bell) {
        // la hauteur à l'écran fixe la note : on garde, parmi les notes de l'accord, celle qui se trouve sur le passage du rayon
        const wanted = name.match(/[A-G][#b]?/g).map((x) => midiOf(x + '4') % 12)
        const steps = SCALES[piece.scale].steps
        let best = null
        for (let rc = 0.05; rc <= R - 0.012; rc += 0.002) {
          const th = th0 + lead(rc), y = C[1] + rc * Math.sin(th), midi = bellMidi(y, piece.root, steps)
          if (!wanted.includes(midi % 12) || bellMidi(y - 0.004, piece.root, steps) !== midi || bellMidi(y + 0.004, piece.root, steps) !== midi) continue   // pas au bord d'une autre note
          if (!best || Math.abs(rc - 0.15) < Math.abs(best.rc - 0.15)) best = { midi, rc, th }
        }
        // rayon presque horizontal : une seule hauteur possible ; si elle n'est pas dans l'accord, cette clochette se tait
        if (best) { const a = polar(best.rc, best.th); things.push({ id: `${piece.id}-${v}-${n++}`, kind: 'bell', a, b: a, timbre: 'harp', midi: best.midi, beat: round(beat) }) }
        else skipped.push(`${piece.id} temps ${beat} (${name})`)
      } else if (name !== '_') {
        const midi = midiOf(name), len = lengthOf(midi, voice.timbre)
        if (len < 0.035 || len > 0.44) throw new Error(`${piece.id} : ${name} donne une corde de ${len.toFixed(3)}, hors de l'écran`)
        const th = th0
        const a = [C[0] + RIM * Math.cos(th), C[1] + RIM * Math.sin(th)]
        // la corde part vers l'intérieur, penchée dans le sens de rotation : le rayon la rencontre d'abord à son point d'accroche
        const d = th + Math.PI - tilt
        const b = [a[0] + len * Math.cos(d), a[1] + len * Math.sin(d)]
        things.push({ id: `${piece.id}-${v}-${n++}`, kind: 'string', a: a.map(round), b: b.map(round), timbre: voice.timbre, midi, beat: round(beat) })
      }
      beat += +dur * unit
    }
    if (Math.abs(beat - piece.turn) > 1e-6) throw new Error(`${piece.id}, voix ${v} : ${beat} temps au lieu de ${piece.turn}`)
  })
  return { app: 'digiart-lutherie', version: 1, title: `${piece.title} (${piece.author})`, style: piece.style,
    settings: { scale: piece.scale, root: piece.root, bpm: piece.bpm, turn: piece.turn }, things }
}

const skipped = []
const rep = (text, times) => Array(times).fill(text).join(' ')

const PIECES = [
  { id: 'ode-a-la-joie', title: 'Ode à la joie', author: 'Beethoven', style: 'classique', scale: 'major', root: 0, bpm: 120, turn: 32, voices: [
    { timbre: 'guitar', notes: 'E5 E5 F5 G5  G5 F5 E5 D5  C5 C5 D5 E5  E5:1.5 D5:.5 D5:2   E5 E5 F5 G5  G5 F5 E5 D5  C5 C5 D5 E5  D5:1.5 C5:.5 C5:2' },
    { timbre: 'bass', tilt: 40, notes: 'C3:2 G3:2  G3:2 C3:2  C3:2 G3:2  C3:2 G3:2   C3:2 G3:2  G3:2 C3:2  C3:2 G3:2  G3:2 C3:2' },
    { drum: 'kick', notes: rep('x:4', 8) }, { drum: 'tom', notes: rep('_:2 x:2', 8) },
    { bell: true, notes: rep('CEG:8', 4) },
  ] },
  { id: 'lettre-a-elise', title: 'Lettre à Élise', author: 'Beethoven', style: 'romantique', scale: 'chroma', root: 0, bpm: 126, turn: 24, unit: 0.5, voices: [   // écrit en doubles croches
    { timbre: 'harp', notes: 'E6 D#6 E6 B5 D6 C6  A5:2 _ C5 E5 A5  B5:2 _ E5 G#5 B5  C6:2 _ E5 E6 D#6   E6 D#6 E6 B5 D6 C6  A5:2 _ C5 E5 A5  B5:2 _ E5 C6 B5  A5:2 _:2 E6 D#6' },
    { timbre: 'bass', tilt: 40, notes: '_:6  A2 E3 A3 _:3  E2 E3 G#3 _:3  A2 E3 A3 _:3   _:6  A2 E3 A3 _:3  E2 E3 G#3 _:3  A2 E3 A3 _:3' },
    { bell: true, notes: '_:6 ACE:6 EG#B:6 ACE:6 _:6 ACE:6 EG#B:6 ACE:6' },
  ] },
  { id: 'the-entertainer', title: 'The Entertainer', author: 'Scott Joplin', style: 'ragtime', scale: 'chroma', root: 0, bpm: 84, turn: 16, unit: 0.25, voices: [   // écrit en doubles croches
    { timbre: 'guitar', notes: 'E4 C5:2 E4 C5:2 E4 C5:6 C5 D5 D#5  E5 C5 D5 E5:2 B4 D5:2  C5:6 D4 D#4   E4 C5:2 E4 C5:2 E4 C5:6 _ A5 G5  F#5 A5 C6 E6:2 D6 C6 A5  D6:6 D4 D#4' },
    { timbre: 'bass', tilt: 40, notes: 'C3:4 G3:4  C3:4 G3:4  C3:4 G3:4  C3:4 G3:4   C3:4 G3:4  C3:4 E3:4  D3:4 F#3:4  G3:4 G3:4' },
    { drum: 'kick', notes: rep('x:8', 8) }, { drum: 'hat', notes: rep('_:2 x:2', 16) },
  ] },
  { id: 'when-the-saints', title: 'When the Saints Go Marching In', author: 'traditionnel', style: 'jazz Nouvelle-Orléans', scale: 'major', root: 0, bpm: 176, turn: 64, voices: [
    { timbre: 'guitar', notes: 'G5:4  _ C5 E5 F5  G5:4  _ C5 E5 F5  G5:2 E5:2  C5:2 E5:2  D5:4  _ E5 E5 D5   C5:3 C5  E5:2 G5:2  G5:2 F5:2  _:2 E5 F5  G5:2 E5:2  C5:2 D5:2  C5:4  _ C5 E5 F5' },
    { timbre: 'bass', tilt: 40, notes: `${rep('C3:2 G3:2', 5)}  C3:2 E3:2  G3:2 D3:2  G3:2 G3:2   C3:2 G3:2  C3:2 E3:2  F3:2 A3:2  F3:2 G3:2  C3:2 G3:2  C3:2 G3:2  C3:2 G3:2  C3:2 G3:2` },
    { drum: 'kick', notes: rep('x:8', 8) }, { drum: 'hat', notes: rep('_ x _ x', 16) },
    { bell: true, notes: 'CEG:8 CEG:8 CEG:8 GBD:8 CEG:8 FAC:8 CEG:8 CEG:8' },
  ] },
  { id: 'korobeiniki', title: 'Korobeïniki, l\'air de Tetris', author: 'traditionnel russe', style: 'folk', scale: 'minor', root: 9, bpm: 150, turn: 32, voices: [
    { timbre: 'guitar', notes: 'E5 B4:.5 C5:.5 D5 C5:.5 B4:.5  A4 A4:.5 C5:.5 E5 D5:.5 C5:.5  B4:1.5 C5:.5 D5 E5  C5 A4 A4:2   _:.5 D5 F5:.5 A5 G5:.5 F5:.5  E5:1.5 C5:.5 E5 D5:.5 C5:.5  B4 B4:.5 C5:.5 D5 E5  C5 A4 A4:2' },
    { timbre: 'bass', tilt: 40, notes: 'E3:2 B3:2  A3:2 E3:2  E3:2 B3:2  A3:2 E3:2   D3:2 A3:2  C3:2 G3:2  E3:2 B3:2  A3:2 E3:2' },
    { drum: 'kick', notes: rep('x:4', 8) }, { drum: 'tom', notes: rep('_:2 x:2', 8) }, { drum: 'hat', notes: rep('_:.5 x:.5', 32) },
  ] },
  { id: 'hava-nagila', title: 'Hava Nagila', author: 'traditionnel', style: 'klezmer', scale: 'hijaz', root: 4, bpm: 126, turn: 16, voices: [
    { timbre: 'guitar', notes: 'E4:1.5 E4:.5 G#4 F4:.5 E4:.5  G#4:1.5 G#4:.5 B4 A4:.5 G#4:.5  A4:1.5 A4:.5 C5 B4:.5 A4:.5  G#4 F4:.5 E4:.5 E4:2' },
    { timbre: 'bass', tilt: 40, notes: 'E3 B3 E3 B3  E3 B3 E3 B3  A3 E3 A3 E3  E3 B3 E3 B3' },
    { drum: 'kick', notes: rep('x:2', 8) }, { drum: 'hat', notes: rep('_:.5 x:.5', 16) },
    { bell: true, notes: 'EG#B:4 EG#B:4 ACE:4 EG#B:4' },
  ] },
  { id: 'sakura', title: 'Sakura Sakura', author: 'traditionnel japonais', style: 'Japon', scale: 'hira', root: 9, bpm: 72, turn: 56, voices: [
    { timbre: 'harp', notes: 'A5 A5 B5:2  A5 A5 B5:2  A5 B5 C6 B5  A5 B5:.5 A5:.5 F5:2  E5 C5 E5 F5  E5 E5:.5 C5:.5 B4:2  A5 B5 C6 B5  A5 B5:.5 A5:.5 F5:2  E5 C5 E5 F5  E5 E5:.5 C5:.5 B4:2  A5 A5 B5:2  A5 A5 B5:2  E5 F5 B5:.5 A5:.5 F5  E5:4' },
    { timbre: 'bass', tilt: 40, notes: 'A2:4 A2:4 A2:4 A2:4 A2:4 E3:4 A2:4 A2:4 A2:4 E3:4 A2:4 A2:4 A2:4 E3:4' },
    { drum: 'kick', notes: 'x:28 x:28' },
    { bell: true, notes: 'ACE:4 ACE:4 ACE:4 ACE:4 ACE:4 EB:4 ACE:4 ACE:4 ACE:4 EB:4 ACE:4 ACE:4 ACE:4 EB:4' },
  ] },
  { id: 'amazing-grace', title: 'Amazing Grace', author: 'traditionnel', style: 'gospel', scale: 'major', root: 7, bpm: 84, turn: 48, voices: [
    { timbre: 'harp', notes: 'G5:2 B5:.5 G5:.5  B5:2 A5  G5:2 E5  D5:2 D5  G5:2 B5:.5 G5:.5  B5:2 A5  D6:3  _:2 B5   D6:1.5 B5:.5 D6:.5 B5:.5  G5:2 D5  E5:1.5 G5:.5 G5:.5 E5:.5  D5:2 D5  G5:2 B5:.5 G5:.5  B5:2 A5  G5:3  _:2 D5' },
    { timbre: 'bass', tilt: 40, notes: 'G3:3 G3:3 C3:3 G3:3 G3:3 E3:3 D3:3 D3:3  G3:3 G3:3 C3:3 G3:3 G3:3 D3:3 G3:3 G3:3' },
    { bell: true, notes: 'GBD:3 GBD:3 CEG:3 GBD:3 GBD:3 EGB:3 DF#A:3 DF#A:3  GBD:3 GBD:3 CEG:3 GBD:3 GBD:3 DF#A:3 GBD:3 GBD:3' },
  ] },
  { id: 'frere-jacques', title: 'Frère Jacques, en canon', author: 'traditionnel', style: 'comptine', scale: 'major', root: 0, bpm: 112, turn: 32, voices: (() => {
    const air = 'C D E C  C D E C  E F G:2  E F G:2  G:.5 A:.5 G:.5 F:.5 E C  G:.5 A:.5 G:.5 F:.5 E C  C g C:2  C g C:2'
    const at = (o) => air.replace(/g/g, `G${o - 1}`).replace(/\b([A-G])(?=[\s:]|$)/g, `$1${o}`)
    const late = at(4).split(/\s{2,}/)                       // la deuxième voix entre deux mesures plus tard
    return [{ timbre: 'harp', notes: at(5) }, { timbre: 'guitar', tilt: 40, notes: [...late.slice(6), ...late.slice(0, 6)].join('  ') },
      { drum: 'tom', notes: rep('x:4', 8) }, { bell: true, notes: '_:24 CEG GBD CEG _ CEG GBD CEG _' }]   // ding, dang, dong
  })() },
]

mkdirSync(OUT, { recursive: true })
for (const f of readdirSync(OUT)) unlinkSync(OUT + f)
const index = []
for (const piece of PIECES) {
  const file = build(piece)
  writeFileSync(`${OUT}${piece.id}.json`, JSON.stringify(file))
  index.push({ id: piece.id, title: file.title, style: piece.style })
  const count = (k) => file.things.filter((t) => t.kind === k).length
  console.log(`${piece.id} : ${count('string')} cordes, ${count('drum')} tambours, ${count('bell')} clochettes, ${piece.turn} temps à ${piece.bpm}`)
}
if (skipped.length) console.log(`clochettes impossibles, laissées de côté : ${skipped.join(' ; ')}`)
writeFileSync(`${OUT}index.json`, JSON.stringify(index, null, 1))
