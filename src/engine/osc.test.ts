import { describe, it, expect } from 'vitest'
import { encodeMessage, decodePacket, firstNumber } from './osc'

describe('OSC codec — encode/decode roundtrip', () => {
  it('roundtrips a float message', () => {
    const buf = encodeMessage('/1/fader1', [0.42])
    const [m] = decodePacket(buf)
    expect(m.address).toBe('/1/fader1')
    expect(m.args.length).toBe(1)
    expect(m.args[0] as number).toBeCloseTo(0.42, 5)
  })

  it('roundtrips mixed args (floats + string)', () => {
    const buf = encodeMessage('/anima/audio', [0.1, 0.9, 'hi'])
    const [m] = decodePacket(buf)
    expect(m.address).toBe('/anima/audio')
    expect(m.args[0] as number).toBeCloseTo(0.1, 5)
    expect(m.args[1] as number).toBeCloseTo(0.9, 5)
    expect(m.args[2]).toBe('hi')
  })

  it('4-byte alignment holds for odd-length addresses', () => {
    for (const addr of ['/a', '/ab', '/abc', '/abcd', '/x/y/zzz']) {
      const buf = encodeMessage(addr, [1.5])
      expect(buf.byteLength % 4).toBe(0)
      const [m] = decodePacket(buf)
      expect(m.address).toBe(addr)
      expect(m.args[0] as number).toBeCloseTo(1.5, 5)
    }
  })

  it('decodes a no-arg message', () => {
    const [m] = decodePacket(encodeMessage('/ping', []))
    expect(m.address).toBe('/ping')
    expect(m.args.length).toBe(0)
  })

  it('firstNumber extracts the first numeric arg', () => {
    const [m] = decodePacket(encodeMessage('/v', ['label', 0.7]))
    expect(firstNumber(m)).toBeCloseTo(0.7, 5)
  })

  it('decodes a hand-built bundle of two messages', () => {
    // Build a #bundle wrapping two encoded messages
    const m1 = new Uint8Array(encodeMessage('/a', [1]))
    const m2 = new Uint8Array(encodeMessage('/b', [2]))
    const enc = new TextEncoder()
    const head = new Uint8Array(16) // '#bundle\0' + 8-byte timetag(=1, immediate)
    head.set(enc.encode('#bundle'), 0)
    head[15] = 1
    const parts = [m1, m2]
    let total = 16
    for (const p of parts) total += 4 + p.length
    const out = new Uint8Array(total)
    out.set(head, 0)
    const dv = new DataView(out.buffer)
    let off = 16
    for (const p of parts) { dv.setInt32(off, p.length, false); off += 4; out.set(p, off); off += p.length }
    const msgs = decodePacket(out.buffer)
    expect(msgs.map((m) => m.address)).toEqual(['/a', '/b'])
    expect(firstNumber(msgs[0])).toBeCloseTo(1, 5)
    expect(firstNumber(msgs[1])).toBeCloseTo(2, 5)
  })

  it('handles a truncated/garbage packet without throwing', () => {
    expect(() => decodePacket(new Uint8Array([1, 2, 3]).buffer)).not.toThrow()
    expect(() => decodePacket(new Uint8Array(0).buffer)).not.toThrow()
  })
})
