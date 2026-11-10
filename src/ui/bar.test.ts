import { describe, expect, it } from 'vitest'
import { barStyle } from './bar'

describe('barStyle', () => {
  it('uses a compositor transform, never width (width changes force layout)', () => {
    const style = barStyle(42.5)
    expect(style.transform).toBe('scaleX(0.4250)')
    expect(style).not.toHaveProperty('width')
  })
  it('clamps and sanitises values', () => {
    expect(barStyle(-5).transform).toBe('scaleX(0.0000)')
    expect(barStyle(250).transform).toBe('scaleX(1.0000)')
    expect(barStyle(Number.NaN).transform).toBe('scaleX(0.0000)')
  })
})
it('no stylesheet rule animates width (regression: 25 % CPU from width transitions)', async () => {
  const css = (await import('node:fs')).readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  expect(css).not.toMatch(/transition\s*:[^;}]*\bwidth\b/)
})
