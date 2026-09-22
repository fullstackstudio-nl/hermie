/**
 * A dependency-free SVG rasteriser and PNG writer, shared by the scripts that
 * render this repository's artwork: scripts/generate-app-icons.mjs for the icons
 * the app ships, scripts/generate-store-assets.mjs for the Play listing.
 *
 * Why a renderer instead of a tool: the machines that build this repository are
 * not guaranteed to have rsvg-convert, and the two rasterisers a Mac ships —
 * `sips` cannot read SVG at all, `qlmanage` writes a thumbnail with its own
 * padding — are not something to pin artwork to. So the geometry is flattened
 * and scan-converted here: no dependencies, and the same bytes on every machine,
 * which is what makes a `--check` mode meaningful.
 *
 * The SVG files stay the source of truth. Only the subset they actually use is
 * supported — <rect> with a corner radius, <path> with M/L/H/V/C/S/Q/T/Z, flat
 * fills and two-stop linear gradients in user space — and anything outside that
 * subset throws rather than being skipped.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

/** Sub-scanlines per pixel row. Sixteen is past the point of visible stepping. */
const SUBSAMPLES = 16

// ---------------------------------------------------------------------------
// SVG reading
// ---------------------------------------------------------------------------

function attributes(tag) {
  const found = {}
  // Attribute names carry digits (x1, y2) and hyphens (stop-color); a pattern
  // that forgets the digits silently loses the gradient's geometry.
  for (const match of tag.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g)) {
    found[match[1]] = match[2]
  }
  return found
}

/** Reads a numeric attribute, refusing to carry a NaN into the raster. */
function num(attrs, name, fallback) {
  const raw = attrs[name]
  if (raw === undefined) {
    if (fallback === undefined) {
      throw new Error(`missing required attribute ${name}`)
    }
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`attribute ${name}=${JSON.stringify(raw)} is not a number`)
  }
  return value
}

function parseColour(value) {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value.trim())
  if (!hex) {
    throw new Error(`only six-digit hex colours are supported, got ${JSON.stringify(value)}`)
  }
  const packed = Number.parseInt(hex[1], 16)
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff]
}

/**
 * Reads the shapes out of an SVG, in document order, each tagged with the group
 * it came from so a caller can render one group on its own.
 */
