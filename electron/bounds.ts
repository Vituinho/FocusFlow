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
