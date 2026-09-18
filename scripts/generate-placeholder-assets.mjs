#!/usr/bin/env node
// Writes the flat-colour placeholder artwork that ships until the real icon set
// lands. Re-runnable: it always produces byte-identical files.
//
//   node scripts/generate-placeholder-assets.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const assetsDir = resolve(here, '../apps/hermie/assets')

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, checksum])
}

function solidPng(width, height, [r, g, b]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(2, 9) // colour type: truecolour
  header.writeUInt8(0, 10) // compression
  header.writeUInt8(0, 11) // filter
  header.writeUInt8(0, 12) // interlace

  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0 // per-row filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3
      raw[pixel] = r
      raw[pixel + 1] = g
      raw[pixel + 2] = b
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const INK = [11, 13, 16]
const ACCENT = [74, 124, 255]

const assets = [
  { file: 'icon.png', width: 1024, height: 1024, colour: ACCENT },
  { file: 'adaptive-icon.png', width: 1024, height: 1024, colour: ACCENT },
  { file: 'splash-icon.png', width: 512, height: 512, colour: ACCENT },
  { file: 'favicon.png', width: 48, height: 48, colour: ACCENT },
  { file: 'macos-icon.png', width: 1024, height: 1024, colour: INK }
]

mkdirSync(assetsDir, { recursive: true })
for (const asset of assets) {
  const target = resolve(assetsDir, asset.file)
  writeFileSync(target, solidPng(asset.width, asset.height, asset.colour))
  console.log(`wrote ${target}`)
}