export function readSvg(text) {
  const gradients = new Map()
  for (const block of text.matchAll(/<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
    const attrs = attributes(block[1])
    if (attrs.gradientUnits !== 'userSpaceOnUse') {
      throw new Error('linear gradients must use gradientUnits="userSpaceOnUse"')
    }
    const stops = [...block[2].matchAll(/<stop\b([^/>]*)\/?>/g)].map(stop => {
      const stopAttrs = attributes(stop[1])
      return { offset: num(stopAttrs, 'offset'), colour: parseColour(stopAttrs['stop-color'] ?? '') }
    })
    if (stops.length !== 2 || stops[0].offset !== 0 || stops[1].offset !== 1) {
      throw new Error('linear gradients must have exactly two stops, at offsets 0 and 1')
    }
    gradients.set(attrs.id, {
      kind: 'linear',
      x1: num(attrs, 'x1'),
      y1: num(attrs, 'y1'),
      x2: num(attrs, 'x2'),
      y2: num(attrs, 'y2'),
      stops
    })
  }

  const body = text.replace(/<defs\b[\s\S]*?<\/defs>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const shapes = []
  const groups = []

  for (const token of body.matchAll(/<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, rawAttrs, selfClosing] = token
    if (name === 'svg') {
      continue
    }
    if (name === 'g') {
      if (closing) {
        groups.pop()
      } else {
        groups.push(attributes(rawAttrs).id ?? '')
      }
      continue
    }
    if (closing) {
      continue
    }
    if (!selfClosing) {
      throw new Error(`<${name}> must be self-closing`)
    }
    if (name !== 'rect' && name !== 'path') {
      throw new Error(`unsupported element <${name}>`)
    }

    const attrs = attributes(rawAttrs)
    const reference = /^url\(#(.+)\)$/.exec(attrs.fill ?? '')
    let fill
    if (reference) {
      fill = gradients.get(reference[1])
      if (!fill) {
        throw new Error(`fill refers to unknown gradient #${reference[1]}`)
      }
    } else {
      fill = { kind: 'solid', colour: parseColour(attrs.fill ?? '') }
    }

    shapes.push({ element: name, id: attrs.id ?? '', group: groups[groups.length - 1] ?? '', attrs, fill })
  }

  if (groups.length > 0) {
    throw new Error('unbalanced <g> elements')
  }
  return shapes
}

// ---------------------------------------------------------------------------
// Geometry: everything becomes a list of closed polygons in SVG user units
// ---------------------------------------------------------------------------

/** The circle-to-cubic constant: a quarter circle is this far along its tangents. */
const KAPPA = 0.5522847498307933

function flattenCubic(points, x0, y0, x1, y1, x2, y2, x3, y3) {
  const rough = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
  const steps = Math.min(256, Math.max(8, Math.ceil(rough / 2)))
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    const u = 1 - t
    points.push(
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
    )
  }
}

function rectPolygons(attrs, radiusOverride) {
  const x = num(attrs, 'x', 0)
  const y = num(attrs, 'y', 0)
  const width = num(attrs, 'width')
  const height = num(attrs, 'height')
  const radius = Math.min(radiusOverride ?? num(attrs, 'rx', 0), width / 2, height / 2)

  if (radius <= 0) {
    return [[x, y, x + width, y, x + width, y + height, x, y + height]]
  }

  const points = [x + radius, y]
  const control = radius * KAPPA
  // Clockwise from the top-left corner, one cubic per corner.
  flattenCubic(points, x + width - radius, y, x + width - radius + control, y, x + width, y + radius - control, x + width, y + radius) // prettier-ignore
  flattenCubic(points, x + width, y + height - radius, x + width, y + height - radius + control, x + width - radius + control, y + height, x + width - radius, y + height) // prettier-ignore
  flattenCubic(points, x + radius, y + height, x + radius - control, y + height, x, y + height - radius + control, x, y + height - radius) // prettier-ignore
  flattenCubic(points, x, y + radius, x, y + radius - control, x + radius - control, y, x + radius, y)
  return [points]
}

function pathPolygons(definition) {
  const tokens = definition.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  const polygons = []
  let points = []
  let index = 0
  let command = ''
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastControlX = 0
  let lastControlY = 0

  const number = () => {
    const value = Number(tokens[index])
    index += 1
    if (!Number.isFinite(value)) {
      throw new Error(`malformed path data near token ${index} of ${JSON.stringify(definition)}`)
    }
    return value
  }
  const close = () => {
    if (points.length >= 6) {
      polygons.push(points)
    }
    points = []
  }

  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) {
      command = tokens[index]
      index += 1
    }
    const relative = command === command.toLowerCase()
    const originX = relative ? x : 0
    const originY = relative ? y : 0

    switch (command.toUpperCase()) {
      case 'M': {
        close()
        x = originX + number()
        y = originY + number()
        startX = x
        startY = y
        points = [x, y]
        command = relative ? 'l' : 'L'
        break
      }
      case 'L': {
        x = originX + number()
        y = originY + number()
        points.push(x, y)
        break
      }
      case 'H': {
        x = originX + number()
        points.push(x, y)
        break
      }
      case 'V': {
        y = originY + number()
        points.push(x, y)
        break
      }
      case 'C':
      case 'S': {
        let c1x
        let c1y
        if (command.toUpperCase() === 'S') {
          c1x = 2 * x - lastControlX
          c1y = 2 * y - lastControlY
        } else {
          c1x = originX + number()
          c1y = originY + number()
        }
        const c2x = originX + number()
        const c2y = originY + number()
        const endX = originX + number()
        const endY = originY + number()
        flattenCubic(points, x, y, c1x, c1y, c2x, c2y, endX, endY)
        lastControlX = c2x
        lastControlY = c2y
        x = endX
        y = endY
        break
      }
      case 'Q':
      case 'T': {
        let qx
        let qy
        if (command.toUpperCase() === 'T') {
          qx = 2 * x - lastControlX
          qy = 2 * y - lastControlY
        } else {
          qx = originX + number()
          qy = originY + number()
        }
        const endX = originX + number()
        const endY = originY + number()
        // A quadratic is the cubic with its controls two thirds of the way out.
        flattenCubic(
          points,
          x,
          y,
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          endX + (2 / 3) * (qx - endX),
          endY + (2 / 3) * (qy - endY),
          endX,
          endY
        )
        lastControlX = qx
        lastControlY = qy
        x = endX
        y = endY
        break
      }
      case 'Z': {
        close()
        x = startX
        y = startY
        break
      }
      default:
        throw new Error(`unsupported path command ${JSON.stringify(command)}`)
    }

    if (!'CSQT'.includes(command.toUpperCase())) {
      lastControlX = x
      lastControlY = y
    }
  }

  close()
  return polygons
}

