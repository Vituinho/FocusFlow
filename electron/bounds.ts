export type Rect = { x: number; y: number; width: number; height: number }
export type DisplayInfo = { id: number; workArea: Rect }

export const isRect = (value: unknown): value is Rect => {
  if (!value || typeof value !== 'object') return false
  const rect = value as Rect
  return [rect.x, rect.y, rect.width, rect.height].every(item => typeof item === 'number' && Number.isFinite(item)) && rect.width > 0 && rect.height > 0
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * Makes a stored window rectangle valid for the displays that exist right now.
 * Handles unplugged monitors, resolution/DPI changes and windows larger than the work area.
 * Coordinates are DIPs, as reported by Electron's screen API.
 */
export function fitBoundsToDisplays(saved: Rect | undefined, displays: DisplayInfo[], primary: DisplayInfo, fallbackSize: { width: number; height: number }, minimum = { width: 0, height: 0 }): Rect {
  const base: Rect = isRect(saved) ? saved : { x: primary.workArea.x, y: primary.workArea.y, ...fallbackSize }
  let target = primary
  let best = 0
  for (const display of displays) {
    const area = overlapArea(base, display.workArea)
    if (area > best) { best = area; target = display }
  }
  const work = target.workArea
  const width = Math.max(Math.min(minimum.width, work.width), Math.min(Math.round(base.width), work.width))
  const height = Math.max(Math.min(minimum.height, work.height), Math.min(Math.round(base.height), work.height))
  const visibleEnough = best >= Math.min(base.width * base.height * 0.25, 120 * 120)
  if (!isRect(saved) || !visibleEnough) {
    // No usable position: top-right of the primary work area for small widgets, centred otherwise.
    const area = primary.workArea
    const small = width * height < area.width * area.height * 0.2
    return small
      ? { x: area.x + area.width - width - 24, y: area.y + 40, width: Math.min(width, area.width), height: Math.min(height, area.height) }
      : { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }
  }
  return {
    x: Math.round(Math.max(work.x, Math.min(base.x, work.x + work.width - width))),
    y: Math.round(Math.max(work.y, Math.min(base.y, work.y + work.height - height))),
    width, height,
  }
}

/** A window's minimum size can never exceed the work area it lives on (high DPI scaling shrinks the work area in DIPs). */
export function minimumSizeFor(minimum: { width: number; height: number }, workArea: Rect): { width: number; height: number } {
  return { width: Math.max(1, Math.min(minimum.width, Math.floor(workArea.width))), height: Math.max(1, Math.min(minimum.height, Math.floor(workArea.height))) }
}

/**
 * Is the window where a user can reach it? True when a meaningful part of it is on some work area and its top edge (title/drag area) is
 * inside that work area. Windows the user deliberately parked partly off-screen are therefore left alone.
 */
export function isUsableBounds(bounds: Rect | undefined, displays: DisplayInfo[]): boolean {
  if (!isRect(bounds)) return false
  return displays.some(display => {
    const area = display.workArea
    return overlapArea(bounds, area) >= Math.min(bounds.width * bounds.height * 0.25, 200 * 100) && bounds.y >= area.y - 8 && bounds.y <= area.y + area.height - 40
  })
}

/** After a display change: leave a usable window exactly where it is; only an unreachable or oversized one is moved. */
export function refitIfNeeded(current: Rect, displays: DisplayInfo[], primary: DisplayInfo, minimum: { width: number; height: number }): { rect: Rect; changed: boolean } {
  const workArea = (displays.find(display => overlapArea(current, display.workArea) > 0) ?? primary).workArea
  const oversized = current.width > workArea.width + 2 || current.height > workArea.height + 2
  if (isUsableBounds(current, displays) && !oversized) return { rect: current, changed: false }
  const rect = fitBoundsToDisplays(current, displays, primary, { width: current.width, height: current.height }, minimum)
  return { rect, changed: rect.x !== current.x || rect.y !== current.y || rect.width !== current.width || rect.height !== current.height }
}
