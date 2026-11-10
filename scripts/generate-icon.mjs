// Generates the application icon set without external dependencies.
//   build/icon.ico            multi-resolution (16/20/24/32/48/64/128/256) ICO used by the installer, exe and tray fallback
//   build/tray/tray-<n>.png   individual PNGs for 100/125/150/200/300 % Windows scaling (16/20/24/32/48)
//   node scripts/generate-icon.mjs --preview <file.png>   also writes a magnified light/dark taskbar preview
//
// Design: a mint clock face with a dark outline and thick dark hands. The outline keeps the shape readable on a LIGHT taskbar
// (mint alone has ~1.5:1 contrast there), the mint disc keeps it readable on a DARK one, and stroke widths are specified in
// device pixels (not scaled down from a large drawing) so the hands survive at 16 px.
import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

export const MINT = { r: 0x58, g: 0xd5, b: 0xbd }
export const INK = { r: 0x0b, g: 0x1f, b: 0x1c }
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
const TRAY_SIZES = [16, 20, 24, 32, 48]

const segmentDistance = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

/** Per-size geometry in device pixels. */
export function geometry(size) {
  const outline = size <= 20 ? 1.1 : size <= 32 ? 1.5 : Math.max(2, size * 0.04)
  const hand = size <= 20 ? 2.1 : size <= 24 ? 2.5 : size <= 32 ? 3.1 : Math.max(4, size * 0.072)
  const radius = size / 2 - (size <= 32 ? 0.4 : size * 0.02)
  return { outline, hand, radius, center: size / 2, ring: size >= 48 ? { radius: radius * 0.78, width: Math.max(1.4, size * 0.03) } : null, ticks: size >= 32 }
}

export function renderRgba(size) {
  const { outline, hand, radius, center, ring, ticks } = geometry(size)
  const samples = size <= 48 ? 8 : 4
  const rgba = Buffer.alloc(size * size * 4)
  const minute = [center, center - radius * 0.56]
  const hour = [center + radius * 0.36, center + radius * 0.21]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let disc = 0, rim = 0, mark = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples, py = y + (sy + 0.5) / samples
      const distance = Math.hypot(px - center, py - center)
      if (distance <= radius) disc++
      if (distance <= radius && distance >= radius - outline) rim++
      const onHand = segmentDistance(px, py, center, center, minute[0], minute[1]) <= hand / 2 || segmentDistance(px, py, center, center, hour[0], hour[1]) <= hand / 2
      const onRing = ring && Math.abs(distance - ring.radius) <= ring.width / 2
      let onTick = false
      if (ticks) for (let k = 0; k < 4 && !onTick; k++) {
        const angle = k * Math.PI / 2
        const inner = radius - outline - Math.max(1.5, size * 0.1), outer = radius - outline - 0.6
        onTick = k !== 0 && segmentDistance(px, py, center + Math.sin(angle) * inner, center - Math.cos(angle) * inner, center + Math.sin(angle) * outer, center - Math.cos(angle) * outer) <= Math.max(0.7, size * 0.02)
      }
      if (distance <= radius && (onHand || onRing || onTick)) mark++
    }
    const total = samples * samples
    const coverage = disc / total
    const offset = (y * size + x) * 4
    if (!coverage) continue
    // Compose inside the disc: mint fill -> dark rim -> dark marks (hands, ring, ticks), weighted by coverage of each layer.
    const rimShare = Math.min(1, rim / Math.max(1, disc)), markShare = Math.min(1, mark / Math.max(1, disc))
    const darkShare = Math.min(1, rimShare + markShare)
    rgba[offset] = Math.round(MINT.r + (INK.r - MINT.r) * darkShare)
    rgba[offset + 1] = Math.round(MINT.g + (INK.g - MINT.g) * darkShare)
    rgba[offset + 2] = Math.round(MINT.b + (INK.b - MINT.b) * darkShare)
    rgba[offset + 3] = Math.round(coverage * 255)
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
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) { rows[y * (stride + 1)] = 0; rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride) }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
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

/** Magnified preview of the small sizes on dark and light taskbar colours (for human review). */
export function previewPng(scale = 8) {
  const sizes = [16, 20, 24, 32]
  const backgrounds = [{ r: 0x20, g: 0x20, b: 0x20 }, { r: 0xf3, g: 0xf3, b: 0xf3 }]
  const pad = 6, cell = 32 * scale + pad * 2
  const width = sizes.length * cell, height = backgrounds.length * cell
  const canvas = Buffer.alloc(width * height * 4)
  backgrounds.forEach((bg, row) => {
    for (let y = 0; y < cell; y++) for (let x = 0; x < width; x++) { const o = ((row * cell + y) * width + x) * 4; canvas[o] = bg.r; canvas[o + 1] = bg.g; canvas[o + 2] = bg.b; canvas[o + 3] = 255 }
    sizes.forEach((size, column) => {
      const icon = renderRgba(size)
      for (let y = 0; y < size * scale; y++) for (let x = 0; x < size * scale; x++) {
        const s = ((Math.floor(y / scale)) * size + Math.floor(x / scale)) * 4
        const a = icon[s + 3] / 255
        const o = ((row * cell + pad + y) * width + column * cell + pad + x) * 4
        canvas[o] = Math.round(icon[s] * a + canvas[o] * (1 - a)); canvas[o + 1] = Math.round(icon[s + 1] * a + canvas[o + 1] * (1 - a)); canvas[o + 2] = Math.round(icon[s + 2] * a + canvas[o + 2] * (1 - a))
      }
    })
  })
  return encodePng(width, height, canvas)
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('generate-icon.mjs')) {
  const rendered = new Map(ICO_SIZES.map(size => [size, encodePng(size, size, renderRgba(size))]))
  await mkdir('build/tray', { recursive: true })
  await writeFile('build/icon.ico', encodeIco(ICO_SIZES.map(size => ({ size, png: rendered.get(size) }))))
  for (const size of TRAY_SIZES) await writeFile(`build/tray/tray-${size}.png`, rendered.get(size))
  const preview = process.argv.indexOf('--preview')
  if (preview > 0) await writeFile(process.argv[preview + 1], previewPng())
  console.log(`Generated build/icon.ico (${ICO_SIZES.join('/')}) and build/tray/tray-{${TRAY_SIZES.join(',')}}.png`)
}