/**
 * The polygons of one shape. `squareCornersOf` names the single id whose corner
 * radius is dropped: a full-bleed icon is masked by the platform, and squaring
 * anything else off with it would be a different logo.
 */
export function shapePolygons(shape, squareCornersOf) {
  if (shape.element === 'rect') {
    const squared = squareCornersOf !== undefined && shape.id === squareCornersOf
    return rectPolygons(shape.attrs, squared ? 0 : undefined)
  }
  return pathPolygons(shape.attrs.d ?? '')
}

export function boundsOf(polygons) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i += 2) {
      minX = Math.min(minX, polygon[i])
      maxX = Math.max(maxX, polygon[i])
      minY = Math.min(minY, polygon[i + 1])
      maxY = Math.max(maxY, polygon[i + 1])
    }
  }
  return { minX, minY, maxX, maxY }
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

function addSpan(row, width, from, to, weight) {
  const start = Math.max(0, from)
  const end = Math.min(width, to)
  if (end <= start) {
    return
  }
  const first = Math.floor(start)
  const last = Math.floor(end)
  if (first === last) {
    row[first] += (end - start) * weight
    return
  }
  row[first] += (first + 1 - start) * weight
  for (let i = first + 1; i < last; i += 1) {
    row[i] += weight
  }
  if (last < width) {
    row[last] += (end - last) * weight
  }
}

/**
 * Non-zero-winding coverage, one polygon set at a time: for every sub-scanline
 * the edge crossings are sorted and the spans that are inside get their exact
 * horizontal overlap added to the pixels they touch.
 */
function coverageOf(polygons, width, height) {
  const edges = []
  for (const polygon of polygons) {
    const count = polygon.length / 2
    for (let i = 0; i < count; i += 1) {
      const next = (i + 1) % count
      const y0 = polygon[i * 2 + 1]
      const y1 = polygon[next * 2 + 1]
      if (y0 !== y1) {
        edges.push({ x0: polygon[i * 2], y0, x1: polygon[next * 2], y1 })
      }
    }
  }

  const coverage = new Float32Array(width * height)
  const crossings = []
  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const row = coverage.subarray(pixelY * width, pixelY * width + width)
    for (let sub = 0; sub < SUBSAMPLES; sub += 1) {
      const y = pixelY + (sub + 0.5) / SUBSAMPLES
      crossings.length = 0
      for (const edge of edges) {
        const low = Math.min(edge.y0, edge.y1)
        const high = Math.max(edge.y0, edge.y1)
        if (y < low || y >= high) {
          continue
        }
        const t = (y - edge.y0) / (edge.y1 - edge.y0)
        crossings.push({ x: edge.x0 + t * (edge.x1 - edge.x0), direction: edge.y1 > edge.y0 ? 1 : -1 })
      }
      if (crossings.length === 0) {
        continue
      }
      crossings.sort((a, b) => a.x - b.x)
      let winding = 0
      for (let i = 0; i < crossings.length - 1; i += 1) {
        winding += crossings[i].direction
        if (winding !== 0) {
          addSpan(row, width, crossings[i].x, crossings[i + 1].x, 1 / SUBSAMPLES)
        }
      }
    }
  }
  return coverage
}

