// Pure helpers for the tray icon files (no Electron import so they can be unit tested).

export const TRAY_REPRESENTATIONS = [
  { size: 16, scaleFactor: 1 },    // 100 %
  { size: 20, scaleFactor: 1.25 }, // 125 %
  { size: 24, scaleFactor: 1.5 },  // 150 %
  { size: 32, scaleFactor: 2 },    // 200 %
  { size: 48, scaleFactor: 3 },    // 300 %
] as const

export const REQUIRED_ICO_SIZES = [16, 20, 24, 32, 48, 256] as const

export type IcoEntry = { width: number; height: number; bpp: number; bytes: number; isPng: boolean }

export function parseIco(buffer: Buffer): IcoEntry[] {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error('Not an ICO file')
  const count = buffer.readUInt16LE(4)
  const entries: IcoEntry[] = []
  for (let index = 0; index < count; index++) {
    const base = 6 + index * 16
    if (base + 16 > buffer.length) throw new Error('Truncated ICO directory')
    const bytes = buffer.readUInt32LE(base + 8), offset = buffer.readUInt32LE(base + 12)
    if (offset + bytes > buffer.length) throw new Error('ICO image data out of range')
    entries.push({
      width: buffer[base] || 256, height: buffer[base + 1] || 256, bpp: buffer.readUInt16LE(base + 6), bytes,
      isPng: buffer.subarray(offset, offset + 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    })
  }
  return entries
}

export function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Not a PNG file')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Last-resort icon (BGRA bitmap, solid brand colour) so the tray entry can never be invisible. */
export function solidBitmap(size: number): Buffer {
  const data = Buffer.alloc(size * size * 4)
  for (let index = 0; index < size * size; index++) {
    const offset = index * 4
    data[offset] = 0xbd; data[offset + 1] = 0xd5; data[offset + 2] = 0x58; data[offset + 3] = 0xff
  }
  return data
}
