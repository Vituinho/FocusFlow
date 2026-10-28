import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const size = 256
const scale = 4
const pngColor = { r: 0x58, g: 0xd5, b: 0xbd }
const ink = { r: 0x10, g: 0x13, b: 0x17 }
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
const pixel = (x, y) => {
  let bg = 0, ring = 0, hand = 0
  for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
    const px = x + (sx + 0.5) / scale, py = y + (sy + 0.5) / scale
    if (rounded(px, py, 8, 8, 248, 248, 54)) bg++
    if (Math.abs(Math.hypot(px - 130, py - 130) - 70) <= 4.5) ring++
    if (segmentDistance(px, py, 130, 130, 130, 92) <= 5 || segmentDistance(px, py, 130, 130, 169, 154) <= 5 || Math.hypot(px - 130, py - 130) <= 5) hand++
  }
  const coverage = value => Math.round(value / (scale * scale) * 255)
  const backgroundAlpha = coverage(bg)
  const inkAlpha = Math.max(coverage(ring), coverage(hand))
  if (inkAlpha) return [ink.r, ink.g, ink.b, inkAlpha]
  if (backgroundAlpha) return [pngColor.r, pngColor.g, pngColor.b, backgroundAlpha]
  return [0, 0, 0, 0]
}
const rows = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1)
  rows[row] = 0
  for (let x = 0; x < size; x++) pixel(x, y).forEach((value, channel) => { rows[row + 1 + x * 4 + channel] = value })
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
const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
header[8] = 8; header[9] = 6
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
])
const icoHeader = Buffer.alloc(22)
icoHeader.writeUInt16LE(0, 0); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4)
icoHeader[6] = 0; icoHeader[7] = 0; icoHeader[8] = 0; icoHeader[9] = 0
icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12)
icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18)
await mkdir('build', { recursive: true })
await writeFile('build/icon.ico', Buffer.concat([icoHeader, png]))
console.log(`Generated build/icon.ico (${png.length} byte PNG payload).`)