function colourAt(fill, x, y) {
  if (fill.kind === 'solid') {
    return fill.colour
  }
  const dx = fill.x2 - fill.x1
  const dy = fill.y2 - fill.y1
  const lengthSquared = dx * dx + dy * dy
  const raw = lengthSquared === 0 ? 0 : ((x - fill.x1) * dx + (y - fill.y1) * dy) / lengthSquared
  const t = Math.min(1, Math.max(0, raw))
  const [r0, g0, b0] = fill.stops[0].colour
  const [r1, g1, b1] = fill.stops[1].colour
  return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t]
}

/**
 * Draws the given shapes into a straight-alpha RGBA buffer.
 *
 * `transform` maps SVG user units onto the output canvas; gradients are
 * evaluated back in user units so they do not shift when the artwork is scaled,
 * and so a gradient-filled shape painted over another one lands on exactly the
 * colour underneath it.
 *
 * A SHAPE may carry a `transform` of its own, and then that is the one used for
 * it — for its geometry and for the back-mapping its gradient is read through,
 * which have to agree or the fill slides off the shape. One image needing two
 * of them is not a general drawing feature looking for a use: a maskable PWA
 * icon has to put the backdrop at full bleed and the mark inside a circle of
 * 80% of the canvas, and those are two different mappings of the same artwork.
 * Everything else passes one transform and never sees this.
 */
export function render(shapes, { width, height, transform, squareCornersOf, opaque = false }) {
  const count = width * height
  const red = new Float32Array(count)
  const green = new Float32Array(count)
  const blue = new Float32Array(count)
  const alpha = new Float32Array(count)

  for (const shape of shapes) {
    const placement = shape.transform ?? transform
    const polygons = shapePolygons(shape, squareCornersOf).map(polygon => {
      const moved = new Array(polygon.length)
      for (let i = 0; i < polygon.length; i += 2) {
        moved[i] = polygon[i] * placement.scale + placement.x
        moved[i + 1] = polygon[i + 1] * placement.scale + placement.y
      }
      return moved
    })

    const coverage = coverageOf(polygons, width, height)
    for (let pixel = 0; pixel < coverage.length; pixel += 1) {
      const source = Math.min(1, coverage[pixel])
      if (source <= 0) {
        continue
      }
      const userX = ((pixel % width) + 0.5 - placement.x) / placement.scale
      const userY = (Math.floor(pixel / width) + 0.5 - placement.y) / placement.scale
      const [r, g, b] = colourAt(shape.fill, userX, userY)
      const destination = alpha[pixel] * (1 - source)
      const total = source + destination
      red[pixel] = (r * source + red[pixel] * destination) / total
      green[pixel] = (g * source + green[pixel] * destination) / total
      blue[pixel] = (b * source + blue[pixel] * destination) / total
      alpha[pixel] = total
    }
  }

  // An icon Apple compiles must have no alpha channel at all, and neither may a
  // Play feature graphic, so those renders are handed back as three bytes per
  // pixel rather than four.
  const channels = opaque ? 3 : 4
  const pixels = Buffer.alloc(count * channels)
  const byte = value => Math.round(Math.min(255, Math.max(0, value)))
  for (let pixel = 0; pixel < count; pixel += 1) {
    pixels[pixel * channels] = byte(red[pixel])
    pixels[pixel * channels + 1] = byte(green[pixel])
    pixels[pixel * channels + 2] = byte(blue[pixel])
    if (!opaque) {
      pixels[pixel * channels + 3] = byte(alpha[pixel] * 255)
    }
  }
  return { pixels, channels, width, height }
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, checksum])
}

