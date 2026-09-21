#!/usr/bin/env node
/**
 * Rasterises design/icon.svg into every icon the app ships.
 *
 *   node scripts/generate-app-icons.mjs
 *   node scripts/generate-app-icons.mjs --check    # fail if anything is stale
 *
 * The renderer itself lives in scripts/lib/svg-raster.mjs, which also draws the
 * Play listing's artwork (scripts/generate-store-assets.mjs); its header explains
 * why this repository carries a rasteriser instead of calling one, and which
 * subset of SVG it understands. design/icon.svg stays the source of truth: the
 * geometry below is only where each icon is placed on its canvas.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boundsOf, createEmitter, encodePng, readSvg, render, shapePolygons } from './lib/svg-raster.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sourceSvg = resolve(repoRoot, 'design/icon.svg')
const assetsDir = resolve(repoRoot, 'apps/hermie/assets')
/**
 * The browser build's icons.
 *
 * `apps/hermie/public` is copied to the root of the web export verbatim, so
 * these land next to `manifest.webmanifest` — which is the only reason they are
 * not in `assets/` with the rest: nothing bundles them, the manifest names them
 * by URL.
 *
 * There is deliberately no `maskable` icon here. A maskable one has to sit
 * inside a circle of 80% of the canvas ON a filled backdrop, and the mark's
 * corners reach 460 of the 409 that circle allows — so it needs the backdrop at
 * full bleed and the mark shrunk, which is two transforms in one image, and
 * `render` composites every shape through one. Until the rasteriser can layer,
 * Android draws the `any` icon on a white circle of its own.
 */
const webIconsDir = resolve(repoRoot, 'apps/hermie/public/icons')

/**
 * How much of the canvas the mark may fill in an Android adaptive foreground.
 *
 * The outer third of that image is cropped away by whichever mask the launcher
 * picks, which leaves a nominal safe zone of 682 — but that is a square, and a
 * circular mask cuts the corners off it. Measured against the circle rather
 * than the square: at 600 the bubble's top corners land 348 from the centre and
 * the tail tip 364, both outside the 338 the circle allows. 528 puts the
 * corners at 306, inside even the stricter 312 that Android's own guidance
 * uses, and leaves only the taper of the tail near the edge.
 */
const ADAPTIVE_SAFE_BOX = 528

/** Artwork that fills its canvas edge to edge, at whatever size is asked for. */
function fullBleed(size, squareCorners) {
  return {
    width: size,
    height: size,
    transform: { scale: size / 1024, x: 0, y: 0 },
    squareCornersOf: squareCorners ? 'backdrop' : undefined
  }
}

/** The mark alone, scaled so its bounding box fits a centred box. */
function fitted(size, shapes, box) {
  const bounds = boundsOf(shapes.flatMap(shape => shapePolygons(shape, undefined)))
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const scale = ((size / 1024) * box) / Math.max(width, height)
  return {
    width: size,
    height: size,
    transform: {
      scale,
      x: size / 2 - (bounds.minX + width / 2) * scale,
      y: size / 2 - (bounds.minY + height / 2) * scale
    }
  }
}

const { emit, finish } = createEmitter({ repoRoot, checkOnly: process.argv.includes('--check') })

const allShapes = readSvg(readFileSync(sourceSvg, 'utf8'))
const markShapes = allShapes.filter(shape => shape.group === 'mark')
if (markShapes.length === 0) {
  throw new Error('design/icon.svg has no shapes inside <g id="mark">')
}
if (!allShapes.some(shape => shape.id === 'backdrop')) {
  throw new Error('design/icon.svg has no #backdrop')
}

// The app's own assets.
emit(resolve(assetsDir, 'icon.png'), encodePng(render(allShapes, { ...fullBleed(1024, true), opaque: true })))
emit(resolve(assetsDir, 'adaptive-icon.png'), encodePng(render(markShapes, fitted(1024, markShapes, ADAPTIVE_SAFE_BOX)))) // prettier-ignore
emit(resolve(assetsDir, 'splash-icon.png'), encodePng(render(allShapes, fullBleed(512, false))))
emit(resolve(assetsDir, 'favicon.png'), encodePng(render(allShapes, fullBleed(64, false))))

// The browser build's own. The two manifest icons keep the artwork's rounded
// corners, because a browser draws them as given; the Apple one is square and
// opaque, because iOS masks and composites it itself and a transparent corner
// there comes out black.
emit(resolve(webIconsDir, 'icon-192.png'), encodePng(render(allShapes, fullBleed(192, false))))
emit(resolve(webIconsDir, 'icon-512.png'), encodePng(render(allShapes, fullBleed(512, false))))
emit(resolve(webIconsDir, 'apple-touch-icon.png'), encodePng(render(allShapes, { ...fullBleed(180, true), opaque: true }))) // prettier-ignore

finish({ subject: 'Icons', source: 'design/icon.svg', command: 'node scripts/generate-app-icons.mjs' })
