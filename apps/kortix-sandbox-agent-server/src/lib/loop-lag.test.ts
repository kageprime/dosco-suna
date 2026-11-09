import { afterEach, describe, expect, test } from 'bun:test'
import { loopLagMs, observeLoopLag, resetLoopLagSampleForTests } from './loop-lag'

const t0 = 1_700_000_000_000

describe('loopLagMs (KRTX-4459)', () => {
  afterEach(() => {
    resetLoopLagSampleForTests()
  })

  test('a slip only the interval could catch is the peak, floored at zero', () => {
    observeLoopLag(0, t0)
    observeLoopLag(4_200, t0 + 250)
    expect(loopLagMs()).toBe(4_200)
  })

  test('a new smaller slip within the window does not lower the peak', () => {
    observeLoopLag(4_200, t0)
    observeLoopLag(40, t0 + 3_000)
    expect(loopLagMs()).toBe(4_200)
  })

  test('past the window the newest slip wins', () => {
    observeLoopLag(4_200, t0)
    observeLoopLag(12, t0 + 15_250)
    expect(loopLagMs()).toBe(12)
  })

  test('clean ticks fold a stall out one window after the stall, and never extend it (the interval ticks clean ~0)', () => {
    observeLoopLag(4_200, t0)
    for (let i = 1; i <= 59; i++) observeLoopLag(0, t0 + i * 250)
    expect(loopLagMs()).toBe(4_200)
    observeLoopLag(0, t0 + 15_000)
    expect(loopLagMs()).toBe(0)
  })

  test('a negative slip is folded as zero', () => {
    observeLoopLag(-3, t0)
    expect(loopLagMs()).toBe(0)
  })
})
