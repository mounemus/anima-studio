import { describe, it, expect, vi, afterEach } from 'vitest'
import { setItem, getItem, hasStorage } from './storage'

afterEach(() => { vi.restoreAllMocks() })

describe('storage — quota / failure surfacing', () => {
  it('round-trips a value', () => {
    expect(setItem('probe', { a: 1 })).toBe(true)
    expect(getItem<{ a: number }>('probe')).toEqual({ a: 1 })
  })

  it('returns false AND dispatches anima:storage-error on QuotaExceededError', () => {
    const events: any[] = []
    const handler = (e: Event) => events.push((e as CustomEvent).detail)
    window.addEventListener('anima:storage-error', handler)

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    const ok = setItem('big', { data: 'x'.repeat(10) })
    expect(ok).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0].quota).toBe(true)
    expect(typeof events[0].message).toBe('string')

    window.removeEventListener('anima:storage-error', handler)
  })

  it('getItem returns null on malformed JSON instead of throwing', () => {
    localStorage.setItem('anima:bad', '{not json')
    expect(getItem('bad')).toBeNull()
  })

  it('hasStorage reports availability', () => {
    expect(typeof hasStorage()).toBe('boolean')
  })
})
