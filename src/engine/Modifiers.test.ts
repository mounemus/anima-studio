import { describe, it, expect } from 'vitest'
import { applyModifiers, rotateHueHex, getColorCycleShift } from './Modifiers'

// Helper: build a flat stride-3 position buffer + stride-2 velocity buffer.
function makeAgents(coords: [number, number][]) {
  const positions = new Float32Array(coords.length * 3)
  const velocities = new Float32Array(coords.length * 2)
  coords.forEach(([x, y], i) => { positions[i * 3] = x; positions[i * 3 + 1] = y })
  return { positions, velocities, count: coords.length }
}
const allFinite = (a: Float32Array) => Array.from(a).every(Number.isFinite)

describe('Modifiers — NaN guards (regression: agents corrupted forever)', () => {
  it('vortex radius=0 with an agent at the exact center never produces NaN', () => {
    const { positions, velocities, count } = makeAgents([[0, 0]])
    applyModifiers(positions, velocities, count, 0.016, 1, [
      { id: 'v', kind: 'vortex', enabled: true, omega: 3, radius: 0, pull: 0.5, center: { x: 0.5, y: 0.5 } } as any,
    ])
    expect(allFinite(positions)).toBe(true)
    expect(allFinite(velocities)).toBe(true)
  })

  it('pulseGate width=0 never produces NaN across a full phase sweep', () => {
    for (let f = 0; f < 200; f++) {
      const { positions, velocities, count } = makeAgents([[0.2, 0.2]])
      velocities[0] = 1; velocities[1] = 1
      applyModifiers(positions, velocities, count, f * 0.05, 1, [
        { id: 'pg', kind: 'pulseGate', enabled: true, bpm: 2, intensity: 3, width: 0 } as any,
      ])
      expect(allFinite(velocities)).toBe(true)
    }
  })

  it('pulseGate clamps velocity magnitude (no exponential blow-up)', () => {
    const { positions, velocities, count } = makeAgents([[0, 0]])
    velocities[0] = 3; velocities[1] = 3
    let maxSpeed = 0
    for (let f = 0; f < 300; f++) {
      applyModifiers(positions, velocities, count, f * 0.001, 1, [
        { id: 'pg', kind: 'pulseGate', enabled: true, bpm: 2, intensity: 4, width: 0.3 } as any,
      ])
      maxSpeed = Math.max(maxSpeed, Math.hypot(velocities[0], velocities[1]))
    }
    expect(maxSpeed).toBeLessThanOrEqual(4.01)
  })
})

describe('Modifiers — correctness', () => {
  it('gravityWell applies distinct forces per agent (stride-2 velocities)', () => {
    const { positions, velocities, count } = makeAgents([[0.5, 0.5], [-0.5, 0.5]])
    applyModifiers(positions, velocities, count, 0.1, 1, [
      { id: 'g', kind: 'gravityWell', enabled: true, wells: [{ x: 0.5, y: 0.5, strength: 1, radius: 1 }] } as any,
    ])
    // Each agent writes to its own stride-2 slot; the two must differ.
    expect(velocities[0]).not.toBe(velocities[2])
    expect(allFinite(velocities)).toBe(true)
  })

  it('vortex rotates an agent around the center', () => {
    const { positions, velocities, count } = makeAgents([[0.5, 0]])
    applyModifiers(positions, velocities, count, 0.5, 1, [
      { id: 'v', kind: 'vortex', enabled: true, omega: 3, radius: 2, pull: 0, center: { x: 0.5, y: 0.5 } } as any,
    ])
    // Position should have moved off the x-axis (rotation), staying finite.
    expect(positions[0]).not.toBeCloseTo(0.5, 5)
    expect(allFinite(positions)).toBe(true)
  })

  it('disabled modifiers are no-ops', () => {
    const { positions, velocities, count } = makeAgents([[0.3, 0.3]])
    const before = Array.from(velocities)
    applyModifiers(positions, velocities, count, 0.1, 1, [
      { id: 'g', kind: 'gravityWell', enabled: false, wells: [{ x: 0.5, y: 0.5, strength: 5, radius: 2 }] } as any,
    ])
    expect(Array.from(velocities)).toEqual(before)
  })
})

describe('Modifiers — colorCycle helpers', () => {
  it('rotateHueHex rotates hue and leaves greys untouched', () => {
    expect(rotateHueHex('#808080', 0.5)).toBe('#808080')           // grey: hue undefined → unchanged
    expect(rotateHueHex('#00ff00', 0.33)).not.toBe('#00ff00')      // green shifts
    expect(rotateHueHex('#00ff00', 0)).toBe('#00ff00')             // zero shift → identity
    expect(rotateHueHex('not-a-color', 0.3)).toBe('not-a-color')   // invalid input → passthrough
  })

  it('getColorCycleShift only counts enabled colorCycle modifiers', () => {
    const none = getColorCycleShift([{ id: 'v', kind: 'vortex', enabled: true } as any])
    expect(none).toBe(0)
    const some = getColorCycleShift([{ id: 'c', kind: 'colorCycle', enabled: true, speedHz: 1, amount: 1 } as any])
    expect(Number.isFinite(some)).toBe(true)
    const off = getColorCycleShift([{ id: 'c', kind: 'colorCycle', enabled: false, speedHz: 1, amount: 1 } as any])
    expect(off).toBe(0)
  })
})
