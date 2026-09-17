// Generates build/icon.ico with zero third-party dependencies.
// Rasterises the mark with signed-distance fields + supersampling, encodes PNG
// via node:zlib, and packs a multi-size Windows ICO.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SS = 4 // supersample factor per axis

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const mix = (a, b, t) => a + (b - a) * t
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r
  const qy = Math.abs(py) - hh + r
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1)
  return Math.hypot(pax - bax * h, pay - bay * h)
}

function rot(px, py, a) {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [px * c - py * s, px * s + py * c]
}

const BG_TOP = [0x7c, 0x6c, 0xff]
const BG_BOT = [0x35, 0x25, 0xc4]
const CARD = [0xff, 0xff, 0xff]
const INK = [0x28, 0x1c, 0x8c]

// Shades one sample. Coordinates are normalised to [-1, 1], y pointing down.
function shade(x, y, detail) {
  const bgD = sdRoundRect(x, y, 0.965, 0.965, 0.3)
  const bgA = 1 - smoothstep(-0.008, 0.008, bgD)
  if (bgA <= 0) return [0, 0, 0, 0]

  const t = clamp((y + 1) / 2, 0, 1)
  const glow = 1 - smoothstep(0, 1.3, Math.hypot(x + 0.3, y + 0.6))
  let r = mix(BG_TOP[0], BG_BOT[0], t) + glow * 28
  let g = mix(BG_TOP[1], BG_BOT[1], t) + glow * 24
  let b = mix(BG_TOP[2], BG_BOT[2], t) + glow * 20

  const put = (col, a) => {
    if (a <= 0) return
    r = mix(r, col[0], a)
    g = mix(g, col[1], a)
    b = mix(b, col[2], a)
  }

  const aa = 0.011

  if (detail) {
    // Two ghost cards fanned out behind the front card: the "stash".
    const ghosts = [
      [-0.2, -0.3, -0.14, 0.28],
      [-0.1, -0.15, -0.08, 0.48],
    ]
    for (const [ang, ox, oy, alpha] of ghosts) {
      const [rx, ry] = rot(x - ox, y - oy, ang)
      const d = sdRoundRect(rx, ry, 0.4, 0.5, 0.11)
      put(CARD, (1 - smoothstep(-aa, aa, d)) * alpha)
    }
  }

  const cx = detail ? 0.1 : 0
  const cy = detail ? 0.06 : 0
  const hw = detail ? 0.44 : 0.58
  const hh = detail ? 0.54 : 0.64
  const cd = sdRoundRect(x - cx, y - cy, hw, hh, detail ? 0.12 : 0.16)
  const inCard = 1 - smoothstep(-aa, aa, cd)
  put(CARD, inCard)

  // Terminal-prompt glyph on the front card.
  if (inCard > 0) {
    const sx = x - cx
    const sy = y - cy
    const k = detail ? 1 : 1.2
    const w = (detail ? 0.085 : 0.095) * k
    const ay = 0.2 * k
    const ax0 = -0.19 * k
    const ax1 = 0.03 * k
    const chev =
      Math.min(sdSegment(sx, sy, ax0, -ay, ax1, 0), sdSegment(sx, sy, ax1, 0, ax0, ay)) - w / 2
    put(INK, (1 - smoothstep(-aa, aa, chev)) * inCard)
    const bar = sdSegment(sx, sy, 0.11 * k, 0.2 * k, 0.29 * k, 0.2 * k) - w / 2
    put(INK, (1 - smoothstep(-aa, aa, bar)) * inCard)
  }

  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255), bgA * 255]
}

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const detail = size >= 48
  const n = SS * SS
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let R = 0
      let G = 0
      let B = 0
      let A = 0
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = ((i + (si + 0.5) / SS) / size) * 2 - 1
          const y = ((j + (sj + 0.5) / SS) / size) * 2 - 1
          const [sr, sg, sb, sa] = shade(x, y, detail)
          const w = sa / 255
          R += sr * w
          G += sg * w
          B += sb * w
          A += sa
        }
      }
      // Un-premultiply so edge pixels keep their colour instead of fading to black.
      const wsum = A / 255 || 1
      const o = (j * size + i) * 4
      px[o] = Math.round(clamp(R / wsum, 0, 255))
      px[o + 1] = Math.round(clamp(G / wsum, 0, 255))
      px[o + 2] = Math.round(clamp(B / wsum, 0, 255))
      px[o + 3] = Math.round(A / n)
    }
  }
  return px
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePNG(rgba, size) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter type: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function encodeBMP(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // height is doubled: XOR bitmap + AND mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4 // BMP rows run bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
    }
  }
  const andStride = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(andStride * size) // zeroed: the alpha channel governs
  return Buffer.concat([header, xor, and])
}

const entries = SIZES.map((size) => {
  const rgba = render(size)
  return { size, data: size >= 256 ? encodePNG(rgba, size) : encodeBMP(rgba, size) }
})

const dir = Buffer.alloc(6 + entries.length * 16)
dir.writeUInt16LE(1, 2)
dir.writeUInt16LE(entries.length, 4)
let offset = dir.length
entries.forEach((e, i) => {
  const p = 6 + i * 16
  dir[p] = e.size >= 256 ? 0 : e.size
  dir[p + 1] = e.size >= 256 ? 0 : e.size
  dir.writeUInt16LE(1, p + 4)
  dir.writeUInt16LE(32, p + 6)
  dir.writeUInt32LE(e.data.length, p + 8)
  dir.writeUInt32LE(offset, p + 12)
  offset += e.data.length
})

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.concat([dir, ...entries.map((e) => e.data)]))
writeFileSync(resolve(dirname(OUT), 'icon.png'), encodePNG(render(512), 512))
console.log('icon.ico written: ' + SIZES.join(', ') + 'px -> ' + OUT)
