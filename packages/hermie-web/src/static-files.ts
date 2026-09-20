/**
 * Serving the exported web build, with an SPA fallback.
 *
 * Three rules, and the second is the one that bites people:
 *
 *  - **No directory listing, ever.** A path that resolves to a directory is
 *    either `index.html` or a 404; there is no third answer.
 *  - **No traversal.** The resolved path has to stay inside the static root.
 *    `..` in a URL is normalised by `new URL()`, but a percent-encoded one is
 *    not, so the check is on the RESOLVED path rather than on the text.
 *  - **Cache by shape.** Expo's bundle and assets carry a content hash in the
 *    file name, so they are immutable for a year; `index.html` names them and
 *    must never be cached at all, or a browser keeps loading yesterday's
 *    bundle after an update.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import path from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** A name with a long hex run in it is content-addressed and safe to pin. */
const HASHED_NAME = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const NO_STORE_CACHE_CONTROL = 'no-store, must-revalidate'

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function cacheControlFor(relativePath: string): string {
  if (relativePath.endsWith('.html')) {
    return NO_STORE_CACHE_CONTROL
  }

  return HASHED_NAME.test(relativePath) || relativePath.startsWith('_expo/')
    ? IMMUTABLE_CACHE_CONTROL
    : 'public, max-age=300'
}

/**
 * Resolve one URL path inside the static root, or `null` when it escapes.
 *
 * Returned relative to the root so the caller can decide the cache policy from
 * the shape of the name without re-deriving it.
 */
export function resolveStaticPath(root: string, pathname: string): { absolute: string; relative: string } | null {
  const decoded = safeDecode(pathname)

  if (decoded === null || decoded.includes('\0')) {
    return null
  }

  const absolute = path.resolve(root, `.${path.posix.normalize(decoded)}`)
  const relative = path.relative(root, absolute)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return { absolute, relative: relative.split(path.sep).join('/') }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export interface ServeStaticOptions {
  root: string
  pathname: string
  method: string
  response: ServerResponse
}

/**
 * Answer one request from the static build.
 *
 * Returns false when the path is not a file, so the caller can fall back to
 * `index.html` — which is what makes a deep link like `/settings` work in an
 * SPA with no server-side router.
 */
export async function serveStatic(options: ServeStaticOptions): Promise<boolean> {
  const { root, pathname, method, response } = options
  const resolved = resolveStaticPath(root, pathname)

  if (!resolved) {
    return false
  }

  const file = await statFile(resolved.absolute)

  if (!file) {
    return false
  }

  send(response, method, resolved.absolute, resolved.relative, file.size)

  return true
}

/** The SPA fallback: the one document every unknown path resolves to. */
export async function serveIndex(root: string, method: string, response: ServerResponse): Promise<boolean> {
  const absolute = path.join(root, 'index.html')
  const file = await statFile(absolute)

  if (!file) {
    return false
  }

  send(response, method, absolute, 'index.html', file.size)

  return true
}

async function statFile(absolute: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(absolute)

    return info.isFile() ? { size: info.size } : null
  } catch {
    return null
  }
}

function send(response: ServerResponse, method: string, absolute: string, relative: string, size: number): void {
  response.writeHead(200, {
    'content-type': contentTypeFor(absolute),
    'content-length': String(size),
    'cache-control': cacheControlFor(relative),
    // The app is one origin talking to itself; nothing here should ever be
    // framed by, or sniffed as, something else.
    'x-content-type-options': 'nosniff'
  })

  if (method === 'HEAD') {
    response.end()

    return
  }

  createReadStream(absolute).pipe(response)
}
