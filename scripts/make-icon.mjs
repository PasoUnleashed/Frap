/**
 * Generates build/icon.png (1024x1024) with no image dependencies.
 * electron-builder converts it to .ico / .icns at package time.
 *
 * Run with: node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const here = dirname(fileURLToPath(import.meta.url))

/* --- minimal PNG encoder ------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* --- the artwork --------------------------------------------------- */

const mix = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => Math.min(1, Math.max(0, v))

/** Signed distance to a rounded rectangle, used for crisp antialiased edges. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - radius
}

const pixels = Buffer.alloc(SIZE * SIZE * 4)

// Glyph: a blocky "F" built from three rounded bars.
const bars = [
  { cx: 0.335, cy: 0.5, w: 0.1, h: 0.46, r: 0.045 }, // stem
  { cx: 0.5, cy: 0.315, w: 0.43, h: 0.1, r: 0.045 }, // top arm
  { cx: 0.455, cy: 0.5, w: 0.34, h: 0.095, r: 0.043 } // middle arm
]

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const u = x / SIZE
    const v = y / SIZE
    const i = (y * SIZE + x) * 4

    // Rounded app-icon silhouette.
    const outer = roundedRectDistance(u, v, 0.5, 0.5, 0.5, 0.5, 0.225)
    const alpha = clamp01(0.5 - outer * SIZE)
    if (alpha <= 0) continue

    // Diagonal gradient, blue into violet.
    const t = clamp01((u + v) / 2)
    let r = mix(0x33, 0x8b, t)
    let g = mix(0x5c, 0x53, t)
    let b = mix(0xd6, 0xf7, t)

    // Subtle top-left sheen so it does not read as flat.
    const sheen = clamp01(1 - Math.hypot(u - 0.22, v - 0.16) * 1.9) * 0.16
    r = mix(r, 255, sheen)
    g = mix(g, 255, sheen)
    b = mix(b, 255, sheen)

    let glyph = 0
    for (const bar of bars) {
      const d = roundedRectDistance(u, v, bar.cx, bar.cy, bar.w / 2, bar.h / 2, bar.r)
      glyph = Math.max(glyph, clamp01(0.5 - d * SIZE))
    }
    r = mix(r, 255, glyph)
    g = mix(g, 255, glyph)
    b = mix(b, 255, glyph)

    pixels[i] = Math.round(r)
    pixels[i + 1] = Math.round(g)
    pixels[i + 2] = Math.round(b)
    pixels[i + 3] = Math.round(alpha * 255)
  }
}

const out = join(here, '..', 'build')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), encodePng(SIZE, SIZE, pixels))
console.log(`wrote ${join(out, 'icon.png')}`)