/**
 * Eight-bit truecolour, with or without alpha, every row filtered with Sub. A
 * flat area filters to zeroes and a vertical gradient to a constant row, which
 * is what keeps a 1024 px icon in the tens of kilobytes. Only the four chunks
 * below are written, so the files carry no metadata of any kind.
 */
export function encodePng({ pixels, channels, width, height }) {
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1)
    raw[target] = 1
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      raw[target + 1 + x] = (pixels[y * stride + x] - left) & 0xff
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(channels === 4 ? 6 : 2, 9) // colour type: truecolour, with alpha when asked
  header.writeUInt8(0, 10) // compression
  header.writeUInt8(0, 11) // filter
  header.writeUInt8(0, 12) // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// Writing, and the --check mode that makes CI able to catch drift
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Desktop icon containers (ICNS, ICO)
// ---------------------------------------------------------------------------

/**
 * Packs already-encoded PNGs into an Apple `.icns` container.
 *
 * Only the modern, PNG-carrying OSTypes are written (`ic07` and up — 128 px
 * and larger, plus the two "@2x of a smaller size" codes that share a pixel
 * size with a plain entry, `ic11`/`ic12`). The legacy pre-10.7 types
 * (`ic04`/`ic05`, 16 px and 32 px as raw, PackBits-compressed ARGB, no PNG)
 * exist for OS releases this app does not target (`minimumSystemVersion`
 * 12.0) and are left out rather than reimplementing PackBits for bytes
 * nothing reads. Confirmed against `iconutil`'s own output on this machine:
 * `entries` here reproduces the TLV list a `.iconset` of the same sizes
 * produces, minus the legacy pair and the `info` bookkeeping entry (which
 * `iconutil` writes for its own use and which macOS does not require).
 */
export function encodeIcns(entries) {
  const parts = entries.map(({ type, png }) => {
    if (type.length !== 4) {
      throw new Error(`icns type code must be 4 characters: ${type}`)
    }
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([header, png])
  })
  const body = Buffer.concat(parts)
  const fileHeader = Buffer.alloc(8)
  fileHeader.write('icns', 0, 'ascii')
  fileHeader.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([fileHeader, body])
}

/**
 * Packs already-encoded PNGs into a Windows `.ico` container.
 *
 * Every modern Windows release (Vista and later) accepts a PNG-compressed
 * frame in place of the classic uncompressed DIB, which is all this writes:
 * one `ICONDIRENTRY` per image pointing at that image's raw PNG bytes.
 */
export function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = []
  const data = []
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width, 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height, 0 means 256
    entry.writeUInt8(0, 2) // colour palette: none
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    data.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...data])
}

/**
 * Collects the files a generator produces. In `--check` mode nothing is written
 * and anything that differs from what is on disk is reported at the end.
 */
export function createEmitter({ repoRoot, checkOnly }) {
  const written = []
  const stale = []

  return {
    emit(path, buffer) {
      let current = null
      try {
        current = readFileSync(path)
      } catch {
        current = null
      }
      const same = current !== null && current.equals(buffer)
      if (checkOnly) {
        if (!same) {
          stale.push(relative(repoRoot, path))
        }
        return
      }
      if (!same) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, buffer)
      }
      written.push(`${relative(repoRoot, path)}  ${(buffer.length / 1024).toFixed(1)} kB`)
    },

    /** Prints the outcome, and exits non-zero from a check that found drift. */
    finish({ subject, source, command }) {
      if (!checkOnly) {
        for (const line of written) {
          console.log(`wrote ${line}`)
        }
        return
      }
      if (stale.length > 0) {
        console.error(`These ${subject.toLowerCase()} do not match ${source}:`)
        for (const path of stale) {
          console.error(`  ${path}`)
        }
        console.error(`\nRun \`${command}\` and commit the result.`)
        process.exit(1)
      }
      console.log(`${subject} are in sync with ${source}.`)
    }
  }
}
