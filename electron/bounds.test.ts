import { describe, expect, it } from 'vitest'
import { fitBoundsToDisplays, isRect } from './bounds'

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const right = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } }
const left = { id: 3, workArea: { x: -1600, y: 100, width: 1600, height: 860 } }
const widget = { width: 310, height: 220 }

describe('fitBoundsToDisplays', () => {
  it('keeps a valid position on a secondary monitor, including negative coordinates', () => {
    expect(fitBoundsToDisplays({ x: -400, y: 200, ...widget }, [primary, left], primary, widget)).toEqual({ x: -400, y: 200, ...widget })
    expect(fitBoundsToDisplays({ x: 2000, y: 50, ...widget }, [primary, right], primary, widget)).toEqual({ x: 2000, y: 50, ...widget })
  })

  it('moves a window back onto the primary display when its monitor was unplugged', () => {
    const fitted = fitBoundsToDisplays({ x: 2500, y: 100, ...widget }, [primary], primary, widget)
    expect(fitted.x).toBeGreaterThanOrEqual(0)
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(1920)
  })

  it('clamps a partly off-screen window and shrinks one larger than the work area', () => {
    expect(fitBoundsToDisplays({ x: 1800, y: 900, ...widget }, [primary], primary, widget)).toEqual({ x: 1610, y: 820, ...widget })
    const huge = fitBoundsToDisplays({ x: 0, y: 0, width: 5000, height: 4000 }, [primary], primary, widget)
    expect(huge.width).toBe(1920)
    expect(huge.height).toBe(1040)
  })

  it('uses defaults for missing or corrupt rectangles and recentres large windows', () => {
    expect(fitBoundsToDisplays(undefined, [primary], primary, widget)).toMatchObject({ width: 310, height: 220, x: 1920 - 310 - 24 })
    expect(fitBoundsToDisplays({ x: Number.NaN, y: 0, width: 10, height: 10 }, [primary], primary, widget).width).toBe(310)
    const dashboard = fitBoundsToDisplays({ x: 9000, y: 9000, width: 1220, height: 820 }, [primary], primary, { width: 1220, height: 820 })
    expect(dashboard).toEqual({ x: 350, y: 110, width: 1220, height: 820 })
  })

  it('re-fits after a DPI change shrinks the work area', () => {
    const scaled = { id: 1, workArea: { x: 0, y: 0, width: 1280, height: 680 } }
    const fitted = fitBoundsToDisplays({ x: 1500, y: 500, width: 1220, height: 820 }, [scaled], scaled, { width: 1220, height: 820 }, { width: 880, height: 650 })
    expect(fitted.width).toBeLessThanOrEqual(1280)
    expect(fitted.height).toBe(680)
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(1280)
  })

  it('recognises valid rectangles only', () => {
    expect(isRect({ x: 1, y: 2, width: 3, height: 4 })).toBe(true)
    expect(isRect({ x: 1, y: 2, width: 0, height: 4 })).toBe(false)
    expect(isRect(null)).toBe(false)
  })
})
