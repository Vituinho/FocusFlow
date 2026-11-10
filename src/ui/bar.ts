import type { CSSProperties } from 'react'

/**
 * Fill of a progress bar as a compositor-only transform instead of `width`. Animating or even re-setting `width` forces a style
 * recalculation and layout of the page (measured: ~40 per second with a 0.4 s width transition on every bar, which cost ~25 % of a CPU
 * core while the dashboard was visible); a transform is applied by the GPU without touching layout.
 */
export function barStyle(percent: number): CSSProperties {
  const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  return { transform: `scaleX(${(clamped / 100).toFixed(4)})` }
}
