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
