import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseIco, pngSize, REQUIRED_ICO_SIZES, solidBitmap, TRAY_REPRESENTATIONS } from './trayAssets'

const build = path.resolve(__dirname, '..', 'build')

describe('tray and application icon assets', () => {
  it('ships a multi-resolution PNG-backed ICO with every required size', () => {
    const entries = parseIco(fs.readFileSync(path.join(build, 'icon.ico')))
    const sizes = entries.map(entry => entry.width)
    for (const required of REQUIRED_ICO_SIZES) expect(sizes).toContain(required)
    expect(entries.every(entry => entry.width === entry.height && entry.bpp === 32 && entry.isPng)).toBe(true)
  })

  it('ships one correctly sized PNG for each Windows scale factor', () => {
    for (const { size } of TRAY_REPRESENTATIONS) {
      const dimensions = pngSize(fs.readFileSync(path.join(build, 'tray', `tray-${size}.png`)))
      expect(dimensions).toEqual({ width: size, height: size })
    }
  })

  it('rejects files that are not icons', () => {
    expect(() => parseIco(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow()
    expect(() => pngSize(Buffer.alloc(40))).toThrow()
  })

  it('builds an opaque fallback bitmap of the requested size', () => {
    const bitmap = solidBitmap(8)
    expect(bitmap.length).toBe(8 * 8 * 4)
    expect(bitmap[3]).toBe(255)
  })

  it('electron-builder copies the icon folder outside app.asar', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).build
    const extra = JSON.stringify(config.extraResources ?? [])
    expect(extra).toContain('icon.ico')
    expect(extra).toContain('tray')
  })
})

// ---- Visual quality of the shipped small icons (the original complaint: invisible / unrecognisable tray icon) ----
import { inflateSync } from 'node:zlib'

type Image = { width: number; height: number; rgba: Buffer }
function decodePng(buffer: Buffer): Image {
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  const idat: Buffer[] = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) { if (raw[y * (stride + 1)] !== 0) throw new Error('unexpected PNG filter'); raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1)) }
  return { width, height, rgba }
}
const luminance = (r: number, g: number, b: number) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a[0], a[1], a[2]), luminance(b[0], b[1], b[2])]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const MINT = [0x58, 0xd5, 0xbd], INK = [0x0b, 0x1f, 0x1c], LIGHT_TASKBAR = [0xf3, 0xf3, 0xf3], DARK_TASKBAR = [0x20, 0x20, 0x20]

describe.each([16, 20, 24, 32, 48])('tray icon %i px', size => {
  const image = decodePng(fs.readFileSync(path.join(build, 'tray', `tray-${size}.png`)))
  const pixel = (x: number, y: number) => { const o = (y * size + x) * 4; return [image.rgba[o], image.rgba[o + 1], image.rgba[o + 2], image.rgba[o + 3]] }

  it('is a round face: transparent corners, mostly opaque body', () => {
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) expect(pixel(x, y)[3]).toBe(0)
    let opaque = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (pixel(x, y)[3] > 200) opaque++
    expect(opaque / (size * size)).toBeGreaterThan(0.6)
  })

  it('has the three colour roles needed to read as a clock: mint face, dark outline, dark hands', () => {
    let mint = 0, ink = 0, innerInk = 0, opaque = 0
    const center = size / 2
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      if (a < 200) continue
      opaque++
      const nearMint = Math.hypot(r - MINT[0], g - MINT[1], b - MINT[2]) < 40, nearInk = Math.hypot(r - INK[0], g - INK[1], b - INK[2]) < 40
      if (nearMint) mint++
      if (nearInk) { ink++; if (Math.hypot(x + 0.5 - center, y + 0.5 - center) < size * 0.36) innerInk++ }
    }
    expect(mint / opaque).toBeGreaterThan(0.45)
    expect(ink / opaque).toBeGreaterThan(0.1)
    expect(innerInk).toBeGreaterThanOrEqual(Math.round(size * 0.5)) // the hands exist inside the face, not just the rim
  })

  it('has readable contrast on both light and dark taskbars (WCAG ratios)', () => {
    expect(contrast(INK, LIGHT_TASKBAR)).toBeGreaterThan(7) // the outline carries the shape on a light taskbar
    expect(contrast(MINT, DARK_TASKBAR)).toBeGreaterThan(7) // the face carries it on a dark one
    expect(contrast(INK, MINT)).toBeGreaterThan(7) // hands against the face
  })
})

it('embeds the same small bitmaps in the ICO as in the tray PNGs (no stale 16-32 px entries)', () => {
  const ico = fs.readFileSync(path.join(build, 'icon.ico'))
  const count = ico.readUInt16LE(4)
  for (let index = 0; index < count; index++) {
    const width = ico[6 + index * 16] || 256
    if (![16, 20, 24, 32, 48].includes(width)) continue
    const size = ico.readUInt32LE(6 + index * 16 + 8), offset = ico.readUInt32LE(6 + index * 16 + 12)
    expect(ico.subarray(offset, offset + size).equals(fs.readFileSync(path.join(build, 'tray', `tray-${width}.png`)))).toBe(true)
  }
})
