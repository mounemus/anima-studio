/**
 * Minimal OSC 1.0 binary codec (encode / decode) — enough for VJ interop with
 * Resolume, TouchDesigner, TouchOSC, Ableton, etc.
 *
 * Supported arg types: i (int32), f (float32), s (string), plus decode of
 * T/F/N/I (true/false/null/impulse → 1/0/0/1) and blobs (skipped). Big-endian,
 * 4-byte aligned, per the OSC spec. Bundles are decoded recursively (timetag
 * ignored — we fire immediately).
 *
 * Pure + dependency-free → unit-testable headless (see osc.test.ts).
 */

export type OscArg = number | string
export interface OscMessage { address: string; args: OscArg[] }

const enc = new TextEncoder()
const dec = new TextDecoder()

function padLen(n: number): number { return (n + 3) & ~3 }

// ---------------- ENCODE ----------------

function writeString(bytes: number[], s: string) {
  const b = enc.encode(s)
  for (let i = 0; i < b.length; i++) bytes.push(b[i])
  bytes.push(0)                               // mandatory null terminator
  while (bytes.length % 4 !== 0) bytes.push(0) // pad to 4
}

/** Encode a single OSC message → ArrayBuffer. Numbers default to float32;
 *  pass an explicit 'i'/'f'/'s' via typed args if you need int. */
export function encodeMessage(address: string, args: OscArg[] = []): ArrayBuffer {
  const head: number[] = []
  writeString(head, address)
  let tags = ','
  for (const a of args) tags += typeof a === 'string' ? 's' : 'f'
  writeString(head, tags)

  // arg bytes
  const argBytes: number[] = []
  const dv = new DataView(new ArrayBuffer(4))
  for (const a of args) {
    if (typeof a === 'string') {
      writeString(argBytes, a)
    } else {
      dv.setFloat32(0, a, false) // big-endian
      argBytes.push(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
    }
  }
  const out = new Uint8Array(head.length + argBytes.length)
  out.set(head, 0)
  out.set(argBytes, head.length)
  return out.buffer
}

// ---------------- DECODE ----------------

function readString(view: DataView, offset: number): { str: string; next: number } {
  let end = offset
  while (end < view.byteLength && view.getUint8(end) !== 0) end++
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, end - offset)
  const str = dec.decode(bytes)
  return { str, next: offset + padLen(end - offset + 1) }
}

/** Decode one OSC packet (message OR bundle) into a flat list of messages. */
export function decodePacket(buf: ArrayBuffer): OscMessage[] {
  const view = new DataView(buf)
  if (view.byteLength >= 8 && dec.decode(new Uint8Array(buf, 0, 7)) === '#bundle') {
    return decodeBundle(view, 0, view.byteLength)
  }
  const m = decodeMessage(view, 0, view.byteLength)
  return m ? [m] : []
}

function decodeBundle(view: DataView, start: number, end: number): OscMessage[] {
  const out: OscMessage[] = []
  let off = start + 16 // skip '#bundle\0' (8) + timetag (8)
  while (off + 4 <= end) {
    const size = view.getInt32(off, false); off += 4
    if (size <= 0 || off + size > end) break
    const tag = dec.decode(new Uint8Array(view.buffer, view.byteOffset + off, Math.min(7, size)))
    if (tag === '#bundle') out.push(...decodeBundle(view, off, off + size))
    else { const m = decodeMessage(view, off, off + size); if (m) out.push(m) }
    off += size
  }
  return out
}

function decodeMessage(view: DataView, start: number, end: number): OscMessage | null {
  const a = readString(view, start)
  if (!a.str.startsWith('/')) return null
  let off = a.next
  if (off >= end || view.getUint8(off) !== 44 /* ',' */) return { address: a.str, args: [] }
  const t = readString(view, off)
  const tags = t.str.slice(1) // drop leading ','
  off = t.next
  const args: OscArg[] = []
  for (const tag of tags) {
    if (tag === 'i') { args.push(view.getInt32(off, false)); off += 4 }
    else if (tag === 'f') { args.push(view.getFloat32(off, false)); off += 4 }
    else if (tag === 's') { const s = readString(view, off); args.push(s.str); off = s.next }
    else if (tag === 'd') { args.push(view.getFloat64(off, false)); off += 8 }
    else if (tag === 'T') args.push(1)
    else if (tag === 'F') args.push(0)
    else if (tag === 'N' || tag === 'I') args.push(0)
    else if (tag === 'b') { const n = view.getInt32(off, false); off += 4 + padLen(n) } // skip blob
  }
  return { address: a.str, args }
}

/** First numeric arg of a message (booleans already mapped to 1/0), or 0. */
export function firstNumber(m: OscMessage): number {
  for (const a of m.args) if (typeof a === 'number') return a
  return 0
}
