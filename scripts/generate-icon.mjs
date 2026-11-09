// Generates the application icon set without external dependencies.
//   build/icon.ico            multi-resolution (16/20/24/32/48/64/128/256) ICO used by the installer, exe and tray fallback
//   build/tray/tray-<n>.png   individual PNGs for 100/125/150/200/300 % Windows scaling (16/20/24/32/48)
import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const mint = { r: 0x58, g: 0xd5, b: 0xbd }
const ink = { r: 0x10, g: 0x13, b: 0x17 }
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
const TRAY_SIZES = [16, 20, 24, 32, 48]

const rounded = (x, y, left, top, right, bottom, radius) => {
  const cx = Math.max(left + radius, Math.min(x, right - radius))
  const cy = Math.max(top + radius, Math.min(y, bottom - radius))
  return Math.hypot(x - cx, y - cy) <= radius
}
const segmentDistance = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

// Geometry is authored on a 256 grid. Strokes are widened for small sizes so the clock stays legible at 16 px.
function renderRgba(size) {
  const unit = 256 / size
  const ringHalf = Math.max(4.5, 0.95 * unit)
  const handHalf = Math.max(5, 1.05 * unit)
  const samples = size <= 32 ? 8 : 4
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let bg = 0, ring = 0, hand = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + 0.5) / samples) * unit, py = (y + (sy + 0.5) / samples) * unit
      if (rounded(px, py, 8, 8, 248, 248, 54)) bg++
      if (Math.abs(Math.hypot(px - 130, py - 130) - 70) <= ringHalf) ring++
      if (segmentDistance(px, py, 130, 130, 130, 92) <= handHalf || segmentDistance(px, py, 130, 130, 169, 154) <= handHalf || Math.hypot(px - 130, py - 130) <= handHalf) hand++
    }
    const total = samples * samples
    const cover = value => Math.round(value / total * 255)
    const inkAlpha = Math.max(cover(ring), cover(hand)), bgAlpha = cover(bg)
    const offset = (y * size + x) * 4
    // Ink drawn over the mint tile; the tile alpha stays at its own coverage so edges are clean.
    const inkMix = bgAlpha ? Math.min(1, inkAlpha / Math.max(1, bgAlpha)) : 0
    const color = { r: Math.round(mint.r + (ink.r - mint.r) * inkMix), g: Math.round(mint.g + (ink.g - mint.g) * inkMix), b: Math.round(mint.b + (ink.b - mint.b) * inkMix) }
    rgba[offset] = color.r; rgba[offset + 1] = color.g; rgba[offset + 2] = color.b; rgba[offset + 3] = Math.max(bgAlpha, inkAlpha)
  }
  return rgba
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
const crc32 = buffer => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
function encodePng(size, rgba) {
  const stride = size * 4
  const rows = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) { rows[y * (stride + 1)] = 0; rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride) }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + entries.length
  images.forEach(({ size, png }, index) => {
    const base = index * 16
    entries[base] = size >= 256 ? 0 : size; entries[base + 1] = size >= 256 ? 0 : size
    entries.writeUInt16LE(1, base + 4); entries.writeUInt16LE(32, base + 6)
    entries.writeUInt32LE(png.length, base + 8); entries.writeUInt32LE(offset, base + 12)
    offset += png.length
  })
  return Buffer.concat([header, entries, ...images.map(image => image.png)])
}

const rendered = new Map(ICO_SIZES.map(size => [size, encodePng(size, renderRgba(size))]))
await mkdir('build/tray', { recursive: true })
await writeFile('build/icon.ico', encodeIco(ICO_SIZES.map(size => ({ size, png: rendered.get(size) }))))
for (const size of TRAY_SIZES) await writeFile(`build/tray/tray-${size}.png`, rendered.get(size))
console.log(`Generated build/icon.ico (${ICO_SIZES.join('/')}) and build/tray/tray-{${TRAY_SIZES.join(',')}}.png`)
